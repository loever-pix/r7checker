// Ubisoft Items + Localizations catalog.
//
// Two endpoints (verified live):
//
//   GET /v1/spaces/:spaceId/items/all
//     → { lastModified, compressedItems, sha1, sha256, md5 }
//       compressedItems is base64(gzip(JSON array)). Each item:
//         { itemId, nameId, type, tags[],
//           localizations:{ nameStringId, ... },
//           assets:{ visualAssetId, visualAssetUrl } }
//       This gives us the IMAGE immediately + the name-localization id.
//
//   GET /v1/spaces/:spaceId/localizations/strings?localizedStringIds=a,b,c&locale=en-US
//     → { localizedStrings:[ { localizedStringId, displayString } ] }
//       HARD LIMIT: max 20 ids per request.
//
// Strategy: items/all is fetched once (24h TTL) and gives every item's image
// + nameStringId. Names are resolved LAZILY for the specific items a player
// owns (~60 unique strings = ~3 requests) and cached, so the catalog fills
// in naturally without 267 upfront requests.

const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');
const { ubiRequest } = require('./api');
const { BASE_HEADERS } = require('./auth');

const PC_SPACE_ID        = '5172a557-50b5-4665-b7db-e3f2e8c5041d';
const CROSSPLAY_SPACE_ID = '0d2ae42d-4c27-4cb7-af6c-2099062302bb';
const GENOME_ID          = '85c31714-0941-4876-a18d-2c7e9dce8d40';
const LOC_MAX_IDS        = 20;   // server hard limit

const CACHE_DIR  = process.env.CACHE_DIR || path.join(__dirname, '..', '.cache');
const CACHE_PATH = path.join(CACHE_DIR, 'ubisoft-catalog.json');
const TTL_MS          = 24 * 60 * 60 * 1000; // items/all freshness
const REFRESH_SOFT_MS = 12 * 60 * 60 * 1000;

// catalog = { ts, items: { itemId: { nameStringId, image, name? } },
//             names: { stringId: displayName } }
let _memCache = null;
let _refreshing = false;

function authHeaders(ticket, sessionId, appId) {
  return {
    ...BASE_HEADERS,
    'Ubi-AppId':      appId || BASE_HEADERS['Ubi-AppId'],
    Authorization:    `Ubi_v1 t=${ticket}`,
    'Ubi-SessionId':  sessionId || '',
    'GenomeId':       GENOME_ID,
    'Ubi-LocaleCode': 'en-US',
    'Ubi-RequestedPlatformType': 'uplay',
  };
}

// ── Disk cache ────────────────────────────────────────────────────────────
function loadFromDisk() {
  try {
    if (!fs.existsSync(CACHE_PATH)) return null;
    const raw = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
    if (!raw || typeof raw.items !== 'object' || !raw.ts) return null;
    if (!raw.names) raw.names = {};
    return raw;
  } catch { return null; }
}
function writeToDisk(catalog) {
  try {
    fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
    const tmp = CACHE_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(catalog));
    fs.renameSync(tmp, CACHE_PATH);
  } catch (e) { console.warn('[ubisoftItems] disk write failed:', e.message); }
}
function getCached() {
  if (_memCache) return _memCache;
  _memCache = loadFromDisk();
  return _memCache;
}
function isStale(catalog)     { return !catalog || Date.now() - catalog.ts > TTL_MS; }
function isSoftStale(catalog) { return !catalog || Date.now() - catalog.ts > REFRESH_SOFT_MS; }

// Title-case the ALL-CAPS Ubisoft display strings while preserving model
// numbers (contain a digit) and 2-letter acronyms (HK).
function prettifyName(s) {
  if (!s || typeof s !== 'string') return s;
  if (s !== s.toUpperCase()) return s; // already mixed-case → trust it
  return s.toLowerCase().replace(/[^\s()\/]+/g, (w) => {
    if (/\d/.test(w)) return w.toUpperCase();
    if (w.length === 2 && /^[a-z]+$/.test(w)) return w.toUpperCase();
    return w.charAt(0).toUpperCase() + w.slice(1);
  });
}

// ── items/all ─────────────────────────────────────────────────────────────
async function fetchItemsAll(spaceId, ticket, sessionId, appId) {
  const url = `https://public-ubiservices.ubi.com/v1/spaces/${spaceId}/items/all`;
  const res = await ubiRequest({
    method: 'get', url, headers: authHeaders(ticket, sessionId, appId),
    validateStatus: () => true, timeout: 20000,
  });
  if (res.status !== 200) {
    const e = new Error(`items/all ${spaceId.slice(0,8)}: HTTP ${res.status}`);
    e.status = res.status; throw e;
  }
  const d = res.data;
  if (d && typeof d.compressedItems === 'string') {
    const gz = Buffer.from(d.compressedItems, 'base64');
    const parsed = JSON.parse(zlib.gunzipSync(gz).toString('utf8'));
    return Array.isArray(parsed) ? parsed : (parsed.items || []);
  }
  if (Array.isArray(d)) return d;
  return d?.items || [];
}

