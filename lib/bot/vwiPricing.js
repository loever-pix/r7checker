'use strict';
// VWI pricing engine — PURE. Computes a per-account USD price from a result
// line's contents (skins + ranks). Final price = the single HIGHEST applicable
// floor (the owner prices in minimums; you never sell an $80 account for its $18
// rank floor). Constants are owner-confirmed — see
// docs/superpowers/specs/2026-06-28-vwi-sellauth-push-phase2-design.md.

const pricingStore = require('../pricingStore');

// DEFAULTS — the fallback baseline. Any values set in data/pricing.json's
// `vwiPricing` section override these live (no restart needed).
const DEFAULTS = {
  // Rank base price by tier + ranked era. Era from peak season:
  //   1.0 = season <= 24, 2.0 = 25..28, 3.0 = >= 29.
  RANK_BASE: {
    Champion: { '1.0': 18, '2.0': 12, '3.0': 8 },
    Diamond:  { '1.0': 10, '2.0': 7,  '3.0': 5 },
    Emerald:  {                       '3.0': 4 },
    Plat:     { '1.0': 5,  '2.0': 4,  '3.0': 3 },
  },
  MULTI_RANK_ADD: 3,     // flat $ per EXTRA distinct qualifying tier
  MYSTERY_FLAT:   5,     // any wanted skin with no higher floor
  GLOBAL_MIN:     1,
  // Flat platform premium added on top of the computed floor price, mirroring
  // the owner's live store (PSN base, XBX a touch more, XBX/PSN doubles the most).
  PLATFORM_PREMIUM: { psn: 0, xbx: 0.5, double: 1.5 },
  // Banned accounts are ≤ $1 regardless of their rank/skin value — a banned
  // Champion+Glacier still can't be USED, so it never gets the $80 floor.
  BANNED_PRICE: { psn: 0.75, xbx: 0.90, double: 1.00, none: 1.00 },
  // Single-family item floors (display names match the bulk "Skins:" tokens).
  ITEM_FLOOR: {
    'Chroma Streaks':   3,
    'Obsidian':         4,
    'Silver GO4 Charm': 20,
    'Gold GO4 Charm':   30,
    'Spellbound R4-C':  30,
  },
};

// Live-merged effective config, refreshed from disk on every call (cheap: mtime cache).
function CFG() { return pricingStore.mergeOverride(DEFAULTS, pricingStore.vwi()); }

const RANK_ORDER = ['Champion', 'Diamond', 'Emerald', 'Plat']; // highest first

function eraForSeason(s) {
  if (s == null || isNaN(s)) return '3.0';  // unknown season -> newest era
  if (s <= 24) return '1.0';
  if (s <= 28) return '2.0';
  return '3.0';
}

function rankBase(tier, era) {
  const t = CFG().RANK_BASE[tier];
  if (!t) return 0;
  if (t[era] != null) return t[era];
  return t['3.0'] != null ? t['3.0'] : (t['2.0'] != null ? t['2.0'] : (t['1.0'] || 0));
}

// "3x Glacier, 1x Obsidian" -> { Glacier:3, Obsidian:1 }
function parseSkins(field) {
  const out = {};
  if (!field || field === '—' || field === '-') return out;
  for (const part of field.split(',')) {
    const m = part.trim().match(/^(?:(\d+)\s*[×x]\s*)?(.+)$/i);
    if (!m) continue;
    const n = m[1] ? parseInt(m[1], 10) : 1;
    const name = m[2].trim();
    if (name) out[name] = (out[name] || 0) + n;
  }
  return out;
}

// "Champion (S20), Diamond (S37)" -> [{tier:'Champion',season:20}, ...]
function parseRanks(field) {
  const out = [];
  if (!field || field === '—' || field === '-') return out;
  for (const part of field.split(',')) {
    const m = part.trim().match(/^([A-Za-z]+)\s*(?:\(S?(\d+)\))?/);
    if (!m) continue;
    out.push({ tier: m[1], season: m[2] != null ? parseInt(m[2], 10) : null });
  }
  return out;
}

function fieldVal(line, label) {
  const m = line.match(new RegExp('\\|\\s*' + label + ':\\s*([^|]*)', 'i'));
  return m ? m[1].trim() : '';
}

