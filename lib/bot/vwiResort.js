'use strict';
// VWI re-sort planner (PURE). Given freshly-checked result lines + a map of where
// each account CURRENTLY sits in the store, decide the correct product for each
// and emit the list of MOVES needed. No SellAuth calls here — the command layer
// executes the moves (add to target + remove from source) behind a dry-run gate.
//
//   routeAccount(line, meta, bannedPrice) -> { productName, price, kind } | null
//   computeResort(freshLines, locations, meta, bannedPrice) -> moves[]

const VB = require('../../public/js/vwiBuckets');
const push = require('./vwiPush');
const pricing = require('./vwiPricing');

// Banned accounts are ≤ $1 regardless of skins. Re-uses the one source of
// truth in vwiPricing so the website Push and Discord re-sort can't disagree.
const DEFAULT_BANNED_PRICE = pricing.BANNED_PRICE;

function platformOf(line) {
  const psn = VB.canLinkPsn(line), xbx = VB.canLinkXbx(line);
  if (psn && xbx) return 'double';
  if (psn) return 'psn';
  if (xbx) return 'xbx';
  return 'none';
}

function normName(s) { return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim(); }
function emailOf(line) { return String(line).split('|')[0].split(':')[0].trim().toLowerCase(); }

// A product is "managed" (a checker-sorted bucket that /checkall is responsible
// for keeping clean) when its name mentions a wanted rank tier, a named-item
// bucket, or an NFA/Wanted/Mystery/Banned-VWI suffix. This lets us know we're
// allowed to REMOVE an account from it when the fresh check no longer supports
// the classification (e.g. a Lvl-10 account got into a Diamond product before
// the level-20 gate landed — after re-check, it has no ranks, so pull it out).
// Operator-curated custom products that don't match any of these keywords are
// intentionally left alone.
function isManagedBucket(productName, meta) {
  if (!productName) return false;
  const n = String(productName).toLowerCase();
  const wantedRanks = (meta && meta.ranks ? meta.ranks : []).map(r => String(r).toLowerCase());
  if (wantedRanks.some(t => n.includes(t))) return true;
  const namedItems = (meta && meta.namedItemBuckets ? meta.namedItemBuckets : []).map(i => String(i).toLowerCase());
  if (namedItems.some(t => n.includes(t))) return true;
  return /\bnfa\b|banned vwi|mystery wanted|wanted vwi/i.test(n);
}

// The CORRECT product (+ price + kind) for one freshly-checked account, or null
// if it doesn't map to a managed product (leave it where it is).
//   banned         → [platform] Banned VWI NFA, priced ≤ $1 by platform
//   rank (Plat+)   → [platform] <Tier> NFA
//   named item     → [platform] <Item> NFA (Glacier/Obsidian/Chroma/GO4)
//   other wanted   → [platform] Mystery Wanted Items (pooled)
function routeAccount(line, meta, bannedPrice = DEFAULT_BANNED_PRICE) {
  if (!VB.isValidLine(line)) return null;          // not a successful check
  const platform = platformOf(line);

  if (VB.isBanned(line)) {
    // Non-linkable banned accounts CANNOT be sold (no platform to link to), so
    // they never get a managed product — push skips them, /checkall leaves them
    // where they are. Avoids creating a bogus "Banned VWI NFA" catch product.
    // Banned VWI is intentionally NOT phone-gated: the account is already
    // sanctioned, so phone-recovery risk (the reason clean VWI requires phone)
    // doesn't apply to this sale channel.
    if (platform === 'none') return null;
    return {
      productName: push.productNameFor('banned', 'Banned VWI', platform),
      price: bannedPrice[platform] != null ? bannedPrice[platform] : 1,
      kind: 'banned',
    };
  }
  if (platform === 'none') return null;            // non-banned + non-linkable → no product
  // Phone-verified gate. Same rule as the bulk checker's isVwiLine + the admin
  // sorter's bucketAccounts (see [[checker-result-line-rules]] memory): a clean
  // resale account without a verified phone is recovery-vulnerable and must not
  // be sold as VWI. /checkall already re-ran a fresh check on this account, so
  // if the freshly-produced line STILL says PhoneVerified: N or ?, actively
  // REMOVE it from whichever managed product it currently sits in — leaving it
  // in place would keep it selling as VWI. Banned VWI stays exempt (already
  // sanctioned; phone-recovery risk moot for that channel).
  if (!VB.isPhoneVerified(line)) return { kind: 'remove' };

  const ranks = VB.getRanksList(line);
  const items = VB.getItemsList(line);
  const highestRank = (meta.ranks || []).find(r => ranks.includes(r));
  if (highestRank) {
    return { productName: push.productNameFor('rank', highestRank, platform), price: pricing.priceLineFor(line, platform).price, kind: 'rank' };
  }
  const named = (meta.namedItemBuckets || []).find(i => items.includes(i));
  if (named) {
    return { productName: push.productNameFor('item', named, platform), price: pricing.priceLineFor(line, platform).price, kind: 'item' };
  }
  if (items.length) {
    return { productName: push.productNameFor('mystery', 'Mystery Items', platform), price: push.mysteryPrice(platform), kind: 'mystery' };
  }
  return null;                                     // plain valid, no rank/item → no managed product
}

