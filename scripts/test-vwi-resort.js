'use strict';
const assert = require('assert');
const sk = require('../lib/checker/skinCheck');
const resort = require('../lib/bot/vwiResort');

const meta = sk.vwiMeta();
// The test helper defaults PhoneVerified: Y so the existing routing cases keep
// working — they were designed to test the routing/dedup logic, not the phone
// gate. The gate itself is covered by explicit cases at the bottom of this file.
const L = (email, ranks, skins, linkable, banned, phone = 'Y') =>
  `${email}:pw | User: U | Lvl: 100 | Items: 9 | Credits: 0 | Renown: 0 | Ranks: ${ranks} | Skins: ${skins} | Linkable: ${linkable} | Banned: ${banned} | 2FA: N | PhoneVerified: ${phone}`;

// routeAccount: banned → Banned product priced ≤ $1 by platform.
let r = resort.routeAccount(L('a@x', 'Champion (S20)', '5x Glacier', 'PSN', 'Y'), meta);
assert.strictEqual(r.productName, '[PSN] Banned VWI NFA', 'banned → banned product');
assert.strictEqual(r.price, 0.75, 'banned psn = $0.75 (even with champ+glacier)');
assert.strictEqual(r.kind, 'banned');

r = resort.routeAccount(L('b@x', '—', '3x Glacier', 'XBX/PSN', 'N'), meta);
assert.strictEqual(r.productName, '[XBX/PSN] Glacier NFA', 'clean glacier double');
assert.strictEqual(r.kind, 'item');

r = resort.routeAccount(L('c@x', 'Champion (S20)', '—', 'XBX', 'N'), meta);
assert.strictEqual(r.productName, '[XBX] Champion NFA', 'clean champion xbx');

r = resort.routeAccount(L('d@x', '—', '8x Gold Dust', 'PSN', 'N'), meta);
assert.strictEqual(r.productName, '[PSN] Mystery Wanted Items NFA', 'mystery skin → mystery');

assert.strictEqual(resort.routeAccount(L('e@x', '—', '—', '—', 'N'), meta), null, 'plain non-linkable valid → no product');
// Non-linkable banned can't be sold (no platform to link), so it gets NO managed
// product — push skips it, /checkall leaves it alone (won't create a bogus
// "Banned VWI NFA" catch-all product).
assert.strictEqual(resort.routeAccount(L('f@x', '—', '1x Obsidian', '—', 'Y'), meta), null, 'banned non-linkable → no product (must be linkable to push)');

// ── PhoneVerified gate — same rule as isVwiLine + bucketAccounts ────────────
// A linkable, non-banned account without PhoneVerified: Y is recovery-
// vulnerable and must NOT be sold as VWI. Because /checkall already re-runs a
// fresh check on every stocked account before deciding, a fresh PhoneVerified:
// N/? line is a signal to REMOVE from every managed product it's in — not
// merely leave alone. Banned VWI stays exempt.
const gpN = resort.routeAccount(L('gp-n@x', 'Champion (S30)', '—', 'PSN', 'N', 'N'), meta);
assert.strictEqual(gpN && gpN.kind, 'remove', 'PhoneVerified: N Champion → kind:remove (pull from products)');
assert.strictEqual(gpN && gpN.productName, undefined, 'remove-kind has no target productName');
const gpQ = resort.routeAccount(L('gp-q@x', 'Champion (S30)', '—', 'PSN', 'N', '?'), meta);
assert.strictEqual(gpQ && gpQ.kind, 'remove', 'PhoneVerified: ? Champion → kind:remove (absence of proof)');
assert.strictEqual(
  resort.routeAccount(L('gp-n2@x', '—', '3x Glacier', 'XBX/PSN', 'N', 'N'), meta).kind,
  'remove',
  'PhoneVerified: N Glacier → kind:remove',
);
assert.strictEqual(
  resort.routeAccount(L('gp-n3@x', '—', '8x Gold Dust', 'XBX', 'N', 'N'), meta).kind,
  'remove',
  'PhoneVerified: N mystery → kind:remove',
);
// Phone Y → normal routing kicks in.
const gpOk = resort.routeAccount(L('gp-y@x', 'Champion (S30)', '—', 'PSN', 'N', 'Y'), meta);
assert.strictEqual(gpOk && gpOk.productName, '[PSN] Champion NFA', 'PhoneVerified: Y Champion → routes normally');
// Banned VWI is UNAFFECTED by the phone gate.
const gpBanned = resort.routeAccount(L('gp-b@x', 'Champion (S20)', '5x Glacier', 'PSN', 'Y', 'N'), meta);
assert.strictEqual(gpBanned && gpBanned.productName, '[PSN] Banned VWI NFA', 'banned + PhoneVerified: N → still banned VWI');

