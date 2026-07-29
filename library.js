// library.js — persistent play history + saved playlists for the music bot.
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HISTORY_FILE = join(__dirname, 'history.json');
const PLAYLISTS_FILE = join(__dirname, 'playlists.json');
const FAVORITES_FILE = join(__dirname, 'favorites.json');
const BLACKLIST_FILE = join(__dirname, 'blacklist.json');
const DASH_ACCESS_FILE = join(__dirname, 'dashboard-access.json');
const ACTIVE_GUILDS_FILE = join(__dirname, 'active-servers.json');
const HISTORY_MAX = 1000; // keep the last 1000 plays

function load(file, fallback) {
  try { return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : fallback; }
  catch { return fallback; }
}
function save(file, data) {
  try { writeFileSync(file, JSON.stringify(data, null, 2)); } catch (e) { console.error('library save failed:', e.message); }
}

/* ---------- history (per guild) ---------- */
// shape: { [guildId]: [ {title,url,uploader,duration,by,at}, ... newest last ] }
export function addHistory(guildId, song, by) {
  const h = load(HISTORY_FILE, {});
  h[guildId] = h[guildId] || [];
  h[guildId].push({ title: song.title, url: song.url, uploader: song.uploader || null, duration: song.duration || '???', by: by || null, at: Date.now() });
  if (h[guildId].length > HISTORY_MAX) h[guildId] = h[guildId].slice(-HISTORY_MAX);
  save(HISTORY_FILE, h);
}
// newest first, up to n
export function getHistory(guildId, n = 100) {
  const h = load(HISTORY_FILE, {});
  return (h[guildId] || []).slice(-n).reverse();
}
// oldest->newest list of the last n, as playable songs (for replay)
export function getLastSongs(guildId, n = 100) {
  const h = load(HISTORY_FILE, {});
  return (h[guildId] || []).slice(-n).map(x => ({ title: x.title, url: x.url, uploader: x.uploader, duration: x.duration }));
}
export function clearHistory(guildId) {
  const h = load(HISTORY_FILE, {});
  delete h[guildId];
  save(HISTORY_FILE, h);
}

/* ---------- saved playlists (per guild, named) ---------- */
// shape: { [guildId]: { [name]: [ {title,url,uploader,duration}, ... ] } }
export function savePlaylist(guildId, name, songs) {
  const p = load(PLAYLISTS_FILE, {});
  p[guildId] = p[guildId] || {};
  p[guildId][name.toLowerCase()] = songs.map(s => ({ title: s.title, url: s.url, uploader: s.uploader || null, duration: s.duration || '???' }));
  save(PLAYLISTS_FILE, p);
}
export function getPlaylist(guildId, name) {
  const p = load(PLAYLISTS_FILE, {});
  return (p[guildId] || {})[name.toLowerCase()] || null;
}
export function listPlaylists(guildId) {
  const p = load(PLAYLISTS_FILE, {});
  return Object.entries(p[guildId] || {}).map(([name, songs]) => ({ name, count: songs.length }));
}
export function deletePlaylist(guildId, name) {
  const p = load(PLAYLISTS_FILE, {});
  if (p[guildId]) { delete p[guildId][name.toLowerCase()]; save(PLAYLISTS_FILE, p); return true; }
  return false;
}

/* ---------- favorites (per user, global) ---------- */
// shape: { [userId]: [ {title,url,uploader,duration}, ... ] }
// toggles the song: returns 'added' or 'removed'
export function toggleFavorite(userId, song) {
  const f = load(FAVORITES_FILE, {});
  f[userId] = f[userId] || [];
  const i = f[userId].findIndex(s => s.url === song.url);
  if (i >= 0) { f[userId].splice(i, 1); save(FAVORITES_FILE, f); return 'removed'; }
  f[userId].push({ title: song.title, url: song.url, uploader: song.uploader || null, duration: song.duration || '???' });
  save(FAVORITES_FILE, f);
  return 'added';
}
export function getFavorites(userId) {
  const f = load(FAVORITES_FILE, {});
  return f[userId] || [];
}
// { [userId]: [songs] } — everyone's favorites, for the dashboard panel.
export function getAllFavorites() {
  return load(FAVORITES_FILE, {});
}

