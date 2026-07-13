# VWI Rules + Sorter (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the new wanted-skin families, the 8+ Dust Line threshold, the Mystery-Items collapse, and a Banned-VWI bucket to the website VWI sorter — driven by a single testable classification module.

**Architecture:** Move the sorter's account→bucket classification out of inline `admin.html` JS into one UMD module `public/js/vwiBuckets.js` that both the browser (`<script src>`) and node test scripts (`require`) consume. `lib/checker/skinCheck.js` stays the catalog source of truth (rules + the new bucket/banned constants) and gains a `vwiMeta()` builder the `/api/admin/vwi/meta` route returns. `admin.html` keeps only DOM rendering (platform split + download buttons).

**Tech Stack:** Node.js (CommonJS), vanilla browser JS, Express. Tests are standalone `node scripts/test-*.js` files using the built-in `assert` module (project convention — no Jest/Mocha).

---

## File structure

- **Create** `public/js/vwiBuckets.js` — UMD pure classifier: field extractors + `bucketAccounts(lines, meta)`. Single source of truth.
- **Modify** `lib/checker/skinCheck.js` — add 5 rules, `WANTED_SKIN_MINS['Dust Line']=8`, `NAMED_ITEM_BUCKETS`, `BANNED_VWI`, `vwiMeta()`.
- **Modify** `server.js` (`/api/admin/vwi/meta`) — return `skinCheck.vwiMeta()`.
- **Modify** `public/admin.html` — load the module, replace inline `analyzeVwiLines`/field helpers, add Banned-VWI container + render, update meta default + totals line.
- **Create** `scripts/test-skincheck-vwi.js` — unit tests for the new rules/threshold/meta.
- **Create** `scripts/test-vwi-buckets.js` — unit tests for `bucketAccounts`.

Desktop sorter parity (`cli/local/menu.js`) is a deferred follow-up (noted in the spec) — not in this plan to avoid SEA-bundle/desktop regression risk.

---

## Task 1: skinCheck — new families, Dust Line threshold, constants

**Files:**
- Modify: `lib/checker/skinCheck.js`
- Test: `scripts/test-skincheck-vwi.js`

- [ ] **Step 1: Write the failing test**

Create `scripts/test-skincheck-vwi.js`:

```js
'use strict';
const assert = require('assert');
const sk = require('../lib/checker/skinCheck');
const cache = require('../lib/skins_cache.json');

// New rule families resolve correctly.
assert.strictEqual(sk.WANTED_SKIN_RULES['Heart Attack']({ category: 'Universals', name: 'Heart Attack' }), true, 'Heart Attack');
assert.strictEqual(sk.WANTED_SKIN_RULES['Lucky']({ category: 'Universals', name: 'Lucky' }), true, 'Lucky');
assert.strictEqual(sk.WANTED_SKIN_RULES['Lucky']({ category: 'Elites', name: 'Pulse (Lucky Seventh)' }), false, 'Lucky must not match Lucky Seventh');
assert.strictEqual(sk.WANTED_SKIN_RULES['Ralphie']({ category: 'Universals', name: 'Ralphie' }), true, 'Ralphie');
assert.strictEqual(sk.WANTED_SKIN_RULES['Board Game']({ category: 'Board Game', name: 'Jiangshi (Lesion Uniform)' }), true, 'Board Game category');
assert.strictEqual(sk.WANTED_SKIN_RULES['Spellbound R4-C']({ category: 'Special', name: 'Spellbound (R4C)' }), true, 'Spellbound primary');
assert.strictEqual(sk.WANTED_SKIN_RULES['Spellbound R4-C']({ category: 'Attachment Skins', name: 'Spellbound (R4C)' }), false, 'Spellbound must exclude attachment');

// Dust Line threshold is 8.
assert.strictEqual(sk.WANTED_SKIN_MINS['Dust Line'], 8, 'Dust Line min 8');

// detectWantedSkins honours the threshold against real catalog ids.
const dustIds = Object.keys(cache).filter(k => cache[k].category === 'Dust Lines');
assert(dustIds.length >= 8, 'fixture: need >=8 dust ids in cache');
const pd = (n) => ({ sections: [{ items: dustIds.slice(0, n).map(id => ({ id })) }] });
assert.strictEqual(sk.detectWantedSkins(pd(7))['Dust Line'], 0, '7 dust lines -> not wanted');
assert.strictEqual(sk.detectWantedSkins(pd(8))['Dust Line'], 8, '8 dust lines -> wanted');

// vwiMeta() shape.
const meta = sk.vwiMeta();
assert.deepStrictEqual(meta.namedItemBuckets, ['Silver GO4 Charm', 'Gold GO4 Charm', 'Obsidian', 'Chroma Streaks', 'Glacier'], 'named buckets');
assert.deepStrictEqual(meta.bannedVwi.ranks, ['Champion', 'Diamond'], 'banned ranks');
assert.deepStrictEqual(meta.bannedVwi.items, ['Chroma Streaks', 'Obsidian', 'Silver GO4 Charm', 'Gold GO4 Charm', 'Spellbound R4-C'], 'banned items');
assert(Array.isArray(meta.items) && meta.items.includes('Heart Attack'), 'items includes new family');
assert.deepStrictEqual(meta.ranks, sk.WANTED_RANK_LABELS, 'ranks');

console.log('OK test-skincheck-vwi');
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node scripts/test-skincheck-vwi.js`
Expected: FAIL — `WANTED_SKIN_RULES['Heart Attack'] is not a function` (rule not added yet).

