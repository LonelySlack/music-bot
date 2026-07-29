// sources.js — resolve YouTube playlists and Spotify links into playable items / search queries.
import { execFile } from 'child_process';
import { promisify } from 'util';
import https from 'https';

const execFileAsync = promisify(execFile);
const YT_DLP = process.env.YT_DLP_PATH || '/home/lonelyslack/bin/yt-dlp';
// Route yt-dlp through Cloudflare WARP (SOCKS proxy) — see bot.js for why.
// Override/disable with YT_DLP_PROXY (empty string = go direct).
const YT_PROXY = process.env.YT_DLP_PROXY ?? 'socks5://127.0.0.1:40000';
const YT_ARGS = ['--js-runtimes', 'node', ...(YT_PROXY ? ['--proxy', YT_PROXY] : [])];

function fmt(s) {
  if (!s || isNaN(s)) return '???';
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = Math.floor(s % 60);
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}` : `${m}:${String(x).padStart(2, '0')}`;
}

export function detectSource(input) {
  if (/open\.spotify\.com|spotify:/i.test(input)) return 'spotify';
  if (/music\.apple\.com/i.test(input)) return 'apple';
  if (/[?&]list=|youtube\.com\/playlist/i.test(input)) return 'youtube-playlist';
  if (/^https?:\/\//i.test(input)) return 'url';
  return 'search';
}

export async function getYoutubePlaylist(url) {
  const { stdout } = await execFileAsync(
    YT_DLP, [...YT_ARGS, url, '--yes-playlist', '--flat-playlist', '--dump-json', '--no-download'],
    { timeout: 90000, maxBuffer: 1024 * 1024 * 128 }
  );
  return stdout.trim().split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
    .map(e => ({
      url: e.url || `https://www.youtube.com/watch?v=${e.id}`,
      title: e.title || 'Unknown',
      uploader: e.uploader || e.channel || null,
      duration: fmt(e.duration),
      durationSec: e.duration || 0,
    }));
}

// normalized artist key from an uploader/channel ("BeeGeesVEVO", "Bee Gees - Topic" → "beegees")
const artistKey = u => (u || '').toLowerCase().replace(/vevo|official|topic|music|records|channel/g, '').replace(/[^a-z0-9]/g, '');
// Autoplay guard: YouTube's Mix falls back to generic kids/nursery content when the seed
// has a weak/empty Mix (common for niche artists on a fresh datacenter IP). Left unchecked,
// one nursery-rhyme pick becomes the next seed and the whole autoplay spirals into CoComelon.
// Drop obvious kids content so that can't happen.
const KIDS_JUNK_RE = /nursery rhymes?|kids?\s+songs?|songs?\s+for\s+kids|for children|for babies|cocomelon|little baby bum|super simple songs|learning\s+(colou?rs|numbers|shapes|abcs?)|baby shark|lullab(y|ies)|abc songs?|phonics|preschool|toddler|counting song/i;
const isKidsJunk = s => KIDS_JUNK_RE.test(`${s.title || ''} ${s.uploader || ''}`);
// Autoplay/radio: given a seed YouTube url, fetch its "Mix" (RD<id> auto-playlist)
// and return one related song we haven't played yet. Returns null if it can't.
//   opts.mode: 'mix' (default) = diverse, drifts across related artists;
//              'artist' = stay close to the seed artist.
//   opts.seedArtist: the current song's uploader, used to avoid repeating it in 'mix'.
export async function getRadioSong(seedUrl, excludeUrls = [], opts = {}) {
  const idm = (seedUrl || '').match(/(?:v=|youtu\.be\/|\/watch\?v=)([A-Za-z0-9_-]{11})/);
  if (!idm) return null;
  const id = idm[1];
  const mix = `https://www.youtube.com/watch?v=${id}&list=RD${id}`;
  // pull a deeper slice (50) so 'mix' mode has room to find different artists
  const { stdout } = await execFileAsync(
    YT_DLP, [...YT_ARGS, mix, '--flat-playlist', '--dump-json', '--no-download', '--playlist-end', '50'],
    { timeout: 60000, maxBuffer: 1024 * 1024 * 64 }
  ).catch(() => ({ stdout: '' }));
  let items = stdout.trim().split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
    .map(e => ({
      url: e.url || `https://www.youtube.com/watch?v=${e.id}`,
      title: e.title || 'Unknown',
      uploader: e.uploader || e.channel || null,
      duration: fmt(e.duration),
      durationSec: e.duration || 0,
    }));
  const exclude = new Set(excludeUrls);
  items = items.filter(s => s.url && !s.url.includes(id) && !exclude.has(s.url) && !isKidsJunk(s));
  if (!items.length) return null;

  if ((opts.mode || 'mix') === 'artist') {
    // stay close: the top of the Mix is the most similar / same-artist
    return items[Math.floor(Math.random() * Math.min(items.length, 6))];
  }
  // diverse 'mix': drop tracks by the seed's own artist, then pick from the whole pool
  const seedKey = artistKey(opts.seedArtist).slice(0, 14);
  let pool = items;
  if (seedKey) {
    const others = items.filter(s => { const k = artistKey(s.uploader); return k && !(k.includes(seedKey) || seedKey.includes(k)); });
    if (others.length >= 3) pool = others;
  }
  // de-duplicate by artist so one artist can't dominate the random pick, then choose
  const seen = new Set();
  const spread = pool.filter(s => { const k = artistKey(s.uploader) || s.url; if (seen.has(k)) return false; seen.add(k); return true; });
  const choices = spread.length >= 3 ? spread : pool;
  return choices[Math.floor(Math.random() * choices.length)];
}

