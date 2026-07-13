'use strict';
const assert = require('assert');
const P = require('../lib/bot/vwiPricing');

const close = (a, b, msg) => assert(Math.abs(a - b) < 0.011, `${msg}: got ${a}, want ${b}`);
// Build a result line with given Ranks/Skins fields.
const L = (ranks, skins) =>
  `e@x.com:pw | User: U | Lvl: 100 | Items: 9 | Credits: 0 | Renown: 0 | Ranks: ${ranks} | Skins: ${skins} | Linkable: PSN | Banned: N`;

// Era boundaries.
assert.strictEqual(P.eraForSeason(20), '1.0');
assert.strictEqual(P.eraForSeason(24), '1.0');
assert.strictEqual(P.eraForSeason(25), '2.0');
assert.strictEqual(P.eraForSeason(28), '2.0');
assert.strictEqual(P.eraForSeason(29), '3.0');
assert.strictEqual(P.eraForSeason(41), '3.0');

// Glacier scale.
close(P.priceLine(L('—', '1x Glacier')).price, 10, 'glacier 1');
close(P.priceLine(L('—', '40x Glacier')).price, 50, 'glacier 40');
close(P.priceLine(L('—', '20x Glacier')).price, Math.min(50, 10 + 19 * (40 / 39)), 'glacier 20');

// Glacier + Champion combo = $80 (beats both the glacier scale and the rank floor).
close(P.priceLine(L('Champion (S20)', '1x Glacier')).price, 80, 'glacier+champ');

// Single-family item floors.
close(P.priceLine(L('—', '1x Chroma Streaks')).price, 5, 'chroma alone -> mystery 5 beats 3');
close(P.priceLine(L('—', '1x Obsidian')).price, 5, 'obsidian alone -> mystery 5 beats 4');
close(P.priceLine(L('—', '1x Silver GO4 Charm')).price, 20, 'silver go4');
close(P.priceLine(L('—', '1x Gold GO4 Charm')).price, 30, 'gold go4');
close(P.priceLine(L('—', '1x Spellbound R4-C')).price, 30, 'spellbound');

// Chroma + Obsidian combo = $10.
close(P.priceLine(L('—', '1x Chroma Streaks, 1x Obsidian')).price, 10, 'chroma+obsidian');

// Rank floors by era.
close(P.priceLine(L('Champion (S20)', '—')).price, 18, 'champ 1.0');
close(P.priceLine(L('Champion (S26)', '—')).price, 12, 'champ 2.0');
close(P.priceLine(L('Champion (S33)', '—')).price, 8, 'champ 3.0');
close(P.priceLine(L('Plat (S41)', '—')).price, 3, 'plat 3.0');
close(P.priceLine(L('Emerald (S33)', '—')).price, 4, 'emerald 3.0');

// Multi-rank: highest tier base + $3 per extra distinct tier.
close(P.priceLine(L('Champion (S20), Diamond (S37)', '—')).price, 18 + 3, 'champ1.0 + 1 extra');
close(P.priceLine(L('Champion (S20), Diamond (S37), Plat (S40)', '—')).price, 18 + 6, 'champ1.0 + 2 extra');

// Mystery: any non-floored wanted skin -> $5.
close(P.priceLine(L('—', '8x Gold Dust')).price, 5, 'gold dust -> mystery');
close(P.priceLine(L('—', '2x Board Game')).price, 5, 'board game -> mystery');

// Final price is the MAX floor: a Champion(1.0)=$18 account with Gold GO4=$30 -> $30.
close(P.priceLine(L('Champion (S20)', '1x Gold GO4 Charm')).price, 30, 'max of floors');

// Empty/no-value line -> global min $1.
close(P.priceLine(L('—', '—')).price, 1, 'global min');

// Platform premium: PSN base, XBX +$0.50, double +$1.50.
const champ = L('Champion (S20)', '—');
close(P.priceLineFor(champ, 'psn').price, 18, 'psn = base');
close(P.priceLineFor(champ, 'xbx').price, 18.5, 'xbx +0.50');
close(P.priceLineFor(champ, 'double').price, 19.5, 'double +1.50');
assert.strictEqual(P.priceLineFor(champ, 'xbx').basePrice, 18, 'basePrice preserved');
close(P.priceLineFor(L('—', '—'), 'double').price, 2.5, 'premium applies to global-min base');

// BANNED override: a banned account ALWAYS prices at the platform's ≤$1 banned
// price — never the rank/skin/Glacier+Champion floor. Locks the Push and the
// Discord re-sort to the same number.
const B = (ranks, skins, linkable) =>
  `e@x.com:pw | User: U | Lvl: 100 | Items: 9 | Credits: 0 | Renown: 0 | Ranks: ${ranks} | Skins: ${skins} | Linkable: ${linkable} | Banned: Y | 2FA: N`;
close(P.priceLineFor(B('—', '—', 'PSN'), 'psn').price, 0.75, 'banned psn');
close(P.priceLineFor(B('—', '—', 'XBX'), 'xbx').price, 0.90, 'banned xbx');
close(P.priceLineFor(B('—', '—', 'XBX/PSN'), 'double').price, 1.00, 'banned double');
close(P.priceLineFor(B('Champion (S20)', '40x Glacier', 'XBX/PSN'), 'double').price, 1.00, 'banned overrides $80 Glacier+Champion');
assert.strictEqual(P.isLineBanned(B('—', '—', 'PSN')), true, 'isLineBanned detects Banned: Y');
assert.strictEqual(P.isLineBanned(L('Champion (S20)', '—')), false, 'isLineBanned false for Banned: N');

console.log('OK test-vwi-pricing');
