# VWI Pricing Engine (Phase 2a) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A pure, fully-tested pricing engine that computes a per-account USD price from a result line's contents (skins + ranks), so the later dry-run preview and live push can price every account.

**Architecture:** One pure CommonJS module `lib/bot/vwiPricing.js` with owner-confirmed constants. Final price = the single highest applicable floor (owner thinks in minimums). No I/O, no SellAuth calls — those come in 2b. Tests are standalone `node scripts/test-*.js` with `assert`.

**Tech Stack:** Node.js CommonJS.

---

## Task 1: pricing engine module + tests

**Files:**
- Create: `lib/bot/vwiPricing.js`
- Test: `scripts/test-vwi-pricing.js`

- [ ] **Step 1: Write the failing test** — create `scripts/test-vwi-pricing.js`:

```js
'use strict';
const assert = require('assert');
const P = require('../lib/bot/vwiPricing');

const close = (a, b, msg) => assert(Math.abs(a - b) < 0.011, `${msg}: got ${a}, want ${b}`);
// Build a result line with given Ranks/Skins fields.
const L = (ranks, skins) =>
  `e@x.com:pw | User: U | Lvl: 100 | Items: 9 | Credits: 0 | Renown: 0 | Ranks: ${ranks} | Skins: ${skins} | Linkable: PSN | Banned: N`;

// Era boundaries.
assert.strictEqual(P.eraForSeason(20), '1.0');
assert.strictEqual(P.eraForSeason(24), '1.0');
assert.strictEqual(P.eraForSeason(25), '2.0');
assert.strictEqual(P.eraForSeason(28), '2.0');
assert.strictEqual(P.eraForSeason(29), '3.0');
assert.strictEqual(P.eraForSeason(41), '3.0');

// Glacier scale.
close(P.priceLine(L('—', '1x Glacier')).price, 10, 'glacier 1');
close(P.priceLine(L('—', '40x Glacier')).price, 50, 'glacier 40');
close(P.priceLine(L('—', '20x Glacier')).price, Math.min(50, 10 + 19 * (40 / 39)), 'glacier 20');

// Glacier + Champion combo = $80 (beats both the glacier scale and the rank floor).
close(P.priceLine(L('Champion (S20)', '1x Glacier')).price, 80, 'glacier+champ');

// Single-family item floors.
close(P.priceLine(L('—', '1x Chroma Streaks')).price, 5, 'chroma alone -> mystery 5 beats 3');
close(P.priceLine(L('—', '1x Obsidian')).price, 5, 'obsidian alone -> mystery 5 beats 4');
close(P.priceLine(L('—', '1x Silver GO4 Charm')).price, 20, 'silver go4');
close(P.priceLine(L('—', '1x Gold GO4 Charm')).price, 30, 'gold go4');
close(P.priceLine(L('—', '1x Spellbound R4-C')).price, 30, 'spellbound');

// Chroma + Obsidian combo = $10.
close(P.priceLine(L('—', '1x Chroma Streaks, 1x Obsidian')).price, 10, 'chroma+obsidian');

// Rank floors by era.
close(P.priceLine(L('Champion (S20)', '—')).price, 18, 'champ 1.0');
close(P.priceLine(L('Champion (S26)', '—')).price, 12, 'champ 2.0');
close(P.priceLine(L('Champion (S33)', '—')).price, 8, 'champ 3.0');
close(P.priceLine(L('Plat (S41)', '—')).price, 3, 'plat 3.0');
close(P.priceLine(L('Emerald (S33)', '—')).price, 4, 'emerald 3.0');

// Multi-rank: highest tier base + $3 per extra distinct tier.
close(P.priceLine(L('Champion (S20), Diamond (S37)', '—')).price, 18 + 3, 'champ1.0 + 1 extra');
close(P.priceLine(L('Champion (S20), Diamond (S37), Plat (S40)', '—')).price, 18 + 6, 'champ1.0 + 2 extra');

// Mystery: any non-floored wanted skin -> $5.
close(P.priceLine(L('—', '8x Gold Dust')).price, 5, 'gold dust -> mystery');
close(P.priceLine(L('—', '2x Board Game')).price, 5, 'board game -> mystery');

// Final price is the MAX floor: a Champion(1.0)=$18 account with Gold GO4=$30 -> $30.
close(P.priceLine(L('Champion (S20)', '1x Gold GO4 Charm')).price, 30, 'max of floors');

// Empty/no-value line -> global min $1.
close(P.priceLine(L('—', '—')).price, 1, 'global min');

console.log('OK test-vwi-pricing');
```

- [ ] **Step 2: Run it — MUST fail** (`Cannot find module '../lib/bot/vwiPricing'`).

Run: `node scripts/test-vwi-pricing.js`

- [ ] **Step 3: Create `lib/bot/vwiPricing.js`:**

