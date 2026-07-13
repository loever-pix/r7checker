// Remembers which Xbox / PSN accounts a Ubisoft profile has *ever* had linked,
// so we can flag a console as a "Ghost" when Ubisoft no longer reports the link
// but it was linked on a previous check.
//
// Ubisoft's profiles API only exposes CURRENT links — once a player unlinks a
// console, it disappears. By persisting the handles we've seen, we can still
// surface that console (and its tracker.gg ranks) marked as Ghost.
//
// Storage: a single JSON file under the cache dir:
//   { [profileId]: { [slug]: { handle, firstSeen, lastLinked } } }

const fs = require('fs');
const path = require('path');

const DIR  = process.env.CACHE_DIR || path.join(__dirname, '..', '.cache');
const FILE = path.join(DIR, 'linked-history.json');

let _cache = null;
function load() {
  if (_cache) return _cache;
  try { _cache = JSON.parse(fs.readFileSync(FILE, 'utf8')); }
  catch { _cache = {}; }
  return _cache;
}
function save() {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(_cache));
    fs.renameSync(tmp, FILE); // atomic-ish replace
  } catch (e) { console.warn('[linkedHistory] save failed:', e.message); }
}

// Record the consoles Ubisoft CURRENTLY reports linked for this profile, and
// return the full known set (current + ghosts) with a `ghost` flag on each.
//   profileId: Ubisoft profile UUID
//   current:   [{ slug:'xbl'|'psn', handle }]
//   now:       timestamp (ms) — passed in so callers control the clock
// Returns: [{ slug, handle, ghost }]
function recordAndList(profileId, current, now = Date.now()) {
  if (!profileId) return (current || []).map(c => ({ ...c, ghost: false }));
  const db = load();
  const rec = db[profileId] || (db[profileId] = {});
  const currentSlugs = new Set();

  for (const c of (current || [])) {
    if (!c || !c.slug || !c.handle) continue;
    currentSlugs.add(c.slug);
    const prev = rec[c.slug];
    rec[c.slug] = {
      handle:    c.handle,
      firstSeen: prev?.firstSeen ?? now,
      lastLinked: now,            // currently linked → refresh
    };
  }

  const out = [];
  for (const [slug, info] of Object.entries(rec)) {
    out.push({ slug, handle: info.handle, ghost: !currentSlugs.has(slug) });
  }
  save();
  return out;
}

module.exports = { recordAndList };