// ── isManagedBucket: detect checker-sorted product names ─────────────────────
// Rank-tier names, named-item bucket names, and the NFA/Wanted/Mystery/Banned
// VWI suffixes all mark a bucket /checkall is responsible for keeping clean.
console.log('  isManagedBucket:');
assert.strictEqual(resort.isManagedBucket('[PSN] Diamond NFA', meta), true, 'Diamond NFA (rank)');
assert.strictEqual(resort.isManagedBucket('[PSN] Champion NFA', meta), true, 'Champion NFA (rank)');
assert.strictEqual(resort.isManagedBucket('[PSN] Glacier NFA', meta), true, 'Glacier NFA (item)');
assert.strictEqual(resort.isManagedBucket('[XBX] Mystery Wanted Items NFA', meta), true, 'Mystery bucket');
assert.strictEqual(resort.isManagedBucket('[PSN] Banned VWI NFA', meta), true, 'Banned VWI');
assert.strictEqual(resort.isManagedBucket('Diamond, Emerald, Platinum', meta), true, 'operator combined "Diamond, Emerald, Platinum" (has diamond)');
assert.strictEqual(resort.isManagedBucket('Platinum', meta), true, 'plain "Platinum" name (bucket)');
assert.strictEqual(resort.isManagedBucket('Year One Pro League Bundle', meta), false, 'operator-curated non-managed name');
assert.strictEqual(resort.isManagedBucket('Custom Store Product', meta), false, 'unrelated name');
assert.strictEqual(resort.isManagedBucket('', meta), false, 'empty name');
assert.strictEqual(resort.isManagedBucket(null, meta), false, 'null name');

// ── Null-target-in-managed-bucket → REMOVE (the "stale classification" fix) ─
// The DMT_Pickles / Silver92_679 case: an account whose OLD stock line put them
// in a rank product now fresh-rechecks with no wanted signal (because our
// level-20 gate or charm-corroboration filter blanked the leaked rank). The
// current product is a Rank/Item bucket → pull them out.
console.log('  stale-bucket removal:');
{
  // Simulate a fresh recheck where Ranks are blanked (level-20 gate fired) —
  // the fixture just uses "—" for Ranks and Skins.
  const freshLines = [L('dmt@x', '—', '—', 'PSN', 'N', 'Y')];  // no ranks, no skins, phone Y
  const locations = {
    'dmt@x': [
      { productId: 42, productName: 'Diamond, Emerald, Platinum', variantId: 421, pooled: false },
      { productId: 43, productName: '[PSN] Diamond NFA',          variantId: 431, pooled: false },
      { productId: 44, productName: 'Year One Pro League Bundle', variantId: 441, pooled: false },
    ],
  };
  const moves = resort.computeResort(freshLines, locations, meta);
  const removes = moves.filter(m => m.kind === 'remove');
  const removedIds = removes.map(m => m.from.productId).sort((a,b)=>a-b);
  assert.strictEqual(removes.length, 2, 'null-target: 2 managed products get remove moves');
  assert.deepStrictEqual(removedIds, [42, 43], 'removed from combined + NFA products');
  assert(!removedIds.includes(44), 'operator-curated non-managed bundle left alone');
}
{
  // Silver92-shape: phone-? routes to explicit remove, hits ALL locations
  // (managed or not) — the explicit-remove path is unchanged.
  const freshLines = [L('silv@x', '—', '—', 'PSN', 'N', '?')];  // phone-?
  const locations = {
    'silv@x': [
      { productId: 51, productName: '[PSN] Platinum NFA',        variantId: 511, pooled: false },
      { productId: 52, productName: 'Year One Pro League Bundle', variantId: 521, pooled: false },
    ],
  };
  const moves = resort.computeResort(freshLines, locations, meta);
  const removes = moves.filter(m => m.kind === 'remove');
  assert.strictEqual(removes.length, 2, 'explicit phone-remove pulls from ALL products, managed or not');
}

