require('dotenv').config();
const { login } = require('../lib/auth');
const { getPlayerData } = require('../lib/player');
(async () => {
  const combo = process.argv[2] || '';
  const i = combo.indexOf(':');
  const s = await login(combo.slice(0, i), combo.slice(i + 1));
  const t = Date.now();
  const data = await getPlayerData(s.userId, s.ticket, s.sessionId, s.appId, { bulk: true });
  console.log(`[bulk] ${data.username} in ${Date.now()-t}ms — seasonRanks: ${(data.seasonRanks||[]).length}, consoles: ${JSON.stringify(data.linkedConsoles||[])}`);
  for (const r of (data.seasonRanks||[]).slice(0,6)) console.log(`   S${r.season} ${r.seasonName}: ${r.rankName} (${r.mmr}) ${r.platform}`);
  process.exit(0);
})().catch(e => { console.log('err', e.message); process.exit(1); });
