// Auto-grant a role to every member: on join (guildMemberAdd) and a one-time
// backfill of all existing members on startup.
//
// REQUIRES the privileged "Server Members Intent" enabled in the Discord
// developer portal (GuildMembers). Without it the bot can't see joins or list
// members.

const { cfg } = require('./config');

async function onJoin(member) {
  if (member.user?.bot) return;
  try { await member.roles.add(cfg.joinRoleId); }
  catch (e) { console.warn(`[bot] join-role add failed for ${member.id}:`, e.message); }
}

// Backfill: give the role to every current member who lacks it.
async function backfill(guild) {
  let added = 0, skipped = 0;
  try {
    const members = await guild.members.fetch(); // needs GuildMembers intent
    for (const member of members.values()) {
      if (member.user.bot) continue;
      if (member.roles.cache.has(cfg.joinRoleId)) { skipped++; continue; }
      try { await member.roles.add(cfg.joinRoleId); added++; }
      catch (e) { console.warn(`[bot] backfill add failed for ${member.id}:`, e.message); }
    }
    console.log(`[bot] join-role backfill: +${added} added, ${skipped} already had it`);
  } catch (e) {
    console.warn('[bot] join-role backfill failed (is the Server Members Intent enabled?):', e.message);
  }
}

module.exports = { onJoin, backfill };
