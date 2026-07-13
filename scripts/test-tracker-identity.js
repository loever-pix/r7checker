// Regression test for the tracker.gg username-collision fix.
//
// Bug: a Level-0 account (own UUID lookup empty) inherited a STRANGER's
// Champion/Diamond ranks because the /ubi/{username} candidate resolved the
// shared display name to a different Ubisoft account, and fetchTrackerGG kept
// whichever candidate returned the most seasons with no identity check.
//
// Fix: trackerProfileMismatch() rejects any tracker profile whose returned
// Ubisoft id (data.platformInfo.platformUserId) is a real UUID that differs
// from the account we looked up.

const assert = require('assert');
const { trackerProfileMismatch, trackerWrongPlatform } = require('../lib/rankSources');

const OURS   = '70feaa2e-6cb3-4b54-b83b-65f63f556550'; // the reported account
const STRANGER = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'; // the champion account

function payload(returnedId, handle, slug) {
  return { data: { platformInfo: { platformUserId: returnedId, platformUserHandle: handle, platformSlug: slug }, segments: [] } };
}

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`); }
}

console.log('tracker.gg identity guard:');

// The bug case: /ubi/{username} resolved to a DIFFERENT account → must reject.
check('rejects a different-account UUID (the collision)',
  trackerProfileMismatch(payload(STRANGER, 'Fuggen.Gummy'), OURS) === true);

// Our own account echoed back → must accept.
check('accepts the same account (exact UUID match)',
  trackerProfileMismatch(payload(OURS, 'Fuggen.Gummy'), OURS) === false);

check('accepts same account regardless of UUID case',
  trackerProfileMismatch(payload(OURS.toUpperCase(), 'X'), OURS) === false);

// Can't verify → must NOT reject (never blank ranks we currently show).
check('accepts when tracker echoes no id (unverifiable)',
  trackerProfileMismatch(payload(undefined, 'X'), OURS) === false);

check('accepts when returned id is not a UUID (unverifiable)',
  trackerProfileMismatch(payload('12345', 'X'), OURS) === false);

check('accepts when we have no UUID to verify against',
  trackerProfileMismatch(payload(STRANGER, 'X'), 'Fuggen.Gummy') === false);

check('accepts when payload is empty/degraded',
  trackerProfileMismatch({}, OURS) === false);

console.log('\ntracker.gg wrong-platform guard:');

// The bug: /ubi/{uuid} resolved to a CONSOLE account (Xbox / PSN), leaking
// console ranks into a PC-account check (Lvl-13 with Diamond-S16 case).
check('rejects platformSlug=xbl (Xbox leak)',
  trackerWrongPlatform(payload(OURS, 'X', 'xbl')) === true);
check('rejects platformSlug=psn (PlayStation leak)',
  trackerWrongPlatform(payload(OURS, 'X', 'psn')) === true);
check('rejects platformSlug=xbox (alt Xbox alias)',
  trackerWrongPlatform(payload(OURS, 'X', 'xbox')) === true);
check('rejects platformSlug case-insensitively',
  trackerWrongPlatform(payload(OURS, 'X', 'XBL')) === true);

// PC/Ubi lookups must NOT be rejected.
check('accepts platformSlug=ubi (Ubisoft cross-prog)',
  trackerWrongPlatform(payload(OURS, 'X', 'ubi')) === false);
check('accepts platformSlug=uplay (PC-only lookup)',
  trackerWrongPlatform(payload(OURS, 'X', 'uplay')) === false);

// Missing/unknown slug → don't reject (never blank ranks we currently show).
check('accepts missing platformSlug (unverifiable)',
  trackerWrongPlatform(payload(OURS, 'X', undefined)) === false);
check('accepts empty payload',
  trackerWrongPlatform({}) === false);
check('accepts unknown future slug',
  trackerWrongPlatform(payload(OURS, 'X', 'stadia')) === false);

console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
