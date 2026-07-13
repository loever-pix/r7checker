// /setupserver — owner-only. Idempotently builds a clean, Ayanokoji-themed
// (Classroom of the Elite) server layout for the R6Checker brand:
//   • categories: Information / Store / Community / Support
//   • read-only info channels + community channels
//   • roles: Staff / Promoter / VIP (colored)
//   • themed welcome / rules / shop / faq embeds (posted ONLY into channels it
//     just created, so re-running never spams)
//
// NON-DESTRUCTIVE: matches existing channels/roles by normalized name and skips
// them — it only ADDS what's missing, never renames or deletes anything.
// Optional Ayanokoji media via env (THEME) — absent = clean, never a broken img.

const { SlashCommandBuilder, ChannelType, PermissionFlagsBits, EmbedBuilder, MessageFlags } = require('discord.js');
const { cfg } = require('../config');
const { isOwner } = require('../util');

const data = new SlashCommandBuilder()
  .setName('setupserver')
  .setDescription('Build the Ayanokoji-themed server layout (non-destructive)');

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const T = () => cfg.theme || { color: 0xCAD3DC };

// ── Layout spec ─────────────────────────────────────────────────────────────
// readonly: @everyone can view + read history but not send. embed: posted once
// into the channel when (and only when) this run creates it.
const LAYOUT = [
  { cat: '🌐 ・ INFORMATION', channels: [
    { name: '👋・welcome',        readonly: true, embed: 'welcome' },
    { name: '📢・announcements',  readonly: true },
    { name: '📜・rules',          readonly: true, embed: 'rules' },
    { name: '🎉・giveaways',      readonly: true },
  ]},
  { cat: '🛒 ・ STORE', channels: [
    { name: '🛍️・shop',          readonly: true, embed: 'shop' },
    { name: '💸・sales',          readonly: true },
    { name: '🔔・restocks',       readonly: true },
    { name: '⭐・vouches',         readonly: false },
    { name: '🧾・get-buyer-role', readonly: true },
  ]},
  { cat: '💬 ・ COMMUNITY', channels: [
    { name: '💬・general',         readonly: false },
    { name: '🎮・r6-siege',        readonly: false },
    { name: '🤖・bot-commands',    readonly: false },
    { name: '🎟️・promoter-program', readonly: true, embed: 'promo' },
  ]},
  { cat: '🎫 ・ SUPPORT', channels: [
    { name: '🎫・open-a-ticket',  readonly: true, embed: 'support' },
    { name: '❓・faq',            readonly: true, embed: 'faq' },
  ]},
];

const ROLES = [
  { name: 'Staff',    color: 0x5865F2, hoist: true },
  { name: 'Promoter', color: 0xE91E63, hoist: true },
  { name: 'VIP',      color: 0xF1C40F, hoist: true },
];

// ── Themed embeds ─────────────────────────────────────────────────────────────
function themedEmbed(kind, guild) {
  const t = T();
  const e = new EmbedBuilder().setColor(t.color);
  const withMedia = (em, gif, img) => { if (gif) em.setImage(gif); if (img && !gif) em.setImage(img); if (t.thumb) em.setThumbnail(t.thumb); return em; };
  switch (kind) {
    case 'welcome':
      e.setTitle(`Welcome to ${guild.name}`)
        .setDescription('> *"Observe. Adapt. Ascend."*\n\nYou\'ve entered the home of **R6Checker** — premium Rainbow Six accounts, the fastest checker tools, and a community that plays to win.\n\n**Get started**\n• 📜 Read the <#rules> \n• 🛍️ Browse the **Store**\n• 🧾 Verify a purchase to unlock the **Buyer** role\n• 💬 Say hi in **general**')
        .setFooter({ text: 'R6Checker · Classroom of the Elite' });
      return withMedia(e, t.welcomeGif, t.bannerGif);
    case 'rules':
      e.setTitle('📜 Rules')
        .setDescription('Keep it sharp, keep it clean.\n\n**1.** Respect every member — no harassment, hate, or drama.\n**2.** No spam, self-promo, or unsolicited DMs.\n**3.** English in public channels.\n**4.** No scamming. Use official channels for all deals.\n**5.** Follow Discord\'s [Terms](https://discord.com/terms) & [Guidelines](https://discord.com/guidelines).\n\n*Staff decisions are final. Play smart.*')
        .setFooter({ text: 'Breaking the rules has consequences.' });
      return withMedia(e, null, t.rulesImage);
    case 'shop':
      e.setTitle('🛍️ R6Checker Store')
        .setDescription('Premium R6 accounts — ranked, skinned, ban-checked.\n\n• 🌐 **Website:** https://r6checker.xyz\n• 🛒 **Shop:** https://r6checker.mysellauth.com/\n• 💸 Live sales post in the **sales** channel\n• 🔔 Restocks ping in **restocks**\n\nAfter purchase, verify your invoice in **get-buyer-role**.')
        .setFooter({ text: 'R6Checker Store' });
      return withMedia(e, null, null);
    case 'promo':
      e.setTitle('🎟️ Promoter Program')
        .setDescription('Grow the brand, earn rewards. Run `/promoter` or ask staff to learn more — promote R6Checker across YouTube, TikTok, X & Discord for store credit, accounts, roles & commission.')
        .setFooter({ text: 'R6Checker · Promoter Program' });
      return withMedia(e, null, null);
    case 'support':
      e.setTitle('🎫 Support')
        .setDescription('Need help with an order, a checker, or your account?\n\n• Describe your issue clearly\n• Include your **invoice ID** for order help\n• A staff member will assist you\n\n*Do not share passwords in public channels.*')
        .setFooter({ text: 'R6Checker Support' });
      return withMedia(e, null, null);
    case 'faq':
      e.setTitle('❓ FAQ')
        .setDescription('**How do I buy?** → Use the **Store** link in 🛍️ shop.\n**How do I get the Buyer role?** → Verify your invoice in 🧾 get-buyer-role.\n**What is the Checker?** → Download it from https://r6checker.xyz/download.\n**Refunds?** → Per the store policy at checkout.')
        .setFooter({ text: 'R6Checker' });
      return withMedia(e, null, null);
    default:
      return e.setDescription('—');
  }
}

