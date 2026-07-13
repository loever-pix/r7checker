'use strict';
// Regression test for:
//   1. Ranks corroborated against owned ranked charms (fetchAndCache filter).
//   2. Season name appearing in detectTopRanks output (e.g. "S41 Silent Hunt").
//
// Bug: SellAuth stock in the [PSN] Platinum bucket had Level-0 accounts whose
// Ranks column showed "Platinum (S16)" and "Platinum (S40)". Level 0 = statscard
// failed = unknown, so the level-20 gate can't block it. Ranked charms are the
// harder signal: a player who really hit Platinum earns the charm and can't
// gift it away, so its ABSENCE (with inventory otherwise healthy) means the
// rank came from a linked-console cross-progression leak. /checkall's recheck
// path uses the resulting checker-output "Ranks:" field to decide moves.

const assert = require('assert');
const sk = require('../lib/checker/skinCheck');

let pass = 0, fail = 0;
function check(name, cond) { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.error(`  ✗ ${name}`); } }

// ── detectTopRanks: season name appears in the output ────────────────────────
console.log('detectTopRanks — season name in output:');
{
  const pd = {
    seasonRanks: [
      { season: 41, seasonName: 'Silent Hunt', rankTier: 'platinum', rankName: 'Platinum 3' },
    ],
  };
  const out = sk.detectTopRanks(pd);
  check('single Plat S41 Silent Hunt → "Plat (S41 Silent Hunt)"',
    Array.isArray(out) && out.length === 1 && out[0] === 'Plat (S41 Silent Hunt)');
}
{
  const pd = {
    seasonRanks: [
      { season: 41, seasonName: 'Silent Hunt',   rankTier: 'diamond', rankName: 'Diamond 5' },
      { season: 37, seasonName: 'Deep Freeze',   rankTier: 'diamond', rankName: 'Diamond 3' },
      { season: 42, seasonName: 'System Override', rankTier: 'platinum', rankName: 'Platinum 5' },
    ],
  };
  const out = sk.detectTopRanks(pd);
  check('most-recent-per-tier: Diamond → S41 Silent Hunt, Plat → S42 System Override',
    out.includes('Diamond (S41 Silent Hunt)') && out.includes('Plat (S42 System Override)'));
}
{
  // seasonName missing (older cache entry) → fall back to the "(S41)" shape.
  const pd = { seasonRanks: [{ season: 41, seasonName: '', rankTier: 'platinum', rankName: 'Platinum 3' }] };
  check('missing seasonName → falls back to "Plat (S41)"',
    sk.detectTopRanks(pd)[0] === 'Plat (S41)');
}
{
  // Trackers return placeholder "Season 41" — strip so we don't render "S41 Season 41".
  const pd = { seasonRanks: [{ season: 41, seasonName: 'Season 41', rankTier: 'champion', rankName: 'Champion' }] };
  check('placeholder "Season 41" seasonName is stripped',
    sk.detectTopRanks(pd)[0] === 'Champion (S41)');
}

// ── Charm-corroboration filter (reproduced-in-test since it lives inside      ─
// fetchAndCache, which is heavy to invoke).                                    ─
// The filter shape we ship in player.js: for each seasonRank whose tier is
// Platinum+, keep it iff ownedRankedCharmImages has a charm at that tier or
// higher for the same season. Non-wanted tiers (Copper–Gold) are always kept.
console.log('\nCharm corroboration (mirrored logic):');
const TIER_ORDER = { copper: 1, bronze: 2, silver: 3, gold: 4, platinum: 5, emerald: 6, diamond: 7, champion: 8 };
const WANTED = new Set(['platinum', 'emerald', 'diamond', 'champion']);
function corroborate(seasonRanks, ownedCharms, hasInventoryItems) {
  if (!hasInventoryItems) return seasonRanks;  // inventory broke → trust API
  const peaks = {};
  for (const key of Object.keys(ownedCharms || {})) {
    const [sStr, tier] = String(key).split('|');
    const s = Number(sStr);
    const r = TIER_ORDER[String(tier).toLowerCase()] || 0;
    if (!s || !r) continue;
    if (!peaks[s] || peaks[s] < r) peaks[s] = r;
  }
  return seasonRanks.filter(r => {
    const tier = String(r.rankTier || '').toLowerCase();
    if (!WANTED.has(tier)) return true;
    const claimed = TIER_ORDER[tier] || 0;
    return (peaks[r.season] || 0) >= claimed;
  });
}