- [ ] **Step 3: Implement in `lib/checker/skinCheck.js`**

In `WANTED_SKIN_RULES` (after the `'Fire'` entry, before `'Plasma Pink'`), add:

```js
  'Heart Attack':        it => it.category === 'Universals' && it.name === 'Heart Attack',
  'Lucky':               it => it.category === 'Universals' && it.name === 'Lucky',
  'Ralphie':             it => it.category === 'Universals' && it.name === 'Ralphie',
  'Board Game':          it => it.category === 'Board Game',
  'Spellbound R4-C':     it => it.category === 'Special' && it.name === 'Spellbound (R4C)',
```

Change `WANTED_SKIN_MINS` to:

```js
const WANTED_SKIN_MINS = {
  'Black Ice (20+)': 20,
  'Dust Line': 8,        // a "complete" dust line = 8+ distinct Dust Line skins
};
```

After `WANTED_RANK_TIERS` (line ~63), add the bucket/banned constants:

```js
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
```

Add the new names to `module.exports` (extend the existing object):

```js
  WANTED_RANK_TIERS,
  WANTED_RANK_LABELS,
  NAMED_ITEM_BUCKETS,
  BANNED_VWI,
  vwiMeta,
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node scripts/test-skincheck-vwi.js`
Expected: `OK test-skincheck-vwi`

- [ ] **Step 5: Commit**

```bash
git add lib/checker/skinCheck.js scripts/test-skincheck-vwi.js
git commit -m "feat(vwi): new wanted families + Dust Line 8/8 + bucket/banned constants

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Serve extended meta from `/api/admin/vwi/meta`

**Files:**
- Modify: `server.js` (route at ~1680)

- [ ] **Step 1: Update the route**

Replace the body of `app.get('/api/admin/vwi/meta', ...)` (server.js:1680) with:

```js
app.get('/api/admin/vwi/meta', noStore, siteAuth.requireOwner, (_req, res) => {
  res.json(fmt_skin.vwiMeta());
});
```

(`fmt_skin` is the existing `require` alias for `lib/checker/skinCheck` already used at line 1682. Confirm with `grep -n "fmt_skin" server.js` — if the alias differs, use whatever name the file already imports skinCheck under.)

- [ ] **Step 2: Verify it loads without crashing**

Run: `node -e "require('./lib/checker/skinCheck').vwiMeta()" && echo "meta-ok"`
Expected: `meta-ok` (proves the function the route calls works; full route needs an owner session, covered by Task 1's unit test of `vwiMeta()`).

- [ ] **Step 3: Commit**

```bash
git add server.js
git commit -m "feat(vwi): serve extended sorter meta (named buckets + banned-vwi)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: `public/js/vwiBuckets.js` — pure classifier module