async function execute(interaction) {
  if (!isOwner(interaction)) {
    return interaction.reply({ content: '⛔ Only owners can run server setup.', flags: MessageFlags.Ephemeral });
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const guild = interaction.guild;
  const me = guild.members.me;
  if (!me?.permissions.has(PermissionFlagsBits.ManageChannels) || !me?.permissions.has(PermissionFlagsBits.ManageRoles)) {
    return interaction.editReply('❌ I need **Manage Channels** and **Manage Roles**. Grant them and re-run.');
  }

  await guild.channels.fetch().catch(() => {});
  await guild.roles.fetch().catch(() => {});
  const report = { cats: 0, channels: 0, roles: 0, skipped: 0, errors: [] };

  // ── Roles (additive) ──
  for (const r of ROLES) {
    if (guild.roles.cache.some(x => norm(x.name) === norm(r.name))) { report.skipped++; continue; }
    try { await guild.roles.create({ name: r.name, color: r.color, hoist: r.hoist, mentionable: false, reason: 'setupserver' }); report.roles++; }
    catch (e) { report.errors.push(`role ${r.name}: ${e.message}`); }
  }

  // ── Optional server icon ──
  if (T().serverIcon) { try { await guild.setIcon(T().serverIcon, 'setupserver theme'); } catch (e) { report.errors.push('icon: ' + e.message); } }

  // ── Categories + channels (additive) ──
  const everyone = guild.roles.everyone.id;
  for (const block of LAYOUT) {
    let category = guild.channels.cache.find(c => c.type === ChannelType.GuildCategory && norm(c.name) === norm(block.cat));
    if (!category) {
      try { category = await guild.channels.create({ name: block.cat, type: ChannelType.GuildCategory, reason: 'setupserver' }); report.cats++; }
      catch (e) { report.errors.push(`cat ${block.cat}: ${e.message}`); continue; }
    } else { report.skipped++; }

    for (const ch of block.channels) {
      const existing = guild.channels.cache.find(c => c.type === ChannelType.GuildText && norm(c.name) === norm(ch.name));
      if (existing) { report.skipped++; continue; }
      const overwrites = ch.readonly ? [
        { id: everyone, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory], deny: [PermissionFlagsBits.SendMessages, PermissionFlagsBits.AddReactions, PermissionFlagsBits.CreatePublicThreads] },
        { id: interaction.client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ManageMessages] },
      ] : undefined;
      try {
        const created = await guild.channels.create({ name: ch.name, type: ChannelType.GuildText, parent: category.id, permissionOverwrites: overwrites, reason: 'setupserver' });
        report.channels++;
        if (ch.embed) { try { await created.send({ embeds: [themedEmbed(ch.embed, guild)] }); } catch (e) { report.errors.push(`embed ${ch.name}: ${e.message}`); } }
      } catch (e) { report.errors.push(`ch ${ch.name}: ${e.message}`); }
    }
  }

  const summary = new EmbedBuilder()
    .setColor(T().color)
    .setTitle('✅ Server setup complete')
    .setDescription(`Created **${report.cats}** categories, **${report.channels}** channels, **${report.roles}** roles.\nSkipped **${report.skipped}** that already existed (nothing was deleted or renamed).`)
    .setFooter({ text: 'Ayanokoji theme · re-run anytime, it only adds what\'s missing' });
  if (report.errors.length) summary.addFields({ name: '⚠️ Notes', value: report.errors.slice(0, 8).join('\n').slice(0, 1000) });
  return interaction.editReply({ embeds: [summary] });
}

module.exports = { data, execute };
