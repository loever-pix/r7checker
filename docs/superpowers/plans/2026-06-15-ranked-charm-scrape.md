# Ranked Charm Scrape Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generate ranked charm image data from `r6.skin` and make profile and bulk ranked charm displays use it before falling back to the existing catalog or rank badges.

**Architecture:** Add a generated `data/ranked-charm-images.json` file and a repeatable `scripts/scrape-ranked-charms.js` scraper. Keep `lib/player.js` as the single ranked charm generation path, but extend `rankedCharmImage()` so the generated map wins over `lib/skins_cache.json`.

**Tech Stack:** Node.js CommonJS, built-in `assert`, built-in `fetch`, existing `lib/player.js` ranked season data, existing project script style.

---

## File Structure

- Create `data/ranked-charm-images.json`: generated ranked charm map keyed by `tier|season`.
- Create `scripts/scrape-ranked-charms.js`: one-shot scraper for the `r6.skin` Meilisearch API.
- Create `scripts/test-ranked-charm-images.js`: focused Node assertions for generated map priority and fallback.
- Modify `lib/player.js`: load generated ranked charm image data and expose small test helpers.

## Task 1: Add Failing Runtime Lookup Test

**Files:**
- Create: `scripts/test-ranked-charm-images.js`
- Read/write during test: `data/ranked-charm-images.json`
- Later modify: `lib/player.js`

- [ ] **Step 1: Write the failing test**

Create `scripts/test-ranked-charm-images.js` with:

```js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const dataPath = path.join(__dirname, '..', 'data', 'ranked-charm-images.json');
const originalExists = fs.existsSync(dataPath);
const original = originalExists ? fs.readFileSync(dataPath, 'utf8') : null;

function writeGeneratedData() {
  fs.mkdirSync(path.dirname(dataPath), { recursive: true });
  fs.writeFileSync(dataPath, JSON.stringify({
    _comment: 'Test data written by scripts/test-ranked-charm-images.js',
    _lastUpdated: '2026-06-15',
    items: {
      'platinum|test season': {
        name: 'Platinum (Test Season)',
        tier: 'platinum',
        season: 'Test Season',
        image: 'https://siegeskins.com/cdn/charms/generated-object.png?imwidth=256',
        source: 'test',
      },
      'gold|string season': 'https://siegeskins.com/cdn/charms/generated-string.png?imwidth=256',
    },
    missing: [],
  }, null, 2));
}

function restoreGeneratedData() {
  if (originalExists) fs.writeFileSync(dataPath, original);
  else if (fs.existsSync(dataPath)) fs.unlinkSync(dataPath);
}

function loadFreshPlayer() {
  const playerPath = require.resolve('../lib/player');
  delete require.cache[playerPath];
  return require('../lib/player');
}

try {
  writeGeneratedData();
  const player = loadFreshPlayer();

  const objectUrl = player._test.rankedCharmImage('platinum', 'Test Season');
  assert.strictEqual(
    objectUrl,
    'https://siegeskins.com/cdn/charms/generated-object.png?imwidth=256',
    'object entries from data/ranked-charm-images.json should win'
  );

  const stringUrl = player._test.rankedCharmImage('gold', 'String Season');
  assert.strictEqual(
    stringUrl,
    'https://siegeskins.com/cdn/charms/generated-string.png?imwidth=256',
    'string entries from data/ranked-charm-images.json should be supported'
  );

  const charms = player._test.buildRankedCharms([
    { season: 99, seasonName: 'Test Season', rankTier: 'platinum' },
  ]);
  const platinum = charms.find(c => c.name === 'Platinum (Test Season)');
  assert(platinum, 'expected generated Platinum (Test Season) charm');
  assert(
    decodeURIComponent(platinum.image).includes('generated-object.png'),
    `expected generated charm image to flow through buildRankedCharms, got ${platinum.image}`
  );

  const fallback = player._test.rankedCharmImage('platinum', 'North Star');
  assert(
    fallback && fallback.includes('/cdn/charms/'),
    `expected existing skins_cache fallback for Platinum (North Star), got ${fallback}`
  );

  console.log('ranked charm image tests passed');
} finally {
  restoreGeneratedData();
}
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
node scripts/test-ranked-charm-images.js
```

Expected: FAIL with an assertion that `rankedCharmImage('platinum', 'Test Season')` returned `null` or a non-generated value.

- [ ] **Step 3: Commit the failing test**

```powershell
git add scripts/test-ranked-charm-images.js
git commit -m "test: cover generated ranked charm images"
```

## Task 2: Load Generated Ranked Charm Map In Player Data

