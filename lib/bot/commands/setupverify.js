// /setupverify — owner-only. Sets the Verified role + optional alt-alert log
// channel, and posts a themed step-by-step verification panel with a Verify
// button that links to the site's Discord-OAuth + anti-alt verification flow.

const {
  SlashCommandBuilder, EmbedBuilder, MessageFlags,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType,
} = require('discord.js');
const { cfg } = require('../config');
const verifyConfig = require('../verifyConfig');
const { isOwner } = require('../util');

const VERIFY_URL = process.env.VERIFY_URL || 'https://r6checker.xyz/verify';

const data = new SlashCommandBuilder()
  .setName('setupverify')
  .setDescription('Post the verification panel and set the Verified role')
  .addRoleOption(o => o.setName('role').setDescription('Role granted on successful verification').setRequired(true))
  .addChannelOption(o => o.setName('channel').setDescription('Channel to post the panel in (default: here)').addChannelTypes(ChannelType.GuildText))
  .addChannelOption(o => o.setName('log').setDescription('Channel for alt-block alerts (optional)').addChannelTypes(ChannelType.GuildText));

async function execute(interaction) {
  if (!isOwner(interaction)) {
    return interaction.reply({ content: '⛔ Only the owner can set up verification.', flags: MessageFlags.Ephemeral });
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const role = interaction.options.getRole('role');
  const channel = interaction.options.getChannel('channel') || interaction.channel;
  const log = interaction.options.getChannel('log');

  // The bot can only assign roles BELOW its own highest role.
  const me = await interaction.guild.members.fetchMe();
  if (role.position >= me.roles.highest.position) {
    return interaction.editReply(`⛔ My highest role must be **above** ${role} for me to assign it. Move my role up in Server Settings → Roles, then re-run.`);
  }

  verifyConfig.set({ roleId: role.id, logChannelId: log ? log.id : null });

  const embed = new EmbedBuilder()
    .setColor((cfg.theme && cfg.theme.color) || 0xCAD3DC)
    .setTitle('🔒 Verification required')
    .setDescription(
      `To unlock the server you must verify you're a **real, unique** member. It takes ~15 seconds.\n\n` +
      `**Step 1** — Click **Verify** below.\n` +
      `**Step 2** — Authorize with Discord (we only read your username).\n` +
      `**Step 3** — We run a quick anti-alt check (device, IP, browser).\n` +
      `**Step 4** — You're granted access automatically and gain the ${role} role.`)
    .addFields({ name: 'One account per person', value: 'Alt / duplicate accounts are detected and blocked. Don\'t try to verify twice.' })
    .setFooter({ text: 'Classroom of the Elite · powered by r6checker.xyz' });
  if (cfg.theme && cfg.theme.thumb) embed.setThumbnail(cfg.theme.thumb);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Verify').setEmoji('🔒').setURL(VERIFY_URL),
  );

  try {
    await channel.send({ embeds: [embed], components: [row] });
  } catch (e) {
    return interaction.editReply(`❌ Couldn't post in ${channel}: ${e.message}`);
  }
  return interaction.editReply(`✅ Verification panel posted in ${channel}.\nVerified role: ${role}${log ? ` · alt alerts → ${log}` : ''}.`);
}

module.exports = { data, execute };