/* ---------- blacklist (global, revokes all bot access) ---------- */
// shape: { [userId]: { tag, by, at } }
export function isBlacklisted(userId) {
  const b = load(BLACKLIST_FILE, {});
  return Object.prototype.hasOwnProperty.call(b, userId);
}
// returns true if newly added, false if it was already there
export function addBlacklist(userId, tag, by) {
  const b = load(BLACKLIST_FILE, {});
  const existed = Object.prototype.hasOwnProperty.call(b, userId);
  b[userId] = { tag: tag || null, by: by || null, at: Date.now() };
  save(BLACKLIST_FILE, b);
  return !existed;
}
// returns true if it was removed, false if it wasn't blacklisted
export function removeBlacklist(userId) {
  const b = load(BLACKLIST_FILE, {});
  if (!Object.prototype.hasOwnProperty.call(b, userId)) return false;
  delete b[userId];
  save(BLACKLIST_FILE, b);
  return true;
}
// [ { id, tag, by, at }, ... ]
export function listBlacklist() {
  const b = load(BLACKLIST_FILE, {});
  return Object.entries(b).map(([id, v]) => ({ id, ...v }));
}

/* ---------- dashboard access allowlist (who may fetch the web link) ---------- */
// shape: { [userId]: { tag, by, at } }. Admins are always allowed (checked in bot).
export function isDashAllowed(userId) {
  const a = load(DASH_ACCESS_FILE, {});
  return Object.prototype.hasOwnProperty.call(a, userId);
}
// returns true if newly granted, false if they already had access
export function addDashAccess(userId, tag, by) {
  const a = load(DASH_ACCESS_FILE, {});
  const existed = Object.prototype.hasOwnProperty.call(a, userId);
  a[userId] = { tag: tag || null, by: by || null, at: Date.now() };
  save(DASH_ACCESS_FILE, a);
  return !existed;
}
// returns true if revoked, false if they didn't have access
export function removeDashAccess(userId) {
  const a = load(DASH_ACCESS_FILE, {});
  if (!Object.prototype.hasOwnProperty.call(a, userId)) return false;
  delete a[userId];
  save(DASH_ACCESS_FILE, a);
  return true;
}
// [ { id, tag, by, at }, ... ]
export function listDashAccess() {
  const a = load(DASH_ACCESS_FILE, {});
  return Object.entries(a).map(([id, v]) => ({ id, ...v }));
}

/* ---------- activated servers (bot may only play in these) ---------- */
// shape: { [guildId]: { name, at } }
export function isGuildActive(guildId) {
  const a = load(ACTIVE_GUILDS_FILE, {});
  return Object.prototype.hasOwnProperty.call(a, guildId);
}
// returns true if newly activated, false if it was already active
export function activateGuild(guildId, name) {
  const a = load(ACTIVE_GUILDS_FILE, {});
  const existed = Object.prototype.hasOwnProperty.call(a, guildId);
  a[guildId] = { name: name || null, at: Date.now() };
  save(ACTIVE_GUILDS_FILE, a);
  return !existed;
}
// returns true if deactivated, false if it wasn't active
export function deactivateGuild(guildId) {
  const a = load(ACTIVE_GUILDS_FILE, {});
  if (!Object.prototype.hasOwnProperty.call(a, guildId)) return false;
  delete a[guildId];
  save(ACTIVE_GUILDS_FILE, a);
  return true;
}
// [ { id, name, at }, ... ]
export function listActiveGuilds() {
  const a = load(ACTIVE_GUILDS_FILE, {});
  return Object.entries(a).map(([id, v]) => ({ id, ...v }));
}
// Has the allowlist ever been initialized? Used to grandfather existing servers on first run.
export function activeGuildsFileExists() {
  return existsSync(ACTIVE_GUILDS_FILE);
}