**Files:**
- Modify: `lib/player.js`
- Test: `scripts/test-ranked-charm-images.js`

- [ ] **Step 1: Add generated-map loader near the ranked charm art index**

In `lib/player.js`, directly before the existing `_rankedCharmArt` declaration, add:

```js
function normalizeRankedCharmKey(tier, seasonName) {
  if (!tier || !seasonName) return null;
  return `${String(tier).toLowerCase().replace(/s$/, '').trim()}|${String(seasonName).toLowerCase().trim()}`;
}

function loadGeneratedRankedCharmArt() {
  const idx = {};
  try {
    const generated = require('../data/ranked-charm-images.json');
    const items = generated && generated.items && typeof generated.items === 'object'
      ? generated.items
      : {};
    for (const [key, value] of Object.entries(items)) {
      const image = typeof value === 'string' ? value : value && value.image;
      if (typeof image === 'string' && image.trim().startsWith('http')) {
        idx[key.toLowerCase().trim()] = image.trim();
      }
    }
  } catch {}
  return idx;
}

const _generatedRankedCharmArt = loadGeneratedRankedCharmArt();
```

- [ ] **Step 2: Update catalog index key creation**

Inside `_rankedCharmArt`, replace:

```js
idx[`${tier}|${m[2].toLowerCase().trim()}`] = v.image;
```

with:

```js
const key = normalizeRankedCharmKey(tier, m[2]);
if (key) idx[key] = v.image;
```

- [ ] **Step 3: Update `rankedCharmImage()` lookup order**

Replace the existing function with:

```js
function rankedCharmImage(tier, seasonName) {
  const key = normalizeRankedCharmKey(tier, seasonName);
  if (!key) return null;
  return _generatedRankedCharmArt[key] || _rankedCharmArt[key] || null;
}
```

- [ ] **Step 4: Export test helper**

At the bottom of `lib/player.js`, replace the existing `module.exports` line with:

```js
module.exports = {
  getPlayerData,
  _test: {
    mergeSeasonRanks,
    preserveFromCache,
    readCacheRaw,
    writeCache,
    eraCorrectRank,
    getRankV6,
    rpToRankId,
    buildRankedCharms,
    rankedCharmImage,
    normalizeRankedCharmKey,
    loadGeneratedRankedCharmArt,
  },
};
```

- [ ] **Step 5: Run focused test**

Run:

```powershell
node scripts/test-ranked-charm-images.js
```

Expected: PASS and prints `ranked charm image tests passed`.

- [ ] **Step 6: Run existing related test**

Run:

```powershell
node scripts/test-profile-and-sellauth-bugfixes.js
```

Expected: PASS and prints `profile/sellauth bugfix tests passed`.

- [ ] **Step 7: Commit runtime lookup change**

```powershell
git add lib/player.js scripts/test-ranked-charm-images.js
git commit -m "feat: load generated ranked charm images"
```

## Task 3: Add Scraper And Seed Generated Data File

**Files:**
- Create: `scripts/scrape-ranked-charms.js`
- Create: `data/ranked-charm-images.json`
- Modify: `lib/player.js`

- [ ] **Step 1: Export season constants for the scraper**

At the bottom of `lib/player.js`, add `SEASON_NAMES`, `SEASON_CHAMPION`, and `SEASON_EMERALD` to the `_test` export block:

```js
    SEASON_NAMES,
    SEASON_CHAMPION,
    SEASON_EMERALD,
```

- [ ] **Step 2: Create initial generated data file**

Create `data/ranked-charm-images.json` with:

```json
{
  "_comment": "Generated by scripts/scrape-ranked-charms.js from r6.skin search results.",
  "_lastUpdated": "2026-06-15",
  "items": {},
  "missing": []
}
```

- [ ] **Step 3: Create scraper script**

Create `scripts/scrape-ranked-charms.js` with:

```js
#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const player = require('../lib/player');

const OUT = path.join(__dirname, '..', 'data', 'ranked-charm-images.json');
const SEARCH_URL = 'https://search.r6s.skin/indexes/skins/search';
const TOKEN = '46f803c7ecd3765ea248cc687b68793630455a0e0be5c4fee234e6238235c6e8';
const DRY_RUN = process.argv.includes('--dry-run');
const ONLY_SEASON = getArg('--season');
const ONLY_TIER = getArg('--tier');

const TIER_LABELS = {
  champion: 'Champion',
  diamond: 'Diamond',
  emerald: 'Emerald',
  platinum: 'Platinum',
  gold: 'Gold',
  silver: 'Silver',
  bronze: 'Bronze',
  copper: 'Copper',
};

const TIER_ORDER = Object.keys(TIER_LABELS);

function getArg(name) {
  const prefix = `${name}=`;
  const raw = process.argv.find(a => a.startsWith(prefix));
  return raw ? raw.slice(prefix.length).trim() : '';
}

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function normalizeKey(tier, season) {
  return `${normalizeText(tier).replace(/s$/, '')}|${normalizeText(season)}`;
}

function isTierAvailable(seasonNum, tier) {
  if (tier === 'champion' && seasonNum < player._test.SEASON_CHAMPION) return false;
  if (tier === 'emerald' && seasonNum < player._test.SEASON_EMERALD) return false;
  return true;
}

function buildQueries(tier, season) {
  const label = TIER_LABELS[tier];
  return [
    `${season} ${label} charm`,
    `${label} ${season}`,
    `ranked charm ${season} ${label}`,
  ];
}

function hitText(hit) {
  return normalizeText([
    hit.name,
    hit.description,
    hit.collection,
    hit.rarity,
    hit.type,
    hit.category,
    hit.id,
  ].filter(Boolean).join(' '));
}

function hitImage(hit) {
  return hit.url || hit.image || hit.asset || hit.icon || '';
}

function scoreHit(hit, tier, season) {
  const text = hitText(hit);
  const image = hitImage(hit);
  if (!image || !String(image).startsWith('http')) return -100;

  const tierText = normalizeText(TIER_LABELS[tier]);
  const seasonText = normalizeText(season);
  let score = 0;

  if (text.includes(tierText)) score += 50;
  if (text.includes(seasonText)) score += 50;
  if (text.includes('charm')) score += 25;
  if (text.includes('rank')) score += 15;
  if (normalizeText(hit.name).includes(tierText)) score += 15;
  if (normalizeText(hit.name).includes(seasonText)) score += 15;
  if (text.includes('background') || text.includes('card')) score -= 20;
  if (!text.includes(tierText) || !text.includes(seasonText)) score -= 100;

  return score;
}

async function search(query) {
  const res = await fetch(SEARCH_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify({ q: query, limit: 250, offset: 0 }),
  });
  if (!res.ok) throw new Error(`r6.skin search failed ${res.status} for ${query}`);
  const json = await res.json();
  return Array.isArray(json.hits) ? json.hits : [];
}

async function findCharm(tier, season) {
  const seen = new Map();
  for (const query of buildQueries(tier, season)) {
    const hits = await search(query);
    for (const hit of hits) {
      const key = `${hit.id || ''}|${hit.name || ''}|${hitImage(hit)}`;
      if (!seen.has(key)) seen.set(key, hit);
    }
  }

  const candidates = [...seen.values()]
    .map(hit => ({ hit, score: scoreHit(hit, tier, season) }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score || String(a.hit.name || '').localeCompare(String(b.hit.name || '')));

  return candidates[0] || null;
}

function loadExisting() {
  try {
    const raw = JSON.parse(fs.readFileSync(OUT, 'utf8'));
    return {
      _comment: raw._comment || 'Generated by scripts/scrape-ranked-charms.js from r6.skin search results.',
      _lastUpdated: raw._lastUpdated || new Date().toISOString().slice(0, 10),
      items: raw.items && typeof raw.items === 'object' ? raw.items : {},
      missing: Array.isArray(raw.missing) ? raw.missing : [],
    };
  } catch {
    return {
      _comment: 'Generated by scripts/scrape-ranked-charms.js from r6.skin search results.',
      _lastUpdated: new Date().toISOString().slice(0, 10),
      items: {},
      missing: [],
    };
  }
}

function writeOutput(data) {
  const sortedItems = {};
  for (const key of Object.keys(data.items).sort()) sortedItems[key] = data.items[key];
  const sortedMissing = data.missing.slice().sort((a, b) => a.key.localeCompare(b.key));
  const out = {
    _comment: 'Generated by scripts/scrape-ranked-charms.js from r6.skin search results.',
    _lastUpdated: new Date().toISOString().slice(0, 10),
    items: sortedItems,
    missing: sortedMissing,
  };
  if (!DRY_RUN) {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');
  }
  return out;
}

async function main() {
  const data = loadExisting();
  const missingByKey = new Map();
  let searched = 0;
  let found = 0;
  let missed = 0;

  for (const [seasonNumRaw, season] of Object.entries(player._test.SEASON_NAMES)) {
    const seasonNum = Number(seasonNumRaw);
    if (ONLY_SEASON && normalizeText(ONLY_SEASON) !== normalizeText(season) && ONLY_SEASON !== String(seasonNum)) continue;

    for (const tier of TIER_ORDER) {
      if (ONLY_TIER && normalizeText(ONLY_TIER).replace(/s$/, '') !== tier) continue;
      if (!isTierAvailable(seasonNum, tier)) continue;

      const key = normalizeKey(tier, season);
      searched++;

      try {
        const match = await findCharm(tier, season);
        if (match) {
          data.items[key] = {
            name: `${TIER_LABELS[tier]} (${season})`,
            tier,
            season,
            image: hitImage(match.hit),
            source: 'r6.skin',
            sourceName: match.hit.name || '',
            sourceId: match.hit.id || '',
            score: match.score,
          };
          found++;
          console.log(`[found] ${key} -> ${match.hit.name || hitImage(match.hit)}`);
        } else {
          missed++;
          missingByKey.set(key, { key, tier, season, reason: 'no matching r6.skin hit' });
          console.log(`[miss] ${key}`);
        }
      } catch (e) {
        missed++;
        missingByKey.set(key, { key, tier, season, reason: e.message });
        console.warn(`[error] ${key}: ${e.message}`);
      }
    }
  }

  data.missing = [...missingByKey.values()];
  const out = writeOutput(data);
  console.log('');
  console.log(`[ranked-charms] searched=${searched} found=${found} missing=${missed} totalSaved=${Object.keys(out.items).length}${DRY_RUN ? ' dryRun=true' : ''}`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
```

