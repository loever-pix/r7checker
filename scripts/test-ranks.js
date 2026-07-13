// Verify the upgraded tracker.gg rank pipeline (3.0 badges, multi-platform,
// ghost) end to end.   node scripts/test-ranks.js email:password
require('dotenv').config();
const { login } = require('../lib/auth');
const { getPlayerData } = require('../lib/player');

(async () => {
  const combo = process.argv[2] || '';
  const i = combo.indexOf(':');
  const email = combo.slice(0, i), password = combo.slice(i + 1);
  if (!email || !password) { console.error('usage: email:password'); process.exit(1); }

  const session = await login(email, password);
  console.log(`[test] login OK userId=${session.userId}`);
  const data = await getPlayerData(session.userId, session.ticket, session.sessionId, session.appId);
  console.log(`[test] ${data.username} banned=${data.banned}`);
  console.log(`[test] linkedPlatforms: ${JSON.stringify(data.linkedConsoles || [])}`);
  const ranks = data.seasonRanks || [];
  console.log(`[test] seasonRanks: ${ranks.length}`);
  for (const r of ranks.slice(0, 10)) {
    const badge = decodeURIComponent((r.currentIconUrl || '').replace('/api/img?url=', '')).split('/').pop();
    console.log(`   S${r.season} ${r.seasonName}: ${r.currentRankName}(${r.currentMmr}) peak ${r.rankName}(${r.mmr}) plat=${r.platform}${r.ghost ? ' GHOST' : ''} badge=${badge}`);
  }
  process.exit(0);
})().catch(e => { console.error('[test] failed:', e.message); process.exit(1); });
