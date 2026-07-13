'use strict';
// Regression test for the era-correction pass in fetchAndCache.
//
// Bug: tracker.gg (and secondary sources) return raw modern-scale rank names for
// old seasons — a Season 5 (Ranked 1.0, pre-Champion, pre-Emerald) can come back
// tagged "Emerald 3", and a Season 10 can come back "Champion". Both tiers were
// literally not in the game yet:
//   • Champion introduced Y4S3 Operation Ember Rise  (Season 15)
//   • Emerald  introduced Y7S4 Operation Solar Raid  (Season 28)
// Fix: eraCorrectRank runs on the merged seasonRanks in fetchAndCache, remapping
// pre-era entries to the tier that ACTUALLY existed that season.

const assert = require('assert');

const { eraCorrectRank, v6FromNameTier, getRankV6 } = require('../lib/player')._test;

let pass = 0, fail = 0;
function check(name, cond) { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.error(`  ✗ ${name}`); } }

// Table walk to prove eraCorrectRank behavior in every era.

// ── Era A: Ranked 1.0 (S1–S14) — top tier is Diamond ─────────────────────────
console.log('Ranked 1.0 (S1–S14): neither Champion NOR Emerald existed');
{
  const emerald5 = v6FromNameTier('Emerald 5', 'emerald');
  const r = eraCorrectRank(5, 3500, emerald5);
  check('S5 "Emerald 5" 3500 MMR → demoted (not emerald)', r.tier !== 'emerald');
  check('S5 "Emerald 5" → NOT champion either', r.tier !== 'champion');
}
{
  const champion = v6FromNameTier('Champion', 'champion');
  const r = eraCorrectRank(10, 0, champion);
  check('S10 "Champion" (no MMR) → demoted to Diamond', r.tier === 'diamond');
}
{
  const emerald3 = v6FromNameTier('Emerald 3', 'emerald');
  const r = eraCorrectRank(14, 0, emerald3);
  check('S14 (last Ranked 1.0 season) "Emerald 3" → demoted (not emerald)', r.tier !== 'emerald');
}

// ── Era B: Champion era, pre-Emerald (S15–S27) ───────────────────────────────
console.log('\nChampion era pre-Emerald (S15–S27): Champion exists, Emerald doesn\'t');
{
  const emerald3 = v6FromNameTier('Emerald 3', 'emerald');
  const r = eraCorrectRank(20, 4500, emerald3);
  check('S20 "Emerald 3" 4500 MMR → demoted (not emerald)', r.tier !== 'emerald');
}
{
  const champion = v6FromNameTier('Champion', 'champion');
  const r = eraCorrectRank(20, 5200, champion);
  check('S20 "Champion" 5200 MMR → stays champion (existed since S15)', r.tier === 'champion');
}
{
  const champion = v6FromNameTier('Champion', 'champion');
  const r = eraCorrectRank(27, 5000, champion);
  check('S27 (last pre-Emerald) "Champion" 5000 MMR → stays champion', r.tier === 'champion');
}

// ── Era C: Modern (S28+) — Champion AND Emerald exist ─────────────────────────
console.log('\nModern (S28+): both Champion and Emerald exist');
{
  const emerald3 = v6FromNameTier('Emerald 3', 'emerald');
  const r = eraCorrectRank(28, 3800, emerald3);
  check('S28 (Solar Raid) "Emerald 3" → passes through unchanged', r.tier === 'emerald');
}
{
  const emerald1 = v6FromNameTier('Emerald 1', 'emerald');
  const r = eraCorrectRank(42, 3900, emerald1);
  check('S42 "Emerald 1" → passes through unchanged', r.tier === 'emerald');
}
{
  const champion = v6FromNameTier('Champion', 'champion');
  const r = eraCorrectRank(42, 4700, champion);
  check('S42 "Champion" → passes through unchanged', r.tier === 'champion');
}

// ── Sanity: unknown/nil season → passes through (never modify what we can't verify) ─
console.log('\nUnknown/nil season: no correction (safe pass-through)');
{
  const emerald3 = v6FromNameTier('Emerald 3', 'emerald');
  const r = eraCorrectRank(null, 3800, emerald3);
  check('season=null → passes through', r.tier === 'emerald');
}
{
  const emerald3 = v6FromNameTier('Emerald 3', 'emerald');
  const r = eraCorrectRank(undefined, 3800, emerald3);
  check('season=undefined → passes through', r.tier === 'emerald');
}

console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
