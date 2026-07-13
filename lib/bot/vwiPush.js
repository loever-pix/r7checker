'use strict';
// VWI → SellAuth push PLANNER. Pure, read-only: turns the sorter's bucketed
// accounts into a concrete plan (per-account price + target product + whether
// that product must be created). NO SellAuth writes happen here — the live push
// (create products, add variants, set prices) consumes this plan in vwiPush.execute
// behind the dry-run confirm gate.
//
// Live store naming convention (from the owner's storefront):
//   "[<PLATFORM>] <Base> NFA"   e.g. "[PSN] Champion NFA", "[XBX/PSN] Glacier NFA"
//   Mystery is pooled:          "[<PLATFORM>] Mystery Wanted Items"
//   Non-linkable banned catch:  "Banned VWI NFA" (no platform prefix)

const pricing = require('./vwiPricing');

// Sorter split label -> storefront platform token.
const PLATFORM_LABEL = { double: 'XBX/PSN', psn: 'PSN', xbx: 'XBX' };

// Bucket display name -> clean product base name.
const PRODUCT_BASENAME = {
  'Plat': 'Platinum',                 // sorter label is "Plat", product is "Platinum"
  'Silver GO4 Charm': 'Silver GO4',
  'Gold GO4 Charm': 'Gold GO4',
  'Mystery Items': 'Mystery Wanted Items',
  'Banned VWI': 'Banned VWI',
};
function baseName(name) { return PRODUCT_BASENAME[name] || name; }

// Canonical SellAuth product name for a (kind, bucketName, platform).
//   kind: 'rank' | 'item' | 'mystery' | 'banned'
//   platform: 'double' | 'psn' | 'xbx' | 'none' (none = non-linkable, banned only)
function productNameFor(kind, bucketName, platform) {
  if (kind === 'mystery') return `[${PLATFORM_LABEL[platform]}] Mystery Wanted Items NFA`;
  if (kind === 'banned' && platform === 'none') return 'Banned VWI NFA';
  return `[${PLATFORM_LABEL[platform]}] ${baseName(bucketName)} NFA`;
}

function normName(s) { return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim(); }

// Split a bucket's lines into mutually-exclusive platform sets. `includeNone`
// captures non-linkable accounts (used for banned, which ignore linkability).
function splitByPlatform(lines, includeNone) {
  const out = { double: [], psn: [], xbx: [] };
  if (includeNone) out.none = [];
  for (const l of lines) {
    const linkable = (l.match(/\|\s*Linkable:\s*([^|]*)/i) || [])[1] || '';
    const canPsn = /PSN|PLAYSTATION/i.test(linkable);
    const canXbx = /XBX|XBOX/i.test(linkable);
    if (canPsn && canXbx) out.double.push(l);
    else if (canPsn) out.psn.push(l);
    else if (canXbx) out.xbx.push(l);
    else if (includeNone) out.none.push(l);
    // non-linkable + not banned → dropped (shouldn't occur: bucketAccounts already excluded them)
  }
  return out;
}

const round2 = (n) => Math.round(n * 100) / 100;

// Mystery is one flat price for the whole pooled variant.
function mysteryPrice(platform) {
  return round2(pricing.MYSTERY_FLAT + (pricing.PLATFORM_PREMIUM[platform] || 0));
}

// Split the sorter's bucketAccounts() result into push UNITS, each with its
// account lines. One unit per (bucket × platform). Shared by preview + execute
// so they agree exactly.
//   kind: 'rank' | 'item' | 'mystery' | 'banned'
function groupAccounts(bucketResult) {
  const groups = [];
  const add = (kind, bucketName, includeNone, bucket) => {
    const s = splitByPlatform(bucket.lines || [], includeNone);
    for (const platform of Object.keys(s)) {
      if (s[platform].length) groups.push({ kind, bucket: bucketName, platform, lines: s[platform] });
    }
  };
  for (const [name, b] of Object.entries(bucketResult.rankBuckets || {})) add('rank', name, false, b);
  for (const [name, b] of Object.entries(bucketResult.itemBuckets || {})) {
    add(name === 'Mystery Items' ? 'mystery' : 'item', name, false, b);
  }
  // Banned: only push LINKABLE banned accounts (non-linkable can't be sold —
  // there's no platform to link to — so they don't get a managed product).
  if (bucketResult.bannedBucket) add('banned', 'Banned VWI', false, bucketResult.bannedBucket);
  return groups;
}