**Files:**
- Create: `public/js/vwiBuckets.js`
- Test: `scripts/test-vwi-buckets.js`

- [ ] **Step 1: Write the failing test**

Create `scripts/test-vwi-buckets.js`:

```js
'use strict';
const assert = require('assert');
const VB = require('../public/js/vwiBuckets.js');

const meta = {
  ranks: ['Champion', 'Diamond', 'Emerald', 'Plat'],
  namedItemBuckets: ['Silver GO4 Charm', 'Gold GO4 Charm', 'Obsidian', 'Chroma Streaks', 'Glacier'],
  bannedVwi: {
    ranks: ['Champion', 'Diamond'],
    items: ['Chroma Streaks', 'Obsidian', 'Silver GO4 Charm', 'Gold GO4 Charm', 'Spellbound R4-C'],
  },
};

// Helper to build a result line.
const L = (email, ranks, skins, linkable, banned) =>
  `${email}:pw | User: U | Lvl: 100 | Items: 9 | Credits: 0 | Renown: 0 | Ranks: ${ranks} | Skins: ${skins} | Linkable: ${linkable} | Banned: ${banned} | 2FA: N | EmailVerified: Y | PhoneVerified: Y | LastPlayed: — | Profile: -`;

const lines = [
  L('champ@x.com', 'Champion (S20)', '—', 'XBX/PSN', 'N'),               // -> rank Champion
  L('glac@x.com', '—', '3x Glacier', 'PSN', 'N'),                        // -> item Glacier
  L('myst@x.com', '—', '1x Heart Attack', 'XBX', 'N'),                   // -> Mystery Items
  L('ban-obs@x.com', '—', '1x Obsidian', '—', 'Y'),                      // -> Banned VWI (banned + obsidian)
  L('ban-plain@x.com', 'Plat (S41)', '—', 'XBX/PSN', 'Y'),              // -> excluded (banned, Plat not a banned qualifier)
  L('nolink@x.com', '—', '2x Glacier', '—', 'N'),                        // -> excluded (not linkable)
  L('leftover@x.com', '—', '—', 'XBX', 'N'),                             // -> leftover (no rank/item)
  L('glac@x.com', '—', '9x Glacier', 'PSN', 'N'),                        // -> duplicate email, dropped
];

const r = VB.bucketAccounts(lines, meta);

assert.strictEqual(r.rankBuckets['Champion'].count, 1, 'champion bucket');
assert.strictEqual(r.itemBuckets['Glacier'].count, 1, 'glacier bucket');
assert.strictEqual(r.itemBuckets['Mystery Items'].count, 1, 'mystery bucket');
assert.strictEqual(r.bannedBucket.count, 1, 'banned vwi bucket');
assert.strictEqual(r.stats.duplicates, 1, 'one duplicate dropped');
assert.strictEqual(r.stats.excluded, 2, 'two excluded (banned-plain + nolink)');
assert.strictEqual(r.leftovers['No VWI — Lvl above 50'].count, 1, 'leftover counted');
assert.strictEqual(r.stats.vwiTotal, 4, 'champ+glacier+mystery+banned = 4 vwi');

// A rank ALWAYS beats an item for non-banned accounts.
const r2 = VB.bucketAccounts([L('a@x.com', 'Champion (S20)', '5x Glacier', 'PSN', 'N')], meta);
assert.strictEqual(r2.rankBuckets['Champion'].count, 1, 'rank beats item');
assert.strictEqual(r2.itemBuckets['Glacier'].count, 0, 'item not double-counted');

console.log('OK test-vwi-buckets');
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node scripts/test-vwi-buckets.js`
Expected: FAIL — `Cannot find module '../public/js/vwiBuckets.js'`.

- [ ] **Step 3: Create `public/js/vwiBuckets.js`**

