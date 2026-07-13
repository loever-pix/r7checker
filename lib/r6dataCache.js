// r6data response cache. r6data limits by API key (not IP) so proxy doesn't help.
// Cache successful responses for 1 hour per userId — drops calls by ~99%.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CACHE_DIR = process.env.CACHE_DIR
  ? path.join(process.env.CACHE_DIR, 'r6data')
  : path.join(__dirname, '..', '.cache', 'r6data');
try { fs.mkdirSync(CACHE_DIR, { recursive: true }); } catch {}

const TTL_MS = 60 * 60 * 1000; // 1 hour

function keyOf(type, identifier) {
  return crypto.createHash('sha1')
    .update(`${type}:${identifier}`)
    .digest('hex').slice(0, 24);
}

function get(type, identifier) {
  const fp = path.join(CACHE_DIR, `${keyOf(type, identifier)}.json`);
  try {
    const stat = fs.statSync(fp);
    if (Date.now() - stat.mtimeMs > TTL_MS) return null;
    return JSON.parse(fs.readFileSync(fp, 'utf8'));
  } catch { return null; }
}

// Stale fallback — returns cached data regardless of age. Use as a last resort
// when every live rank source has failed or is rate-limited. Rank data within
// a single season is mostly static, so stale-by-a-day is far better than empty.
function getStale(type, identifier) {
  const fp = path.join(CACHE_DIR, `${keyOf(type, identifier)}.json`);
  try {
    const stat = fs.statSync(fp);
    const ageMs = Date.now() - stat.mtimeMs;
    const data = JSON.parse(fs.readFileSync(fp, 'utf8'));
    return { data, ageMs };
  } catch { return null; }
}

function set(type, identifier, data) {
  if (!data) return;
  const fp = path.join(CACHE_DIR, `${keyOf(type, identifier)}.json`);
  try {
    const tmp = fp + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, fp);
  } catch (e) { console.warn('[r6dataCache] save failed:', e.message); }
}

// ── Sliding-window cooldown gate ────────────────────────────────────────
// r6data resets the 429 timer on EVERY request. If we get a 429, we MUST stop
// asking entirely for `retryAfter` ms — otherwise we never escape the window.
let cooldownUntil = 0;
function isCoolingDown() { return Date.now() < cooldownUntil; }
function cooldownRemainingMs() { return Math.max(0, cooldownUntil - Date.now()); }
function trip(retryAfterMs) {
  const wait = Math.max(retryAfterMs || 30_000, 30_000) + 5_000;
  cooldownUntil = Date.now() + wait;
  console.warn(`[r6dataCache] cooldown tripped — refusing r6data for ${Math.ceil(wait/1000)}s`);
}
function clear() { cooldownUntil = 0; }

module.exports = { get, set, getStale, TTL_MS, isCoolingDown, cooldownRemainingMs, trip, clear };
