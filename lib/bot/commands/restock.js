// /restock — owner-only. Append account lines from a .txt attachment to a
// SellAuth product's stock, then announce the restock with a role ping.

const {
  SlashCommandBuilder, EmbedBuilder, MessageFlags,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
} = require('discord.js');
const sa = require('../sellauth');
const stockWatcher = require('../stockWatcher');
const { cfg } = require('../config');
const { isOwner } = require('../util');

const data = new SlashCommandBuilder()
  .setName('restock')
  .setDescription('Add accounts to a SellAuth product and announce the restock')
  .addStringOption(o => o
    .setName('product')
    .setDescription('Which product to restock')
    .setRequired(true)
    .setAutocomplete(true))
  .addAttachmentOption(o => o
    .setName('accounts')
    .setDescription('.txt file, one account per line')
    .setRequired(true));

async function autocomplete(interaction) {
  const focused = (interaction.options.getFocused() || '').toLowerCase();
  let products = [];
  try { products = await sa.listProducts(); } catch { /* empty list on failure */ }
  const choices = products
    .filter(p => !focused || p.name.toLowerCase().includes(focused))
    .slice(0, 25)
    .map(p => ({ name: `${p.name} — stock ${p.stock}`.slice(0, 100), value: String(p.id) }));
  await interaction.respond(choices);
}

async function execute(interaction) {
  if (!isOwner(interaction)) {
    return interaction.reply({ content: '⛔ Only the owner can restock.', flags: MessageFlags.Ephemeral });
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const productId = interaction.options.getString('product');
  const file = interaction.options.getAttachment('accounts');

  const looksTxt = /\.txt$/i.test(file.name || '') ||
    (file.contentType || '').startsWith('text/');
  if (!looksTxt) {
    return interaction.editReply('❌ Attach a `.txt` file (one account per line).');
  }

  // Resolve the product so we have the variant, name and image.
  let product;
  try {
    product = await sa.getProduct(productId);
  } catch (e) {
    return interaction.editReply(`❌ Could not load that product: ${e.message}`);
  }
  if (!product || !product.variantId) {
    return interaction.editReply('❌ That product has no variant to stock.');
  }

  // Download + parse the attachment.
  let text;
  try {
    const res = await fetch(file.url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    text = await res.text();
  } catch (e) {
    return interaction.editReply(`❌ Could not download the attachment: ${e.message}`);
  }
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (!lines.length) {
    return interaction.editReply('❌ That file has no non-empty lines.');
  }

  // Add each account as its OWN buyable variant (one variant per account), so a
  // product can hold unlimited variants. Existing variants/stock are untouched.
  // Mystery/Wanted products stay pooled (the helper appends + refreshes there).
  const storeSync = require('../storeSync');
  let r;
  try {
    r = await storeSync.addAccountVariants(product.id, lines);
  } catch (e) {
    return interaction.editReply(`❌ SellAuth rejected the restock: ${e.message}`);
  }
  if (r.error) {
    return interaction.editReply(`❌ Could not restock: ${r.error}`);
  }
  const newStock = r.pooled
    ? (r.newStock != null ? r.newStock : product.stock + r.added)
    : product.stock + (r.written != null ? r.written : r.added);
  const descNote = r.pooled
    ? ' · pooled stock + description refreshed'
    : ` · ${r.written != null ? r.written : r.added} account variant(s) added`;

  // Batch this restock (suppresses the per-product auto-alert) and offer a single
  // "Announce" button so the owner can stock everything, then notify once.
  stockWatcher.markRestocked(product, lines.length, newStock);
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('restock:announce')
      .setLabel(`📢 Announce restock (${stockWatcher.batchTotal()} acct · ${stockWatcher.batchSize()} product${stockWatcher.batchSize() === 1 ? '' : 's'})`)
      .setStyle(ButtonStyle.Success),
  );
  return interaction.editReply({
    content: `✅ Added **${lines.length}** to **${product.name}** — now **${newStock}** in stock${descNote}.\nStock more if you want, then press the button to send **one** notification for everything.`,
    components: [row],
  });
}

// Button: post one combined restock notification for everything batched.
async function onButton(interaction) {
  if (interaction.customId !== 'restock:announce') return false;
  if (!isOwner(interaction)) { await interaction.reply({ content: '⛔ Owner only.', flags: MessageFlags.Ephemeral }); return true; }
  await interaction.deferUpdate().catch(() => {});
  const r = await stockWatcher.announceBatch();
  const msg = r.posted
    ? `📢 Sent restock notification — **${r.total}** account${r.total === 1 ? '' : 's'} across **${r.products}** product${r.products === 1 ? '' : 's'}.`
    : `⚠️ Nothing to announce (${r.reason}).`;
  await interaction.editReply({ content: msg, components: [] }).catch(() => {});
  return true;
}

module.exports = { data, execute, autocomplete, onButton };