// Build the read-only push PLAN (preview): prices every account, matches each
// group to its SellAuth product (or flags it for creation). NO writes.
function buildPlan(bucketResult, existingProducts) {
  const byName = new Map((existingProducts || []).map(p => [normName(p.name), p]));
  const groups = groupAccounts(bucketResult).map(g => {
    const productName = productNameFor(g.kind, g.bucket, g.platform);
    const existing = byName.get(normName(productName)) || null;
    const pooled = g.kind === 'mystery';
    const value = g.lines.reduce((a, line) => a + pricing.priceLineFor(line, g.platform).price, 0);
    return {
      kind: g.kind, bucket: g.bucket, platform: g.platform, productName,
      productId: existing ? existing.id : null, exists: !!existing, pooled,
      count: g.lines.length,
      value: pooled ? mysteryPrice(g.platform) : round2(value),
      flatPrice: pooled ? mysteryPrice(g.platform) : null,
    };
  });
  const totals = groups.reduce((a, g) => ({
    accounts: a.accounts + g.count,
    value: a.value + g.value,
    toCreate: a.toCreate + (g.exists ? 0 : 1),
  }), { accounts: 0, value: 0, toCreate: 0 });
  totals.value = round2(totals.value);
  return { groups, totals };
}

// Choose an existing product to CLONE when a target product doesn't exist.
// Mystery clones an existing Mystery product; variant products clone any
// existing per-account-variant product (preferring the same platform so the
// variant config matches).
function pickTemplate(group, existingProducts) {
  const isMystery = group.kind === 'mystery';
  const candidates = (existingProducts || []).filter(p =>
    isMystery ? /mystery wanted items/i.test(p.name) : !/mystery wanted items/i.test(p.name));
  if (!candidates.length) return null;
  const platTok = ({ double: 'xbx/psn', psn: 'psn', xbx: 'xbx' })[group.platform];
  const samePlat = platTok && candidates.find(p => normName(p.name).includes(`[${platTok}]`));
  return (samePlat || candidates[0]).id;
}

// EXECUTE the push (LIVE writes). Creates missing products by cloning, then adds
// per-account variants priced by the engine (pooled flat price for Mystery).
// Continues past per-group errors so one failure doesn't abort the rest.
//   deps = { sellauth, storeSync }
async function execute(bucketResult, existingProducts, deps, opts = {}) {
  const sa = deps.sellauth, storeSync = deps.storeSync;
  const products = (existingProducts || []).slice();
  const byName = new Map(products.map(p => [normName(p.name), p]));
  const visibility = opts.visibility || 'public';
  const results = [];

  for (const g of groupAccounts(bucketResult)) {
    const productName = productNameFor(g.kind, g.bucket, g.platform);
    const pooled = g.kind === 'mystery';
    try {
      let product = byName.get(normName(productName)) || null;
      let created = false;
      if (!product) {
        const tplId = pickTemplate(g, products);
        if (!tplId) { results.push({ productName, count: g.lines.length, error: 'no template product to clone from' }); continue; }
        const initPrice = pooled ? mysteryPrice(g.platform) : pricing.priceLineFor(g.lines[0], g.platform).price;
        const np = await sa.createProductFromTemplate(tplId, { name: productName, price: initPrice, visibility });
        product = { id: np.id, name: productName };
        products.push(product); byName.set(normName(productName), product); // reusable by later groups
        created = true;
      }
      const addOpts = pooled
        ? { dedup: true, poolPrice: mysteryPrice(g.platform) }
        : { dedup: !created, replaceExisting: created, priceFor: (line) => pricing.priceLineFor(line, g.platform).price };
      const r = await storeSync.addAccountVariants(product.id, g.lines, addOpts);
      results.push({ productName, productId: product.id, created, pooled, count: g.lines.length, added: r.added, written: r.written, error: r.error || null });
    } catch (e) {
      results.push({ productName, count: g.lines.length, error: e.message });
    }
  }

  const totals = results.reduce((a, r) => ({
    groups: a.groups + 1,
    created: a.created + (r.created ? 1 : 0),
    accounts: a.accounts + (r.count || 0),
    errors: a.errors + (r.error ? 1 : 0),
  }), { groups: 0, created: 0, accounts: 0, errors: 0 });

  return { results, totals };
}

module.exports = {
  buildPlan, groupAccounts, execute, pickTemplate, productNameFor,
  splitByPlatform, baseName, mysteryPrice, PLATFORM_LABEL, PRODUCT_BASENAME,
};
