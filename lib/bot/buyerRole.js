// Buyer-role claim. A member proves a purchase by giving a SellAuth invoice ID;
// the bot verifies it's a REAL, PAID invoice (and not already claimed) and grants
// the buyer role.
//
// Two ways to claim, both supported:
//   • Click the "Claim Buyer Role" button on the embed → modal (no special intent)
//   • DM the bot the invoice ID (needs the Message Content privileged intent)

const fs = require('fs');
const path = require('path');
const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle, MessageFlags,
} = require('discord.js');
const sa = require('./sellauth');
const { cfg } = require('./config');

const MSG_STATE = path.join(__dirname, '..', '..', '.cache', 'buyerrole-msg.json');
const CLAIMS    = path.join(__dirname, '..', '..', '.cache', 'claimed-invoices.json');

function loadJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return {}; } }
function saveJson(p, o) { try { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(o)); } catch (e) { console.warn('[bot] buyerRole save failed:', e.message); } }

function isPaid(invoice) {
  const s = String(invoice.status || '').toLowerCase();
  return s === 'completed' || s === 'complete' || s === 'paid' || !!invoice.completed_at;
}

// Core: verify invoice + grant role. Returns { ok, message }.
async function claim(invoiceId, member) {
  invoiceId = String(invoiceId || '').trim();
  if (!invoiceId) return { ok: false, message: 'Please provide your order/invoice ID.' };
  if (member.roles.cache?.has(cfg.buyerRoleId)) return { ok: true, message: '✅ You already have the buyer role.' };

  // One invoice can only ever grant one person the role.
  const claims = loadJson(CLAIMS);
  if (claims[invoiceId] && claims[invoiceId] !== member.id) {
    return { ok: false, message: '❌ That invoice has already been claimed by another account.' };
  }

  let invoice;
  try { invoice = await sa.getInvoice(invoiceId); }
  catch (e) {
    if (e.status === 404) return { ok: false, message: `❌ No order found with ID \`${invoiceId}\`.` };
    return { ok: false, message: `❌ Could not verify that order: ${e.message}` };
  }
  if (!isPaid(invoice)) return { ok: false, message: `❌ That order isn't paid/completed (status: \`${invoice.status || 'unknown'}\`).` };

  try { await member.roles.add(cfg.buyerRoleId); }
  catch (e) { return { ok: false, message: `❌ Verified, but I couldn't assign the role: ${e.message}` }; }

  claims[invoiceId] = member.id;
  saveJson(CLAIMS, claims);
  return { ok: true, message: '✅ Verified! You now have the **buyer** role. Thanks for your purchase.' };
}

// ── Embed with claim button ────────────────────────────────────────────────
function buildEmbed() {
  return new EmbedBuilder()
    .setTitle('🛒 Get your Buyer role')
    .setColor(0x9b59b6)
    .setDescription(
      'Bought an account? Verify your order to unlock the **buyer** role.\n\n' +
      '**Option A:** Click **Claim Buyer Role** below and paste your order/invoice ID.\n' +
      '**Option B:** DM me your order/invoice ID.\n\n' +
      'Your invoice must be a real, paid SellAuth order. Each invoice works once.');
}
function buildRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('buyer_claim').setLabel('Claim Buyer Role').setStyle(ButtonStyle.Success).setEmoji('🛒'));
}

let client = null;
async function ensureEmbed(discordClient) {
  client = discordClient;
  const channel = await client.channels.fetch(cfg.buyerClaimChannelId);
  const state = loadJson(MSG_STATE);
  if (state.messageId) {
    try { await channel.messages.fetch(state.messageId); return; } catch { /* gone — repost */ }
  }
  const msg = await channel.send({ embeds: [buildEmbed()], components: [buildRow()] });
  saveJson(MSG_STATE, { messageId: msg.id });
  console.log(`[bot] posted buyer-role embed ${msg.id} in ${cfg.buyerClaimChannelId}`);
}

// ── Interaction handlers (button + modal) ──────────────────────────────────
async function onButton(interaction) {
  if (interaction.customId !== 'buyer_claim') return false;
  const modal = new ModalBuilder().setCustomId('buyer_claim_modal').setTitle('Claim Buyer Role');
  modal.addComponents(new ActionRowBuilder().addComponents(
    new TextInputBuilder().setCustomId('invoice_id').setLabel('Your order / invoice ID')
      .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100)));
  await interaction.showModal(modal);
  return true;
}
async function onModal(interaction) {
  if (interaction.customId !== 'buyer_claim_modal') return false;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const invoiceId = interaction.fields.getTextInputValue('invoice_id');
  const member = interaction.member ?? await interaction.guild.members.fetch(interaction.user.id);
  const r = await claim(invoiceId, member);
  await interaction.editReply(r.message);
  return true;
}

// ── DM handler ─────────────────────────────────────────────────────────────
// Needs the Message Content intent. The whole DM is treated as the invoice ID.
async function onDirectMessage(message) {
  if (message.author.bot || message.guildId) return false;        // DMs only
  const invoiceId = (message.content || '').trim();
  if (!invoiceId) { await message.reply('Send me your order/invoice ID to get the buyer role.').catch(() => {}); return true; }
  const guild = client.guilds.cache.get(cfg.guildId) || await client.guilds.fetch(cfg.guildId);
  let member;
  try { member = await guild.members.fetch(message.author.id); }
  catch { await message.reply('You need to be a member of the server first.').catch(() => {}); return true; }
  const r = await claim(invoiceId, member);
  await message.reply(r.message).catch(() => {});
  return true;
}

module.exports = { ensureEmbed, onButton, onModal, onDirectMessage, claim };
