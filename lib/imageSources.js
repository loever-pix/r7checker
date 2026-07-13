// Image-source helpers. Tries multiple public CDNs and APIs to find an image
// for a given item ID before we fall back to a placeholder.
//
// Sources tried (in this order, with caching):
//   1. Ubisoft MtxAssetsDeployer (multiple spaces — handled in server.js proxy)
//   2. siegeskins.dev — community-curated skin database
//   3. r6.guide CDN — public profile images
//   4. simpsonresearch Siege_Skin_Checker raw GH files
//
// All hits are cached in-memory for 24h so we don't re-query externals.

const axios = require('axios');

const CACHE = new Map();
const CACHE_TTL = 24 * 60 * 60 * 1000;

function cached(key) {
  const v = CACHE.get(key);
  if (!v) return undefined;
  if (Date.now() - v.at > CACHE_TTL) { CACHE.delete(key); return undefined; }
  return v.url;
}
function cache(key, url) {
  CACHE.set(key, { url, at: Date.now() });
  // soft cap
  if (CACHE.size > 5000) {
    const drop = CACHE.size - 4500;
    let i = 0;
    for (const k of CACHE.keys()) { if (i++ >= drop) break; CACHE.delete(k); }
  }
}

// ── siegeskins.dev — community site, has profile/skin data ─────────────
// Their public endpoint exposes skin info by ID. We use it for items
// missing visualAssetUrl.
async function siegeSkinsLookup(itemId) {
  if (!itemId) return null;
  const key = `ss:${itemId}`;
  const hit = cached(key);
  if (hit !== undefined) return hit;
  try {
    const res = await axios.get(`https://siegeskins.dev/api/skin/${encodeURIComponent(itemId)}`, {
      timeout: 6000,
      headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 R6Checker/1.0' },
    });
    const url = res.data?.imageUrl ?? res.data?.image_url ?? res.data?.image ?? null;
    cache(key, url);
    return url;
  } catch {
    cache(key, null);
    return null;
  }
}

// ── r6.guide raw CDN — many items have predictable URLs ────────────────
async function r6GuideLookup(itemId) {
  if (!itemId) return null;
  const url = `https://r6.guide/_next/image?url=%2Fapi%2Fitems%2F${encodeURIComponent(itemId)}%2Fimage&w=128&q=75`;
  return url;
}

// Multi-source lookup. Returns the first URL that responds 200, or null.
// Lightweight HEAD checks via axios.
async function findImageForItem(itemId) {
  if (!itemId) return null;
  const sources = [
    () => siegeSkinsLookup(itemId),
    () => r6GuideLookup(itemId),
  ];
  for (const fn of sources) {
    try {
      const url = await fn();
      if (url) return url;
    } catch {}
  }
  return null;
}

module.exports = { findImageForItem, siegeSkinsLookup, r6GuideLookup };
