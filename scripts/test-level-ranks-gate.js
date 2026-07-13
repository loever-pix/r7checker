'use strict';
// Regression test for the level-20 ranks gate.
//
// Bug: DMT_Picklez showed Diamond on a Lvl-10 account (Xbox rank leaking in via
// Y8+ crossplay aggregation). Same class as an earlier bug case.
// Fix: R6 Siege gates ranked at Level 20. When PC clearance level is confirmed
// below 20, the Ranks field is blanked to '—' in the checker output — those
// ranks can't have been earned on this PC login.

const assert = require('assert');
const fmt = require('../lib/checker/resultFormat');

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`); }
}

// The unit helper (pure, no formatSuccess invocation)
console.log('ranksBlockedByLevel:');
check('lvl 10 (confirmed below 20) → BLOCKED', fmt.ranksBlockedByLevel({ level: 10 }) === true);
check('lvl 19 → BLOCKED (one below the unlock)', fmt.ranksBlockedByLevel({ level: 19 }) === true);
check('lvl 20 → NOT blocked (unlock threshold)', fmt.ranksBlockedByLevel({ level: 20 }) === false);
check('lvl 100 → NOT blocked', fmt.ranksBlockedByLevel({ level: 100 }) === false);
check('lvl 0 (statscard failed = unknown) → NOT blocked', fmt.ranksBlockedByLevel({ level: 0 }) === false);
check('level undefined → NOT blocked', fmt.ranksBlockedByLevel({ }) === false);
check('level null → NOT blocked', fmt.ranksBlockedByLevel({ level: null }) === false);
check('level "?" (string sentinel) → NOT blocked', fmt.ranksBlockedByLevel({ level: '?' }) === false);
check('level "15" (string numeric) → BLOCKED', fmt.ranksBlockedByLevel({ level: '15' }) === true);

console.log('\nformatSuccess (end-to-end line):');

// Fixture: Lvl-10 account with a real Diamond in seasonRanks (Xbox-earned via
// crossplay aggregation, per the DMT_Picklez case).
const bugCasePd = {
  userId: 'cbb16ded-43fe-4aee-bf65-88a7afd509c9',
  username: 'DMT_Picklez',
  level: 10,
  credits: 0,
  renown: 4012,
  sections: [],
  seasonRanks: [
    // The offending Xbox-earned Diamond, aggregated onto the Ubi account
    { season: 42, rankTier: 'diamond', rankName: 'Diamond 3', mmr: 4300, iconUrl: '' },
  ],
  linkedAccounts: [{ platform: 'xbl', username: 'DMTPicklezXbox' }],
  linkedPlatforms: ['xbl'],
  banned: false, banChecked: true,
  twoFactor: false,
  emailVerified: true,
  phoneVerified: true,
  hasPhone: true,
};
const bugLine = fmt.formatSuccess('a@b.com', 'pw', bugCasePd);
check('Lvl-10 Diamond fixture → line shows "Ranks: —" (blocked)', /\|\s*Ranks:\s*—\s*\|/.test(bugLine));
check('  (same line still carries the correct level)', /\|\s*Lvl:\s*10\s*\|/.test(bugLine));

// Same fixture but Lvl 25 — Ranks should now show through normally.
const okCasePd = { ...bugCasePd, level: 25 };
const okLine = fmt.formatSuccess('a@b.com', 'pw', okCasePd);
check('Lvl-25 Diamond fixture → line shows the Diamond rank',
  /\|\s*Ranks:\s*Diamond\b/.test(okLine));

// Level 0 (statscard failed) — don't suppress; ranks stay visible so we never
// blank a legit high-rank account whose level fetch broke.
const unknownLvlPd = { ...bugCasePd, level: 0 };
const unknownLine = fmt.formatSuccess('a@b.com', 'pw', unknownLvlPd);
check('Lvl-0 (unknown) Diamond fixture → line still shows Diamond', /\|\s*Ranks:\s*Diamond\b/.test(unknownLine));

// The gate must NOT touch the Skins field (items are PC inventory, unaffected).
const skinPd = { ...bugCasePd, level: 10, sections: [{ key: 'skins', items: [{ name: '1x Glacier', rarity: 'Legendary', tags: ['glacier'] }] }] };
const skinLine = fmt.formatSuccess('a@b.com', 'pw', skinPd);
check('Lvl-10 with Glacier skin → Ranks blocked, but Skins still visible',
  /\|\s*Ranks:\s*—\s*\|/.test(skinLine));  // ranks blocked

// The classification must also flow through correctly — a Lvl-10 line with
// no other wanted signal must NOT classify as vwi.
check('Lvl-10 Diamond fixture is NOT VWI (blocked ranks + no skins)', fmt.isVwiLine(bugLine) === false);

console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