// Compute { price, floors } from parsed { skins:{fam:count}, ranks:[{tier,season}] }.
function priceParts(skins, ranks) {
  const cfg = CFG();
  const floors = [];
  const has = (k) => (skins[k] || 0) > 0;
  const glacier = skins['Glacier'] || 0;
  const hasChampion = ranks.some(r => r.tier === 'Champion');

  if (glacier > 0) {
    floors.push({ rule: `Glacier x${glacier}`, amount: Math.min(50, 10 + (glacier - 1) * (40 / 39)) });
    if (hasChampion) floors.push({ rule: 'Glacier + Champion', amount: 80 });
  }
  for (const [fam, amt] of Object.entries(cfg.ITEM_FLOOR)) {
    if (has(fam)) floors.push({ rule: fam, amount: amt });
  }
  if (has('Chroma Streaks') && has('Obsidian')) floors.push({ rule: 'Chroma + Obsidian', amount: 10 });

  const tiers = ranks.filter(r => cfg.RANK_BASE[r.tier]);
  if (tiers.length) {
    const highest = RANK_ORDER.find(t => tiers.some(r => r.tier === t));
    const peak = tiers.filter(r => r.tier === highest)
      .reduce((a, r) => ((r.season == null ? -1 : r.season) > (a.season == null ? -1 : a.season) ? r : a));
    const era = eraForSeason(peak.season);
    const distinct = new Set(tiers.map(r => r.tier)).size;
    floors.push({ rule: `${highest} ${era} (+${distinct - 1})`, amount: rankBase(highest, era) + cfg.MULTI_RANK_ADD * (distinct - 1) });
  }

  if (Object.keys(skins).length) floors.push({ rule: 'Mystery Items', amount: cfg.MYSTERY_FLAT });

  const amount = floors.length ? Math.max(...floors.map(f => f.amount)) : 0;
  return { price: Math.max(cfg.GLOBAL_MIN, Math.round(amount * 100) / 100), floors };
}

function priceLine(line) {
  return priceParts(parseSkins(fieldVal(line, 'Skins')), parseRanks(fieldVal(line, 'Ranks')));
}

// Detect "| Banned: Y" — banned accounts get the ≤$1 platform price regardless
// of their rank/skin value (they can't be used, so floors don't apply).
function isLineBanned(line) {
  return /\|\s*Banned:\s*(y|yes|true|banned|1)\b/i.test(String(line || ''));
}

// Price a line for a specific platform product: floor price + the platform
// premium. `platform` is the sorter split label ('psn'|'xbx'|'double'); anything
// else is treated as no premium. Banned lines short-circuit to BANNED_PRICE so
// the website Push and the Discord re-sort never disagree on price.
// Returns { price, premium, basePrice, floors }.
function priceLineFor(line, platform) {
  const cfg = CFG();
  if (isLineBanned(line)) {
    const p = cfg.BANNED_PRICE[platform] != null ? cfg.BANNED_PRICE[platform] : 1;
    return { price: p, premium: 0, basePrice: p, floors: [{ rule: 'Banned (≤$1)', amount: p }] };
  }
  const r = priceLine(line);
  const premium = cfg.PLATFORM_PREMIUM[platform] || 0;
  return {
    price: Math.max(cfg.GLOBAL_MIN, Math.round((r.price + premium) * 100) / 100),
    premium,
    basePrice: r.price,
    floors: r.floors,
  };
}

// Back-compat getters (existing callers imported these as constants — now they
// read the live-merged CFG so tuning the admin editor takes effect instantly).
module.exports = {
  priceLine, priceLineFor, priceParts, parseSkins, parseRanks, eraForSeason, rankBase,
  isLineBanned, DEFAULTS, RANK_ORDER,
  get RANK_BASE()        { return CFG().RANK_BASE; },
  get MULTI_RANK_ADD()   { return CFG().MULTI_RANK_ADD; },
  get MYSTERY_FLAT()     { return CFG().MYSTERY_FLAT; },
  get GLOBAL_MIN()       { return CFG().GLOBAL_MIN; },
  get PLATFORM_PREMIUM() { return CFG().PLATFORM_PREMIUM; },
  get BANNED_PRICE()     { return CFG().BANNED_PRICE; },
  get ITEM_FLOOR()       { return CFG().ITEM_FLOOR; },
};
