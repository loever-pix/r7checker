// /replace — owner-only. Verify a SellAuth order, then pull one fresh account
// from the SAME product's stock and email it to the order's customer.

const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const sa = require('../sellauth');
const email = require('../../email');
const { isOwner, maskEmail, sameEmail } = require('../util');

const data = new SlashCommandBuilder()
  .setName('replace')
  .setDescription('Email a replacement account for an order (owner only)')
  .addStringOption(o => o
    .setName('order_id')
    .setDescription('SellAuth order / invoice ID')
    .setRequired(true))
  .addStringOption(o => o
    .setName('email')
    .setDescription("Customer's email on the order")
    .setRequired(true));

// Pull product/variant/name out of an invoice item across possible shapes.
function itemTarget(item) {
  if (!item) return null;
  const productId = item.product_id ?? (item.product && item.product.id);
  const variantId = item.variant_id ?? (item.variant && item.variant.id);
  const name = (item.product && item.product.name) || item.name || `product ${productId}`;
  if (!productId || !variantId) return null;
  return { productId, variantId, name };
}

function isPaid(invoice) {
  const s = String(invoice.status || '').toLowerCase();
  return s === 'completed' || s === 'complete' || s === 'paid' || !!invoice.completed_at;
}

async function execute(interaction) {
  if (!isOwner(interaction)) {
    return interaction.reply({ content: '⛔ Only the owner can issue replacements.', flags: MessageFlags.Ephemeral });
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const orderId = interaction.options.getString('order_id').trim();
  const claimedEmail = interaction.options.getString('email').trim();

  // 1. Look up the order.
  let invoice;
  try {
    invoice = await sa.getInvoice(orderId);
  } catch (e) {
    if (e.status === 404) return interaction.editReply(`❌ No order found with ID \`${orderId}\`.`);
    return interaction.editReply(`❌ Could not load that order: ${e.message}`);
  }

  const orderEmail = invoice.email || (invoice.customer && invoice.customer.email);

  // 2. Verify email matches — never touch stock on a mismatch.
  if (!sameEmail(orderEmail, claimedEmail)) {
    return interaction.editReply(
      `❌ Email does not match this order. Provided \`${claimedEmail}\` but the order is under a different address.`);
  }

  // 3. Verify the order is actually paid/completed.
  if (!isPaid(invoice)) {
    return interaction.editReply(`❌ That order is not completed (status: \`${invoice.status || 'unknown'}\`).`);
  }

  // 4. Resolve the purchased product/variant.
  const items = invoice.items || [];
  const target = itemTarget(items[0]);
  if (!target) {
    return interaction.editReply('❌ Could not read the product from that order.');
  }
  if (items.length > 1) {
    console.warn(`[bot] order ${orderId} has ${items.length} items; replacing first only`);
  }

  // 5. Pull one account from that product's stock.
  let serial, remaining;
  try {
    ({ serial, remaining } = await sa.popOneSerial(target.productId, target.variantId));
  } catch (e) {
    return interaction.editReply(`❌ Could not read stock for **${target.name}**: ${e.message}`);
  }
  if (!serial) {
    return interaction.editReply(`❌ **${target.name}** is out of stock — restock it first, then retry.`);
  }

  // 6. Email it to the customer.
  const subject = 'Your replacement account';
  const textBody =
    `Hi,\n\nHere is your replacement account for order ${orderId} (${target.name}):\n\n${serial}\n\nThanks!`;
  const htmlBody =
    `<p>Hi,</p><p>Here is your replacement account for order <b>${orderId}</b> (${target.name}):</p>` +
    `<pre style="white-space:pre-wrap;word-break:break-all">${serial.replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]))}</pre><p>Thanks!</p>`;

  let sent;
  try {
    sent = await email.send({ to: orderEmail, subject, text: textBody, html: htmlBody });
  } catch (e) {
    sent = { ok: false, reason: e.message };
  }

  if (sent && sent.ok) {
    return interaction.editReply(
      `✅ Replacement for **${target.name}** emailed to **${maskEmail(orderEmail)}**.\n` +
      `Remaining stock: **${remaining}**.`);
  }
  // Email failed but the serial is already removed from stock — hand it to the
  // owner so the delivered unit is never lost.
  return interaction.editReply(
    `⚠️ Pulled a replacement for **${target.name}** but the email failed (${sent && sent.reason || 'unknown'}).\n` +
    `Remaining stock: **${remaining}**. Deliver this manually to **${maskEmail(orderEmail)}**:\n\`\`\`\n${serial}\n\`\`\``);
}

module.exports = { data, execute };