- [ ] **Step 4: Run scraper for one known recent charm in dry-run mode**

Run:

```powershell
node scripts/scrape-ranked-charms.js --dry-run --season="Silent Hunt" --tier=emerald
```

Expected: command exits 0 and prints either `[found] emerald|silent hunt` or `[miss] emerald|silent hunt`. If it prints `[error]`, inspect the status code and query before continuing.

- [ ] **Step 5: Run full scraper and write data**

Run:

```powershell
node scripts/scrape-ranked-charms.js
```

Expected: command exits 0, writes `data/ranked-charm-images.json`, and prints a summary with `searched=`, `found=`, `missing=`, and `totalSaved=`.

- [ ] **Step 6: Commit scraper and generated data**

```powershell
git add lib/player.js scripts/scrape-ranked-charms.js data/ranked-charm-images.json
git commit -m "feat: scrape ranked charm image data"
```

## Task 4: Verify End-To-End Ranked Charm Behavior

**Files:**
- Test: `scripts/test-ranked-charm-images.js`
- Test: `scripts/test-profile-and-sellauth-bugfixes.js`
- Optional read: `data/ranked-charm-images.json`

- [ ] **Step 1: Run focused ranked charm image test**

Run:

```powershell
node scripts/test-ranked-charm-images.js
```

Expected: PASS and prints `ranked charm image tests passed`.

- [ ] **Step 2: Run existing profile and SellAuth regression test**

Run:

```powershell
node scripts/test-profile-and-sellauth-bugfixes.js
```

Expected: PASS and prints `profile/sellauth bugfix tests passed`.

- [ ] **Step 3: Inspect generated data size**

Run:

```powershell
node -e "const d=require('./data/ranked-charm-images.json'); console.log({items:Object.keys(d.items||{}).length, missing:(d.missing||[]).length});"
```

Expected: prints an object where `items` is greater than 0. Record the count in the final implementation summary.

- [ ] **Step 4: Inspect representative current-season image flow**

Run:

```powershell
node -e "const p=require('./lib/player'); const c=p._test.buildRankedCharms([{season:41, seasonName:'Silent Hunt', rankTier:'emerald'}]); console.log(c.filter(x=>['Emerald (Silent Hunt)','Copper (Silent Hunt)'].includes(x.name)).map(x=>({name:x.name,image:x.image})));"
```

Expected: output includes `Emerald (Silent Hunt)` and `Copper (Silent Hunt)`. When generated data contains those keys, each image should include `/api/img?url=` and decode to an `r6.skin` or source CDN image URL rather than a rank badge URL.

- [ ] **Step 5: Commit verification-only fixes if needed**

If any verification step finds a code defect and a fix is made, run:

```powershell
git add lib/player.js scripts/scrape-ranked-charms.js scripts/test-ranked-charm-images.js data/ranked-charm-images.json
git commit -m "fix: verify ranked charm image generation"
```

If no files changed after verification, do not create a commit.

## Self-Review Notes

- Spec coverage: Tasks cover generated data, scraper behavior, player integration, tests, dry-run support, and runtime fallback.
- Runtime safety: `lib/player.js` continues when the generated data file is absent or malformed because the loader catches read/parse failures.
- Bulk/profile coverage: No bulk-specific code is needed because both surfaces already consume `buildRankedCharms()` output through player data.
