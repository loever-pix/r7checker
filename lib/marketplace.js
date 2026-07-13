// Ubisoft Marketplace image resolver.
//
// The R6 Marketplace exposes every tradeable cosmetic as { itemId, name,
// assetUrl }, keyed by the SAME UUIDs as a player's inventory. We fetch the
// full catalog ONCE with a marketplace-authorized session and cache it to
// data/marketplace-images.json; the locker then uses it to fill item images
// that Ubisoft's own inventory details didn't include.
//
// Building the catalog needs an account with trading enabled (clearance 25 +
// 2FA + marketplace opt-in). The catalog is global, so one fetch covers
// everyone:  node scripts/build-marketplace.js "email:password"

const path = require('path');
const fs = require('fs');
const { proxiedRequest } = require('./proxyClient');

const ENDPOINT  = 'https://public-ubiservices.ubi.com/v1/profiles/me/uplay/graphql';
const SPACE_ID  = '0d2ae42d-4c27-4cb7-af6c-2099062302bb';
const MP_APP_ID = '80a4a0e8-8797-440f-8f4c-eaba87d0fdda';
const UA        = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:151.0) Gecko/20100101 Firefox/151.0';
const CATALOG_PATH = path.join(__dirname, '..', 'data', 'marketplace-images.json');

// Minimal slice of the marketplace GetMarketableItems query — just the fields
// we need to map an item UUID to its name + image.
const QUERY = `query GetMarketableItems($spaceId: String!, $limit: Int!, $offset: Int) {
  game(spaceId: $spaceId) {
    id
    marketableItems(limit: $limit, offset: $offset, withMarketData: false) {
      nodes { item { itemId name assetUrl type } }
      totalCount
    }
  }
}`;

// ── Runtime lookup (used by the locker / lib/player.js) ────────────────────
let _cache = { mtime: 0, map: {} };
function loadCatalog() {
  try {
    const stat = fs.statSync(CATALOG_PATH);
    if (stat.mtimeMs !== _cache.mtime) {
      const data = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));
      _cache = { mtime: stat.mtimeMs, map: data.items || {} };
    }
  } catch { /* catalog not built yet — fine */ }
  return _cache.map;
}

function getImage(itemId) {
  if (!itemId) return null;
  const e = loadCatalog()[itemId];
  if (!e) return null;
  return typeof e === 'string' ? e : (e.image || null);
}

function getName(itemId) {
  if (!itemId) return null;
  const e = loadCatalog()[itemId];
  return (e && typeof e === 'object') ? (e.name || null) : null;
}

function isAvailable() { return Object.keys(loadCatalog()).length > 0; }

// ── Catalog builder (used by scripts/build-marketplace.js) ─────────────────
async function fetchPage(ticket, sessionId, offset, limit) {
  const r = await proxiedRequest({
    method: 'post', url: ENDPOINT,
    headers: {
      'Content-Type':   'application/json',
      'Authorization':  `Ubi_v1 t=${ticket}`,
      'Ubi-AppId':      MP_APP_ID,
      'Ubi-SessionId':  sessionId || '',
      'Ubi-LocaleCode': 'en-US',
      'User-Agent':     UA,
    },
    data: { operationName: 'GetMarketableItems', variables: { spaceId: SPACE_ID, limit, offset }, query: QUERY },
    validateStatus: () => true, timeout: 25000,
  });
  const gqlErr = r.data?.errors?.[0]?.message;
  if (gqlErr) { const e = new Error(gqlErr); e.gql = true; throw e; }
  return r.data?.data?.game?.marketableItems || { nodes: [], totalCount: 0 };
}

// Paginate the whole catalog into { itemId: { name, image } }.
async function fetchCatalog(ticket, sessionId, onProgress) {
  const items = {};
  const LIMIT = 100;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  let offset = 0, total = Infinity;

  while (offset < total) {
    let page = null;
    for (let attempt = 1; attempt <= 4; attempt++) {
      try { page = await fetchPage(ticket, sessionId, offset, LIMIT); break; }
      catch (e) {
        if (e.gql) throw e;                 // hard GraphQL/authorization error — stop
        await sleep(400);                   // transient/network — retry (fresh IP)
      }
    }
    if (!page) throw new Error(`marketplace fetch failed at offset ${offset}`);
    total = page.totalCount || 0;
    for (const n of (page.nodes || [])) {
      const it = n.item;
      if (it && it.itemId && it.assetUrl) items[it.itemId] = { name: it.name || '', image: it.assetUrl };
    }
    if (onProgress) onProgress(Object.keys(items).length, total);
    if (!page.nodes || page.nodes.length === 0) break;
    offset += LIMIT;
    await sleep(150);
  }
  return items;
}

function writeCatalog(items) {
  fs.mkdirSync(path.dirname(CATALOG_PATH), { recursive: true });
  fs.writeFileSync(CATALOG_PATH, JSON.stringify({ count: Object.keys(items).length, items }));
  return CATALOG_PATH;
}

module.exports = { getImage, getName, isAvailable, fetchCatalog, writeCatalog, CATALOG_PATH };
