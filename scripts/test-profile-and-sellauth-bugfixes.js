const assert = require('assert');

const player = require('../lib/player');
const sa = require('../lib/bot/sellauth');
const storeSync = require('../lib/bot/storeSync');

function testRankedCharmUsesCharmArt() {
  const charms = player._test.buildRankedCharms([
    { season: 22, seasonName: 'North Star', rankTier: 'platinum' },
  ]);
  const platinum = charms.find(c => c.name === 'Platinum (North Star)');
  assert(platinum, 'expected Platinum (North Star) charm');
  assert(
    decodeURIComponent(platinum.image).includes('/cdn/charms/'),
    `expected ranked charm art, got ${platinum.image}`
  );
}

function testSellAuthVariantSelection() {
  const product = {
    id: 123,
    name: 'R6 Accounts',
    variants: [
      { id: 'v1', name: 'Champion XBOX' },
      { id: 'v2', name: 'Platinum XBOX' },
      { id: 'v3', name: 'Multi Platinum XBOX' },
    ],
  };
  const account = storeSync.classifyAccount(
    'a:b | User: test | Lvl: 160 | Items: 855 | Ranks: Platinum (Deadly Omen) | Skins: 300 | Linkable: XBX | Banned: No'
  );
  const hit = storeSync._test.selectVariant(product, account);
  assert(hit, 'expected a matching variant');
  assert.strictEqual(hit.id, 'v2');
}

function testDefaultVariantUsesProductName() {
  const product = { name: '[PSN] Platinum NFA' };
  const variant = { name: 'Default' };
  assert.strictEqual(storeSync._test.syncedVariantName(product, variant), '[PSN] Platinum NFA');
  assert.strictEqual(storeSync._test.syncedVariantName(product, { name: 'Platinum PSN' }), 'Platinum PSN');
}

function testAccountVariantFormatting() {
  const line = 'a:b | User: gcb528 | Lvl: 160 | Items: 855 | Credits: 300 | Renown: 50596 | Black Ices: 6 | Elites: 1 | 2FA: ENABLED | Banned: No | Phone Verified: No | Email Verified: No | Ranked Charms: Platinum (Deadly Omen) | Wanted Items: none | Skin Link: https://r6skins.locker/profile/abc | Last Played: 2025-08-10';
  const parsed = storeSync.parseLine(line);
  assert.strictEqual(storeSync._test.accountVariantName(parsed), 'gcb528 | L160 | 855 items | 6 BI | 1 Elite');
  const desc = storeSync._test.buildAccountVariantDescription(parsed);
  assert(desc.includes('Username: gcb528'));
  assert(desc.includes('Level: 160'));
  assert(desc.includes('Ranked Charms: Platinum (Deadly Omen)'));
  assert(desc.includes('Skin checker: https://r6checker.xyz/profile/abc'));
  assert(desc.includes('Delivered as email:password after purchase.'));
  assert(!desc.includes('**'));
  assert(!desc.includes('<!--'));
}

function testMysteryProductsAreSkippedForAccountVariants() {
  assert.strictEqual(storeSync._test.shouldSplitProduct({ name: '[PSN] Platinum NFA' }), true);
  assert.strictEqual(storeSync._test.shouldSplitProduct({ name: '[PSN] Mystery Wanted Items NFA' }), false);
}

function testAccountVariantDetection() {
  assert.strictEqual(storeSync._test.isAccountVariantName('ITG.Main | L75 | 121 items'), true);
  assert.strictEqual(storeSync._test.isAccountVariantName('[XBX] Platinum NFA'), false);
}

async function testSyncAccountsRoutesToVariant() {
  const originalListProducts = sa.listProducts;
  sa.listProducts = async () => [{
    id: 123,
    name: 'R6 Accounts',
    variants: [
      { id: 'v1', name: 'Champion XBOX' },
      { id: 'v2', name: 'Platinum XBOX' },
      { id: 'v3', name: 'Multi Platinum XBOX' },
    ],
  }];

  try {
    const report = await storeSync.syncAccounts([
      'a:b | User: test | Lvl: 160 | Items: 855 | Ranks: Platinum (Deadly Omen) | Skins: 300 | Linkable: XBX | Banned: No',
    ], { dryRun: true });
    assert.strictEqual(report.unmatched.length, 0);
    assert.strictEqual(report.routed.length, 1);
    assert.strictEqual(report.routed[0].variantId, 'v2');
  } finally {
    sa.listProducts = originalListProducts;
  }
}

(async () => {
  testRankedCharmUsesCharmArt();
  testSellAuthVariantSelection();
  testDefaultVariantUsesProductName();
  testAccountVariantFormatting();
  testMysteryProductsAreSkippedForAccountVariants();
  testAccountVariantDetection();
  await testSyncAccountsRoutesToVariant();
  console.log('profile/sellauth bugfix tests passed');
})().catch(e => {
  console.error(e);
  process.exit(1);
});