// ── localizations/strings (≤20 ids per call) ───────────────────────────────
async function fetchLocalizations(spaceId, idsBatch, ticket, sessionId, appId) {
  const idParam = idsBatch.map(encodeURIComponent).join(','); // literal commas
  const url = `https://public-ubiservices.ubi.com/v1/spaces/${spaceId}/localizations/strings?localizedStringIds=${idParam}&locale=en-US`;
  const res = await ubiRequest({
    method: 'get', url, headers: authHeaders(ticket, sessionId, appId),
    validateStatus: () => true, timeout: 20000,
  });
  if (res.status !== 200) {
    const e = new Error(`localizations: HTTP ${res.status}`);
    e.status = res.status; throw e;
  }
  const out = {};
  for (const entry of (res.data?.localizedStrings || [])) {
    if (entry.localizedStringId && entry.displayString != null) {
      out[entry.localizedStringId] = entry.displayString;
    }
  }
  return out;
}

// ── Refresh items/all → catalog.items (image + nameStringId). No name
//    resolution here; that's lazy (resolveNames). ────────────────────────────
async function refreshCatalog(ticket, sessionId, appId) {
  if (_refreshing) return getCached();
  _refreshing = true;
  try {
    let raw = [];
    try {
      raw = await fetchItemsAll(PC_SPACE_ID, ticket, sessionId, appId);
    } catch (e) {
      console.warn('[ubisoftItems] items/all failed:', e.message);
      return getCached();
    }
    if (!raw.length) return getCached();

    const prev  = getCached();
    const items = {};
    for (const it of raw) {
      const id = it.itemId || it.id;
      if (!id) continue;
      items[id] = {
        nameStringId: it.localizations?.nameStringId || null,
        image:        it.assets?.visualAssetUrl || null,
        // Preserve any previously resolved name for this item.
        name:         prev?.items?.[id]?.name || null,
      };
    }
    const catalog = { ts: Date.now(), items, names: prev?.names || {} };
    writeToDisk(catalog);
    _memCache = catalog;
    console.log(`[ubisoftItems] items/all cached: ${Object.keys(items).length} items`);
    return catalog;
  } finally {
    _refreshing = false;
  }
}

// ── Resolve display names for a specific set of owned item ids. Batches the
//    unresolved nameStringIds (≤20/req) and caches them. ──────────────────────
async function resolveNames(itemIds, ticket, sessionId, appId) {
  const cat = getCached();
  if (!cat) return 0;

  // Collect nameStringIds we don't have a name for yet.
  const need = new Set();
  for (const id of itemIds) {
    const meta = cat.items[id];
    if (meta?.nameStringId && !cat.names[meta.nameStringId]) need.add(meta.nameStringId);
  }
  if (!need.size) { applyNames(cat); return 0; }

  const ids = [...need];
  let resolved = 0;
  for (let i = 0; i < ids.length; i += LOC_MAX_IDS) {
    const chunk = ids.slice(i, i + LOC_MAX_IDS);
    for (const spaceId of [PC_SPACE_ID, CROSSPLAY_SPACE_ID]) {
      try {
        const partial = await fetchLocalizations(spaceId, chunk, ticket, sessionId, appId);
        for (const [k, v] of Object.entries(partial)) {
          cat.names[k] = prettifyName(v);
          resolved++;
        }
        break; // success on this space
      } catch { /* try other space */ }
    }
  }
  applyNames(cat);
  writeToDisk(cat);
  console.log(`[ubisoftItems] resolved ${resolved} new names (catalog now ${Object.keys(cat.names).length})`);
  return resolved;
}

// Fold resolved names from catalog.names back onto catalog.items[].name.
function applyNames(cat) {
  for (const id of Object.keys(cat.items)) {
    const m = cat.items[id];
    if (m.nameStringId && cat.names[m.nameStringId]) m.name = cat.names[m.nameStringId];
  }
}

// Ensure the catalog exists + names for these owned items are resolved.
// Single call used by player.js during a check (has a fresh ticket).
async function ensureForItems(itemIds, ticket, sessionId, appId) {
  let cat = getCached();
  if (isStale(cat)) {
    cat = await Promise.race([
      refreshCatalog(ticket, sessionId, appId),
      new Promise(r => setTimeout(() => r(getCached()), 25000)),
    ]);
  }
  if (!cat) return;
  await resolveNames(itemIds, ticket, sessionId, appId);
}

function maybeRefreshInBackground(ticket, sessionId, appId) {
  const cached = getCached();
  if (cached && !isSoftStale(cached)) return;
  refreshCatalog(ticket, sessionId, appId).catch(() => {});
}

function lookupItem(itemId) {
  const c = getCached();
  if (!c || !c.items) return null;
  const m = c.items[itemId];
  if (!m) return null;
  return { name: m.name || null, image: m.image || null };
}

module.exports = {
  refreshCatalog,
  resolveNames,
  ensureForItems,
  maybeRefreshInBackground,
  lookupItem,
  getCached,
  isStale,
  prettifyName,
  PC_SPACE_ID,
  CROSSPLAY_SPACE_ID,
};