```js
'use strict';
// VWI pricing engine — PURE. Computes a per-account USD price from a result
// line's contents (skins + ranks). Final price = the single HIGHEST applicable
// floor (the owner prices in minimums; you never sell an $80 account for its $18
// rank floor). Constants are owner-confirmed — see
// docs/superpowers/specs/2026-06-28-vwi-sellauth-push-phase2-design.md.

// Rank base price by tier + ranked era. Era from peak season:
//   1.0 = season <= 24, 2.0 = 25..28, 3.0 = >= 29.
const RANK_BASE = {
  Champion: { '1.0': 18, '2.0': 12, '3.0': 8 },
  Diamond:  { '1.0': 10, '2.0': 7,  '3.0': 5 },
  Emerald:  {                       '3.0': 4 },
  Plat:     { '1.0': 5,  '2.0': 4,  '3.0': 3 },
};
const RANK_ORDER = ['Champion', 'Diamond', 'Emerald', 'Plat']; // highest first
const MULTI_RANK_ADD = 3;   // flat $ per EXTRA distinct qualifying tier
const MYSTERY_FLAT  = 5;    // any wanted skin with no higher floor
const GLOBAL_MIN    = 1;

// Single-family item floors (display names match the bulk "Skins:" tokens).
const ITEM_FLOOR = {
  'Chroma Streaks':   3,
  'Obsidian':         4,
  'Silver GO4 Charm': 20,
  'Gold GO4 Charm':   30,
  'Spellbound R4-C':  30,
};

function eraForSeason(s) {
  if (s == null || isNaN(s)) return '3.0';  // unknown season -> newest era
  if (s <= 24) return '1.0';
  if (s <= 28) return '2.0';
  return '3.0';
}

function rankBase(tier, era) {
  const t = RANK_BASE[tier];
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
  const floors = [];
  const has = (k) => (skins[k] || 0) > 0;
  const glacier = skins['Glacier'] || 0;
  const hasChampion = ranks.some(r => r.tier === 'Champion');

  if (glacier > 0) {
    floors.push({ rule: `Glacier x${glacier}`, amount: Math.min(50, 10 + (glacier - 1) * (40 / 39)) });
    if (hasChampion) floors.push({ rule: 'Glacier + Champion', amount: 80 });
  }
  for (const [fam, amt] of Object.entries(ITEM_FLOOR)) {
    if (has(fam)) floors.push({ rule: fam, amount: amt });
  }
  if (has('Chroma Streaks') && has('Obsidian')) floors.push({ rule: 'Chroma + Obsidian', amount: 10 });

  const tiers = ranks.filter(r => RANK_BASE[r.tier]);
  if (tiers.length) {
    const highest = RANK_ORDER.find(t => tiers.some(r => r.tier === t));
    const peak = tiers.filter(r => r.tier === highest)
      .reduce((a, r) => ((r.season == null ? -1 : r.season) > (a.season == null ? -1 : a.season) ? r : a));
    const era = eraForSeason(peak.season);
    const distinct = new Set(tiers.map(r => r.tier)).size;
    floors.push({ rule: `${highest} ${era} (+${distinct - 1})`, amount: rankBase(highest, era) + MULTI_RANK_ADD * (distinct - 1) });
  }

  if (Object.keys(skins).length) floors.push({ rule: 'Mystery Items', amount: MYSTERY_FLAT });

  const amount = floors.length ? Math.max(...floors.map(f => f.amount)) : 0;
  return { price: Math.max(GLOBAL_MIN, Math.round(amount * 100) / 100), floors };
}

function priceLine(line) {
  return priceParts(parseSkins(fieldVal(line, 'Skins')), parseRanks(fieldVal(line, 'Ranks')));
}

module.exports = {
  priceLine, priceParts, parseSkins, parseRanks, eraForSeason, rankBase,
  RANK_BASE, RANK_ORDER, MULTI_RANK_ADD, MYSTERY_FLAT, ITEM_FLOOR, GLOBAL_MIN,
};
```

- [ ] **Step 4: Run the test — MUST print `OK test-vwi-pricing`.**

Run: `node scripts/test-vwi-pricing.js`

- [ ] **Step 5: Commit (only these two files; never `git add -A`):**

```bash
git add lib/bot/vwiPricing.js scripts/test-vwi-pricing.js
git commit -m "feat(vwi): pricing engine — per-account floors (ranks/items/combos)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-review (coverage vs spec §Pricing)

- Glacier scale + Champion combo ($80) → covered. ✓
- Chroma $3 / Obsidian $4 / both $10; GO4 $20/$30; Spellbound $30 → covered. ✓
- Rank table per era + multi-rank flat $3 add → covered. ✓
- Mystery flat $5 → covered. ✓
- Highest-floor-wins + global $1 min → covered. ✓
- Live writes / product creation → NOT here (Phase 2b).