```js
// VWI sorter classification — single source of truth shared by the browser
// (admin.html sorter) and node test scripts. Pure: no DOM, no I/O.
//
// UMD: require() in node, or window.VwiBuckets in the browser.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.VwiBuckets = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function extractField(line, label) {
    const re = new RegExp('\\|\\s*' + label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ':\\s*([^|]*)', 'i');
    const m = line.match(re);
    return m ? m[1].trim() : '';
  }
  function getItemsList(line) {
    const raw = extractField(line, 'Skins');
    if (!raw || raw === '—' || raw === '-') return [];
    return raw.split(',').map(s => s.replace(/^\s*\d+\s*[×x]\s*/, '').trim()).filter(Boolean);
  }
  function getRanksList(line) {
    const raw = extractField(line, 'Ranks');
    if (!raw || raw === '—') return [];
    return raw.split(',').map(r => r.trim().split(' (')[0].trim()).filter(Boolean);
  }
  function getLevel(line) { return parseInt(extractField(line, 'Lvl'), 10); }
  function isLinkable(line) { return /XBX|PSN|XBOX|PLAYSTATION/i.test(extractField(line, 'Linkable')); }
  function isBanned(line) { return /^(y|yes|true|banned|1)$/i.test(extractField(line, 'Banned')); }
  function isValidLine(line) { return line.includes('| User: ') && line.includes('| Lvl: '); }
  function canLinkPsn(line) { return /PSN|PLAYSTATION/i.test(extractField(line, 'Linkable')); }
  function canLinkXbx(line) { return /XBX|XBOX/i.test(extractField(line, 'Linkable')); }

  // Classify every line into exactly one bucket. Priority:
  //   banned-with-qualifier > rank > named item > mystery item > leftover.
  // Banned accounts ignore the linkable requirement (sold for cosmetics).
  function bucketAccounts(linesArr, meta) {
    const ranksOrder = meta.ranks || [];
    const named = meta.namedItemBuckets || [];
    const bannedVwi = meta.bannedVwi || { ranks: [], items: [] };

    const rankBuckets = {};
    ranksOrder.forEach(r => rankBuckets[r] = { count: 0, lines: [] });
    const itemBuckets = {};
    named.forEach(i => itemBuckets[i] = { count: 0, lines: [] });
    itemBuckets['Mystery Items'] = { count: 0, lines: [] };
    const bannedBucket = { count: 0, lines: [] };
    const leftovers = {
      'No VWI — Lvl 50 & below': { count: 0, lines: [] },
      'No VWI — Lvl above 50': { count: 0, lines: [] },
    };

    let vwiTotal = 0, valid = 0, excluded = 0, noLvlCount = 0, duplicates = 0;
    const seen = new Set();

    for (let raw of linesArr) {
      const line = (raw || '').replace(/\r$/, '');
      if (!line || !isValidLine(line)) continue;
      const email = line.split('|')[0].split(':')[0].trim().toLowerCase();
      if (email) { if (seen.has(email)) { duplicates++; continue; } seen.add(email); }
      valid++;

      const ranks = getRanksList(line);
      const items = getItemsList(line);

      if (isBanned(line)) {
        const q = bannedVwi.ranks.some(r => ranks.includes(r)) || bannedVwi.items.some(i => items.includes(i));
        if (q) { vwiTotal++; bannedBucket.count++; bannedBucket.lines.push(line); }
        else excluded++;
        continue;
      }
      if (!isLinkable(line)) { excluded++; continue; }

      const highestRank = ranksOrder.find(r => ranks.includes(r));
      if (highestRank) { vwiTotal++; rankBuckets[highestRank].count++; rankBuckets[highestRank].lines.push(line); continue; }

      const topNamed = named.find(i => items.includes(i));
      if (topNamed) { vwiTotal++; itemBuckets[topNamed].count++; itemBuckets[topNamed].lines.push(line); continue; }

      if (items.length) { vwiTotal++; itemBuckets['Mystery Items'].count++; itemBuckets['Mystery Items'].lines.push(line); continue; }

      const lvl = getLevel(line);
      if (isNaN(lvl)) { noLvlCount++; continue; }
      const key = lvl <= 50 ? 'No VWI — Lvl 50 & below' : 'No VWI — Lvl above 50';
      leftovers[key].count++; leftovers[key].lines.push(line);
    }

    return {
      rankBuckets, itemBuckets, bannedBucket, leftovers,
      stats: { vwiTotal, valid, excluded, noLvlCount, duplicates },
    };
  }

  return {
    bucketAccounts,
    extractField, getItemsList, getRanksList, getLevel,
    isLinkable, isBanned, isValidLine, canLinkPsn, canLinkXbx,
  };
});
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node scripts/test-vwi-buckets.js`
Expected: `OK test-vwi-buckets`

