'use strict';
const assert = require('assert');
const VB = require('../public/js/vwiBuckets');
const sk = require('../lib/checker/skinCheck');
const push = require('../lib/bot/vwiPush');

// Canonical product names.
assert.strictEqual(push.productNameFor('rank', 'Champion', 'psn'), '[PSN] Champion NFA');
assert.strictEqual(push.productNameFor('rank', 'Plat', 'double'), '[XBX/PSN] Platinum NFA');
assert.strictEqual(push.productNameFor('item', 'Glacier', 'xbx'), '[XBX] Glacier NFA');
assert.strictEqual(push.productNameFor('item', 'Silver GO4 Charm', 'psn'), '[PSN] Silver GO4 NFA');
assert.strictEqual(push.productNameFor('mystery', 'Mystery Items', 'psn'), '[PSN] Mystery Wanted Items NFA');
assert.strictEqual(push.productNameFor('banned', 'Banned VWI', 'none'), 'Banned VWI NFA');

// Existing products mirroring the owner's live storefront.
const existing = [
  { id: 1, name: '[PSN] Champion NFA' }, { id: 2, name: '[XBX] Champion NFA' }, { id: 3, name: '[XBX/PSN] Champion NFA' },
  { id: 4, name: '[PSN] Diamond NFA' }, { id: 5, name: '[XBX] Diamond NFA' }, { id: 6, name: '[XBX/PSN] Diamond NFA' },
  { id: 7, name: '[PSN] Emerald NFA' }, { id: 8, name: '[XBX] Emerald NFA' }, { id: 9, name: '[XBX/PSN] Emerald NFA' },
  { id: 10, name: '[PSN] Platinum NFA' }, { id: 11, name: '[XBX] Platinum NFA' }, { id: 12, name: '[XBX/PSN] Platinum NFA' },
  { id: 13, name: '[XBX] Mystery Wanted Items NFA' }, { id: 14, name: '[PSN] Mystery Wanted Items NFA' },
];

const L = (email, ranks, skins, linkable, banned) =>
  `${email}:pw | User: U | Lvl: 100 | Items: 9 | Credits: 0 | Renown: 0 | Ranks: ${ranks} | Skins: ${skins} | Linkable: ${linkable} | Banned: ${banned} | 2FA: N`;

const lines = [
  L('c1@x', 'Champion (S20)', '—', 'PSN', 'N'),            // [PSN] Champion NFA (exists)
  L('g1@x', '—', '3x Glacier', 'XBX/PSN', 'N'),            // [XBX/PSN] Glacier NFA (to create)
  L('gd@x', '—', '8x Gold Dust', 'XBX', 'N'),              // [XBX] Mystery Wanted Items (exists, pooled)
  L('bo@x', '—', '1x Obsidian', '—', 'Y'),                 // Banned VWI NFA (non-linkable, to create)
];

const bucketed = VB.bucketAccounts(lines, sk.vwiMeta());
const plan = push.buildPlan(bucketed, existing);

// Find groups by product name.
const g = (name) => plan.groups.find(x => x.productName === name);

assert(g('[PSN] Champion NFA'), 'champion group present');
assert.strictEqual(g('[PSN] Champion NFA').exists, true, 'champion product exists');
assert.strictEqual(g('[PSN] Champion NFA').productId, 1, 'champion id matched');

const glac = g('[XBX/PSN] Glacier NFA');
assert(glac, 'glacier group present');
assert.strictEqual(glac.exists, false, 'glacier product must be created');
assert.strictEqual(glac.count, 1, 'one glacier account');

const myst = g('[XBX] Mystery Wanted Items NFA');
assert(myst, 'mystery group present');
assert.strictEqual(myst.exists, true, 'mystery exists');
assert.strictEqual(myst.pooled, true, 'mystery is pooled');
assert.strictEqual(myst.flatPrice, 5 + 0.5, 'mystery flat = MYSTERY_FLAT + xbx premium');

// Non-linkable banned must NOT be pushed (can't be sold without a linkable
// platform) — the "Banned VWI NFA" catch product should never be planned.
assert.strictEqual(g('Banned VWI NFA'), undefined, 'non-linkable banned → not planned (catch product never created)');

assert.strictEqual(plan.totals.accounts, 3, 'three accounts planned (non-linkable banned dropped)');
assert(plan.totals.toCreate >= 1, 'at least glacier to create');

// groupAccounts must not produce a banned/none group anymore.
assert(!push.groupAccounts(bucketed).some(g => g.kind === 'banned' && g.platform === 'none'), 'no banned/none group');

// groupAccounts: one unit per (bucket x platform), carrying the lines.
const groups = push.groupAccounts(bucketed);
const champG = groups.find(g => g.kind === 'rank' && g.bucket === 'Champion' && g.platform === 'psn');
assert(champG && champG.lines.length === 1, 'champion psn group has its line');
// (non-linkable banned has no group — already asserted above)

// pickTemplate: mystery clones a mystery product; variants clone same-platform rank.
assert.strictEqual(push.pickTemplate({ kind: 'item', platform: 'psn' }, existing), 1, 'item/psn -> [PSN] Champion NFA');
assert.strictEqual(push.pickTemplate({ kind: 'item', platform: 'double' }, existing), 3, 'item/double -> [XBX/PSN] Champion NFA');
assert.strictEqual(push.pickTemplate({ kind: 'mystery', platform: 'psn' }, existing), 14, 'mystery -> [PSN] Mystery Wanted Items');
assert.strictEqual(push.pickTemplate({ kind: 'banned', platform: 'none' }, existing), 1, 'banned/none -> first non-mystery product');

console.log('OK test-vwi-push-plan');
