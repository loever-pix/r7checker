'use strict';
// Persistent, hot-reloadable pricing overrides.
//
// Reads/writes a single JSON file (data/pricing.json). Every pricing consumer
// (vwiPricing, bulkRunner, store's subscription plans) merges the file's values
// on top of its hardcoded defaults at request time — the file re-reads on every
// call, cached by mtime so it's cheap. Missing keys fall through to the code
// defaults, so an empty file is a valid state.
//
// Shape (only include keys you want to override; anything absent uses defaults):
//   {
//     "vwiPricing": {
//       "RANK_BASE": { "Champion": { "1.0": 18, "2.0": 12, "3.0": 8 }, ... },
//       "ITEM_FLOOR": { "Glacier": 10, ... },
//       "MYSTERY_FLAT": 5, "MULTI_RANK_ADD": 3, "GLOBAL_MIN": 1,
//       "PLATFORM_PREMIUM": { "psn": 0, "xbx": 0.5, "double": 1.5 },
//       "BANNED_PRICE": { "psn": 0.75, "xbx": 0.9, "double": 1, "none": 1 }
//     },
//     "subscriptionPlans": {
//       "daily":   { "days": 1,  "usd": 5 },
//       "weekly":  { "days": 7,  "usd": 20 },
//       "monthly": { "days": 30, "usd": 50 }
//     },
//     "serverCheckerBrackets": [
//       { "upTo": 10000,   "usd": 0.0002 },
//       { "upTo": 100000,  "usd": 0.00005 },
//       { "upTo": 1000000, "usd": 0.00003 },
//       { "upTo": null,    "usd": 0.00002 }
//     ]
//   }

const fs   = require('fs');
const path = require('path');

const FILE = process.env.PRICING_FILE
  || path.join(process.env.CACHE_DIR || path.join(__dirname, '..', '.cache'), 'pricing.json');

let cached = { mtime: 0, data: {} };

function _read() {
  try {
    const st = fs.statSync(FILE);
    if (st.mtimeMs === cached.mtime) return cached.data;
    const raw = fs.readFileSync(FILE, 'utf8');
    const data = raw.trim() ? JSON.parse(raw) : {};
    cached = { mtime: st.mtimeMs, data };
    return data;
  } catch (e) {
    // Missing file / bad JSON → empty overrides (every consumer falls back to
    // hardcoded defaults). We never throw from a read path.
    if (e.code !== 'ENOENT') console.warn('[pricing] read failed:', e.message);
    cached = { mtime: 0, data: {} };
    return {};
  }
}

// Full overrides blob (never null).
function all() { return _read(); }

// Convenience getters for the three pricing sections.
function vwi()          { return _read().vwiPricing || {}; }
function subscriptions(){ return _read().subscriptionPlans || {}; }
function serverBrackets(){ return _read().serverCheckerBrackets || null; }

// Atomically replace the whole overrides file. Caller has already validated.
function save(nextData) {
  try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); } catch {}
  const tmp = FILE + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(nextData, null, 2));
  fs.renameSync(tmp, FILE);
  cached = { mtime: 0, data: {} };   // force re-read next call
}

// Merge helper: shallow for scalars, KEY-WISE for nested objects (so partial
// overrides work — override just Champion.1.0 without wiping the rest).
function mergeOverride(defaults, override) {
  if (override == null) return defaults;
  if (Array.isArray(defaults) || Array.isArray(override)) return override;
  if (typeof defaults !== 'object' || typeof override !== 'object') return override;
  const out = { ...defaults };
  for (const k of Object.keys(override)) out[k] = mergeOverride(defaults[k], override[k]);
  return out;
}

module.exports = { FILE, all, vwi, subscriptions, serverBrackets, save, mergeOverride };