- [ ] **Step 5: Commit**

```bash
git add public/js/vwiBuckets.js scripts/test-vwi-buckets.js
git commit -m "feat(vwi): shared UMD bucket classifier (mystery collapse + banned vwi)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Wire the sorter UI to the module + Banned-VWI bucket

**Files:**
- Modify: `public/admin.html` (HTML container ~700-707; JS ~974-1148)

- [ ] **Step 1: Add the script include**

In `<head>` (or just before the existing sorter `<script>` block), add:

```html
<script src="/js/vwiBuckets.js"></script>
```

- [ ] **Step 2: Add the Banned-VWI container**

In the `#vwi-results` block (admin.html:700-707), after the items row (`<div id="vwi-items" ...>`'s parent), add a banned section before the leftovers header:

```html
      <div class="vwi-h" style="margin-top: 1rem;">🚫 Banned VWI (banned but valuable)</div>
      <div id="vwi-banned" class="vwi-list"></div>
```

- [ ] **Step 3: Update the meta default fallback**

Replace the `loadVwiMeta` fallbacks (admin.html:979-980) so a fetch failure still has the new shape:

```js
        if (resp.ok) vwiMeta = await resp.json();
        else vwiMeta = { ranks: ['Champion','Diamond','Emerald','Plat'], items: ['Glacier','Obsidian'], namedItemBuckets: ['Silver GO4 Charm','Gold GO4 Charm','Obsidian','Chroma Streaks','Glacier'], bannedVwi: { ranks: ['Champion','Diamond'], items: ['Chroma Streaks','Obsidian','Silver GO4 Charm','Gold GO4 Charm','Spellbound R4-C'] } };
      } catch(e) { console.warn(e); vwiMeta = { ranks: ['Champion','Diamond','Emerald','Plat'], items: ['Glacier','Obsidian'], namedItemBuckets: ['Silver GO4 Charm','Gold GO4 Charm','Obsidian','Chroma Streaks','Glacier'], bannedVwi: { ranks: ['Champion','Diamond'], items: ['Chroma Streaks','Obsidian','Silver GO4 Charm','Gold GO4 Charm','Spellbound R4-C'] } }; }
```

- [ ] **Step 4: Replace the inline classifiers with the module**

Delete the inline helper functions `extractField`, `getItemsList`, `getRanksList`, `getLevel`, `isLinkable`, `isBanned`, `isValidLine`, `analyzeVwiLines`, `canLinkPsn`, `canLinkXbx` (admin.html ~983-1049) and replace `analyzeVwiLines` usage. Keep `downloadLines` and `renderVwiBuckets`. Add thin aliases so `renderVwiBuckets` still works:

```js
    const canLinkPsn = (l) => VwiBuckets.canLinkPsn(l);
    const canLinkXbx = (l) => VwiBuckets.canLinkXbx(l);
```

- [ ] **Step 5: Update `runVwiAnalysis` to call the module + render banned**

Replace `runVwiAnalysis` (admin.html ~1128-1148) with:

```js
    function runVwiAnalysis(textContent) {
      const lines = textContent.split(/\r?\n/);
      const msgDiv = $('#vwi-msg');
      msgDiv.className = 'grant-msg';
      const { rankBuckets, itemBuckets, bannedBucket, leftovers, stats } = VwiBuckets.bucketAccounts(lines, vwiMeta);
      const { vwiTotal, valid, excluded, noLvlCount, duplicates } = stats;
      if (valid === 0) {
        msgDiv.className = 'grant-msg err';
        msgDiv.textContent = '❌ No valid result lines found (expected "| User: " format).';
        $('#vwi-results').style.display = 'none';
        return;
      }
      renderVwiBuckets('vwi-ranks', rankBuckets, 'rank');
      renderVwiBuckets('vwi-items', itemBuckets, 'item');
      renderVwiBuckets('vwi-banned', { 'Banned VWI': bannedBucket }, 'banned');
      renderVwiBuckets('vwi-leftovers', leftovers, 'novwi');
      const sortedCount = valid - excluded;
      const nonVwiCount = sortedCount - vwiTotal;
      $('#vwi-total').innerHTML = `${vwiTotal.toLocaleString()} VWI accounts · ${nonVwiCount.toLocaleString()} non-VWI · ${excluded.toLocaleString()} skipped (banned/unlinkable)${duplicates ? ` · ${duplicates.toLocaleString()} duplicate(s) removed` : ''}${noLvlCount ? ` · ${noLvlCount} missing level` : ''}<br>📄 ${valid.toLocaleString()} unique valid account(s). Rank beats item; banned-but-valuable go to Banned VWI.`;
      $('#vwi-results').style.display = 'block';
      msgDiv.className = 'grant-msg ok';
      msgDiv.textContent = `✓ Analysis complete. ${vwiTotal} VWI accounts found.`;
    }
```

- [ ] **Step 6: Sanity-check the browser path with a headless DOM-free simulation**

The module is already unit-tested (Task 3). Confirm admin.html has no leftover references to the deleted helpers:

Run: `node -e "const s=require('fs').readFileSync('public/admin.html','utf8'); const bad=['function analyzeVwiLines','function getItemsList','function isBanned(']; for(const b of bad) if(s.includes(b)) throw new Error('leftover: '+b); if(!s.includes('/js/vwiBuckets.js')) throw new Error('script not included'); if(!s.includes('vwi-banned')) throw new Error('no banned container'); console.log('admin-html-ok');"`
Expected: `admin-html-ok`

- [ ] **Step 7: Manual browser verification**

Start the server (`node server.js`), open `/admin` as owner, paste these two lines into the sorter and click Analyze:

```
a@a.com:p | User: U | Lvl: 100 | Items: 9 | Credits: 0 | Renown: 0 | Ranks: Champion (S20) | Skins: — | Linkable: XBX/PSN | Banned: N | 2FA: N | EmailVerified: Y | PhoneVerified: Y | LastPlayed: — | Profile: -
b@b.com:p | User: U | Lvl: 100 | Items: 9 | Credits: 0 | Renown: 0 | Ranks: — | Skins: 1x Obsidian | Linkable: — | Banned: Y | 2FA: N | EmailVerified: Y | PhoneVerified: Y | LastPlayed: — | Profile: -
```

Expected: 1 in Champion rank bucket, 1 in Banned VWI bucket, total "2 VWI accounts".

- [ ] **Step 8: Commit**

```bash
git add public/admin.html
git commit -m "feat(vwi): sorter uses shared classifier + Banned VWI bucket

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Full-suite run + final commit

- [ ] **Step 1: Run both test scripts**

Run: `node scripts/test-skincheck-vwi.js && node scripts/test-vwi-buckets.js`
Expected: `OK test-skincheck-vwi` then `OK test-vwi-buckets`.

- [ ] **Step 2: Confirm clean tree (no stray credential/proxy files staged)**

Run: `git status --porcelain`
Expected: only intended files touched; `accounts*.txt`, `proxies*.txt`, `public/downloads/output/` remain untracked and UNstaged.

- [ ] **Step 3: Tag the phase**

```bash
git commit --allow-empty -m "chore(vwi): phase 1 (sorter rules) complete

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-review notes (coverage vs spec §Phase 1)

- New families (Heart Attack/Lucky/Ralphie/Board Game/Spellbound R4-C) → Task 1. ✓
- Dust Line 8/8 → Task 1 (`WANTED_SKIN_MINS['Dust Line']=8`, threshold test). ✓
- Named-only buckets + Mystery Items collapse → Task 3 (`bucketAccounts`). ✓
- Banned-VWI bucket (qualifiers, ignores linkable) → Task 3 + Task 4. ✓
- Meta source of truth → Task 1 (`vwiMeta()`) + Task 2 (route). ✓
- Gold Dust already wanted; surfaces via `items` automatically. ✓
- Desktop parity → explicitly deferred (spec §1.4).