// ── computeResort emits a remove-only move for every current location ─────
// An account currently in 2 products (rank + mystery) that fresh-rechecks with
// PhoneVerified: N should have BOTH copies pulled. No add, no toProductName.
const rmLocs = {
  'rm@x': [
    { productId: 90, productName: '[PSN] Champion NFA',           variantId: 901, pooled: false },
    { productId: 91, productName: '[PSN] Mystery Wanted Items NFA', variantId: 911, pooled: true  },
  ],
};
const rmFresh = [L('rm@x', 'Champion (S30)', '—', 'PSN', 'N', 'N')];
const rmMoves = resort.computeResort(rmFresh, rmLocs, meta);
assert.strictEqual(rmMoves.length, 2, 'phone-N account in 2 products → 2 remove moves');
assert(rmMoves.every(m => m.kind === 'remove'), 'both moves are kind:remove');
assert(rmMoves.every(m => m.toProductName === null), 'remove moves carry no target productName');
assert.deepStrictEqual(rmMoves.map(m => m.from.productId).sort(), [90, 91], 'both source products pulled');

// ── executeResort: remove-only pass calls removeAccountFromProduct, no add ─
(async () => {
  const calls = [];
  const fakeStore = {
    addAccountVariants: async (id, lines) => { calls.push({ op: 'add', id, n: lines.length }); return { added: lines.length }; },
    removeAccountFromProduct: async (id, o) => { calls.push({ op: 'remove', id, email: o.email }); return { removed: 1 }; },
  };
  const products = [
    { id: 90, name: '[PSN] Champion NFA' },
    { id: 91, name: '[PSN] Mystery Wanted Items NFA' },
    { id: 200, name: '[XBX] Glacier NFA' },
  ];
  const mv = [
    // one normal move (add-first)
    { email: 'g@x', line: 'g@x:pw', from: { productId: 300, variantId: 301, pooled: false }, toProductName: '[XBX] Glacier NFA', price: 12, kind: 'item' },
    // two removes for one email (was in 2 products)
    { email: 'rm@x', line: 'rm@x:pw', from: { productId: 90, variantId: 901, pooled: false }, toProductName: null, price: null, kind: 'remove' },
    { email: 'rm@x', line: 'rm@x:pw', from: { productId: 91, variantId: 911, pooled: true  }, toProductName: null, price: null, kind: 'remove' },
  ];
  const res = await resort.executeResort(mv, { storeSync: fakeStore }, { products });
  const ops = calls.map(c => `${c.op}:${c.id}`);
  assert.deepStrictEqual(ops, ['add:200', 'remove:300', 'remove:90', 'remove:91'], 'add-first for the item, then both removes; no add for removes');
  const rmRow = res.find(r => /removed/i.test(r.target));
  assert(rmRow, 'result set contains a "(removed — no PhoneVerified)" group');
  assert.strictEqual(rmRow.count, 2, 'group counts both removes');
  assert.strictEqual(rmRow.removed, 2, 'both were actually removed');
  assert.strictEqual(rmRow.added, 0, 'no adds on remove-only pass');
  console.log('OK test-vwi-resort remove-path');
})().catch(e => { console.error(e); process.exit(1); });