// The exact bug case: Level-0 account with claimed Plat S16 + Plat S40, no charms
// for either, inventory has items (71 skins) — both claims should be DROPPED.
{
  const seasonRanks = [
    { season: 16, seasonName: 'Skull Rain',   rankTier: 'platinum', rankName: 'Platinum 3' },
    { season: 40, seasonName: 'Collision Point', rankTier: 'platinum', rankName: 'Platinum 5' },
  ];
  const ownedCharms = {};                  // account owns ZERO ranked charms
  const out = corroborate(seasonRanks, ownedCharms, true);
  check('bug case: 71-item Lvl 0 with Plat S16 + Plat S40 but ZERO charms → both dropped', out.length === 0);
}

// Corroborated: charm for S41 Platinum exists → keep the Platinum S41 claim.
{
  const seasonRanks = [{ season: 41, seasonName: 'Silent Hunt', rankTier: 'platinum', rankName: 'Platinum 3' }];
  const ownedCharms = { '41|platinum': '/api/img?url=...' };
  const out = corroborate(seasonRanks, ownedCharms, true);
  check('Plat S41 corroborated by owned charm → kept', out.length === 1);
}

// Higher-tier charm implies lower — hitting Diamond earns Diamond + Plat + ...
// so a Diamond charm corroborates a Platinum claim for the same season.
{
  const seasonRanks = [{ season: 41, seasonName: 'Silent Hunt', rankTier: 'platinum', rankName: 'Platinum 3' }];
  const ownedCharms = { '41|diamond': '/api/img?url=...' };   // higher tier owned
  const out = corroborate(seasonRanks, ownedCharms, true);
  check('Plat claim corroborated by a HIGHER-tier (Diamond) charm', out.length === 1);
}

// Wrong-season charm doesn't corroborate.
{
  const seasonRanks = [{ season: 16, seasonName: 'Skull Rain', rankTier: 'platinum', rankName: 'Platinum 3' }];
  const ownedCharms = { '41|diamond': '/api/img?url=...' };   // charm is for S41, not S16
  const out = corroborate(seasonRanks, ownedCharms, true);
  check('S16 Plat claim NOT corroborated by an S41 charm → dropped', out.length === 0);
}

// Non-wanted tier (Gold) is always kept — not a resale signal, no need to gate.
{
  const seasonRanks = [{ season: 20, seasonName: 'Void Edge', rankTier: 'gold', rankName: 'Gold 2' }];
  const out = corroborate(seasonRanks, {}, true);
  check('Gold (non-wanted tier) → always kept regardless of charms', out.length === 1);
}

// Safety: no inventory items = trust API (avoid blanking legit accounts whose
// inventory fetch broke).
{
  const seasonRanks = [{ season: 41, seasonName: 'Silent Hunt', rankTier: 'diamond', rankName: 'Diamond 3' }];
  const ownedCharms = {};
  const out = corroborate(seasonRanks, ownedCharms, false);   // inventory failed
  check('inventory-fetch-failed → charm filter SKIPPED, API rank kept', out.length === 1);
}

// End-to-end: filter then format. A bug-case account with no charms yields
// "Ranks: —" via formatWantedRanks(detectTopRanks(...)).
{
  const bugPd = {
    level: 0,
    seasonRanks: corroborate(
      [{ season: 16, seasonName: 'Skull Rain', rankTier: 'platinum', rankName: 'Platinum 3' }],
      {},
      true,
    ),
  };
  const label = sk.formatWantedRanks(sk.detectTopRanks(bugPd));
  check('e2e: Lvl-0 Plat-S16 no-charm → formatted Ranks output is "—"', label === '—');
}

console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
