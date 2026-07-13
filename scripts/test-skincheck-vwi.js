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
assert.strictEqual(sk.WANTED_SKIN_MINS['Dust Line'], 45, 'Dust Line min 45 (complete 45/45 set)');

// detectWantedSkins honours the threshold against real catalog ids. A complete
// Dust Line set = all 45 weapon skins; anything short of 45/45 does not qualify.
const dustIds = Object.keys(cache).filter(k => cache[k].category === 'Dust Lines');
assert.strictEqual(dustIds.length, 45, 'fixture: catalog must hold exactly 45 dust lines');
const pd = (n) => ({ sections: [{ items: dustIds.slice(0, n).map(id => ({ id })) }] });
assert.strictEqual(sk.detectWantedSkins(pd(44))['Dust Line'], 0, '44/45 dust lines -> not wanted');
assert.strictEqual(sk.detectWantedSkins(pd(45))['Dust Line'], 45, '45/45 dust lines -> wanted');

// vwiMeta() shape.
const meta = sk.vwiMeta();
assert.deepStrictEqual(meta.namedItemBuckets, ['Silver GO4 Charm', 'Gold GO4 Charm', 'Obsidian', 'Chroma Streaks', 'Glacier'], 'named buckets');
assert.deepStrictEqual(meta.bannedVwi.ranks, ['Champion', 'Diamond'], 'banned ranks');
assert.deepStrictEqual(meta.bannedVwi.items, ['Chroma Streaks', 'Obsidian', 'Silver GO4 Charm', 'Gold GO4 Charm', 'Spellbound R4-C'], 'banned items');
assert(Array.isArray(meta.items) && meta.items.includes('Heart Attack'), 'items includes new family');
assert.deepStrictEqual(meta.ranks, sk.WANTED_RANK_LABELS, 'ranks');

console.log('OK test-skincheck-vwi');
