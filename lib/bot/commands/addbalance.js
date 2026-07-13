// /addbalance — owner-only. Add SellAuth store credit to a customer by email.
//   /addbalance amount:<USD> email:<customer>
// Two-step against the SellAuth API:
//   1. find the customer by email   → GET  /customers?email=
//   2. add credit to their wallet   → POST /customers/{id}/credits  { amount }

const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const sa = require('../sellauth');
const { isOwner } = require('../util');

const data = new SlashCommandBuilder()
  .setName('addbalance')
  .setDescription('Add SellAuth store credit to a customer by email')
  .addNumberOption(o => o
    .setName('amount')
    .setDescription('Amount of store credit to add (USD, e.g. 5 or 12.50)')
    .setRequired(true)
    .setMinValue(0.01)
    .setMaxValue(10000))
  .addStringOption(o => o
    .setName('email')
    .setDescription("Customer's SellAuth email")
    .setRequired(true))
  .addStringOption(o => o
    .setName('reason')
    .setDescription('Optional note shown on the SellAuth transaction')
    .setRequired(false)
    .setMaxLength(200));

async function execute(interaction) {
  if (!isOwner(interaction)) {
    return interaction.reply({ content: '⛔ Only owners can add store credit.', flags: MessageFlags.Ephemeral });
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const amount = Number(interaction.options.getNumber('amount'));
  const email  = String(interaction.options.getString('email') || '').trim().toLowerCase();
  const reason = String(interaction.options.getString('reason') || '').trim();
  const description = reason || `Manual credit by ${interaction.user.tag} via Discord`;
  if (!Number.isFinite(amount) || amount <= 0) {
    return interaction.editReply('❌ Amount must be greater than 0.');
  }
  if (!/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(email)) {
    return interaction.editReply('❌ That email doesn\'t look valid.');
  }

  // 1) Find the customer.
  let customer;
  try {
    customer = await sa.findCustomerByEmail(email);
  } catch (e) {
    return interaction.editReply(`❌ SellAuth lookup failed: ${e.message}`);
  }
  if (!customer || !customer.id) {
    return interaction.editReply(`❌ No SellAuth customer found for **${email}**.`);
  }

  // 2) Credit their balance.
  try {
    await sa.addCustomerCredit(customer.id, amount, description);
  } catch (e) {
    return interaction.editReply(`❌ SellAuth rejected the credit: ${e.message}`);
  }

  const usd = amount.toFixed(2);
  console.log(`[bot/addbalance] ${interaction.user.tag} added $${usd} credit to ${email} (customer ${customer.id})`);

  const embed = new EmbedBuilder()
    .setColor(0x3a8dff)
    .setTitle('✅ Store credit added')
    .setDescription(`**$${usd}** added to **${email}**'s SellAuth wallet.`)
    .addFields(
      { name: 'Customer', value: email, inline: true },
      { name: 'Amount',   value: `$${usd}`, inline: true },
      { name: 'Customer ID', value: String(customer.id), inline: true },
      ...(reason ? [{ name: 'Reason', value: reason, inline: false }] : []),
    )
    .setFooter({ text: `By ${interaction.user.tag}` })
    .setTimestamp(new Date());
  return interaction.editReply({ embeds: [embed] });
}

module.exports = { data, execute };