// computeResort: locations are ARRAYS — every copy of an account is evaluated.
const locations = {
  'banned1@x': [{ productId: 1, productName: '[PSN] Champion NFA', variantId: 11, pooled: false }],  // banned in Champion → move
  'glac1@x':   [{ productId: 2, productName: '[XBX] Champion NFA', variantId: 21, pooled: false }],   // glacier in Champion → move
  'champ1@x':  [{ productId: 3, productName: '[PSN] Champion NFA', variantId: 31, pooled: false }],   // already correct → no move
  'ban-ok@x':  [{ productId: 4, productName: '[XBX] Banned VWI NFA', variantId: 41, pooled: false }], // banned already in banned → no move
  // duplicated account: one copy already correct ([PSN] Champion), one stray copy
  // in Diamond → the stray is pulled, the correct one kept.
  'dup@x':     [{ productId: 3, productName: '[PSN] Champion NFA', variantId: 33, pooled: false },
                { productId: 5, productName: '[PSN] Diamond NFA',  variantId: 55, pooled: false }],
};
const fresh = [
  L('banned1@x', 'Champion (S20)', '—', 'PSN', 'Y'),     // → [PSN] Banned VWI NFA (move)
  L('glac1@x', '—', '2x Glacier', 'XBX', 'N'),           // → [XBX] Glacier NFA (move)
  L('champ1@x', 'Champion (S30)', '—', 'PSN', 'N'),      // → [PSN] Champion NFA (no move)
  L('ban-ok@x', '—', '1x Obsidian', 'XBX', 'Y'),         // → [XBX] Banned VWI NFA (no move)
  L('dup@x', 'Champion (S30)', '—', 'PSN', 'N'),         // → [PSN] Champion NFA: keep 1, pull the Diamond stray
];
const moves = resort.computeResort(fresh, locations, meta);
const byEmail = {}; for (const m of moves) (byEmail[m.email] = byEmail[m.email] || []).push(m);
assert.strictEqual(moves.length, 3, 'banned + glacier + dup-stray = 3 moves');
assert.strictEqual(byEmail['banned1@x'][0].toProductName, '[PSN] Banned VWI NFA', 'banned moved to banned');
assert.strictEqual(byEmail['banned1@x'][0].price, 0.75, 'banned priced 0.75');
assert.strictEqual(byEmail['glac1@x'][0].toProductName, '[XBX] Glacier NFA', 'glacier moved to glacier');
assert(!byEmail['champ1@x'], 'correct champion not moved');
assert(!byEmail['ban-ok@x'], 'already-banned-product not moved');
assert.strictEqual(byEmail['dup@x'].length, 1, 'duplicate: exactly one stray copy pulled');
assert.strictEqual(byEmail['dup@x'][0].from.productId, 5, 'the Diamond stray (not the correct Champion) is pulled');

// executeResort: grouping + safety ordering (banned removes-first, others add-first).
(async () => {
  const calls = [];
  const fakeStore = {
    addAccountVariants: async (id, lines) => { calls.push({ op: 'add', id, n: lines.length }); return { added: lines.length }; },
    removeAccountFromProduct: async (id, o) => { calls.push({ op: 'remove', id, email: o.email }); return { removed: 1 }; },
  };
  const products = [{ id: 100, name: '[PSN] Banned VWI NFA' }, { id: 200, name: '[XBX] Glacier NFA' }];
  const mv = [
    { email: 'b@x', line: 'b@x:pw | ...', from: { productId: 1, variantId: 11, pooled: false }, toProductName: '[PSN] Banned VWI NFA', price: 0.75, kind: 'banned' },
    { email: 'g@x', line: 'g@x:pw | ...', from: { productId: 2, variantId: 21, pooled: false }, toProductName: '[XBX] Glacier NFA', price: 12, kind: 'item' },
  ];
  const res = await resort.executeResort(mv, { storeSync: fakeStore }, { products });
  // banned group first: remove(1) THEN add(100). glacier group: add(200) THEN remove(2).
  assert.deepStrictEqual(calls.map(c => `${c.op}:${c.id}`), ['remove:1', 'add:100', 'add:200', 'remove:2'], 'banned removes-first, others add-first');
  assert.strictEqual(res.length, 2, 'two target groups');
  assert(res.every(r => r.added === 1 && r.removed === 1 && !r.errors), 'each moved cleanly');

  console.log('OK test-vwi-resort');
})().catch(e => { console.error(e); process.exit(1); });