// Compute the moves needed to put every account in its right spot.
//   freshLines: array of freshly-checked result lines.
//   locations: { emailLower: [ {productId, productName, variantId, pooled}, … ] }.
// Returns moves: [{ email, line, from:{...location}, toProductName, price, kind }].
// EVERY copy of an account is evaluated: a copy already in the correct product is
// kept; every other copy is moved (so duplicates collapse into the right product).
// One fresh line drives all copies (the same email can't have two truths).
function computeResort(freshLines, locations, meta, bannedPrice = DEFAULT_BANNED_PRICE) {
  const moves = [];
  const seen = new Set();                          // guard against a duplicated fresh line
  for (const line of (freshLines || [])) {
    if (!VB.isValidLine(line)) continue;
    const email = emailOf(line);
    if (seen.has(email)) continue;
    seen.add(email);
    const locs = locations[email];
    if (!locs || !locs.length) continue;           // not currently stocked → nothing to move
    const target = routeAccount(line, meta, bannedPrice);
    if (!target) {
      // Fresh check qualifies for NOTHING (no wanted rank/skin/mystery). But the
      // account may currently sit in a managed rank/item bucket from an earlier
      // classification that our newer gates have since invalidated (level-20
      // gate, charm-corroboration filter, era-correction). Rip it out of every
      // such bucket. Operator-curated non-managed products are left alone.
      const stale = locs.filter(loc => isManagedBucket(loc.productName, meta));
      for (const loc of stale) {
        moves.push({ email, line, from: loc, toProductName: null, price: null, kind: 'remove' });
      }
      continue;
    }
    if (target.kind === 'remove') {
      // Explicit remove (currently: phone-not-verified). Pull EVERY copy from
      // every product it's in, regardless of whether it's "managed" — an
      // unverified-phone account shouldn't sell out of anywhere.
      for (const loc of locs) {
        moves.push({ email, line, from: loc, toProductName: null, price: null, kind: 'remove' });
      }
      continue;
    }
    const targetN = normName(target.productName);
    let keptCorrect = false;
    for (const loc of locs) {
      if (normName(loc.productName) === targetN && !keptCorrect) { keptCorrect = true; continue; } // keep ONE in the right spot
      // Move every other copy: a wrong-product copy → its correct product; a
      // duplicate already-correct copy → also pulled (executeResort's add is
      // deduped, so the account ends up exactly once in the target).
      moves.push({ email, line, from: loc, toProductName: target.productName, price: target.price, kind: target.kind });
    }
  }
  return moves;
}

// Walk EVERY product → EVERY variant → EVERY stock line and build:
//   locations: { emailLower: [ { productId, productName, variantId, pooled }, … ] }
//              (an ARRAY — an account that's in several variants/products is
//               tracked in ALL of them, so every copy gets sorted/deduped)
//   lines:     every stock line (full result lines) — the input for a re-check
//   products:  the product list (for later name→id resolution)
//   counts:    { products, variants, accounts } for a transparent scan summary
// Many API calls (one getDeliverables per variant) — it's a maintenance scan.
async function gatherStock(sa) {
  const products = await sa.listProducts();
  const locations = {};
  const lines = [];
  let variants = 0;
  for (const p of products) {
    let raw;
    try { raw = await sa.getProductRaw(p.id); } catch { continue; }
    const pooled = /mystery wanted items/i.test(p.name);
    for (const v of (raw.variants || [])) {
      variants++;
      let dels;
      try { dels = await sa.getDeliverables(p.id, v.id); } catch { continue; }
      for (const line of (dels || [])) {
        const email = emailOf(line);
        if (!email) continue;
        (locations[email] = locations[email] || []).push({ productId: p.id, productName: p.name, variantId: v.id, pooled });
        lines.push(line);
      }
    }
  }
  return { products, locations, lines, counts: { products: products.length, variants, accounts: lines.length } };
}

