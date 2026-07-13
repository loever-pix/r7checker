// /setupsales — owner-only. Creates (or points at) the PUBLIC sales-feed
// channel where the bot auto-posts every purchase (pending → paid). Everyone
// can READ it; only the bot can post. Persists the channel id so the feed works
// without an env var / restart. Pass an existing channel to use it instead.

const { SlashCommandBuilder, ChannelType, PermissionFlagsBits, EmbedBuilder, MessageFlags } = require('discord.js');
const { cfg } = require('../config');
const salesFeed = require('../salesFeed');
const { isOwner } = require('../util');

const data = new SlashCommandBuilder()
  .setName('setupsales')
  .setDescription('Create/set the public sales-feed channel (auto-posts purchases)')
  .addChannelOption(o => o
    .setName('channel')
    .setDescription('Use this existing channel instead of creating one')
    .addChannelTypes(ChannelType.GuildText)
    .setRequired(false));

async function execute(interaction) {
  if (!isOwner(interaction)) {
    return interaction.reply({ content: '⛔ Only owners can set up the sales feed.', flags: MessageFlags.Ephemeral });
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const guild = interaction.guild;
  let channel = interaction.options.getChannel('channel');

  try {
    if (!channel) {
      // Public read-only channel: @everyone can VIEW + read history but NOT send;
      // the bot can send.
      channel = await guild.channels.create({
        name: '💸-sales',
        type: ChannelType.GuildText,
        topic: 'Live store purchases — auto-posted by the bot.',
        permissionOverwrites: [
          { id: guild.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory], deny: [PermissionFlagsBits.SendMessages, PermissionFlagsBits.AddReactions] },
          { id: interaction.client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageMessages, PermissionFlagsBits.EmbedLinks] },
        ],
        reason: `Sales feed set up by ${interaction.user.tag}`,
      });
    } else {
      // Lock an existing channel to read-only for @everyone, allow the bot.
      try {
        await channel.permissionOverwrites.edit(guild.id, { ViewChannel: true, ReadMessageHistory: true, SendMessages: false });
        await channel.permissionOverwrites.edit(interaction.client.user.id, { ViewChannel: true, SendMessages: true, EmbedLinks: true });
      } catch (e) { /* best-effort — owner can adjust perms manually */ }
    }
  } catch (e) {
    return interaction.editReply(`❌ Could not create/configure the channel: ${e.message}\nMake sure I have **Manage Channels**.`);
  }

  salesFeed.setChannelId(channel.id);

  // Header so the channel isn't empty before the first sale.
  try {
    await channel.send({ embeds: [new EmbedBuilder()
      .setColor(0x42cb6e)
      .setTitle('💸 Live Sales Feed')
      .setDescription('Every purchase from the **R6Checker Store** posts here automatically.\nBuyer emails are partially hidden for privacy.')
      .setFooter({ text: 'R6Checker Store' })] });
  } catch { /* non-fatal */ }

  return interaction.editReply(`✅ Sales feed channel set to <#${channel.id}>. New purchases will post here automatically (pending → paid).`);
}

module.exports = { data, execute };
