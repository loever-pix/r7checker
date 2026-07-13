// /promoter — owner-only. Posts the Promoter Program recruitment embed
// (with Visit + Shop link buttons) into the current channel as a clean,
// standalone bot message. The invoking staff member gets an ephemeral ack.

const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const { isOwner } = require('../util');

const data = new SlashCommandBuilder()
  .setName('promoter')
  .setDescription('Post the Promoter Program recruitment embed in this channel');

function buildPromoMessage() {
  const embed = new EmbedBuilder()
    .setTitle('🚀 Promoter Program – Join Our Team')
    .setDescription('We are looking for motivated individuals to help grow the **R6Checker** brand across social media platforms.')
    .setColor(15105570)
    .addFields(
      { name: '📱 Platforms', value: 'Promote across **YouTube, Discord, TikTok, Twitter/X, Instagram, and more**.', inline: false },
      { name: '📢 What to Promote', value: '• **Discord Server** (use your custom invite link)\n• **R6Checker.xyz** (stats & verification)\n• **R6Checker Shop** (r6checker.mysellauth.com)\n• **The Checker Tool** (account lookup)\n• **Website & Services**', inline: false },
      { name: '🔗 Your Invite Link', value: '**Create your own Discord invite link** with:\n• **Expire:** Never\n• **Max Uses:** Unlimited\n• Always use this link for all promotions.', inline: false },
      { name: '🎁 Rewards', value: 'Earn rewards based on performance:\n• **Accounts** – access to premium stock\n• **Checker Access** – unlimited lookups\n• **Store Balance** – credit added to your account\n• **Exclusive Roles** – in the Discord server\n• **Commission** – on sales via your referrals', inline: false },
      { name: '📊 How It Works', value: '1. Create your permanent Discord invite link.\n2. Promote across your social channels.\n3. Track your referrals and performance.\n4. Redeem rewards monthly.', inline: false },
      { name: '📩 Apply Now', value: 'DM a staff member with your:\n• Preferred platforms\n• Experience (if any)\n• Discord invite link\n\n**Start earning today!**', inline: false },
    )
    .setFooter({ text: 'R6Checker.xyz | Promoter Program' });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setLabel('🌐 Visit R6Checker.xyz').setStyle(ButtonStyle.Link).setURL('https://r6checker.xyz'),
    new ButtonBuilder().setLabel('🛒 Shop Now').setStyle(ButtonStyle.Link).setURL('https://r6checker.mysellauth.com/'),
  );

  return { embeds: [embed], components: [row] };
}

async function execute(interaction) {
  if (!isOwner(interaction)) {
    return interaction.reply({ content: '⛔ Only owners can post the promoter embed.', flags: MessageFlags.Ephemeral });
  }
  const msg = buildPromoMessage();
  try {
    await interaction.channel.send(msg);
    await interaction.reply({ content: '✅ Promoter embed posted.', flags: MessageFlags.Ephemeral });
  } catch (e) {
    await interaction.reply({ content: `❌ Could not post: ${e.message}`, flags: MessageFlags.Ephemeral });
  }
}

module.exports = { data, execute, buildPromoMessage };