// Execute a list of moves (LIVE writes). Groups by target product, adds each
// account at its computed price, and removes it from its source.
//   deps = { sellauth, storeSync }, opts.products = current product list (for name→id).
// Ordering is chosen to avoid the worst failure in each case:
//   • banned move → REMOVE from the (wrong, pricier) source FIRST so a banned
//     account can't keep selling at a rank price, THEN add to the Banned product.
//   • other move → ADD to the correct product FIRST (never lose valid inventory),
//     THEN remove from the source.
async function executeResort(moves, deps, opts = {}) {
  const storeSync = deps.storeSync;
  const byName = new Map((opts.products || []).map(p => [normName(p.name), p]));
  const groups = new Map();
  const removes = [];   // kind:'remove' — pull from source only, no target to add to
  for (const m of (moves || [])) {
    if (m.kind === 'remove') { removes.push(m); continue; }
    const k = normName(m.toProductName);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(m);
  }

  const results = [];
  for (const [k, group] of groups) {
    let prod = byName.get(k);
    if (!prod) {
      // Target doesn't exist yet → auto-create it by cloning a template (same as
      // the push), so a re-sort never stalls on a missing product.
      const name = group[0].toProductName;
      const platform = /\[xbx\/psn\]/i.test(name) ? 'double' : (/\[xbx\]/i.test(name) ? 'xbx' : (/\[psn\]/i.test(name) ? 'psn' : 'none'));
      const tplId = push.pickTemplate({ kind: group[0].kind, platform }, opts.products || []);
      if (!tplId || !deps.sellauth) { results.push({ target: name, count: group.length, error: 'target missing + could not auto-create' }); continue; }
      try {
        const np = await deps.sellauth.createProductFromTemplate(tplId, { name, price: group[0].price, visibility: 'public' });
        prod = { id: np.id, name };
        byName.set(k, prod); (opts.products = opts.products || []).push(prod);
      } catch (e) { results.push({ target: name, count: group.length, error: 'auto-create failed: ' + e.message }); continue; }
    }
    const pooled = /mystery wanted items/i.test(prod.name);
    const isBanned = /banned/i.test(prod.name);

    const addToTarget = (lines) => storeSync.addAccountVariants(prod.id, lines, pooled
      ? { dedup: true, poolPrice: group[0].price }
      : { dedup: true, priceFor: (line) => { const m = group.find(x => x.line === line); return m ? m.price : group[0].price; } });
    const removeFromSource = (m) => storeSync.removeAccountFromProduct(m.from.productId, { variantId: m.from.variantId, pooled: m.from.pooled, email: m.email });

    let added = 0, removed = 0, errors = 0;
    if (isBanned) {
      for (const m of group) { try { const r = await removeFromSource(m); if (r && r.removed) removed++; } catch { errors++; } }
      try { const a = await addToTarget(group.map(m => m.line)); added = (a && a.added) || 0; } catch { errors++; }
    } else {
      try { const a = await addToTarget(group.map(m => m.line)); added = (a && a.added) || 0; }
      catch (e) { results.push({ target: prod.name, count: group.length, error: 'add failed: ' + e.message }); continue; }
      for (const m of group) { try { const r = await removeFromSource(m); if (r && r.removed) removed++; } catch { errors++; } }
    }
    results.push({ target: prod.name, count: group.length, added, removed, errors });
  }

  // Remove-only pass. Accounts that no longer qualify for ANY managed product
  // (e.g. PhoneVerified went from Y → N/? on the fresh check) — pull every copy
  // from wherever it currently lives. No add step. One aggregated result row so
  // the Discord embed shows the count without a target name.
  if (removes.length) {
    let removed = 0, errors = 0;
    for (const m of removes) {
      try {
        const r = await storeSync.removeAccountFromProduct(m.from.productId, { variantId: m.from.variantId, pooled: m.from.pooled, email: m.email });
        if (r && r.removed) removed++;
      } catch { errors++; }
    }
    results.push({ target: '(removed — no PhoneVerified)', count: removes.length, added: 0, removed, errors });
  }

  return results;
}

module.exports = { routeAccount, computeResort, executeResort, gatherStock, platformOf, emailOf, normName, isManagedBucket, DEFAULT_BANNED_PRICE };
