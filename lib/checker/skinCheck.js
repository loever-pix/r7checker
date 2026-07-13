// Wanted-skin + wanted-rank detector for the bulk checker output.
//
// "Wanted" things are high-value cosmetics or competitive ranks that bump
// an account's resale value. We look at every item the account owns,
// resolve it against skins_cache.json (operator-curated catalog of 4000+
// items with clean name + category + release season), and tally how
// many of each "wanted" family the account has.

const SKIN_CACHE = require('../skins_cache.json');

// Definition of "wanted" — exact matches against the skins_cache fields.
// Each rule returns true when an item belongs to that family. Keys are the
// display names used in the bulk "Skins:" column AND the VWI sorter buckets,
// so keep them in sync with the owner dashboard (served via /api/admin/vwi/meta).
const WANTED_SKIN_RULES = {
  'Dust Line':           it => it.category === 'Dust Lines',
  'Chroma Streaks':      it => it.name === 'Chroma Streaks',
  'El Dorado':           it => it.category === 'Seasonals' && it.name === 'El Dorado',
  'Crossfader':          it => it.category === 'Seasonals' && it.name === 'Crossfader',
  'Obsidian':            it => it.category === 'Seasonals' && it.name === 'Obsidian',
  'Racer':               it => it.category === 'Racer',
  'Chupinazo':           it => it.category === 'Seasonals' && it.name === 'Chupinazo',
  'Glacier':             it => it.category === 'Glacier',
  'VIP Invitational':    it => it.category === 'Invitational/Major' && /vip/i.test(it.name || ''),
  'Year One Pro League': it => it.category === 'Pro Leagues (Old)',
  'Peacock':             it => it.name === 'Peacock',
  'Gold Dust':           it => it.category === 'Gold Dusts',
  'Fire':                it => it.category === 'Universals' && it.name === 'Fire',
  'Heart Attack':        it => it.category === 'Universals' && it.name === 'Heart Attack',
  'Lucky':               it => it.category === 'Universals' && it.name === 'Lucky',
  'Ralphie':             it => it.category === 'Universals' && it.name === 'Ralphie',
  'Board Game':          it => it.category === 'Board Game',
  'Spellbound R4-C':     it => it.category === 'Special' && it.name === 'Spellbound (R4C)',
  // Plasma Pink exists as BOTH a Universal weapon skin (Y1S4) and an Attachment
  // Skin (Y7S1) — both share the same display name. Either one qualifies.
  'Plasma Pink':         it => it.name === 'Plasma Pink' && (it.category === 'Universals' || it.category === 'Attachment Skins'),
  'R4-C Black Ice':      it => it.category === 'Black Ices' && it.name === 'R4C',
  'SMG12 Black Ice':     it => it.category === 'Black Ices' && it.name === 'SMG-12',
  // Bulk Black Ice collections — counts EVERY Black Ice (incl. R4-C/SMG-12),
  // but only "wanted" when the account has 20+ of them (see WANTED_SKIN_MINS).
  'Black Ice (20+)':     it => it.category === 'Black Ices',
  // ('Frontlines' requested but has no catalog match — intentionally omitted.)
};

// Per-family minimum owned count for an item family to count as "wanted".
// Defaults to 1 (any). Black Ice only qualifies at 20+.
const WANTED_SKIN_MINS = {
  'Black Ice (20+)': 20,
  'Dust Line': 45,       // a "complete" dust line = all 45 Dust Line weapon skins (45/45)
};

// Wanted items matched by EXACT Ubisoft item id (not via skins_cache) — for
// rare collectibles that don't live in the curated catalog, e.g. tournament
// charms. Each display name maps to a Set of qualifying item ids. These names
// flow into the bulk "Skins:" column AND the VWI sorter buckets just like the
// rule-based families above.
const WANTED_ITEM_IDS = {
  'Silver GO4 Charm': new Set(['dd7305df-8638-4bed-ba31-b87164981ec4']),
  'Gold GO4 Charm':   new Set(['c83e8f07-eade-4fe4-a2d5-635b240e49d8']),
};
// Every wanted-item display name, in order (rule families first, then id-based).
// Used to seed counts AND to feed the owner dashboard / VWI sorter buckets.
const WANTED_ITEM_NAMES = [...Object.keys(WANTED_SKIN_RULES), ...Object.keys(WANTED_ITEM_IDS)];