/* ---------- lyrics (lyrics.ovh, free/no-key) ---------- */
// Clean a YouTube-ish title down to something a lyrics API can match.
function cleanTitle(t) {
  return (t || '')
    .replace(/\([^)]*\)|\[[^\]]*\]|\{[^}]*\}/g, ' ')               // (Official Video), [HD], etc.
    .replace(/\b(official|lyric[s]?|video|audio|mv|m\/v|hd|hq|4k|visualizer|performance|live)\b/ig, ' ')
    .replace(/ft\.?\s.*$/i, ' ').replace(/feat\.?\s.*$/i, ' ')      // drop "ft. ..."
    .replace(/[|"]/g, ' ').replace(/\s+/g, ' ').trim();
}
function parseArtistTitle(raw, uploader) {
  const cleaned = cleanTitle(raw);
  if (cleaned.includes(' - ')) { const [a, ...rest] = cleaned.split(' - '); return { artist: a.trim(), title: rest.join(' - ').trim() }; }
  return { artist: (uploader || '').replace(/\s*-?\s*Topic$/i, '').trim(), title: cleaned };
}
// lrclib.net search → best title match with lyrics. Strips [mm:ss.xx] tags if only synced lyrics exist.
function fetchLrclib(query, wantTitle) {
  return new Promise((resolve) => {
    const path = `/api/search?q=${encodeURIComponent(query)}`;
    const req = https.get({ hostname: 'lrclib.net', path, timeout: 12000, headers: { 'User-Agent': 'Music67 Discord bot' } }, res => {
      let b = ''; res.on('data', d => b += d);
      res.on('end', () => {
        try {
          const arr = (JSON.parse(b) || []).filter(x => x.plainLyrics || x.syncedLyrics);
          if (!arr.length) return resolve(null);
          const w = (wantTitle || '').toLowerCase().trim();
          const hit = arr.find(x => x.trackName?.toLowerCase() === w)         // exact title
                   || arr.find(x => w && x.trackName?.toLowerCase().includes(w)) // title contained
                   || arr[0];
          const lyrics = (hit.plainLyrics || hit.syncedLyrics.replace(/\[\d+:\d+(\.\d+)?\]\s?/g, '')).replace(/\r\n/g, '\n').trim();
          resolve(lyrics ? { artist: hit.artistName, title: hit.trackName, lyrics } : null);
        } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}
// Fallback: lyrics.ovh (needs exact artist+title; flakier, used only if lrclib misses).
function fetchOvh(artist, title) {
  return new Promise((resolve) => {
    if (!artist || !title) return resolve(null);
    const req = https.get({ hostname: 'api.lyrics.ovh', path: `/v1/${encodeURIComponent(artist)}/${encodeURIComponent(title)}`, timeout: 10000 }, res => {
      let b = ''; res.on('data', d => b += d);
      res.on('end', () => { try { const j = JSON.parse(b); resolve(j.lyrics ? { artist, title, lyrics: j.lyrics.replace(/\r\n/g, '\n').trim() } : null); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}
// Returns { artist, title, lyrics } or null. Tries lrclib first, then lyrics.ovh.
export async function getLyrics(rawTitle, uploader) {
  const { artist, title } = parseArtistTitle(rawTitle, uploader);
  if (!title) return null;
  return (await fetchLrclib(`${artist} ${title}`.trim(), title))
      || (await fetchLrclib(title, title))
      || (await fetchOvh(artist, title));
}

/* ---------- Spotify (via public embed page — no API key / no Premium needed) ----------
   Spotify's Web API now returns 403 "Active premium subscription required for the owner
   of the app" for Development-mode apps, so the client-credentials flow is useless for us.
   Instead we read the public /embed page's __NEXT_DATA__ JSON, which carries the track name
   + artists (and, for albums/playlists, the whole track list). The bot only needs
   "artist - title" strings to search on YouTube. No auth, no Premium, no SPOTIFY_* keys. */
// Generic browser-UA HTTPS GET (follows redirects) — shared by the Spotify embed
// scrape, the Apple Music page scrape, and the iTunes Lookup API.
function httpGet(url, redirects = 3) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'en' }, timeout: 15000 }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume(); return resolve(httpGet(new URL(res.headers.location, url).href, redirects - 1));
      }
      let b = ''; res.on('data', d => b += d); res.on('end', () => resolve(b));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('request timed out')); });
  });
}
// pull "artist - title" out of an embed entity (track) or track-list item
function embedQuery(e) {
  const who = e.subtitle || (e.artists || []).map(a => a.name).join(', ');
  return `${who} - ${e.title || e.name}`.replace(/^\s*-\s*/, '').trim();
}
// returns an array of "artist - title" search queries (the bot then resolves each on YouTube)
export async function getSpotifyTracks(url) {
  const m = url.match(/(playlist|album|track)[/:]([A-Za-z0-9]+)/);
  if (!m) throw new Error('unrecognized Spotify URL');
  const [, type, sid] = m;
  const html = await httpGet(`https://open.spotify.com/embed/${type}/${sid}`);
  const jm = html.match(/<script id="__NEXT_DATA__" type="application\/json">(.*?)<\/script>/s);
  let entity;
  try { entity = JSON.parse(jm[1]).props.pageProps.state.data.entity; }
  catch { throw new Error('spotify: bad response'); }

  const out = [];
  if (type === 'track') {
    if (entity.name) out.push(embedQuery(entity));
  } else {
    for (const t of (entity.trackList || [])) if (t.title) out.push(embedQuery(t));
  }
  if (!out.length) throw new Error(type === 'playlist'
    ? "Couldn't read tracks from that Spotify playlist — try a track or album link, a YouTube playlist, or paste the song names and I'll queue them."
    : 'no tracks found in that Spotify link');
  return out;
}

/* ---------- Apple Music (public iTunes Lookup API + page scrape — no key/auth) ----------
   Apple Music URLs carry a numeric catalog id. Songs & albums resolve cleanly through the
   free, keyless iTunes Lookup API. Playlists (pl.* ids) aren't served by that API, so we
   scrape the public page's `serialized-server-data` JSON, which lists title + artistName
   per track. Like Spotify, we only produce "artist - title" strings to search on YouTube. */
function appleQuery(artist, title) {
  return `${artist || ''} - ${title || ''}`.replace(/^\s*-\s*/, '').replace(/\s*-\s*$/, '').trim();
}
async function itunesLookup(id, entity, country) {
  const params = new URLSearchParams({ id, country: country || 'us', limit: '200' });
  if (entity) params.set('entity', entity);
  const body = await httpGet(`https://itunes.apple.com/lookup?${params}`);
  try { return JSON.parse(body); } catch { throw new Error('apple: bad response from iTunes API'); }
}
// Scrape an Apple Music playlist page → [{ artist, title }, …] (server-data is the rich
// source with per-track artists; falls back to ld+json track names if it's ever missing).
async function scrapeApplePlaylist(url) {
  const html = await httpGet(url);
  const rows = [];
  const sm = html.match(/<script[^>]*id="serialized-server-data"[^>]*>([\s\S]*?)<\/script>/);
  if (sm) {
    let data; try { data = JSON.parse(sm[1]); } catch { data = null; }
    (function walk(o) {
      if (!o || typeof o !== 'object') return;
      if (Array.isArray(o)) { o.forEach(walk); return; }
      if (o.artistName && (o.title || o.name)) rows.push({ artist: o.artistName, title: o.title || o.name });
      for (const k in o) walk(o[k]);
    })(data);
  }
  if (!rows.length) {
    const jm = html.match(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/);
    if (jm) { try { for (const t of (JSON.parse(jm[1]).track || [])) if (t.name) rows.push({ artist: '', title: t.name }); } catch {} }
  }
  return rows;
}
// returns an array of "artist - title" search queries (the bot then resolves each on YouTube)
export async function getAppleMusicTracks(url) {
  // Song links are album URLs with ?i=<trackId>, or /song/<name>/<trackId>; plain album
  // links end in /<albumId>; playlists are /playlist/<name>/pl.<id>.
  const songId = (url.match(/[?&]i=(\d+)/) || url.match(/\/song\/[^/]*\/(\d+)/i) || [])[1];
  const albumId = (url.match(/\/album\/[^/]*\/(\d+)/i) || [])[1];
  const isPlaylist = /\/playlist\//i.test(url);
  const country = (url.match(/music\.apple\.com\/([a-z]{2})\//i) || [])[1] || 'us';
  const out = [];

  if (songId) {
    const t = ((await itunesLookup(songId, null, country)).results || []).find(r => r.wrapperType === 'track');
    if (t) out.push(appleQuery(t.artistName, t.trackName));
  } else if (albumId) {
    for (const t of ((await itunesLookup(albumId, 'song', country)).results || []))
      if (t.wrapperType === 'track' && t.trackName) out.push(appleQuery(t.artistName, t.trackName));
  } else if (isPlaylist) {
    for (const r of await scrapeApplePlaylist(url)) if (r.title) out.push(appleQuery(r.artist, r.title));
  } else {
    throw new Error('unrecognized Apple Music link — send a song, album, or playlist link');
  }

  if (!out.length) throw new Error(isPlaylist
    ? "Couldn't read tracks from that Apple Music playlist — try a song or album link, a YouTube playlist, or paste the song names and I'll queue them."
    : 'no tracks found in that Apple Music link');
  return out;
}
