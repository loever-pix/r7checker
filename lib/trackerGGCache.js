// tracker.gg response cache. tracker.gg fronts behind Cloudflare and 403s
// occasionally — cache successful responses for 1 hour per userId.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CACHE_DIR = path.join(__dirname, '..', '.cache', 'tracker-gg');
try { fs.mkdirSync(CACHE_DIR, { recursive: true }); } catch {}

const TTL_MS = 60 * 60 * 1000; // 1 hour

function keyOf(identifier) {
  return crypto.createHash('sha1').update(`tg:${identifier}`).digest('hex').slice(0, 24);
}

function get(identifier) {
  const fp = path.join(CACHE_DIR, `${keyOf(identifier)}.json`);
  try {
    const stat = fs.statSync(fp);
    if (Date.now() - stat.mtimeMs > TTL_MS) return null;
    return JSON.parse(fs.readFileSync(fp, 'utf8'));
  } catch { return null; }
}

// Last-known-good, ignoring TTL. Used as a fallback when a live fetch is
// blocked (Cloudflare 403) so we keep showing the seasons we last saw
// instead of an empty list.
function getStale(identifier) {
  const fp = path.join(CACHE_DIR, `${keyOf(identifier)}.json`);
  try { return JSON.parse(fs.readFileSync(fp, 'utf8')); }
  catch { return null; }
}

function set(identifier, data) {
  if (!data) return;
  const fp = path.join(CACHE_DIR, `${keyOf(identifier)}.json`);
  try {
    const tmp = fp + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, fp);
  } catch (e) { console.warn('[trackerGGCache] save failed:', e.message); }
}

// Cooldown gate — tracker.gg Cloudflare rate-limits aggressively.
let cooldownUntil = 0;
function isCoolingDown() { return Date.now() < cooldownUntil; }
function cooldownRemainingMs() { return Math.max(0, cooldownUntil - Date.now()); }
function trip(ms) {
  // Respect the caller's value. cycletls already retries with rotating proxy
  // IPs, so a long global cooldown just blocks other users; keep the floor low.
  const wait = Math.max(ms || 10_000, 5_000);
  cooldownUntil = Date.now() + wait;
  console.warn(`[trackerGGCache] cooldown tripped — refusing tracker.gg for ${Math.ceil(wait/1000)}s`);
}
function clear() { cooldownUntil = 0; }

// ── Bounded-cache pruner ────────────────────────────────────────────────────
// The 1h TTL controls FRESHNESS; getStale() keeps serving a file past TTL as a
// Cloudflare-403 fallback — so nothing here ever deleted files, and a big bulk
// run (one file per unique account, ~57KB each) grew this dir to tens of
// thousands of files / GBs and filled the disk. Prune by BOTH age and a hard
// file-count cap (oldest-first), frequently, so it can't run away mid-job.
const PRUNE_MS      = Number(process.env.TRACKER_CACHE_PRUNE_MS)       || 6 * 60 * 60 * 1000; // 6h retention
const MAX_FILES     = Number(process.env.TRACKER_CACHE_MAX_FILES)      || 15000;              // ~<1GB at 57KB
const PRUNE_EVERY_MS = Number(process.env.TRACKER_CACHE_PRUNE_EVERY_MS) || 20 * 60 * 1000;    // every 20m
function prune() {
  try {
    const now = Date.now();
    const live = [];
    for (const f of fs.readdirSync(CACHE_DIR)) {
      const fp = path.join(CACHE_DIR, f);
      let mt;
      try { mt = fs.statSync(fp).mtimeMs; } catch { continue; }
      // Age out anything past retention (and any leftover .tmp from a failed write).
      if (now - mt > PRUNE_MS || f.endsWith('.tmp')) { try { fs.unlinkSync(fp); } catch {} continue; }
      if (f.endsWith('.json')) live.push({ fp, mt });
    }
    // Hard cap: if still over MAX_FILES, delete the oldest until under it.
    if (live.length > MAX_FILES) {
      live.sort((a, b) => a.mt - b.mt);
      const drop = live.length - MAX_FILES;
      for (let i = 0; i < drop; i++) { try { fs.unlinkSync(live[i].fp); } catch {} }
      console.log(`[trackerGGCache] pruned ${drop} over-cap entries (cap ${MAX_FILES})`);
    }
  } catch (e) { console.warn('[trackerGGCache] prune failed:', e.message); }
}
setTimeout(prune, 30_000).unref();
setInterval(prune, PRUNE_EVERY_MS).unref();

module.exports = { get, getStale, set, TTL_MS, isCoolingDown, cooldownRemainingMs, trip, clear, prune };
