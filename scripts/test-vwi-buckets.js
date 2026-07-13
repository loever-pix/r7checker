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
