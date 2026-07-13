// /price — owner-only. Set a product's price. If the new price is lower than
// the old one, announce the drop in the alert channel with a role ping;
// otherwise just confirm to the owner.

const {
  SlashCommandBuilder, EmbedBuilder, MessageFlags,
} = require('discord.js');
const sa = require('../sellauth');
const { cfg } = require('../config');
const { isOwner } = require('../util');

const data = new SlashCommandBuilder()
  .setName('price')
  .setDescription('Set a product\'s price (announces a ping if it drops)')
  .addStringOption(o => o
    .setName('product')
    .setDescription('Which product to reprice')
    .setRequired(true)
    .setAutocomplete(true))
  .addNumberOption(o => o
    .setName('price')
    .setDescription('New price (e.g. 4.50)')
    .setRequired(true)
    .setMinValue(0));

async function autocomplete(interaction) {
  const focused = (interaction.options.getFocused() || '').toLowerCase();
  let products = [];
  try { products = await sa.listProducts(); } catch { /* empty on failure */ }
  const choices = products
    .filter(p => !focused || p.name.toLowerCase().includes(focused))
    .slice(0, 25)
    .map(p => ({
      name: `${p.name} — ${p.currency || 'USD'} ${Number(p.price).toFixed(2)}`.slice(0, 100),
      value: String(p.id),
    }));
  await interaction.respond(choices);
}

function money(amount, currency) {
  return `${currency || 'USD'} ${Number(amount).toFixed(2)}`;
}

async function execute(interaction) {
  if (!isOwner(interaction)) {
    return interaction.reply({ content: '⛔ Only the owner can change prices.', flags: MessageFlags.Ephemeral });
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const productId = interaction.options.getString('product');
  const newPrice = interaction.options.getNumber('price');

  let result;
  try {
    result = await sa.updatePrice(productId, newPrice);
  } catch (e) {
    return interaction.editReply(`❌ Could not update the price: ${e.message}`);
  }

  const { oldPrice, name, image, currency, variantCount, stock } = result;
  const dropped = result.newPrice < oldPrice;

  // The stock watcher posts the public price-change alert (single alerter, also
  // catches manual SellAuth edits). Just confirm to the owner here.
  const multiNote = variantCount > 1
    ? `\n⚠️ This product has ${variantCount} variants; I changed the first one only.`
    : '';
  const dropNote = dropped ? ' A price-drop alert will post shortly.' : '';

  return interaction.editReply(
    `✅ **${name}** price set: ${money(oldPrice, currency)} → **${money(result.newPrice, currency)}** · **${stock}** in stock.${dropNote}${multiNote}`);
}

module.exports = { data, execute, autocomplete };
