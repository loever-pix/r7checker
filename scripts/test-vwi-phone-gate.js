// Regression test for the "VWI requires PhoneVerified: Y" rule.
//
// Bug: bulk output classified a Lvl-13 XBX-linked account with (leaked-from-Xbox)
// Diamond ranks as VWI even though PhoneVerified was N. Operator spec: without a
// verified phone, a clean resale account is recovery-vulnerable and must NOT be
// sold as VWI. Applied to BOTH classifiers:
//   - lib/checker/resultFormat.js isVwiLine / feedStatus (server bulk output)
//   - public/js/vwiBuckets.js bucketAccounts (admin sorter for downloads)

const fmt = require('../lib/checker/resultFormat');
const V = require('../public/js/vwiBuckets');

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`); }
}

// The EXACT bogus line from the user's report — must NOT classify as VWI.
const BUG_LINE = `redacted@example.com:redacted | User: gillira2007 | Lvl: 13 | Items: 125 | Credits: 0 | Renown: 2,046 | Ranks: Diamond (S16), Plat (S17) | Skins: — | Linkable: XBX | Banned: N | 2FA: Y | EmailVerified: N | PhoneVerified: N | LastPlayed: — | Profile: https://r6checker.xyz/profile/cbb16ded-43fe-4aee-bf65-88a7afd509c9`;
// Same line but with PhoneVerified: Y — this should still be VWI (has wanted rank).
const OK_LINE  = BUG_LINE.replace('PhoneVerified: N', 'PhoneVerified: Y');
// Phone-status unknown ("?") — spec: must NOT qualify as VWI.
const UNK_LINE = BUG_LINE.replace('PhoneVerified: N', 'PhoneVerified: ?');
// No wanted ranks or skins at all — never VWI regardless of phone.
const PLAIN_LINE = `x@x.com:pw | User: X | Lvl: 100 | Items: 5 | Credits: 0 | Renown: 0 | Ranks: — | Skins: — | Linkable: XBX/PSN | Banned: N | 2FA: N | EmailVerified: Y | PhoneVerified: Y | LastPlayed: — | Profile: -`;

console.log('server-side isVwiLine + feedStatus:');

check('bogus line (PhoneVerified: N) is NOT vwi', fmt.isVwiLine(BUG_LINE) === false);
check('bogus line falls through feedStatus to twofa (2FA: Y)', fmt.feedStatus(BUG_LINE) === 'twofa');
check('same line with PhoneVerified: Y IS vwi', fmt.isVwiLine(OK_LINE) === true);
check('PhoneVerified: ? is NOT vwi (absence of proof)', fmt.isVwiLine(UNK_LINE) === false);
check('plain line with no ranks/skins is NOT vwi even with PhoneVerified: Y', fmt.isVwiLine(PLAIN_LINE) === false);
check('isPhoneVerifiedLine detects Y', fmt.isPhoneVerifiedLine(OK_LINE) === true);
check('isPhoneVerifiedLine rejects N', fmt.isPhoneVerifiedLine(BUG_LINE) === false);
check('isPhoneVerifiedLine rejects ?', fmt.isPhoneVerifiedLine(UNK_LINE) === false);

console.log('\nclient-side vwiBuckets classifier:');

check('isPhoneVerified helper detects Y', V.isPhoneVerified(OK_LINE) === true);
check('isPhoneVerified helper rejects N', V.isPhoneVerified(BUG_LINE) === false);
check('isPhoneVerified helper rejects ?', V.isPhoneVerified(UNK_LINE) === false);

// End-to-end bucketing: a Diamond-with-phone-N account must land in leftovers,
// not a rank bucket. Meta mirrors the real prod metadata.
const meta = {
  ranks: ['Champion', 'Diamond', 'Emerald', 'Plat'],
  namedItemBuckets: ['Glacier', 'Obsidian', 'Chroma Streaks'],
  bannedVwi: { ranks: ['Champion', 'Diamond'], items: [] },
};
const r1 = V.bucketAccounts([BUG_LINE], meta);
check('bucketAccounts: PhoneVerified: N Diamond → NOT rank bucket', r1.rankBuckets['Diamond'].count === 0);
check('bucketAccounts: PhoneVerified: N Diamond → leftover Lvl 13 (<=50)',
  r1.leftovers['No VWI — Lvl 50 & below'].count === 1);
check('bucketAccounts: PhoneVerified: N → vwiTotal 0', r1.stats.vwiTotal === 0);

const r2 = V.bucketAccounts([OK_LINE], meta);
check('bucketAccounts: PhoneVerified: Y Diamond → Diamond bucket', r2.rankBuckets['Diamond'].count === 1);
check('bucketAccounts: PhoneVerified: Y → vwiTotal 1', r2.stats.vwiTotal === 1);

const r3 = V.bucketAccounts([UNK_LINE], meta);
check('bucketAccounts: PhoneVerified: ? Diamond → NOT rank bucket', r3.rankBuckets['Diamond'].count === 0);
check('bucketAccounts: PhoneVerified: ? → leftover, not VWI', r3.stats.vwiTotal === 0);

// Banned VWI path stays as-is (banned account is already sanctioned; phone
// verification is irrelevant to that sale channel).
const BANNED_LINE = BUG_LINE.replace('Banned: N', 'Banned: Y');
const r4 = V.bucketAccounts([BANNED_LINE], meta);
check('bucketAccounts: banned Diamond → banned bucket regardless of phone',
  r4.bannedBucket.count === 1);

console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
