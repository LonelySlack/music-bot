import { Client, GatewayIntentBits, EmbedBuilder, ActivityType, SlashCommandBuilder, REST, Routes, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, StringSelectMenuBuilder } from 'discord.js';
import { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, VoiceConnectionStatus, entersState, NoSubscriberBehavior, StreamType } from '@discordjs/voice';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, readdirSync } from 'fs';
import { createHash, randomBytes } from 'crypto';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { patchConsole, updateStatus, startDashboard, disconnectClients } from './dashboard.js';
import * as lib from './library.js';
import { detectSource, getYoutubePlaylist, getSpotifyTracks, getAppleMusicTracks, getRadioSong, getLyrics } from './sources.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
if (existsSync(join(__dirname, '.env'))) {
  for (const line of readFileSync(join(__dirname, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([\w]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
const execFileAsync = promisify(execFile);
patchConsole();

const YT_DLP = process.env.YT_DLP_PATH || '/home/lonelyslack/bin/yt-dlp';
const FFMPEG = process.env.FFMPEG_PATH || '/home/lonelyslack/bin/ffmpeg';
const TOKEN = process.env.DISCORD_TOKEN;
const PREFIX = process.env.PREFIX || '67';
// Discord user IDs allowed to run admin-only commands (e.g. `67 admin`).
// Comma-separated in ADMIN_ID (.env); defaults to the owner + alt account.
const ADMIN_IDS = new Set(
  (process.env.ADMIN_ID || '750320261097848853,774893047044374529')
    .split(',').map(s => s.trim()).filter(Boolean)
);
// Route yt-dlp through Cloudflare WARP (SOCKS proxy) so YouTube sees a Cloudflare
// egress IP instead of this datacenter IP, which YouTube blocks with a bot check.
// Override/disable with YT_DLP_PROXY (empty string = go direct).
const YT_PROXY = process.env.YT_DLP_PROXY ?? 'socks5://127.0.0.1:40000';
const YT_ARGS = ['--js-runtimes', 'node', ...(YT_PROXY ? ['--proxy', YT_PROXY] : [])];
if (!TOKEN) { console.error('DISCORD_TOKEN required'); process.exit(1); }

// ffmpeg -af presets. Applied (with volume) when a song streams; changing one
// re-streams from the current spot. `none` clears it.
const FILTERS = {
  none: '',
  bassboost: 'bass=g=12',
  treble: 'treble=g=8',
  nightcore: 'asetrate=48000*1.25,aresample=48000',
  vaporwave: 'asetrate=48000*0.82,aresample=48000',
  '8d': 'apulsator=hz=0.08',
  karaoke: 'pan=stereo|c0=c0-c1|c1=c1-c0',
};
const IDLE_LEAVE_MS = 5 * 60 * 1000;   // leave after 5 min idle (queue empty, no autoplay)
const ALONE_LEAVE_MS = 60 * 1000;      // leave 60s after the channel goes empty

// Downloaded-audio cache: we fetch each song to disk first and play from the
// local file (smoother than live streaming). Wiped on every startup.
const CACHE_DIR = join(__dirname, 'cache');
try { rmSync(CACHE_DIR, { recursive: true, force: true }); } catch {}
try { mkdirSync(CACHE_DIR, { recursive: true }); } catch {}

/* ============================ queue + helpers ============================ */
const queues = new Map();
function getQueue(guildId) {
  if (!queues.has(guildId)) {
    const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
    player.on(AudioPlayerStatus.Idle, () => onSongEnd(guildId));
    player.on('error', (err) => { console.error(`[${guildId}] player error: ${err.message}`); onSongEnd(guildId, true); });
    queues.set(guildId, { songs: [], played: [], player, connection: null, playing: false, paused: false, loop: false, textChannel: null, current: null, startedAt: 0, seekOffset: 0, npMessage: null, volume: 1, autoplay: true, autoplayMode: 'mix', pausedAt: 0, filter: null, leaveTimer: null, ffmpeg: null, sponsorblock: true, next: null, prepareTimer: null });
  }
  return queues.get(guildId);
}
function onSongEnd(guildId, isError = false) {
  const q = queues.get(guildId);
  if (!q) return;
  if (q.loop && q.current && !isError) { playSong(guildId, 0, { relocate: false }); return; } // replay same, keep panel in place
  if (q.current) { cleanupFile(q.current); q.played.push(q.current); if (q.played.length > 200) q.played.shift(); }
  q.songs.shift();
  playSong(guildId);
}
function fmt(s) {
  if (s == null || isNaN(s)) return '???';
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = Math.floor(s % 60);
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}` : `${m}:${String(x).padStart(2, '0')}`;
}
function ytDlpJson(args) { return execFileAsync(YT_DLP, [...YT_ARGS, ...args], { timeout: 25000 }).then(({ stdout }) => { const t = (stdout || '').trim(); if (!t) return null; try { return JSON.parse(t); } catch { const last = t.split('\n').filter(Boolean).pop(); return last ? JSON.parse(last) : null; } }); }

async function searchSong(query) {
  if (/^https?:\/\//i.test(query)) {
    const info = await ytDlpJson([query, '--no-playlist', '--dump-json', '--no-download']);
    if (!info) return null;
    return { url: info.webpage_url || info.url || query, title: info.title || 'Unknown', duration: fmt(info.duration), durationSec: info.duration || 0, thumbnail: info.thumbnail || null, uploader: info.uploader || info.channel || null };
  }
  // ytsearch can rank a matching CHANNEL or playlist above the actual song —
  // those come back as ie_key 'YoutubeTab' with a non-video id (e.g. a 24-char
  // UC… channel id) and no duration. Blindly wrapping one as watch?v=<id> yields
  // "Video unavailable". So pull several results and take the first real video.
  const { stdout } = await execFileAsync(YT_DLP, [...YT_ARGS, `ytsearch5:${query}`, '--dump-json', '--no-download', '--flat-playlist'], { timeout: 25000 });
  const entries = stdout.split('\n').map(l => l.trim()).filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const isVideo = (x) => x && x.id && (x.ie_key ? x.ie_key === 'Youtube' : /^[\w-]{11}$/.test(x.id));
  const e = entries.find(isVideo);
  if (!e) return null;
  return { url: `https://www.youtube.com/watch?v=${e.id}`, title: e.title || query, duration: fmt(e.duration), durationSec: e.duration || 0, thumbnail: e.thumbnails?.[0]?.url || null, uploader: e.uploader || e.channel || null };
}

/* ============================ playback (download-first, with seek) ============================ */
// Download a song's audio to a local file (once per song). Playing from disk is
// immune to mid-song network/WARP jitter. De-dupes concurrent calls via _dlPromise.
// SponsorBlock categories to strip from music videos (intros, sponsor reads, the
// non-music "off-topic" bits of official videos, etc.).
const SB_CATEGORIES = 'sponsor,selfpromo,interaction,intro,outro,music_offtopic';
// YouTube periodically bot-flags WARP's Cloudflare egress IP — then every
// download hard-fails with `429 Too Many Requests` / `Sign in to confirm you're
// not a bot`, and retrying the same IP keeps failing. Rotating WARP (disconnect
// → connect) lands a fresh egress IP; a good fraction of those are ALSO flagged,
// so callers rotate-and-retry a few times until one works. Serialized via a
// shared in-flight promise so a burst of simultaneous failures (prefetch of
// several tracks) triggers ONE rotation, not a stampede.
let _warpRotating = null;
function rotateWarp() {
  if (_warpRotating) return _warpRotating;
  _warpRotating = (async () => {
    try {
      await execFileAsync('warp-cli', ['--accept-tos', 'disconnect'], { timeout: 15000 }).catch(() => {});
      await new Promise(r => setTimeout(r, 2000));
      await execFileAsync('warp-cli', ['--accept-tos', 'connect'], { timeout: 15000 }).catch(() => {});
      await new Promise(r => setTimeout(r, 5000));
      console.log('[warp] rotated egress IP after YouTube bot-check');
    } catch (e) { console.error('[warp] rotate failed:', e.message); }
  })().finally(() => { _warpRotating = null; });
  return _warpRotating;
}
const isBotCheck = (msg) => /\b429\b|Too Many Requests|not a bot|Sign in to confirm/i.test(msg || '');

// Cap a single yt-dlp attempt so hung proxy/CDN sockets cannot leak forever
// (we previously used --retries infinite with no process timeout → multi-day zombies).
const DL_TIMEOUT_MS = 5 * 60 * 1000; // 5 min per attempt
const DL_RETRIES = 5;                 // yt-dlp network retries within one attempt
const DL_SOCKET_TIMEOUT = 30;         // seconds; fail faster on dead sockets

function ensureDownloaded(song, sb = false) {
  if (song.file && existsSync(song.file)) return Promise.resolve(song.file);
  if (song._dlPromise) return song._dlPromise;
  // sb is part of the cache key so SponsorBlock'd and raw versions don't collide.
  const hash = createHash('sha1').update(song.url + (sb ? '|sb' : '')).digest('hex');
  const tmpl = join(CACHE_DIR, hash + '.%(ext)s');
  const label = song.title || song.url;
  const args = [
    ...YT_ARGS, song.url,
    '-f', 'bestaudio[ext=m4a]/bestaudio/best',
    '--no-playlist', '--no-part',
    '--retries', String(DL_RETRIES),
    '--fragment-retries', String(DL_RETRIES),
    '--socket-timeout', String(DL_SOCKET_TIMEOUT),
  ];
  if (sb) args.push('--sponsorblock-remove', SB_CATEGORIES);
  args.push('-o', tmpl);
  // One yt-dlp run → resolves to the cached file, or rejects with yt-dlp's tail stderr.
  const attempt = () => new Promise((resolve, reject) => {
    const started = Date.now();
    console.log(`[dl] start "${label}" sb=${!!sb} hash=${hash.slice(0, 8)}`);
    const dl = spawn(YT_DLP, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = ''; let settled = false;
    const finish = (fn, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(val);
    };
    const timer = setTimeout(() => {
      try { dl.kill('SIGKILL'); } catch {}
      console.error(`[dl] timeout "${label}" after ${DL_TIMEOUT_MS / 1000}s`);
      finish(reject, new Error(`download timed out after ${DL_TIMEOUT_MS / 1000}s`));
    }, DL_TIMEOUT_MS);
    dl.stderr.on('data', d => { err += d; if (err.length > 8000) err = err.slice(-4000); });
    dl.on('error', (e) => finish(reject, e));
    dl.on('close', (code) => {
      const f = readdirSync(CACHE_DIR).find(n => n.startsWith(hash));
      if (f) {
        song.file = join(CACHE_DIR, f);
        console.log(`[dl] ok "${label}" → ${f} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
        finish(resolve, song.file);
      } else {
        const tail = err.trim().split('\n').slice(-3).join(' | ');
        console.error(`[dl] fail "${label}" exit=${code} ${tail.slice(0, 240)}`);
        finish(reject, new Error(`exit ${code}: ${tail}`));
      }
    });
  });
  // WARP can throw a transient 403 on the media CDN (quick retry fixes it), or a
  // hard bot-check when the egress IP is flagged (rotate the WARP IP and retry).
  song._dlPromise = (async () => {
    let transient = 0, rotations = 0;
    for (;;) {
      try { return await attempt(); }
      catch (e) {
        if (YT_PROXY && isBotCheck(e.message)) {
          if (rotations >= 6) throw new Error(`download produced no file (${e.message})`);
          rotations++;
          console.warn(`[dl] bot-check on "${label}" — rotating WARP (try ${rotations}/6)`);
          await rotateWarp();   // land a fresh egress IP, then retry (doesn't burn the transient budget)
          continue;
        }
        if (transient >= 2) throw new Error(`download produced no file (${e.message})`);
        transient++;
        console.warn(`[dl] retry "${label}" transient=${transient}/2: ${e.message.slice(0, 160)}`);
        await new Promise(r => setTimeout(r, 1500));
      }
    }
  })().finally(() => { song._dlPromise = null; });
  return song._dlPromise;
}
// Pre-download (and resolve) the next several queued songs so a skip or a failed
// download recovers instantly — the following tracks are already on disk.
const PREFETCH_AHEAD = 5;
async function prefetchAhead(q) {
  if (q._prefetching) return; // one pass at a time (downloads are sequential)
  q._prefetching = true;
  try {
    for (let idx = 1; idx <= PREFETCH_AHEAD && idx < q.songs.length; idx++) {
      const s = q.songs[idx];
      if (!s || (s.file && existsSync(s.file))) continue;
      try {
        if (s.needsResolve) { const r = await searchSong(s.searchQuery); if (!r) continue; Object.assign(s, r, { needsResolve: false }); }
        await ensureDownloaded(s, q.sponsorblock);
      } catch { /* best-effort; it'll download on demand if this misses */ }
    }
  } finally { q._prefetching = false; }
}
function cleanupFile(song) { if (song?.file) { try { rmSync(song.file, { force: true }); } catch {} song.file = null; } }
function clearPrepared(q) { try { q.next?.ffmpeg?.kill('SIGKILL'); } catch {} q.next = null; }
function cleanupQueueFiles(q) { try { q.ffmpeg?.kill('SIGKILL'); q.ffmpeg = null; } catch {} clearTimeout(q.prepareTimer); q.prepareTimer = null; clearPrepared(q); cleanupFile(q.current); (q.songs || []).forEach(cleanupFile); (q.played || []).forEach(cleanupFile); }

// Build the ffmpeg→Ogg/Opus stream + AudioResource for a downloaded file, applying
// the queue's current volume + filter. Shared by live play and the gapless pre-builder.
function buildAudio(file, q, seekSeconds = 0) {
  const ffArgs = [];
  if (seekSeconds > 0) ffArgs.push('-ss', String(seekSeconds));
  ffArgs.push('-i', file);
  const chain = [];
  if (q.volume && q.volume !== 1) chain.push(`volume=${q.volume.toFixed(2)}`);
  if (q.filter && FILTERS[q.filter]) chain.push(FILTERS[q.filter]);
  if (chain.length) ffArgs.push('-af', chain.join(','));
  ffArgs.push('-analyzeduration', '0', '-loglevel', '0', '-vn', '-c:a', 'libopus', '-ar', '48000', '-ac', '2', '-b:a', '96k', '-f', 'ogg', 'pipe:1');
  const ffmpeg = spawn(FFMPEG, ffArgs, { stdio: ['ignore', 'pipe', 'ignore'] });
  ffmpeg.stdout.on('error', () => {});
  ffmpeg.on('error', (e) => console.error(`ffmpeg: ${e.message}`));
  return { ffmpeg, resource: createAudioResource(ffmpeg.stdout, { inputType: StreamType.OggOpus }) };
}
// Pre-build the NEXT song's audio stream a few seconds before the current one ends,
// so the transition is gap-free (no ffmpeg cold-start at the boundary).
async function prepareNextResource(q) {
  try {
    const nxt = q.songs[1];
    if (!nxt || !q.playing || (q.next && q.next.song === nxt)) return;
    if (nxt.needsResolve) { const r = await searchSong(nxt.searchQuery); if (!r) return; Object.assign(nxt, r, { needsResolve: false }); }
    const file = await ensureDownloaded(nxt, q.sponsorblock);
    if (q.songs[1] !== nxt) return; // queue changed while downloading
    clearPrepared(q);
    q.next = { song: nxt, ...buildAudio(file, q, 0) };
  } catch { /* fall back to live build at the boundary */ }
}
function schedulePrepare(q) {
  clearTimeout(q.prepareTimer); q.prepareTimer = null;
  const total = q.current?.durationSec || 0;
  if (!total) return;
  const left = total - currentPosition(q), lead = 7;
  if (left > lead + 3) q.prepareTimer = setTimeout(() => prepareNextResource(q), (left - lead) * 1000);
}
// Wait for the voice handshake to finish before streaming — NoSubscriberBehavior.Play
// discards audio while the connection isn't Ready. On a rare stuck handshake (Discord
// reassigns idle voice servers), force ONE rejoin for a fresh UDP session instead of
// burning the track into a dead connection. Returns true if Ready. Never throws.
async function awaitVoiceReady(q, guildId, ms = 12000) {
  const c = q.connection;
  if (!c || c.state.status === VoiceConnectionStatus.Ready) return true;
  try { await entersState(c, VoiceConnectionStatus.Ready, ms); return true; } catch {}
  if (c.state.status === VoiceConnectionStatus.Destroyed) return false;
  console.error(`[${guildId}] ⚠ voice stuck (${c.state.status}) — forcing rejoin`);
  try { c.rejoin(); } catch {}
  try {
    await entersState(c, VoiceConnectionStatus.Ready, ms);
    console.log(`[${guildId}] ✓ voice recovered after rejoin`);
    return true;
  } catch {
    console.error(`[${guildId}] ❌ voice never reached Ready after rejoin (UDP/handshake blocked?) — audio will be silent`);
    return false;
  }
}
async function playSong(guildId, seekSeconds = 0, { relocate = true } = {}) {
  const q = getQueue(guildId);
  if (q.songs.length === 0) {
    // Autoplay/radio: when the queue runs dry, pull a related song so music never stops.
    if (q.autoplay && q.connection) {
      const seed = q.current || q.played[q.played.length - 1];
      if (seed?.url) {
        try {
          const next = await getRadioSong(seed.url, q.played.map(s => s.url).filter(Boolean), { mode: q.autoplayMode, seedArtist: seed.uploader || seed.title });
          if (next) { q.songs.push({ ...next, by: 'autoplay 📻' }); return playSong(guildId, 0, { relocate }); }
        } catch (e) { console.error(`[${guildId}] autoplay: ${e.message}`); }
      }
    }
    q.playing = false; q.current = null;
    updatePresence();
    if (q.npMessage) { try { await q.npMessage.delete(); } catch {} q.npMessage = null; }
    if (q.textChannel) q.textChannel.send(`📭 Queue empty. Add more with \`${PREFIX} play <song>\`! (I'll leave if idle for 5 min.)`);
    scheduleLeave(guildId, 'idle', IDLE_LEAVE_MS);
    return;
  }
  let song = q.songs[0];
  // lazy-resolve Spotify/search-only entries to a real YouTube url
  if (song.needsResolve) {
    try {
      const r = await searchSong(song.searchQuery);
      if (!r) { q.songs.shift(); return playSong(guildId); }
      song = { ...r, by: song.by }; q.songs[0] = song;
    } catch { q.songs.shift(); return playSong(guildId); }
  }
  q.playing = true; q.paused = false; q.current = song;
  updatePresence();
  clearLeave(q); // a song is starting — cancel any pending idle/alone disconnect
  console.log(`[${guildId}] ▶ ${song.title}${seekSeconds ? ` @${seekSeconds}s` : ''}`);

  // Gapless: if we pre-built this exact song's stream before the last one ended, play it instantly.
  if (seekSeconds === 0 && q.next && q.next.song === song) {
    try { q.ffmpeg?.kill('SIGKILL'); } catch {}
    q.ffmpeg = q.next.ffmpeg; const resource = q.next.resource; q.next = null;
    q.startedAt = Date.now(); q.seekOffset = 0;
    q.player.play(resource);
    lib.addHistory(guildId, song, q.current?.by);
    showNowPlaying(q, { relocate });
    schedulePrepare(q); prefetchAhead(q);
    return;
  }

  // Download to a local file first (usually already done by prefetch → instant),
  // then play from disk so network jitter can't stutter playback.
  let file;
  try { file = await ensureDownloaded(song, q.sponsorblock); }
  catch (e) { console.error(`[${guildId}] download: ${e.message}`); cleanupFile(song); q.songs.shift(); return playSong(guildId); }
  if (q.current !== song) return; // user skipped/changed track while it was downloading
  // Wait for the voice connection to be Ready (with one rejoin-recovery) before streaming.
  await awaitVoiceReady(q, guildId);
  if (q.current !== song) return; // user skipped/changed track while awaiting the handshake
  try {
    try { q.ffmpeg?.kill('SIGKILL'); } catch {} // stop the previous stream (seek/volume/filter re-spawn)
    const { ffmpeg, resource } = buildAudio(file, q, seekSeconds);
    q.ffmpeg = ffmpeg;
    q.startedAt = Date.now(); q.seekOffset = seekSeconds;
    q.player.play(resource);
    if (seekSeconds === 0) {
      lib.addHistory(guildId, song, q.current?.by);
      showNowPlaying(q, { relocate });
    }
    schedulePrepare(q); // pre-build the next song's stream for a gap-free switch
    prefetchAhead(q);    // and pre-download the next several so skips/failures recover instantly
  } catch (e) { console.error(`[${guildId}] play err: ${e.message}`); onSongEnd(guildId, true); }
}
// Elapsed seconds into the current song. Freezes while paused (we shift startedAt
// forward by the paused duration on resume, so this stays accurate).
function currentPosition(q) {
  const ref = q.paused && q.pausedAt ? q.pausedAt : Date.now();
  return Math.max(0, Math.floor((ref - q.startedAt) / 1000) + (q.seekOffset || 0));
}

/* ============================ presence ============================ */
// The bot's Discord status mirrors what it's actually doing: with one server
// playing we show that track, with several a track from one would misrepresent
// the rest. Discord rate-limits presence updates, so we only push on change.
// Noise publishers glue onto YouTube titles. Deliberately tight — "(feat. …)",
// "(Remastered)" and the like carry real information and must survive.
const TITLE_NOISE = /\s*[\(\[]\s*(?:official\s*(?:music\s*)?(?:video|audio|lyric(?:s)?(?:\s*video)?|visuali[sz]er)?|lyric(?:s)?(?:\s*video)?|audio|visuali[sz]er|m\/?v|hq|hd|full\s*hd|[48]k)\s*[\)\]]/gi;
function presenceTitle(song) {
  const t = (song.title || '').replace(TITLE_NOISE, '').replace(/\s{2,}/g, ' ').trim() || song.title || 'music';
  return t.length > 120 ? t.slice(0, 119) + '…' : t;
}
let presenceText = null;
function updatePresence() {
  if (!client.user) return;
  const active = [...queues.values()].filter(q => q.playing && q.current);
  let text;
  if (active.length === 1) {
    const q = active[0];
    text = `${q.paused ? '⏸️' : '🎵'} ${presenceTitle(q.current)}`;
  } else if (active.length > 1) {
    text = `🎵 ${active.length} servers`;
  } else {
    text = `${PREFIX} play — music`;
  }
  if (text === presenceText) return; // don't spend rate limit re-sending the same line
  presenceText = text;
  try { client.user.setActivity(text, { type: ActivityType.Listening }); } catch {}
}

/* ============================ embeds + buttons ============================ */
// `1:12 ▬▬▬🔘▬▬▬▬ 3:45` — visual progress; shows just the elapsed time if we
// don't know the song's length yet (e.g. an unresolved Spotify entry).
function progressBar(q) {
  const s = q.current; if (!s) return null;
  const total = s.durationSec || 0;
  const pos = total ? Math.min(currentPosition(q), total) : currentPosition(q);
  if (!total) return `\`${fmt(pos)}\``;
  const slots = 18;
  const filled = Math.max(0, Math.min(slots - 1, Math.floor((pos / total) * slots)));
  return `\`${fmt(pos)}\` ${'▬'.repeat(filled)}🔘${'▬'.repeat(slots - 1 - filled)} \`${fmt(total)}\``;
}
function nowPlayingEmbed(q) {
  const s = q.current || q.songs[0];
  if (!s) return new EmbedBuilder().setColor(0x555555).setTitle('⏹️ Nothing playing').setDescription(`Add a song with \`${PREFIX} play <song>\`.`);
  const bar = progressBar(q);
  const embed = new EmbedBuilder().setColor(q.paused ? 0xE67E22 : 0x1DB954)
    .setTitle(q.paused ? '⏸️ Paused' : '🎵 Now Playing')
    .setDescription(`**[${s.title}](${s.url})**` + (bar ? `\n\n${bar}` : ''));
  if (s.uploader) embed.addFields({ name: 'Channel', value: s.uploader, inline: true });
  embed.addFields({ name: 'Volume', value: `${Math.round((q.volume || 1) * 100)}%`, inline: true });
  // Mini-queue: show the next few song titles right on the panel.
  if (q.songs.length > 1) {
    const upNext = q.songs.slice(1, 4).map((x, i) => `\`${i + 1}.\` ${x.title.length > 45 ? x.title.slice(0, 44) + '…' : x.title}`).join('\n');
    const more = q.songs.length - 1 - Math.min(3, q.songs.length - 1);
    embed.addFields({ name: '⏭️ Up next', value: upNext + (more > 0 ? `\n*+${more} more*` : ''), inline: false });
  }
  const foot = [];
  if (q.loop) foot.push('🔁 Looping');
  if (q.autoplay) foot.push(q.autoplayMode === 'artist' ? '📻 Autoplay (artist)' : '📻 Autoplay (mix)');
  if (q.filter) foot.push(`🎚️ ${q.filter}`);
  if (s.by) foot.push(`Added by ${s.by}`);
  if (foot.length) embed.setFooter({ text: foot.join(' · ') });
  if (s.thumbnail) embed.setThumbnail(s.thumbnail);
  return embed;
}
// Buttons reflect live state: ⏸️/▶️ flips with pause, 🔁 lights up when looping,
// and buttons that can't do anything right now are disabled.
function controlRows(q) {
  const b = (id, emoji, style = ButtonStyle.Secondary, disabled = false) =>
    new ButtonBuilder().setCustomId(id).setEmoji(emoji).setStyle(style).setDisabled(disabled);
  const paused = !!q?.paused;
  return [
    new ActionRowBuilder().addComponents(
      b('m_back', '⏮️', ButtonStyle.Secondary, !(q?.played?.length)),
      b('m_pauseresume', paused ? '▶️' : '⏸️', paused ? ButtonStyle.Success : ButtonStyle.Primary),
      b('m_skip', '⏭️', ButtonStyle.Secondary, !(q?.songs?.length > 1 || q?.loop || q?.autoplay)),
      b('m_stop', '⏹️', ButtonStyle.Danger)),
    new ActionRowBuilder().addComponents(
      b('m_back15', '⏪'), b('m_fwd15', '⏩'),
      b('m_loop', '🔁', q?.loop ? ButtonStyle.Success : ButtonStyle.Secondary),
      b('m_shuffle', '🔀', ButtonStyle.Secondary, (q?.songs?.length || 0) < 3)),
    new ActionRowBuilder().addComponents(
      b('m_voldown', '🔉'), b('m_volup', '🔊'),
      b('m_queue', '📋'),
      b('m_autoplay', '📻', q?.autoplay ? (q.autoplayMode === 'artist' ? ButtonStyle.Primary : ButtonStyle.Success) : ButtonStyle.Secondary),
      b('m_like', '⭐')),
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder().setCustomId('m_filter').setPlaceholder(q?.filter ? `🎚️ Filter: ${q.filter}` : '🎚️ Audio filter / EQ…')
        .addOptions(Object.keys(FILTERS).map(k => ({ label: k === 'none' ? 'No filter' : k, value: k, default: (q?.filter || 'none') === k })))),
  ];
}
// One persistent "Now Playing" control panel per guild. Edits in place for
// state changes (pause/loop/seek); on a new song it relocates to the bottom so
// the controls are always reachable without scrolling — and never duplicated.
async function showNowPlaying(q, { relocate = false } = {}) {
  if (!q.textChannel || !q.current) return;
  const payload = { embeds: [nowPlayingEmbed(q)], components: controlRows(q) };
  try {
    if (q.npMessage && !relocate) {
      q.npMessage = await q.npMessage.edit(payload);
    } else {
      if (q.npMessage) { try { await q.npMessage.delete(); } catch {} }
      q.npMessage = await q.textChannel.send(payload);
    }
  } catch {
    try { q.npMessage = await q.textChannel.send(payload); } catch {}
  }
}

/* ============================ voice connect ============================ */
function connect(guild, voiceChannel, q) {
  if (q.connection) return;
  const connection = joinVoiceChannel({ channelId: voiceChannel.id, guildId: guild.id, adapterCreator: guild.voiceAdapterCreator });
  q.connection = connection;
  connection.subscribe(q.player);
  let lock = false;
  connection.on('error', (e) => console.error(`[${guild.id}] voice-error: ${e.message}`));
  connection.on('stateChange', async (oldS, newS) => {
    if (newS.status === VoiceConnectionStatus.Disconnected) {
      if (newS.reason === 'WebSocketClose' && newS.closeCode === 4014) { try { connection.destroy(); } catch {} queues.delete(guild.id); }
      else if (connection.rejoinAttempts < 5) { await new Promise(r => setTimeout(r, (connection.rejoinAttempts + 1) * 5000)); connection.rejoin(); }
      else { try { connection.destroy(); } catch {} queues.delete(guild.id); }
    } else if (!lock && (newS.status === VoiceConnectionStatus.Connecting || newS.status === VoiceConnectionStatus.Signalling)) {
      lock = true;
      try { await entersState(connection, VoiceConnectionStatus.Ready, 20000); } catch { if (connection.state.status !== VoiceConnectionStatus.Destroyed) { try { connection.destroy(); } catch {} queues.delete(guild.id); } } finally { lock = false; }
    }
  });
  connection.on(VoiceConnectionStatus.Destroyed, () => queues.delete(guild.id));
}

/* ============================ auto-disconnect ============================ */
function clearLeave(q) { if (q?.leaveTimer) { clearTimeout(q.leaveTimer); q.leaveTimer = null; } }
function scheduleLeave(guildId, reason, ms) {
  const q = queues.get(guildId); if (!q) return;
  clearLeave(q);
  q.leaveTimer = setTimeout(() => {
    const q2 = queues.get(guildId); if (!q2) return;
    cleanupQueueFiles(q2);
    try { q2.connection?.destroy(); } catch {}
    if (q2.npMessage) q2.npMessage.delete().catch(() => {});
    if (q2.textChannel) q2.textChannel.send(reason === 'alone' ? '👋 Left — everyone left the voice channel.' : '💤 Left after 5 min idle.').catch(() => {});
    queues.delete(guildId);
  }, ms);
}

/* ============================ commands (shared) ============================ */
// each returns a response object {content?, embeds?, components?} or null
async function cmdPlay(guild, voiceChannel, textChannel, by, arg) {
  if (!voiceChannel) return { content: '❌ Join a voice channel first!' };
  if (!arg) return { content: `❌ Usage: \`${PREFIX} play <song / YouTube, Spotify or Apple Music link>\`` };
  const q = getQueue(guild.id); q.textChannel = textChannel;

  // Multi-line paste = bulk add: one song per line, lazily resolved to YouTube
  // at play time (so adding 50 songs is instant and one bad line can't block).
  const lines = arg.split('\n').map(l => l.trim().replace(/^[-•*\d.\)\s]+/, '').trim()).filter(Boolean);
  if (lines.length > 1) {
    const added = lines.map(line => ({ title: line, searchQuery: line, needsResolve: true, duration: '???', by }));
    q.songs.push(...added);
    connect(guild, voiceChannel, q);
    if (!q.playing) { playSong(guild.id); return { content: `🎶 Added **${added.length}** songs — starting now! Use \`${PREFIX} queue\` to see the list.` }; }
    return { content: `➕ Queued **${added.length}** songs. Now **${q.songs.length}** in queue.` };
  }

  const src = detectSource(arg);
  let added = [];
  if (src === 'youtube-playlist') {
    const items = await getYoutubePlaylist(arg);
    added = items.map(s => ({ ...s, by }));
  } else if (src === 'spotify') {
    const queries = await getSpotifyTracks(arg); // ["artist - title", ...]
    added = queries.map(query => ({ title: query, searchQuery: query, needsResolve: true, duration: '???', by }));
  } else if (src === 'apple') {
    const queries = await getAppleMusicTracks(arg); // ["artist - title", ...]
    added = queries.map(query => ({ title: query, searchQuery: query, needsResolve: true, duration: '???', by }));
  } else {
    const s = await searchSong(arg);
    if (!s) return { content: '❌ No results found.' };
    added = [{ ...s, by }];
  }
  q.songs.push(...added);
  connect(guild, voiceChannel, q);
  if (!q.playing) { playSong(guild.id); return { content: added.length > 1 ? `🎶 Added **${added.length}** songs, starting now!` : `🎶 Added **${added[0].title}** — playing now!` }; }
  return { content: added.length > 1 ? `➕ Queued **${added.length}** songs.` : `➕ Queued **${added[0].title}** (#${q.songs.length - 1}).` };
}
function cmdSkip(guild) { const q = getQueue(guild.id); if (!q.playing) return { content: '❌ Nothing playing.' }; q.loop = false; q.player.stop(); return { content: '⏭️ Skipped.' }; }
function cmdBack(guild) {
  const q = getQueue(guild.id);
  if (!q.played.length) return { content: '❌ No previous song.' };
  const prev = q.played.pop();
  if (q.current) q.songs.unshift(q.current);
  q.songs.unshift(prev); q.loop = false; clearPrepared(q); q.player.stop();
  return { content: `⏮️ Back to **${prev.title}**.` };
}
function cmdStop(guild) { const q = getQueue(guild.id); cleanupQueueFiles(q); q.songs = []; q.loop = false; q.playing = false; q.current = null; q.player?.stop(); updatePresence(); return { content: '⏹️ Stopped & cleared.' }; }
function cmdPause(guild) { const q = getQueue(guild.id); if (!q.playing) return { content: '❌ Nothing playing.' }; q.player.pause(); q.paused = true; q.pausedAt = Date.now(); updatePresence(); return { content: '⏸️ Paused.' }; }
function cmdResume(guild) { const q = getQueue(guild.id); if (q.paused && q.pausedAt) { q.startedAt += Date.now() - q.pausedAt; q.pausedAt = 0; } q.player.unpause(); q.paused = false; updatePresence(); return { content: '▶️ Resumed.' }; }
function cmdLeave(guild) { const q = getQueue(guild.id); cleanupQueueFiles(q); clearLeave(q); q.connection?.destroy(); queues.delete(guild.id); updatePresence(); return { content: '👋 Left the voice channel.' }; }
function cmdLoop(guild) { const q = getQueue(guild.id); q.loop = !q.loop; return { content: q.loop ? '🔁 Loop ON.' : '➡️ Loop OFF.' }; }
function cmdShuffle(guild) {
  const q = getQueue(guild.id);
  if (q.songs.length < 3) return { content: '❌ Need 3+ songs to shuffle.' };
  const head = q.songs.shift();
  for (let i = q.songs.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [q.songs[i], q.songs[j]] = [q.songs[j], q.songs[i]]; }
  q.songs.unshift(head); clearPrepared(q);
  return { content: `🔀 Shuffled ${q.songs.length - 1} songs.` };
}
/* ---- queue management (positions are 1-based, matching `queue`/the panel) ---- */
function cmdRemove(guild, arg) {
  const q = getQueue(guild.id);
  const n = parseInt(arg, 10);
  if (isNaN(n) || n < 1 || n >= q.songs.length) return { content: `❌ \`${PREFIX} remove <#>\` (1–${Math.max(1, q.songs.length - 1)}). See \`${PREFIX} queue\`.` };
  const [removed] = q.songs.splice(n, 1);
  cleanupFile(removed); clearPrepared(q);
  return { content: `🗑️ Removed **${removed.title}**.` };
}
function cmdMove(guild, arg) {
  const q = getQueue(guild.id);
  const max = q.songs.length - 1;
  const [a, b] = (arg || '').trim().split(/\s+/).map(x => parseInt(x, 10));
  if (isNaN(a) || isNaN(b) || a < 1 || b < 1 || a > max || b > max) return { content: `❌ \`${PREFIX} move <from> <to>\` (1–${Math.max(1, max)}).` };
  const [s] = q.songs.splice(a, 1);
  q.songs.splice(b, 0, s); clearPrepared(q);
  return { content: `↕️ Moved **${s.title}** to #${b}.` };
}
function cmdJump(guild, arg) {
  const q = getQueue(guild.id);
  const n = parseInt(arg, 10);
  if (isNaN(n) || n < 1 || n >= q.songs.length) return { content: `❌ \`${PREFIX} jump <#>\` (1–${Math.max(1, q.songs.length - 1)}).` };
  const dropped = q.songs.splice(1, n - 1); // drop the songs before the target
  dropped.forEach(cleanupFile); clearPrepared(q);
  const target = q.songs[1]?.title;
  q.loop = false; q.player.stop(); // end current → onSongEnd advances to the target
  return { content: `⏯️ Jumping to **${target || 'next'}**.` };
}
async function cmdPlayNext(guild, voiceChannel, textChannel, by, arg) {
  if (!voiceChannel) return { content: '❌ Join a voice channel first!' };
  if (!arg) return { content: `❌ Usage: \`${PREFIX} playnext <song / link>\`` };
  const q = getQueue(guild.id); q.textChannel = textChannel;
  if (['youtube-playlist', 'spotify', 'apple'].includes(detectSource(arg)))
    return { content: `ℹ️ Play-next is for single songs — use \`${PREFIX} play\` for playlists.` };
  const s = await searchSong(arg);
  if (!s) return { content: '❌ No results found.' };
  q.songs.splice(q.playing ? 1 : q.songs.length, 0, { ...s, by });
  clearPrepared(q);
  connect(guild, voiceChannel, q);
  if (!q.playing) { playSong(guild.id); return { content: `🎶 Playing **${s.title}**.` }; }
  prefetchAhead(q); // pre-download the next several
  return { content: `⏭️ **${s.title}** will play next.` };
}
async function cmdLyrics(guild, arg) {
  const q = getQueue(guild.id);
  const query = (arg || '').trim();
  if (!query && !q.current) return { content: `❌ Nothing playing — try \`${PREFIX} lyrics <artist - title>\`.` };
  const r = await getLyrics(query || q.current.title, query ? null : q.current?.uploader);
  if (!r) return { content: `❌ Couldn't find lyrics. Try \`${PREFIX} lyrics <artist> - <title>\`.` };
  // Discord embed description caps at 4096; split long lyrics across a few embeds.
  const head = `📜 ${r.artist ? r.artist + ' — ' : ''}${r.title}`.slice(0, 256);
  const chunks = r.lyrics.match(/[\s\S]{1,4000}(\n|$)/g)?.slice(0, 3) || [r.lyrics.slice(0, 4000)];
  const embeds = chunks.map((c, i) => new EmbedBuilder().setColor(0x1DB954).setDescription(c).setTitle(i === 0 ? head : null));
  return { embeds };
}
function cmdSponsorblock(guild) {
  const q = getQueue(guild.id);
  q.sponsorblock = !q.sponsorblock;
  return { content: q.sponsorblock ? '⏭️ SponsorBlock **ON** — intros/sponsors/non-music bits get trimmed (applies to new downloads).' : '🚫 SponsorBlock **OFF**.' };
}
function cmdQueue(guild) {
  const q = getQueue(guild.id);
  if (!q.songs.length) return { content: '📭 Queue is empty.' };
  const list = q.songs.slice(0, 15).map((s, i) => `${i === 0 ? '▶️' : `\`${i}.\``} [${s.title}](${s.url || ''}) \`(${s.duration})\``).join('\n');
  const embed = new EmbedBuilder().setColor(0x1DB954).setTitle('📋 Queue').setDescription(list + (q.songs.length > 15 ? `\n…and ${q.songs.length - 15} more` : ''));
  return { embeds: [embed] };
}
async function cmdNp(guild, textChannel) { const q = getQueue(guild.id); if (!q.playing) return { content: '❌ Nothing playing.' }; if (textChannel) q.textChannel = textChannel; await showNowPlaying(q, { relocate: true }); return { _silent: true }; }
function cmdSeek(guild, arg) {
  const q = getQueue(guild.id);
  if (!q.playing) return { content: '❌ Nothing playing.' };
  let sec = 0;
  if (/^\d+:\d{1,2}$/.test(arg)) { const [m, s] = arg.split(':').map(Number); sec = m * 60 + s; }
  else sec = parseInt(arg, 10);
  if (isNaN(sec) || sec < 0) return { content: `❌ Usage: \`${PREFIX} seek 1:30\` (or seconds).` };
  playSong(guild.id, sec);
  return { content: `⏩ Seeked to ${fmt(sec)}.` };
}
function cmdSeekRel(guild, delta) {
  const q = getQueue(guild.id);
  if (!q.playing) return { content: '❌ Nothing playing.' };
  const pos = Math.max(0, currentPosition(q) + delta);
  playSong(guild.id, pos);
  return { content: `${delta < 0 ? '⏪' : '⏩'} ${fmt(pos)}` };
}
// Volume is applied by ffmpeg, so changing it re-streams from the current position
// (a brief gap, like a seek). 0–200%.
function cmdVolume(guild, arg) {
  const q = getQueue(guild.id);
  const v = parseInt(String(arg).replace('%', '').trim(), 10);
  if (isNaN(v)) return { content: `🔊 Volume is **${Math.round((q.volume || 1) * 100)}%**. Set with \`${PREFIX} volume 50\` (0–200).` };
  q.volume = Math.max(0, Math.min(200, v)) / 100;
  clearPrepared(q);
  if (q.playing) playSong(guild.id, currentPosition(q));
  return { content: `🔊 Volume set to **${Math.round(q.volume * 100)}%**.` };
}
function cmdVolRel(guild, delta) {
  const q = getQueue(guild.id);
  if (!q.playing) return { content: '❌ Nothing playing.' };
  q.volume = Math.max(0, Math.min(200, Math.round((q.volume || 1) * 100) + delta)) / 100;
  clearPrepared(q);
  playSong(guild.id, currentPosition(q));
  return { content: `🔊 ${Math.round(q.volume * 100)}%` };
}
function cmdAutoplay(guild, arg) {
  const q = getQueue(guild.id);
  const a = (arg || '').trim().toLowerCase();
  if (a === 'mix' || a === 'diverse') { q.autoplay = true; q.autoplayMode = 'mix'; }
  else if (a === 'artist' || a === 'similar') { q.autoplay = true; q.autoplayMode = 'artist'; }
  else { q.autoplay = !q.autoplay; }            // no arg → just toggle on/off
  if (!q.autoplay) return { content: '📴 Autoplay **OFF**.' };
  return { content: q.autoplayMode === 'artist'
    ? '📻 Autoplay **ON · Artist** — stays close to the current artist.'
    : '📻 Autoplay **ON · Mix** — drifts across related artists for variety. (`' + PREFIX + ' autoplay artist` to stay on one artist)' };
}
function cmdFilter(guild, arg) {
  const q = getQueue(guild.id);
  const key = (arg || '').trim().toLowerCase();
  const names = Object.keys(FILTERS).join(', ');
  if (!key) return { content: `🎚️ Current: **${q.filter || 'none'}**. Options: ${names}. e.g. \`${PREFIX} filter bassboost\`.` };
  if (!(key in FILTERS)) return { content: `❌ Unknown filter **${key}**. Options: ${names}.` };
  q.filter = key === 'none' ? null : key;
  clearPrepared(q);
  if (q.playing) playSong(guild.id, currentPosition(q));
  return { content: q.filter ? `🎚️ Filter set to **${key}**.` : '🎚️ Filters cleared.' };
}
// ⭐ Favorites are per-user and global (work across servers). Toggles the current song.
function cmdLike(guild, userId) {
  const q = getQueue(guild.id);
  if (!q.current) return { content: '❌ Nothing playing to favorite.' };
  const r = lib.toggleFavorite(userId, q.current);
  return { content: r === 'added' ? `⭐ Added **${q.current.title}** to your favorites.` : `💔 Removed **${q.current.title}** from your favorites.` };
}
function cmdFavorites(guild, voiceChannel, textChannel, userId, by, arg) {
  const favs = lib.getFavorites(userId);
  if (!favs.length) return { content: '📭 No favorites yet — hit ⭐ or `' + PREFIX + ' like` while a song plays.' };
  if (/^(play|load)$/i.test((arg || '').trim())) {
    if (!voiceChannel) return { content: '❌ Join a voice channel first!' };
    const q = getQueue(guild.id); q.textChannel = textChannel;
    q.songs.push(...favs.map(s => ({ ...s, by })));
    connect(guild, voiceChannel, q);
    if (!q.playing) playSong(guild.id);
    return { content: `⭐ Queued your **${favs.length}** favorites.` };
  }
  const list = favs.slice(0, 20).map((s, i) => `\`${i + 1}.\` [${s.title}](${s.url}) \`(${s.duration})\``).join('\n');
  return { embeds: [new EmbedBuilder().setColor(0xF1C40F).setTitle('⭐ Your favorites').setDescription(list + (favs.length > 20 ? `\n…and ${favs.length - 20} more` : '')).setFooter({ text: `${PREFIX} favorites play — queue them all` })] };
}
function cmdHistory(guild, arg) {
  // "play <n>" -> replay last n ; else show list
  const m = (arg || '').match(/^(play|replay)\s*(\d+)?/i);
  if (m) {
    const n = Math.min(parseInt(m[2] || '20', 10), 100);
    const songs = lib.getLastSongs(guild.id, n);
    if (!songs.length) return { content: '❌ No history yet.' };
    return { _replay: songs, content: `🔁 Re-queuing the last **${songs.length}** songs…` };
  }
  const n = Math.min(parseInt(arg || '15', 10) || 15, 25);
  const hist = lib.getHistory(guild.id, n);
  if (!hist.length) return { content: '📭 No history yet.' };
  const list = hist.map((h, i) => `\`${i + 1}.\` [${h.title}](${h.url}) \`(${h.duration})\``).join('\n');
  return { embeds: [new EmbedBuilder().setColor(0x1DB954).setTitle(`🕑 Recently played (last ${hist.length})`).setDescription(list).setFooter({ text: `${PREFIX} history play 50 — replay last 50` })] };
}
function cmdPlaylist(guild, voiceChannel, textChannel, by, arg) {
  const [sub, ...rest] = (arg || '').trim().split(/\s+/);
  const name = rest.join(' ');
  const q = getQueue(guild.id);
  if (sub === 'save') {
    if (!name) return { content: `❌ \`${PREFIX} playlist save <name>\`` };
    const songs = [q.current, ...q.songs].filter(Boolean);
    if (!songs.length) return { content: '❌ Nothing in the queue to save.' };
    lib.savePlaylist(guild.id, name, songs);
    return { content: `💾 Saved playlist **${name}** (${songs.length} songs).` };
  }
  if (sub === 'list') {
    const pls = lib.listPlaylists(guild.id);
    if (!pls.length) return { content: '📭 No saved playlists.' };
    return { content: '🎶 **Playlists:**\n' + pls.map(p => `• **${p.name}** (${p.count})`).join('\n') };
  }
  if (sub === 'delete' || sub === 'remove') { return { content: lib.deletePlaylist(guild.id, name) ? `🗑️ Deleted **${name}**.` : `❌ No playlist **${name}**.` }; }
  if (sub === 'play' || sub === 'load' || sub === '') {
    if (!voiceChannel) return { content: '❌ Join a voice channel first!' };
    const songs = lib.getPlaylist(guild.id, name || sub);
    if (!songs || !songs.length) return { content: `❌ No playlist **${name || sub}**. Try \`${PREFIX} playlist list\`.` };
    q.textChannel = textChannel; q.songs.push(...songs.map(s => ({ ...s, by })));
    connect(guild, voiceChannel, q);
    if (!q.playing) playSong(guild.id);
    return { content: `🎶 Loaded **${name || sub}** (${songs.length} songs).` };
  }
  return { content: `❓ \`${PREFIX} playlist save|play|list|delete <name>\`` };
}
function helpText() {
  return new EmbedBuilder().setColor(0x1DB954).setTitle('🎵 Music67 — commands').setDescription(
    `Prefix everything with **\`${PREFIX}\`** (e.g. \`${PREFIX} play never gonna give you up\`).`
  ).addFields(
    { name: '▶️ Play', value: `\`${PREFIX} play <song / YT link / YT playlist / Spotify / Apple Music link>\`\n\`${PREFIX} playnext <song>\` — jump it to the front · \`${PREFIX} search <query>\``, inline: false },
    { name: '🎛️ Control', value: `\`skip\` \`back\` \`pause\` \`resume\` \`stop\` \`loop\` \`shuffle\` \`seek 1:30\` \`leave\`\n(or just use the buttons on the Now Playing message)`, inline: false },
    { name: '📝 Manage queue', value: `\`remove <#>\` · \`move <from> <to>\` · \`jump <#>\` — skip ahead to a song`, inline: false },
    { name: '🔊 Volume / 📻 Radio', value: `\`volume 50\` (0–200%) · \`autoplay\` — keep playing when the queue ends · \`autoplay mix\` (diverse) / \`autoplay artist\` (stay on one artist)`, inline: false },
    { name: '🎚️ Filters / ⏭️ SponsorBlock', value: `\`filter bassboost\` (${Object.keys(FILTERS).filter(k => k !== 'none').join(', ')}, none) · \`sponsorblock\` — trim non-music/sponsor bits`, inline: false },
    { name: '⭐ Favorites', value: `\`like\` — favorite the current song · \`favorites\` — list · \`favorites play\` — queue them`, inline: false },
    { name: '📋 Queue / info', value: `\`queue\` \`np\` · \`lyrics\` — lyrics for the current song`, inline: false },
    { name: '🕑 History', value: `\`history\` — recent · \`history play 100\` — replay last 100 · \`continue\` — pick your last session back up (\`continue 50\` for more)`, inline: false },
    { name: '💾 Playlists', value: `\`playlist save <name>\` · \`playlist play <name>\` · \`playlist list\` · \`playlist delete <name>\``, inline: false },
    { name: '🎛️ Web dashboard', value: `\`link\` — I'll DM you the web dashboard (now playing, drag-reorder queue, history)`, inline: false },
    { name: '🛠️ Admin (admins only)', value: [
      `\`admin\` — full reference · \`admin activate\` / \`admin deactivate\` — allow/block playback in this server · \`admin servers\` — list`,
      `\`blacklist add/remove/list <@user>\` — block users from the bot (shortcuts \`block\`/\`unblock\`)`,
      `\`access add/remove/list <@user>\` — grant dashboard access (shortcuts \`grant\`/\`revoke\`) · \`rotatetoken\` — reset all dashboard links`,
    ].join('\n'), inline: false },
  );
}

// Admin-only, full instruction sheet: every command + its aliases and how to use
// them. Restricted to ADMIN_ID (see the `admin` case in dispatch()).
function adminHelpText() {
  return new EmbedBuilder().setColor(0xF1C40F).setTitle('🛠️ Music67 — Admin / Full Command Reference').setDescription(
    `You are the **admin**. Prefix every command with **\`${PREFIX}\`** (e.g. \`${PREFIX} play daft punk\`). Slash \`/\` commands work too where available.`
  ).addFields(
    { name: '▶️ Playback', value: [
      `\`play | p | add <song / YT link / YT playlist / Spotify / Apple Music link>\``,
      `\`playnext | pn | insert <song>\` — queue right after the current song`,
      `\`search | find <query>\` — pick from top 5 results`,
    ].join('\n'), inline: false },
    { name: '🎛️ Transport', value: `\`skip | s | next\` · \`back | prev | previous\` · \`pause\` · \`resume | unpause\` · \`stop\` · \`leave | dc | disconnect\` · \`loop | repeat\` · \`shuffle\` · \`seek <1:30>\``, inline: false },
    { name: '📝 Queue editing', value: `\`queue | q\` · \`np | nowplaying\` · \`remove | rm | delete <#>\` · \`move | mv <from> <to>\` · \`jump | skipto <#>\``, inline: false },
    { name: '🔊 Sound', value: `\`volume | vol | v <0–200>\` · \`filter | fx | effect <${Object.keys(FILTERS).filter(k => k !== 'none').join(' | ')} | none>\` · \`sponsorblock | sb\``, inline: false },
    { name: '📻 Radio / autoplay', value: `\`autoplay | radio\` (toggle) · \`autoplay mix\` (diverse) · \`autoplay artist\` (stay on one artist)`, inline: false },
    { name: '⭐ Favorites / 💾 Playlists', value: `\`like | fav | favorite\` · \`favorites | favs | likes [play]\`\n\`playlist | pl save <name>\` · \`pl play <name>\` · \`pl list\` · \`pl delete <name>\``, inline: false },
    { name: '📜 Info', value: `\`lyrics | ly <optional query>\` · \`history | hist | recent\` · \`history play <n>\` · \`help | commands | h\``, inline: false },
    { name: '🎚️ Web dashboard', value: `\`link | dashboard | web | panel\` — DMs you a private, tokenized dashboard URL. Current tunnel: get it with \`link\`.`, inline: false },
    { name: '🛠️ Admin', value: [
      `\`admin\` — this reference (admins only).`,
      `\`blacklist add <@user/ID>\` — block from the bot · \`blacklist remove <@user/ID>\` · \`blacklist list\` · shortcuts \`block\`/\`unblock\``,
      `\`access add <@user/ID>\` — grant dashboard link access · \`access remove <@user/ID>\` · \`access list\` · shortcuts \`grant\`/\`revoke\``,
      `\`admin activate\` / \`admin deactivate\` — allow/block playback in **this** server · \`admin servers\` — list activated (also \`activate\`/\`deactivate\`).`,
      `\`rotatetoken\` — kill all existing dashboard links & DM you a fresh one (use after revoking someone).`,
      `Dashboard \`link\` is admins-only unless granted. Admins can't be blacklisted. New servers must be activated before they can play.`,
      `Admin IDs: ${[...ADMIN_IDS].map(id => `\`${id}\``).join(', ')} (set \`ADMIN_ID\` comma-separated in \`.env\`).`,
    ].join('\n'), inline: false },
  );
}

// Admin-only blacklist management. `arg` is the raw text after the command; we
// pull the target user ID from a mention (<@123>) or a bare ID. Admins are immune.
async function cmdBlacklist(arg, byTag) {
  const parts = arg.trim().split(/\s+/).filter(Boolean);
  const sub = (parts.shift() || 'list').toLowerCase();
  const targetId = (arg.match(/\d{17,20}/) || [])[0];
  const nameOf = async (id) => { try { return (await client.users.fetch(id)).tag; } catch { return null; } };

  if (sub === 'list') {
    const rows = lib.listBlacklist();
    if (!rows.length) return { content: '✅ The blacklist is empty.' };
    const list = rows.map((r, i) => `\`${i + 1}.\` ${r.tag ? `**${r.tag}** ` : ''}\`${r.id}\`${r.by ? ` — by ${r.by}` : ''}`).join('\n');
    return { embeds: [new EmbedBuilder().setColor(0x555555).setTitle('⛔ Blacklisted users').setDescription(list).setFooter({ text: `${PREFIX} blacklist remove <@user> to restore access` })] };
  }
  if (sub === 'add' || sub === 'block' || sub === 'ban') {
    if (!targetId) return { content: `❌ \`${PREFIX} blacklist add <@user or ID>\`` };
    if (ADMIN_IDS.has(targetId)) return { content: "❌ You can't blacklist an admin." };
    const tag = await nameOf(targetId);
    const added = lib.addBlacklist(targetId, tag, byTag);
    const who = tag ? `**${tag}**` : `\`${targetId}\``;
    return { content: added ? `⛔ Blocked ${who} — they can no longer use the bot.` : `ℹ️ ${who} is already blacklisted.` };
  }
  if (sub === 'remove' || sub === 'unblock' || sub === 'unban' || sub === 'del') {
    if (!targetId) return { content: `❌ \`${PREFIX} blacklist remove <@user or ID>\`` };
    const tag = await nameOf(targetId);
    const who = tag ? `**${tag}**` : `\`${targetId}\``;
    return { content: lib.removeBlacklist(targetId) ? `✅ Unblocked ${who} — access restored.` : `ℹ️ ${who} wasn't blacklisted.` };
  }
  return { content: `❌ Usage: \`${PREFIX} blacklist add|remove|list <@user or ID>\`` };
}

// Admin-only dashboard access-list management. Grants/revokes who (besides admins)
// may run `67 link`. Note: revoking stops NEW links only — a link already saved
// keeps working until DASHBOARD_TOKEN is rotated (single shared token).
async function cmdAccess(arg, byTag) {
  const parts = arg.trim().split(/\s+/).filter(Boolean);
  const sub = (parts.shift() || 'list').toLowerCase();
  const targetId = (arg.match(/\d{17,20}/) || [])[0];
  const nameOf = async (id) => { try { return (await client.users.fetch(id)).tag; } catch { return null; } };

  if (sub === 'list') {
    const rows = lib.listDashAccess();
    const admins = [...ADMIN_IDS].map(id => `\`${id}\` (admin)`).join('\n');
    const granted = rows.length ? rows.map((r, i) => `\`${i + 1}.\` ${r.tag ? `**${r.tag}** ` : ''}\`${r.id}\`${r.by ? ` — by ${r.by}` : ''}`).join('\n') : '_(none granted yet)_';
    return { embeds: [new EmbedBuilder().setColor(0x1DB954).setTitle('🔑 Dashboard access').setDescription(`**Always allowed:**\n${admins}\n\n**Granted access:**\n${granted}`).setFooter({ text: `${PREFIX} access add/remove <@user>` })] };
  }
  if (sub === 'add' || sub === 'grant' || sub === 'allow') {
    if (!targetId) return { content: `❌ \`${PREFIX} access add <@user or ID>\`` };
    if (ADMIN_IDS.has(targetId)) return { content: 'ℹ️ That user is an admin — they already have access.' };
    const tag = await nameOf(targetId);
    const added = lib.addDashAccess(targetId, tag, byTag);
    const who = tag ? `**${tag}**` : `\`${targetId}\``;
    return { content: added ? `🔑 Granted ${who} dashboard access — they can now use \`${PREFIX} link\`.` : `ℹ️ ${who} already has access.` };
  }
  if (sub === 'remove' || sub === 'revoke' || sub === 'del') {
    if (!targetId) return { content: `❌ \`${PREFIX} access remove <@user or ID>\`` };
    const tag = await nameOf(targetId);
    const who = tag ? `**${tag}**` : `\`${targetId}\``;
    if (!lib.removeDashAccess(targetId)) return { content: `ℹ️ ${who} didn't have granted access.` };
    return { content: `✅ Revoked ${who}'s access — they can't get a **new** link. ⚠️ Any link they already saved still works until you rotate \`DASHBOARD_TOKEN\`.` };
  }
  return { content: `❌ Usage: \`${PREFIX} access add|remove|list <@user or ID>\`` };
}

// Persist a KEY=VALUE into .env (replacing the line if present, appending if not),
// so a rotated token survives restarts.
function setEnvVar(key, value) {
  const path = join(__dirname, '.env');
  let lines = [];
  try { lines = readFileSync(path, 'utf8').split('\n'); } catch {}
  let found = false;
  lines = lines.map(l => { const m = l.match(/^\s*([\w]+)\s*=/); if (m && m[1] === key) { found = true; return `${key}=${value}`; } return l; });
  if (!found) lines.push(`${key}=${value}`);
  writeFileSync(path, lines.join('\n'));
}

// Admin-only: generate a brand-new dashboard token. This instantly kills every
// previously shared link — open dashboards get dropped and can't reconnect, and
// any saved link 401s. Then DM the requester a fresh working link.
async function cmdRotateToken(guild, userId) {
  const newTok = randomBytes(24).toString('hex');
  process.env.DASHBOARD_TOKEN = newTok; // live: dashboard reads this on each request
  try { setEnvVar('DASHBOARD_TOKEN', newTok); } catch (e) { return { content: `❌ Rotated in memory but couldn't save to .env (${e.message}). It'll revert on restart.` }; }
  try { disconnectClients(); } catch {}
  const linkRes = await cmdLink(guild, userId);
  return { content: `🔄 **Dashboard token rotated.** Every previously shared link is now dead — open dashboards were disconnected and can't reconnect, and saved links stop working. Re-share access as needed.\n\n${linkRes.content}` };
}

// Does this command (with its args) actually try to START playback? Used by the
// per-server activation gate — non-playback commands (help, queue, np…) stay open.
function isPlaybackAttempt(name, arg) {
  const play = new Set(['play', 'p', 'add', 'playnext', 'pn', 'insert', 'playlist', 'pl', 'autoplay', 'radio', 'continue', 'cont', 'resumesession']);
  if (play.has(name)) return true;
  if (['favorites', 'favourites', 'favs', 'likes'].includes(name) && /^(play|load)/i.test((arg || '').trim())) return true;
  if (['history', 'hist', 'recent'].includes(name) && /^(play|replay)/i.test((arg || '').trim())) return true;
  return false;
}

// Admin-only per-server activation. `action` is 'on' | 'off' | 'list'. Deactivating
// also disconnects the bot so playback actually stops, not just future plays.
function cmdServerActivation(guild, action) {
  if (action === 'list') {
    const rows = lib.listActiveGuilds();
    if (!rows.length) return { content: 'No servers are activated yet.' };
    const list = rows.map((r, i) => `\`${i + 1}.\` ${r.name ? `**${r.name}** ` : ''}\`${r.id}\``).join('\n');
    return { embeds: [new EmbedBuilder().setColor(0x1DB954).setTitle('🟢 Activated servers').setDescription(list)] };
  }
  if (!guild) return { content: '❌ Run this inside the server you want to (de)activate.' };
  if (action === 'on') {
    const added = lib.activateGuild(guild.id, guild.name);
    return { content: added ? `✅ **${guild.name}** is now **activated** — the bot can play here.` : `ℹ️ **${guild.name}** is already activated.` };
  }
  // off
  const removed = lib.deactivateGuild(guild.id);
  if (removed) { try { cmdLeave(guild); } catch {} }
  return { content: removed ? `🚫 **${guild.name}** **deactivated** — playback is now blocked and I've left the voice channel.` : `ℹ️ **${guild.name}** wasn't activated.` };
}

// DM the web dashboard link to the requester. The URL carries the private access
// token, so we never post it in a channel — only the requester's DMs get it.
async function cmdLink(guild, userId) {
  // Dashboard link is admin-only by default; admins can grant others access
  // with `67 access add @user` (see cmdAccess).
  if (!ADMIN_IDS.has(userId) && !lib.isDashAllowed(userId)) {
    return { content: '⛔ You don\'t have dashboard access. Ask an admin to grant it with `' + PREFIX + ' access add @you`.' };
  }
  const token = process.env.DASHBOARD_TOKEN || '';
  // Prefer the live Cloudflare tunnel URL (HTTPS, works past the DO firewall);
  // fall back to DASHBOARD_URL / localhost if the tunnel file isn't there.
  let base = '';
  try { base = readFileSync(join(__dirname, 'tunnel-url.txt'), 'utf8').trim(); } catch {}
  if (!base) base = process.env.DASHBOARD_URL || `http://localhost:${process.env.DASHBOARD_PORT || '3000'}`;
  base = base.replace(/\/+$/, '');
  const url = token ? `${base}/?token=${encodeURIComponent(token)}` : base;
  try {
    const user = await client.users.fetch(userId);
    await user.send(`🎛️ **Music67 Web Dashboard**\n${url}\n\n${token ? '⚠️ This link has your private access token — keep it to yourself. Anyone with it can control the music.' : ''}`);
    return { content: '📬 Sent the dashboard link to your **DMs**.' };
  } catch {
    return { content: `❌ I couldn't DM you — turn on **Direct Messages** for this server, then try again. (I won't post the link here${token ? " because it contains your access token" : ''}.)` };
  }
}

/* dispatch a parsed command name+arg; returns response or handles replay */
async function dispatch(name, arg, ctx) {
  const { guild, voiceChannel, textChannel, by, userId } = ctx;
  // Security gate: the bot only plays in servers an admin has activated. Admins
  // bypass (so they can play/test), and non-playback commands stay open.
  if (guild && !ADMIN_IDS.has(userId) && isPlaybackAttempt(name, arg) && !lib.isGuildActive(guild.id)) {
    return { content: `⛔ **${guild.name}** isn't activated for playback. An admin must run \`${PREFIX} admin activate\` here first.` };
  }
  switch (name) {
    case 'play': case 'p': case 'add': return cmdPlay(guild, voiceChannel, textChannel, by, arg);
    case 'playnext': case 'pn': case 'insert': return cmdPlayNext(guild, voiceChannel, textChannel, by, arg);
    case 'search': case 'find': { const r = await searchMultiplePreview(arg); return r; }
    case 'skip': case 's': case 'next': return cmdSkip(guild);
    case 'back': case 'prev': case 'previous': return cmdBack(guild);
    case 'remove': case 'rm': case 'delete': return cmdRemove(guild, arg);
    case 'move': case 'mv': return cmdMove(guild, arg);
    case 'jump': case 'skipto': return cmdJump(guild, arg);
    case 'stop': return cmdStop(guild);
    case 'pause': return cmdPause(guild);
    case 'resume': case 'unpause': return cmdResume(guild);
    case 'leave': case 'dc': case 'disconnect': return cmdLeave(guild);
    case 'loop': case 'repeat': return cmdLoop(guild);
    case 'shuffle': return cmdShuffle(guild);
    case 'sponsorblock': case 'sb': return cmdSponsorblock(guild);
    case 'lyrics': case 'ly': case 'lyric': return cmdLyrics(guild, arg);
    case 'queue': case 'q': return cmdQueue(guild);
    case 'np': case 'nowplaying': return cmdNp(guild, textChannel);
    case 'volume': case 'vol': case 'v': return cmdVolume(guild, arg);
    case 'autoplay': case 'radio': return cmdAutoplay(guild, arg);
    case 'filter': case 'fx': case 'effect': return cmdFilter(guild, arg);
    case 'like': case 'fav': case 'favorite': case 'favourite': return cmdLike(guild, userId);
    case 'favorites': case 'favourites': case 'favs': case 'likes': return cmdFavorites(guild, voiceChannel, textChannel, userId, by, arg);
    case 'seek': return cmdSeek(guild, arg);
    case 'history': case 'hist': case 'recent': {
      const r = cmdHistory(guild, arg);
      if (r._replay) { const q = getQueue(guild.id); q.textChannel = textChannel; if (!voiceChannel) return { content: '❌ Join a voice channel first!' }; q.songs.push(...r._replay.map(s => ({ ...s, by }))); connect(guild, voiceChannel, q); if (!q.playing) playSong(guild.id); }
      return { content: r.content, embeds: r.embeds };
    }
    case 'continue': case 'cont': case 'resumesession': {
      // Pick the last session back up: re-queue recently played songs from history.
      // Optional count, e.g. "continue 50" (default 20, max 100).
      const r = cmdHistory(guild, `play ${arg || ''}`.trim());
      if (!r._replay) return { content: r.content, embeds: r.embeds }; // e.g. "❌ No history yet."
      if (!voiceChannel) return { content: '❌ Join a voice channel first!' };
      const q = getQueue(guild.id); q.textChannel = textChannel;
      q.songs.push(...r._replay.map(s => ({ ...s, by })));
      connect(guild, voiceChannel, q);
      if (!q.playing) playSong(guild.id);
      return { content: `▶️ Continuing your last session — re-queued the last **${r._replay.length}** song${r._replay.length === 1 ? '' : 's'}.` };
    }
    case 'playlist': case 'pl': return cmdPlaylist(guild, voiceChannel, textChannel, by, arg);
    case 'link': case 'dashboard': case 'web': case 'panel': return cmdLink(guild, userId);
    case 'help': case 'commands': case 'h': return { embeds: [helpText()] };
    case 'admin': case 'adminhelp': {
      if (!ADMIN_IDS.has(userId)) return { content: '⛔ This command is **admin-only**.' };
      const sub = (arg || '').trim().split(/\s+/)[0].toLowerCase();
      if (['activate', 'active', 'on', 'enable'].includes(sub)) return cmdServerActivation(guild, 'on');
      if (['deactivate', 'off', 'disable'].includes(sub)) return cmdServerActivation(guild, 'off');
      if (['servers', 'active-list', 'activelist'].includes(sub)) return cmdServerActivation(guild, 'list');
      return { embeds: [adminHelpText()] };
    }
    case 'activate': case 'deactivate': {
      if (!ADMIN_IDS.has(userId)) return { content: '⛔ This command is **admin-only**.' };
      return cmdServerActivation(guild, name === 'activate' ? 'on' : 'off');
    }
    case 'blacklist': case 'blocklist': case 'bl':
      if (!ADMIN_IDS.has(userId)) return { content: '⛔ This command is **admin-only**.' };
      return cmdBlacklist(arg, by);
    case 'block': case 'ban':
      if (!ADMIN_IDS.has(userId)) return { content: '⛔ This command is **admin-only**.' };
      return cmdBlacklist(`add ${arg}`, by);
    case 'unblock': case 'unban':
      if (!ADMIN_IDS.has(userId)) return { content: '⛔ This command is **admin-only**.' };
      return cmdBlacklist(`remove ${arg}`, by);
    case 'access': case 'dashaccess':
      if (!ADMIN_IDS.has(userId)) return { content: '⛔ This command is **admin-only**.' };
      return cmdAccess(arg, by);
    case 'grant':
      if (!ADMIN_IDS.has(userId)) return { content: '⛔ This command is **admin-only**.' };
      return cmdAccess(`add ${arg}`, by);
    case 'revoke':
      if (!ADMIN_IDS.has(userId)) return { content: '⛔ This command is **admin-only**.' };
      return cmdAccess(`remove ${arg}`, by);
    case 'rotatetoken': case 'rotate': case 'newtoken':
      if (!ADMIN_IDS.has(userId)) return { content: '⛔ This command is **admin-only**.' };
      return cmdRotateToken(guild, userId);
    default: return null;
  }
}
async function searchMultiplePreview(query) {
  if (!query) return { content: `❌ \`${PREFIX} search <query>\`` };
  const info = await ytDlpJson([`ytsearch5:${query}`, '--dump-json', '--no-download', '--flat-playlist']).catch(() => null);
  const entries = Array.isArray(info) ? info : (info?.entries || (info ? [info] : []));
  if (!entries.length) return { content: '❌ No results.' };
  const list = entries.slice(0, 5).map((e, i) => `**${i + 1}.** [${e.title}](https://youtu.be/${e.id}) \`(${fmt(e.duration)})\``).join('\n');
  return { embeds: [new EmbedBuilder().setColor(0x1DB954).setTitle(`🔍 ${query}`).setDescription(list).setFooter({ text: `${PREFIX} play <name or link> to add` })] };
}

/* ============================ discord client ============================ */
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.MessageContent] });

const slashCommands = [
  new SlashCommandBuilder().setName('play').setDescription('Play a song / link / playlist').addStringOption(o => o.setName('query').setDescription('song, YouTube/Spotify/Apple Music link').setRequired(true)),
  new SlashCommandBuilder().setName('playnext').setDescription('Play a song right after the current one').addStringOption(o => o.setName('query').setDescription('song or link').setRequired(true)),
  new SlashCommandBuilder().setName('remove').setDescription('Remove a song from the queue').addIntegerOption(o => o.setName('position').setDescription('queue # (see /queue)').setRequired(true)),
  new SlashCommandBuilder().setName('move').setDescription('Move a queued song to another position').addIntegerOption(o => o.setName('from').setDescription('from #').setRequired(true)).addIntegerOption(o => o.setName('to').setDescription('to #').setRequired(true)),
  new SlashCommandBuilder().setName('jump').setDescription('Skip ahead to a queue position').addIntegerOption(o => o.setName('position').setDescription('queue #').setRequired(true)),
  new SlashCommandBuilder().setName('sponsorblock').setDescription('Toggle skipping non-music/sponsor segments'),
  new SlashCommandBuilder().setName('lyrics').setDescription('Lyrics for the current song (or a query)').addStringOption(o => o.setName('query').setDescription('artist - title (optional)')),
  new SlashCommandBuilder().setName('skip').setDescription('Skip'), new SlashCommandBuilder().setName('back').setDescription('Previous song'),
  new SlashCommandBuilder().setName('stop').setDescription('Stop & clear'), new SlashCommandBuilder().setName('pause').setDescription('Pause'),
  new SlashCommandBuilder().setName('resume').setDescription('Resume'), new SlashCommandBuilder().setName('queue').setDescription('Show queue'),
  new SlashCommandBuilder().setName('np').setDescription('Now playing'), new SlashCommandBuilder().setName('shuffle').setDescription('Shuffle'),
  new SlashCommandBuilder().setName('loop').setDescription('Toggle loop'), new SlashCommandBuilder().setName('leave').setDescription('Leave VC'),
  new SlashCommandBuilder().setName('seek').setDescription('Seek to time').addStringOption(o => o.setName('time').setDescription('1:30 or seconds').setRequired(true)),
  new SlashCommandBuilder().setName('volume').setDescription('Set volume (0–200%)').addIntegerOption(o => o.setName('percent').setDescription('0–200').setRequired(true)),
  new SlashCommandBuilder().setName('autoplay').setDescription('Autoplay when the queue ends (toggle, or pick a mode)').addStringOption(o => o.setName('mode').setDescription('mix = diverse · artist = stay close').addChoices({ name: 'mix (diverse)', value: 'mix' }, { name: 'artist (stay close)', value: 'artist' })),
  new SlashCommandBuilder().setName('filter').setDescription('Audio filter / EQ').addStringOption(o => o.setName('name').setDescription('bassboost, nightcore, 8d, none…').setRequired(true).addChoices(...Object.keys(FILTERS).map(k => ({ name: k, value: k })))),
  new SlashCommandBuilder().setName('like').setDescription('Favorite the current song'),
  new SlashCommandBuilder().setName('favorites').setDescription('Show or play your favorites').addStringOption(o => o.setName('arg').setDescription('"play" to queue them')),
  new SlashCommandBuilder().setName('history').setDescription('Recent songs (or "play N" to replay)').addStringOption(o => o.setName('arg').setDescription('e.g. "play 100"')),
  new SlashCommandBuilder().setName('link').setDescription('DM me the web dashboard link'),
  new SlashCommandBuilder().setName('help').setDescription('Show commands'),
];

/* ============================ web dashboard controller ============================ */
// The dashboard runs in-process, so it drives the same cmd* functions the Discord
// commands use. All queue mutations therefore behave identically in both places.
function dashGuild() {
  for (const [gid] of queues) { const g = client.guilds.cache.get(gid); if (g) return g; } // prefer an active queue
  return client.guilds.cache.first() || null;
}
// The web dashboard can target a specific server; fall back to the auto-picked
// one when no (or an unknown) guildId is supplied.
function resolveDashGuild(guildId) {
  if (guildId) { const g = client.guilds.cache.get(guildId); if (g) return g; }
  return dashGuild();
}
// Every server the bot is in, for the dashboard's server-picker — active
// (has a queue) and currently-playing ones sorted first.
function dashGuildList() {
  return [...client.guilds.cache.values()]
    .map(g => { const q = queues.get(g.id); return { id: g.id, name: g.name, active: !!q, playing: !!q?.playing }; })
    .sort((a, b) => (b.playing - a.playing) || (b.active - a.active) || a.name.localeCompare(b.name));
}
function dashVoiceChannel(guild) {
  const mine = guild.members.me?.voice?.channel; // reuse the channel the bot is already in
  if (mine) return mine;
  let best = null, bestN = -1;               // else the busiest voice channel with humans in it
  for (const ch of guild.channels.cache.values()) {
    if (typeof ch.isVoiceBased === 'function' && ch.isVoiceBased()) {
      const n = ch.members.filter(m => !m.user.bot).size;
      if (n > bestN) { bestN = n; best = ch; }
    }
  }
  return bestN > 0 ? best : null;
}
function dashState(guildId) {
  const guild = resolveDashGuild(guildId);
  const guilds = dashGuildList();
  const q = guild ? queues.get(guild.id) : null;
  if (!guild) return { connected: false, error: 'Bot is not in any server.', guilds, guildId: null };
  if (!q) return { connected: false, guildName: guild.name, queue: [], history: lib.getHistory(guild.id, 30), guilds, guildId: guild.id };
  const cur = q.current;
  const queue = q.songs.slice(1).map((s, i) => ({
    pos: i + 1, title: s.title, uploader: s.uploader || null,
    duration: s.duration && s.duration !== '???' ? s.duration : (s.durationSec ? null : null),
    durationSec: s.durationSec || 0, url: s.url || null, by: s.by || null, pending: !!s.needsResolve,
  }));
  let history = lib.getHistory(guild.id, 31);
  if (cur && history[0] && history[0].url === cur.url) history = history.slice(1); // top of history is the current song
  return {
    connected: !!q.connection, guildName: guild.name, guilds, guildId: guild.id,
    playing: !!q.playing, paused: !!q.paused, loop: !!q.loop,
    autoplay: !!q.autoplay, autoplayMode: q.autoplayMode || 'mix',
    volume: Math.round((q.volume ?? 1) * 100),
    position: q.playing ? currentPosition(q) : 0,
    current: cur ? { title: cur.title, uploader: cur.uploader || null, duration: cur.duration || null, durationSec: cur.durationSec || 0, url: cur.url || null, by: cur.by || null } : null,
    queue, history: history.slice(0, 30),
  };
}
const dashController = {
  getState: dashState,
  listGuilds: dashGuildList,
  async add(query, { next = false, guildId } = {}) {
    if (!query || !query.trim()) return { ok: false, error: 'Enter a song name or link.' };
    const g = resolveDashGuild(guildId); if (!g) return { ok: false, error: 'Bot is not in any server.' };
    if (!lib.isGuildActive(g.id)) return { ok: false, error: `${g.name} isn't activated for playback — an admin must run "${PREFIX} admin activate" there.` };
    const vc = dashVoiceChannel(g);
    if (!vc) return { ok: false, error: 'Join a voice channel first (nobody is in one for the bot to play in).' };
    const q0 = queues.get(g.id);
    const res = await (next ? cmdPlayNext : cmdPlay)(g, vc, q0?.textChannel, 'dashboard 🖥️', query.trim());
    return { ok: true, message: res?.content };
  },
  skip(guildId)    { const g = resolveDashGuild(guildId); return g ? (cmdSkip(g), { ok: true }) : { ok: false, error: 'No server' }; },
  back(guildId)    { const g = resolveDashGuild(guildId); return g ? (cmdBack(g), { ok: true }) : { ok: false, error: 'No server' }; },
  shuffle(guildId) { const g = resolveDashGuild(guildId); return g ? (cmdShuffle(g), { ok: true }) : { ok: false, error: 'No server' }; },
  loop(guildId)    { const g = resolveDashGuild(guildId); return g ? (cmdLoop(g), { ok: true }) : { ok: false, error: 'No server' }; },
  autoplay(guildId){ const g = resolveDashGuild(guildId); return g ? (cmdAutoplay(g, ''), { ok: true }) : { ok: false, error: 'No server' }; },
  togglePause(guildId) { const g = resolveDashGuild(guildId); if (!g) return { ok: false, error: 'No server' }; const q = queues.get(g.id); if (!q?.playing) return { ok: false, error: 'Nothing playing.' }; q.paused ? cmdResume(g) : cmdPause(g); return { ok: true }; },
  volume(v, guildId) { const g = resolveDashGuild(guildId); return g ? (cmdVolume(g, String(v)), { ok: true }) : { ok: false, error: 'No server' }; },
  remove(pos, guildId) { const g = resolveDashGuild(guildId); return g ? (cmdRemove(g, String(pos)), { ok: true }) : { ok: false, error: 'No server' }; },
  move(from, to, guildId) { const g = resolveDashGuild(guildId); return g ? (cmdMove(g, `${from} ${to}`), { ok: true }) : { ok: false, error: 'No server' }; },
  jump(pos, guildId) { const g = resolveDashGuild(guildId); return g ? (cmdJump(g, String(pos)), { ok: true }) : { ok: false, error: 'No server' }; },
  // Everyone's favorites, grouped by user with a friendly name resolved from Discord.
  async favorites() {
    const all = lib.getAllFavorites();
    const out = [];
    for (const [userId, songs] of Object.entries(all)) {
      if (!songs || !songs.length) continue;
      let name = userId;
      try { const u = client.users.cache.get(userId) || await client.users.fetch(userId); name = u.globalName || u.username || u.tag || userId; } catch {}
      out.push({ userId, name, songs: songs.map(s => ({ title: s.title, uploader: s.uploader || null, duration: s.duration || null, url: s.url || null })) });
    }
    return out;
  },
  // Queue every favorite of a given user into the selected server.
  async playFavorites(userId, { guildId } = {}) {
    if (!userId) return { ok: false, error: 'No user.' };
    const g = resolveDashGuild(guildId); if (!g) return { ok: false, error: 'Bot is not in any server.' };
    if (!lib.isGuildActive(g.id)) return { ok: false, error: `${g.name} isn't activated for playback — an admin must run "${PREFIX} admin activate" there.` };
    const vc = dashVoiceChannel(g);
    if (!vc) return { ok: false, error: 'Join a voice channel first (nobody is in one for the bot to play in).' };
    const q0 = queues.get(g.id);
    const res = cmdFavorites(g, vc, q0?.textChannel, userId, 'dashboard 🖥️', 'play');
    return { ok: true, message: res?.content };
  },
};

client.once('clientReady', async () => {
  console.log(`🎵 Music bot ready as ${client.user.tag}`);
  console.log(`📡 Guilds: ${client.guilds.cache.size} · prefix "${PREFIX}"`);
  console.log(`[boot] ffmpeg=${FFMPEG} yt-dlp=${YT_DLP} proxy=${YT_PROXY || '(none)'} dl_timeout=${DL_TIMEOUT_MS / 1000}s`);
  // First run: grandfather every server the bot is already in, so existing
  // servers keep working. New servers must be activated with `67 admin activate`.
  if (!lib.activeGuildsFileExists()) {
    for (const g of client.guilds.cache.values()) lib.activateGuild(g.id, g.name);
    console.log(`🔐 Seeded ${client.guilds.cache.size} existing server(s) as activated.`);
  }
  startDashboard(parseInt(process.env.DASHBOARD_PORT || '3000'), dashController);
  try { await new REST({ version: '10' }).setToken(TOKEN).put(Routes.applicationCommands(client.user.id), { body: slashCommands }); console.log('✅ Slash commands registered'); }
  catch (e) { console.error('❌ slash register:', e.message); }
  const t0 = Date.now();
  setInterval(() => {
    const e = Math.floor((Date.now() - t0) / 1000); const uptime = e > 3600 ? `${Math.floor(e / 3600)}h ${Math.floor(e % 3600 / 60)}m` : e > 60 ? `${Math.floor(e / 60)}m ${e % 60}s` : `${e}s`;
    const qd = {}; for (const [g, q] of queues) qd[g] = { playing: q.playing, current: q.current?.title || null, songs: q.songs.length };
    updateStatus({ uptime, guilds: client.guilds.cache.size, queues: qd });
    updatePresence();
  }, 3000);
  // Live progress bar: refresh each active panel in place every 10s (no new messages).
  setInterval(() => {
    for (const [, q] of queues) {
      if (q.playing && !q.paused && q.current && q.npMessage) showNowPlaying(q, { relocate: false });
    }
  }, 10000);
  // Hourly heartbeat into the service log so a week of history shows liveness even when idle.
  const heartbeat = () => {
    let playing = 0, queued = 0;
    for (const [, q] of queues) {
      if (q.playing && q.current) playing++;
      queued += q.songs?.length || 0;
    }
    const e = Math.floor((Date.now() - t0) / 1000);
    const uptime = e > 3600 ? `${Math.floor(e / 3600)}h${Math.floor((e % 3600) / 60)}m` : `${Math.floor(e / 60)}m`;
    console.log(`[heartbeat] up=${uptime} guilds=${client.guilds.cache.size} ping=${client.ws.ping}ms playing=${playing} queued=${queued} ws=${client.ws.status}`);
  };
  heartbeat();
  setInterval(heartbeat, 60 * 60 * 1000);
});

async function reply(target, res) {
  if (!res) return;
  const payload = { content: res.content, embeds: res.embeds, components: res.components };
  Object.keys(payload).forEach(k => payload[k] === undefined && delete payload[k]);
  if (target.deferred || target.replied) return target.editReply(payload);
  if (target.isMessage) return target.channel.send(payload);
  return target.reply(payload);
}

// prefix commands: "67 <cmd> <args>"
client.on('messageCreate', async (msg) => {
  if (msg.author.bot || !msg.guild) return;
  const re = new RegExp(`^\\s*${PREFIX}\\b[\\s,:]*([\\s\\S]*)`, 'i');
  const m = msg.content.match(re);
  if (!m) return;
  if (lib.isBlacklisted(msg.author.id) && !ADMIN_IDS.has(msg.author.id)) {
    return msg.reply('⛔ You have been blocked from using this bot.').catch(() => {});
  }
  const rest = m[1].trim();
  if (!rest) { return reply({ isMessage: true, channel: msg.channel }, { embeds: [helpText()] }); }
  const sp = rest.indexOf(' ');
  const name = (sp === -1 ? rest : rest.slice(0, sp)).toLowerCase();
  const arg = sp === -1 ? '' : rest.slice(sp + 1).trim();
  const ctx = { guild: msg.guild, voiceChannel: msg.member?.voice?.channel, textChannel: msg.channel, by: msg.author.tag, userId: msg.author.id };
  let working;
  try {
    if (['play', 'p', 'add', 'playnext', 'pn', 'insert', 'search', 'find', 'lyrics', 'ly', 'lyric'].includes(name)) working = await msg.channel.send('🔎 working…');
    const res = await dispatch(name, arg, ctx);
    if (res === null) { if (working) working.edit(`❓ unknown command — \`${PREFIX} help\``); return; }
    if (res._silent) { if (working) working.delete().catch(() => {}); return; }
    if (working) await working.edit({ content: res.content || null, embeds: res.embeds || [], components: res.components || [] });
    else await reply({ isMessage: true, channel: msg.channel }, res);
  } catch (e) { console.error('prefix cmd error:', e); const t = `❌ ${e.message}`; if (working) working.edit(t).catch(() => {}); else msg.channel.send(t).catch(() => {}); }
});

// slash
client.on('interactionCreate', async (i) => {
  try {
    if (i.user?.id && lib.isBlacklisted(i.user.id) && !ADMIN_IDS.has(i.user.id)) {
      if (i.isRepliable?.()) await i.reply({ content: '⛔ You have been blocked from using this bot.', flags: MessageFlags.Ephemeral }).catch(() => {});
      return;
    }
    if (i.isChatInputCommand()) {
      const ctx = { guild: i.guild, voiceChannel: i.member?.voice?.channel, textChannel: i.channel, by: i.user.tag, userId: i.user.id };
      const name = i.commandName;
      const pct = i.options.getInteger?.('percent');
      const pos = i.options.getInteger?.('position');
      const mvFrom = i.options.getInteger?.('from'); const mvTo = i.options.getInteger?.('to');
      let arg = i.options.getString('query') || i.options.getString('time') || i.options.getString('arg') || i.options.getString('name') || i.options.getString('mode') || '';
      if (!arg && pct != null) arg = String(pct);
      if (!arg && pos != null) arg = String(pos);
      if (!arg && mvFrom != null && mvTo != null) arg = `${mvFrom} ${mvTo}`;
      if (['play', 'playnext', 'search', 'history', 'lyrics'].includes(name)) await i.deferReply();
      const res = await dispatch(name, arg, ctx);
      if (res?._silent) { if (i.deferred) await i.deleteReply().catch(() => {}); else await i.reply({ content: '🎵 Panel updated below.', flags: MessageFlags.Ephemeral }).catch(() => {}); return; }
      await reply(i, res || { content: '❓ unknown command' });
    } else if (i.isButton() && i.customId.startsWith('m_')) {
      const guild = i.guild;
      const q = getQueue(guild.id);
      // 📋 Queue / ⭐ Like — private replies that leave the panel untouched.
      if (i.customId === 'm_queue') {
        const r = cmdQueue(guild);
        await i.reply({ content: r.content || null, embeds: r.embeds || [], flags: MessageFlags.Ephemeral }).catch(() => {});
        return;
      }
      if (i.customId === 'm_like') {
        const r = cmdLike(guild, i.user.id);
        await i.reply({ content: r.content, flags: MessageFlags.Ephemeral }).catch(() => {});
        return;
      }
      let relocate = false, stopped = false;
      switch (i.customId) {
        case 'm_skip': cmdSkip(guild); relocate = true; break;
        case 'm_back': cmdBack(guild); relocate = true; break;
        case 'm_stop': cmdStop(guild); stopped = true; break;
        case 'm_loop': cmdLoop(guild); break;
        case 'm_shuffle': cmdShuffle(guild); break;
        case 'm_back15': cmdSeekRel(guild, -15); break;
        case 'm_fwd15': cmdSeekRel(guild, 15); break;
        case 'm_voldown': cmdVolRel(guild, -10); break;
        case 'm_volup': cmdVolRel(guild, 10); break;
        case 'm_autoplay': // cycle: off → mix → artist → off
          if (!q.autoplay) { q.autoplay = true; q.autoplayMode = 'mix'; }
          else if (q.autoplayMode !== 'artist') { q.autoplayMode = 'artist'; }
          else { q.autoplay = false; }
          break;
        case 'm_pauseresume': q.paused ? cmdResume(guild) : cmdPause(guild); break;
      }
      if (stopped) {
        q.npMessage = null;
        await i.update({ embeds: [new EmbedBuilder().setColor(0x555555).setTitle('⏹️ Stopped').setDescription('Queue cleared.')], components: [] }).catch(() => {});
      } else if (relocate) {
        // skip/back start a new song; playSong reposts the panel at the bottom — just ack the click
        await i.deferUpdate().catch(() => {});
      } else {
        // pause / resume / loop / shuffle / seek / volume / autoplay: refresh THIS panel in place
        q.npMessage = i.message;
        await i.update({ embeds: [nowPlayingEmbed(q)], components: controlRows(q) }).catch(() => {});
      }
    } else if (i.isStringSelectMenu() && i.customId === 'm_filter') {
      // 🎚️ Filter dropdown — apply and refresh the panel in place.
      const q = getQueue(i.guild.id);
      cmdFilter(i.guild, i.values?.[0] || 'none');
      q.npMessage = i.message;
      await i.update({ embeds: [nowPlayingEmbed(q)], components: controlRows(q) }).catch(() => {});
    }
  } catch (e) { console.error('interaction error:', e); try { if (i.deferred) await i.editReply(`❌ ${e.message}`); else if (!i.replied) await i.reply({ content: `❌ ${e.message}`, flags: MessageFlags.Ephemeral }); } catch {} }
});

// Auto-disconnect when the bot is left alone in the voice channel.
client.on('voiceStateUpdate', (oldS, newS) => {
  const guild = (oldS || newS).guild;
  const q = queues.get(guild.id);
  if (!q || !q.connection) return;
  const channelId = q.connection.joinConfig?.channelId;
  const vc = guild.channels.cache.get(channelId);
  if (!vc) return;
  const humans = vc.members.filter(m => !m.user.bot).size;
  if (humans === 0) scheduleLeave(guild.id, 'alone', ALONE_LEAVE_MS);
  else clearLeave(q); // someone (re)joined — cancel the pending leave
});

// Surface Discord gateway issues in the service log (helps post-mortem after outages).
client.on('error', (e) => console.error(`[discord] client error: ${e?.message || e}`));
client.on('warn', (m) => console.warn(`[discord] warn: ${m}`));
client.on('shardDisconnect', (event, id) => console.warn(`[discord] shard ${id} disconnected code=${event?.code} reason=${event?.reason || ''}`));
client.on('shardReconnecting', (id) => console.warn(`[discord] shard ${id} reconnecting…`));
client.on('shardResume', (id) => console.log(`[discord] shard ${id} resumed`));
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e?.stack || e));
process.on('uncaughtException', (e) => console.error('[uncaughtException]', e?.stack || e));

client.login(TOKEN);
