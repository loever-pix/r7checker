// Invite tracking — caches each guild's invite uses so that, on join, we can
// tell WHICH invite a member used (and therefore who invited them). Standard
// technique: snapshot uses on boot + invite events, then on join diff the
// counts to find the one that ticked up. Needs the bot to have "Manage Server".

const cache = new Map();   // guildId -> Map<code, uses>

async function snapshot(guild) {
  const m = new Map();
  try {
    const invites = await guild.invites.fetch();
    invites.forEach(i => m.set(i.code, i.uses || 0));
  } catch { /* no Manage Server perm — invite source will read "Unknown" */ }
  try {
    if (guild.vanityURLCode) { const v = await guild.fetchVanityData(); m.set('VANITY', v.uses || 0); }
  } catch {}
  return m;
}

async function primeGuild(guild) {
  try { cache.set(guild.id, await snapshot(guild)); } catch {}
}

async function prime(client) {
  for (const guild of client.guilds.cache.values()) await primeGuild(guild);
}

function onInviteCreate(invite) {
  if (!invite?.guild) return;
  const m = cache.get(invite.guild.id) || new Map();
  m.set(invite.code, invite.uses || 0);
  cache.set(invite.guild.id, m);
}
function onInviteDelete(invite) {
  const m = invite?.guild && cache.get(invite.guild.id);
  if (m) m.delete(invite.code);
}

// Returns { code, inviter, uses, vanity? } for the invite the member just used,
// or null if it can't be determined. Updates the cache to the new counts.
async function resolveUsedInvite(member) {
  const guild = member.guild;
  const before = cache.get(guild.id) || new Map();
  let used = null;
  try {
    const invites = await guild.invites.fetch();
    for (const inv of invites.values()) {
      if ((inv.uses || 0) > (before.get(inv.code) || 0)) { used = inv; break; }
    }
    const after = new Map();
    invites.forEach(i => after.set(i.code, i.uses || 0));
    if (!used && guild.vanityURLCode) {
      try {
        const v = await guild.fetchVanityData();
        if ((v.uses || 0) > (before.get('VANITY') || 0)) used = { code: guild.vanityURLCode, inviter: null, uses: v.uses, vanity: true };
        after.set('VANITY', v.uses || 0);
      } catch {}
    }
    cache.set(guild.id, after);
  } catch { return null; }
  return used;
}

module.exports = { prime, primeGuild, onInviteCreate, onInviteDelete, resolveUsedInvite };
