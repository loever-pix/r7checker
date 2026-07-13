// Join handling:
//   • Account-age gate — accounts younger than MIN_ACCOUNT_DAYS get a DM'd
//     explainer embed and are kicked (anti-alt / anti-raid).
//   • Otherwise post a themed Ayanokoji welcome that PINGS them and shows their
//     account age, who invited them, and the (human) member count, with a random
//     Ayanokoji gif.

const { EmbedBuilder } = require('discord.js');
const { cfg } = require('./config');
const inviteTracker = require('./inviteTracker');
const inviteLog = require('./inviteLog');

const WELCOME_CHANNEL_ID = process.env.WELCOME_CHANNEL_ID || '1513412737819086898';
const MIN_ACCOUNT_DAYS = Math.max(0, Number(process.env.MIN_ACCOUNT_DAYS) || 30);

// Pool of Ayanokoji gifs — site-hosted (always up) plus any configured Tenor
// URLs. Deduped; one is picked at random per join.
function gifPool() {
  const site = [
    'https://r6checker.xyz/img/ayanokoji/scene.gif',
    'https://r6checker.xyz/img/ayanokoji/banner.gif',
    'https://r6checker.xyz/img/ayanokoji/portrait.gif',
  ];
  const themed = [cfg.theme && cfg.theme.welcomeGif, cfg.theme && cfg.theme.bannerGif, cfg.theme && cfg.theme.rulesImage].filter(Boolean);
  return [...new Set([...site, ...themed])];
}

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

// Best-effort human member count (memberCount includes bots).
function humanCount(guild) {
  const bots = guild.members.cache.filter(m => m.user && m.user.bot).size;
  return Math.max(1, guild.memberCount - bots);
}

async function onJoin(member) {
  try {
    if (!member || member.user?.bot) return;
    const guild = member.guild;

    // ── 1) Account-age gate ──────────────────────────────────────────────────
    const ageMs = Date.now() - member.user.createdTimestamp;
    const days = Math.max(0, Math.floor(ageMs / 86400000));
    if (days < MIN_ACCOUNT_DAYS) {
      const denyEmbed = new EmbedBuilder()
        .setColor(0xf87171)
        .setTitle('⛔ Account too new')
        .setDescription(`Your Discord account must be at least **${MIN_ACCOUNT_DAYS} days old** to join **${guild.name}**.\nYours is only **${days} day${days === 1 ? '' : 's'}** old — come back once it's older.`)
        .setFooter({ text: 'Classroom of the Elite' });
      try { await member.send({ embeds: [denyEmbed] }); } catch { /* DMs closed */ }
      try { await member.kick(`Account younger than ${MIN_ACCOUNT_DAYS} days`); }
      catch (e) { console.warn('[welcome] kick failed (need Kick Members perm):', e.message); }
      // Refresh the invite cache anyway so the count diff stays correct.
      try { await inviteTracker.resolveUsedInvite(member); } catch {}
      return;
    }

    // ── 2) Welcome ───────────────────────────────────────────────────────────
    const ch = await guild.channels.fetch(WELCOME_CHANNEL_ID).catch(() => null);
    if (!ch || typeof ch.send !== 'function') {
      console.warn('[welcome] channel', WELCOME_CHANNEL_ID, 'not found / not text');
      try { await inviteTracker.resolveUsedInvite(member); } catch {}
      return;
    }

    // Who invited them.
    let invitedBy = 'Unknown';
    try {
      const inv = await inviteTracker.resolveUsedInvite(member);
      if (inv) {
        if (inv.vanity) invitedBy = `Vanity URL \`${inv.code}\``;
        else if (inv.inviter) {
          invitedBy = `<@${inv.inviter.id}> · \`${inv.code}\``;
          // Log this join under the inviter so /invites can show it.
          inviteLog.record({ inviterId: inv.inviter.id, joinerId: member.id, joinerName: member.user.username, createdAt: member.user.createdTimestamp, code: inv.code });
        }
        else invitedBy = `\`${inv.code}\``;
      }
    } catch {}

    const created = Math.floor(member.user.createdTimestamp / 1000);
    const pool = gifPool();
    const gif = pool[Math.floor(Math.random() * pool.length)];

    const embed = new EmbedBuilder()
      .setColor((cfg.theme && cfg.theme.color) || 0xCAD3DC)
      .setAuthor({ name: member.user.username, iconURL: member.displayAvatarURL({ size: 128 }) })
      .setTitle('ようこそ — Welcome to the Elite')
      .setDescription(`Welcome <@${member.id}> to **${guild.name}** — our **${ordinal(humanCount(guild))}** member.`)
      .addFields(
        { name: 'Account age', value: `created <t:${created}:R>`, inline: true },
        { name: 'Invited by', value: invitedBy, inline: true },
      )
      .setThumbnail(member.displayAvatarURL({ size: 256 }))
      .setImage(gif)
      .setFooter({ text: 'Classroom of the Elite' })
      .setTimestamp(new Date());

    // The content ping is what actually notifies them (embed mentions don't).
    await ch.send({ content: `<@${member.id}>`, embeds: [embed], allowedMentions: { users: [member.id] } });
  } catch (e) {
    console.warn('[welcome] failed:', e.message);
  }
}

module.exports = { onJoin, WELCOME_CHANNEL_ID, MIN_ACCOUNT_DAYS, gifPool };