// Short tier labels used by detectTopRanks() in the bulk "Ranks:" column and by
// the VWI sorter's rank buckets. Order = display precedence (highest first).
const WANTED_RANK_LABELS = ['Champion', 'Diamond', 'Emerald', 'Plat'];

const WANTED_RANK_TIERS = ['platinum', 'emerald', 'diamond', 'champion'];

// The ONLY item families that keep their own sorter bucket. Every other wanted
// item collapses into the single "Mystery Items" bucket.
const NAMED_ITEM_BUCKETS = ['Silver GO4 Charm', 'Gold GO4 Charm', 'Obsidian', 'Chroma Streaks', 'Glacier'];

// Banned accounts are normally excluded, but a banned account still has resale
// value when it carries any of these. Names match the Ranks/Skins field tokens.
const BANNED_VWI = {
  ranks: ['Champion', 'Diamond'],
  items: ['Chroma Streaks', 'Obsidian', 'Silver GO4 Charm', 'Gold GO4 Charm', 'Spellbound R4-C'],
};

// Payload for the owner sorter (served by /api/admin/vwi/meta). Pure — no I/O.
function vwiMeta() {
  return {
    ranks: WANTED_RANK_LABELS,
    items: WANTED_ITEM_NAMES,
    namedItemBuckets: NAMED_ITEM_BUCKETS,
    bannedVwi: BANNED_VWI,
  };
}

// Walk every item in playerData.sections and tally how many of each wanted
// family the account owns. Returns an object like:
//   { Glacier: 3, Obsidian: 1, 'Chroma Streaks': 0, Spellbound: 0 }
function detectWantedSkins(playerData) {
  const counts = {};
  for (const name of WANTED_ITEM_NAMES) counts[name] = 0;

  const sections = playerData?.sections || [];
  for (const sec of sections) {
    const items = sec.items || [];
    // Some sections are "grouped" with subgroups (e.g. Black Ices grouped by year).
    const flatItems = sec.grouped
      ? items.concat((sec.groups || []).flatMap(g => g.items || []))
      : items;

    for (const it of flatItems) {
      // Id-based wanted items (charms etc.) — independent of skins_cache, so
      // they're checked BEFORE the cache-meta lookup (which would `continue`).
      for (const [name, ids] of Object.entries(WANTED_ITEM_IDS)) {
        if (ids.has(it.id)) counts[name]++;
      }
      const meta = SKIN_CACHE[it.id];
      if (!meta) continue;
      for (const [name, rule] of Object.entries(WANTED_SKIN_RULES)) {
        if (rule(meta)) counts[name]++;
      }
    }
  }
  // Apply per-family minimums: a family below its threshold is not "wanted"
  // (e.g. Black Ice needs 20+). Drop it to 0 so it's hidden + doesn't count VWI.
  for (const name of Object.keys(counts)) {
    if (counts[name] < (WANTED_SKIN_MINS[name] || 1)) counts[name] = 0;
  }
  return counts;
}

// Walk seasonRanks and find the user's PEAK in each "wanted" tier. Returns
// an array of compact labels like ['Plat (S41)', 'Diamond (S37)'] — most-
// recent season per tier. Empty array if no qualifying ranks.
function detectTopRanks(playerData) {
  const ranks = playerData?.seasonRanks || [];
  // Map tier -> { season, seasonName, name } — keep the MOST RECENT season per tier.
  const byTier = {};
  for (const r of ranks) {
    const tier = (r.rankTier || '').toLowerCase();
    if (!WANTED_RANK_TIERS.includes(tier)) continue;
    const seasonNum = r.season ?? 0;
    if (!byTier[tier] || seasonNum > byTier[tier].season) {
      byTier[tier] = { season: seasonNum, seasonName: r.seasonName || '', name: r.rankName || tier };
    }
  }
  // Output in fixed precedence so the column is consistent — champion first,
  // then diamond, emerald, platinum. Include the season NAME (e.g. "Silent
  // Hunt") alongside the number so operators don't have to memorize which S#
  // is which live season. Falls back to just "(S41)" when seasonName is empty.
  const order = ['champion', 'diamond', 'emerald', 'platinum'];
  return order
    .filter(t => byTier[t])
    .map(t => {
      const r = byTier[t];
      const short = t === 'platinum' ? 'Plat' : (t.charAt(0).toUpperCase() + t.slice(1));
      // Some names come back prefixed "Season " (r6data / trackers) — strip so
      // we don't render "S41 Season 41". Only the real live-name is worth showing.
      const clean = String(r.seasonName || '').replace(/^season\s*\d+$/i, '').trim();
      return clean
        ? `${short} (S${r.season} ${clean})`
        : `${short} (S${r.season})`;
    });
}

