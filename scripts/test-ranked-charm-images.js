const assert = require('assert');
const fs = require('fs');
const path = require('path');

const dataPath = path.join(__dirname, '..', 'data', 'ranked-charm-images.json');
const originalExists = fs.existsSync(dataPath);
const original = originalExists ? fs.readFileSync(dataPath, 'utf8') : null;

function writeGeneratedData() {
  fs.mkdirSync(path.dirname(dataPath), { recursive: true });
  fs.writeFileSync(dataPath, JSON.stringify({
    _comment: 'Test data written by scripts/test-ranked-charm-images.js',
    _lastUpdated: '2026-06-15',
    items: {
      'platinum|test season': {
        name: 'Platinum (Test Season)',
        tier: 'platinum',
        season: 'Test Season',
        image: 'https://siegeskins.com/cdn/charms/generated-object.png?imwidth=256',
        source: 'test',
      },
      'gold|string season': 'https://siegeskins.com/cdn/charms/generated-string.png?imwidth=256',
    },
    missing: [],
  }, null, 2));
}

function restoreGeneratedData() {
  if (originalExists) fs.writeFileSync(dataPath, original);
  else if (fs.existsSync(dataPath)) fs.unlinkSync(dataPath);
}

function loadFreshPlayer() {
  const playerPath = require.resolve('../lib/player');
  delete require.cache[playerPath];
  return require('../lib/player');
}

try {
  writeGeneratedData();
  const player = loadFreshPlayer();

  const objectUrl = player._test.rankedCharmImage('platinum', 'Test Season');
  assert.strictEqual(
    objectUrl,
    'https://siegeskins.com/cdn/charms/generated-object.png?imwidth=256',
    'object entries from data/ranked-charm-images.json should win'
  );

  const stringUrl = player._test.rankedCharmImage('gold', 'String Season');
  assert.strictEqual(
    stringUrl,
    'https://siegeskins.com/cdn/charms/generated-string.png?imwidth=256',
    'string entries from data/ranked-charm-images.json should be supported'
  );

  const charms = player._test.buildRankedCharms([
    { season: 99, seasonName: 'Test Season', rankTier: 'platinum' },
  ]);
  const platinum = charms.find(c => c.name === 'Platinum (Test Season)');
  assert(platinum, 'expected generated Platinum (Test Season) charm');
  assert(
    decodeURIComponent(platinum.image).includes('generated-object.png'),
    `expected generated charm image to flow through buildRankedCharms, got ${platinum.image}`
  );

  const ownedCollision = player._test.buildRankedCharms([
    { season: 99, seasonName: 'Test Season', rankTier: 'platinum' },
  ], {
    '99|platinum': '/api/img?url=https%3A%2F%2Fowned.example%2Fwrong.png',
  });
  const collisionPlatinum = ownedCollision.find(c => c.name === 'Platinum (Test Season)');
  assert(
    decodeURIComponent(collisionPlatinum.image).includes('generated-object.png'),
    `expected generated charm image to beat owned heuristic image, got ${collisionPlatinum.image}`
  );

  const fallback = player._test.rankedCharmImage('platinum', 'North Star');
  assert(
    fallback && fallback.includes('/cdn/charms/'),
    `expected existing skins_cache fallback for Platinum (North Star), got ${fallback}`
  );

  console.log('ranked charm image tests passed');
} finally {
  restoreGeneratedData();
}
