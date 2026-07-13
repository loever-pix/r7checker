// Throwaway local-preview generator: builds a synthetic cached profile that
// embeds the REAL parsed tracker.gg combat stats so the new panel renders
// without a live Ubisoft session. Visual verification only.
const fs = require('fs');
const path = require('path');
const { parseTrackerGGStats } = require('../lib/rankSources');

const ROOT = path.join(__dirname, '..');
const tgRaw = JSON.parse(
  fs.readFileSync(path.join(ROOT, '.cache', 'tracker-gg', '39cf69766633b1672067a65d.json'), 'utf8')
);
const trackerStats = parseTrackerGGStats(tgRaw);
if (!trackerStats) { console.error('parse failed'); process.exit(1); }

const data = {
  userId: 'preview-demo',
  username: trackerStats.handle || 'Sakayanagi',
  avatar: 'https://ubisoft-avatars.akamaized.net/default/default_146_146.png',
  level: 312,
  renown: 0,
  credits: 0,
  linkedPlatforms: ['uplay'],
  trackerStats,
  seasonRanks: [
    { seasonName: 'Y9S4 Collision', rankTier: 'champion', rankName: 'Champion', mmr: 4643, iconUrl: '', champPosition: 812 },
    { seasonName: 'Y9S3 Heavy Mettle', rankTier: 'diamond', rankName: 'Diamond', mmr: 4120, iconUrl: '' },
    { seasonName: 'Y9S2 New Blood', rankTier: 'platinum', rankName: 'Platinum 1', mmr: 3550, iconUrl: '' },
  ],
  sections: [
    { title: 'Black Ice', key: 'blackice', items: [
      { name: 'R4-C Black Ice', image: '' },
      { name: 'AK-12 Black Ice', image: '' },
    ] },
  ],
};

const out = path.join(ROOT, '.cache', 'preview-demo.json');
fs.writeFileSync(out, JSON.stringify({ ts: Date.now(), data }));
console.log('wrote', out);
console.log('trackerStats.overview KD:', trackerStats.overview?.kdRatio?.display,
  '| Win:', trackerStats.overview?.winPct?.display,
  '| modes:', trackerStats.gamemodes?.length,
  '| hero:', !!trackerStats.heroUrl);