// Format the wanted-skins tally for bulk output.
// "3× Glacier, 1× Obsidian" — only includes non-zero entries.
// Returns "—" when none.
function formatWantedSkins(counts) {
  const parts = Object.entries(counts)
    .filter(([_, n]) => n > 0)
    .map(([name, n]) => `${n}x ${name}`); // ASCII 'x' — the × glyph renders as ▯ in many consoles
  return parts.length ? parts.join(', ') : '—';
}

// Format the wanted-ranks list for bulk output.
function formatWantedRanks(ranks) {
  return ranks.length ? ranks.join(', ') : '—';
}

// All item images served through our /api/img proxy: keeps the allowlist +
// caching + placeholder behaviour consistent, and means the locker page
// never embeds a third-party CDN URL directly.
//
// `fallback` is a second URL the proxy will try if the primary 404s. Used
// to preserve the original Ubisoft URL when we swap the displayed image to
// the cleaner siegeskins.com CDN — ~7% of siegeskins URLs are broken, and
// the Ubisoft fallback gives a real image instead of the placeholder SVG.
function proxyImage(url, fallback) {
  if (!url) return null;
  const fb = fallback ? `&fallback=${encodeURIComponent(fallback)}` : '';
  return `/api/img?url=${encodeURIComponent(url)}${fb}`;
}

// The original Ubisoft URL was stored as `/api/img?url=<ubisoft-url>` by
// player.js's inventory builder. Extract the inner URL so we can use it as
// the fallback when we overwrite `it.image` with a cleaner cache URL.
function extractInnerUrl(proxiedUrl) {
  if (!proxiedUrl || typeof proxiedUrl !== 'string' || !proxiedUrl.startsWith('/api/img?')) return null;
  try {
    const qs = proxiedUrl.split('?')[1];
    const params = new URLSearchParams(qs);
    return params.get('url') || null;
  } catch { return null; }
}

// In-place upgrade of items using skins_cache as the authoritative source.
// The cache holds operator-curated name, category, release, and image for
// 4,200+ items keyed by Ubisoft UUID. For every item we own that has a
// cache entry we replace name/category/release/image with the cache value,
// so the locker + bulk format display matches the catalog instead of
// Ubisoft's occasionally mojibaked or stale fields.
function enhanceItemNames(playerData) {
  if (!playerData?.sections) return playerData;
  // Lazy-require so a missing/old deploy can't break this path
  let ubisoftItems = null;
  try { ubisoftItems = require('../ubisoftItems'); } catch {}

  for (const sec of playerData.sections) {
    const items = sec.items || [];
    const groups = sec.groups || [];
    const flat = sec.grouped ? items.concat(groups.flatMap(g => g.items || [])) : items;
    for (const it of flat) {
      // BEFORE we overwrite the image, capture the original Ubisoft URL so
      // we can pass it to the proxy as a fallback. Without this, when the
      // cache URL is broken we'd serve a placeholder; with it, we get the
      // real Ubisoft asset.
      const originalUbi = extractInnerUrl(it.image);

      // Layer 1: operator-curated cache (preferred — cleanest names)
      const meta = SKIN_CACHE[it.id];
      if (meta) {
        if (meta.name)     it.name     = meta.name;
        if (meta.category) it.category = meta.category;
        if (meta.release)  it.release  = meta.release;
        if (meta.image)    it.image    = proxyImage(meta.image, originalUbi);
        continue;
      }
      // Layer 2: live Ubisoft catalog (fills the 64% the curated cache misses)
      const ubi = ubisoftItems?.lookupItem(it.id);
      if (ubi) {
        if (ubi.name)     it.name     = ubi.name;
        if (ubi.category) it.category = ubi.category;
        if (ubi.image)    it.image    = proxyImage(ubi.image, originalUbi);
      }
    }
  }
  return playerData;
}

module.exports = {
  detectWantedSkins,
  detectTopRanks,
  formatWantedSkins,
  formatWantedRanks,
  enhanceItemNames,
  WANTED_SKIN_RULES,
  WANTED_SKIN_MINS,
  WANTED_ITEM_IDS,
  WANTED_ITEM_NAMES,
  WANTED_RANK_TIERS,
  WANTED_RANK_LABELS,
  NAMED_ITEM_BUCKETS,
  BANNED_VWI,
  vwiMeta,
};
