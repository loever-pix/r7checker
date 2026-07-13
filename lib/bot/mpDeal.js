// Marketplace deal lifecycle inside Discord.
//
// A "deal" channel (deal-<listingId>) is created when a buyer reserves a
// listing. The listing stays PENDING (hidden from the marketplace, not sold)
// until the deal resolves here:
//
//   FINISH  — both buyer AND seller confirm (button or typing "finish").
//             → listing marked sold (gone for good), a vouch embed is posted to
//               the vouches channel, and the deal channel is deleted.
//   CANCEL  — both buyer AND seller confirm (button or typing "cancel").
//             → listing returns to the marketplace, deal channel deleted.
//   /close  — owner force-closes the channel (listing stays pending unless they
//             also resolved it).
//
// Dual-confirm state is tracked in-memory per channel. If the bot restarts
// mid-deal the confirmations reset (parties just click again) — the listing
// state in SQLite is the source of truth, so nothing is lost.

const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  SlashCommandBuilder, PermissionFlagsBits,
} = require('discord.js');
const store = require('../store');
const { cfg } = require('./config');

const VOUCH_CHANNEL_ID = process.env.MP_VOUCH_CHANNEL_ID || '1511886039550001274';

// channelId → { finish:Set<discordUserId>, cancel:Set<discordUserId> }
const confirms = new Map();
function tracker(channelId) {
  let t = confirms.get(channelId);
  if (!t) { t = { finish: new Set(), cancel: new Set() }; confirms.set(channelId, t); }
  return t;
}
function clearTracker(channelId) { confirms.delete(channelId); }

// Resolve the two Discord user ids that must both confirm, from the listing.
function partiesFor(listing) {
  const seller = listing.seller_user_id ? store.getUserById(listing.seller_user_id) : null;
  const buyer  = listing.buyer_user_id  ? store.getUserById(listing.buyer_user_id)  : null;
  return { sellerId: seller?.discord_id || null, buyerId: buyer?.discord_id || null };
}
function isParty(userId, p) { return userId === p.sellerId || userId === p.buyerId; }
function isStaff(member) {
  if (!member) return false;
  try {
    if (cfg.ownerRoleId && member.roles?.cache?.has(cfg.ownerRoleId)) return true;
    if (member.permissions?.has(PermissionFlagsBits.Administrator)) return true;
    if (member.permissions?.has(PermissionFlagsBits.ManageChannels)) return true;
  } catch {}
  return false;
}

function statusLine(set, p) {
  const tick = (id) => (id && set.has(id)) ? '✅' : '⬜';
  return `${tick(p.buyerId)} Buyer <@${p.buyerId || '0'}>\n${tick(p.sellerId)} Seller <@${p.sellerId || '0'}>`;
}

async function deleteChannelSoon(channel, seconds = 6) {
  try {
    await channel.send(`🔒 Closing this channel in ${seconds} seconds…`);
  } catch {}
  setTimeout(() => { channel.delete().catch(() => {}); }, seconds * 1000);
}

// Post the permanent vouch record for a completed deal.
async function postVouch(client, listing, p) {
  try {
    const ch = await client.channels.fetch(VOUCH_CHANNEL_ID).catch(() => null);
    if (!ch) { console.warn('[mpDeal] vouch channel not found:', VOUCH_CHANNEL_ID); return; }
    const priceText = `$${(listing.price_cents / 100).toFixed(2)}`;
    const embed = new EmbedBuilder()
      .setColor(0x42cb6e)
      .setTitle('✅ Deal Completed')
      .setDescription(`A marketplace deal was completed successfully between both parties.`)
      .addFields(
        { name: 'Buyer',   value: `<@${p.buyerId || '0'}>`,  inline: true },
        { name: 'Seller',  value: `<@${p.sellerId || '0'}>`, inline: true },
        { name: 'Access',  value: String(listing.access_type || '—').toUpperCase(), inline: true },
        { name: 'Price',   value: priceText, inline: true },
        { name: 'Listing', value: `#${listing.id}`, inline: true },
      )
      .setFooter({ text: 'r6checker marketplace · vouch' })
      .setTimestamp(new Date());
    await ch.send({ embeds: [embed] });
  } catch (e) { console.warn('[mpDeal] postVouch failed:', e.message); }
}

// Apply one party's confirmation for `action` ('finish'|'cancel'); complete the
// action once BOTH parties have confirmed. `respond` posts a public status note.
async function applyConfirm(client, channel, listing, action, userId, respond) {
  const p = partiesFor(listing);
  const t = tracker(channel.id);
  // Confirming one action clears any pending confirms for the other.
  const other = action === 'finish' ? 'cancel' : 'finish';
  t[other].clear();
  t[action].add(userId);

  const bothConfirmed = p.buyerId && p.sellerId && t[action].has(p.buyerId) && t[action].has(p.sellerId);

  if (!bothConfirmed) {
    const title = action === 'finish' ? '✅ Finish confirmation' : '✖️ Cancel confirmation';
    const embed = new EmbedBuilder()
      .setColor(action === 'finish' ? 0x42cb6e : 0xff5c6c)
      .setTitle(title)
      .setDescription(`Both parties must confirm to ${action} this deal.\n\n${statusLine(t[action], p)}`)
      .setFooter({ text: 'Waiting for the other party…' });
    await respond({ embeds: [embed] });
    return;
  }

  // Both confirmed — resolve.
  clearTracker(channel.id);
  if (action === 'finish') {
    store.completeListing(listing.id);
    await postVouch(client, listing, p);
    const done = new EmbedBuilder().setColor(0x42cb6e).setTitle('✅ Deal complete')
      .setDescription('Both parties confirmed. The listing has been removed from the marketplace and a vouch was posted.');
    await respond({ embeds: [done] });
  } else {
    store.reopenListing(listing.id);
    const done = new EmbedBuilder().setColor(0xff5c6c).setTitle('✖️ Deal cancelled')
      .setDescription('Both parties confirmed the cancellation. The listing is back on the marketplace.');
    await respond({ embeds: [done] });
  }
  await deleteChannelSoon(channel);
}

// ── Button handler (custom_id: mpdeal:finish:<id> | mpdeal:cancel:<id>) ───────
async function onButton(interaction) {
  const id = interaction.customId || '';
  if (!id.startsWith('mpdeal:')) return false;
  const [, action, listingIdStr] = id.split(':');
  const listing = store.getListing(Number(listingIdStr)) || store.getListingByChannel(interaction.channelId);
  if (!listing) { await interaction.reply({ content: 'This deal is no longer active.', ephemeral: true }); return true; }
  const p = partiesFor(listing);
  if (!isParty(interaction.user.id, p) && !isStaff(interaction.member)) {
    await interaction.reply({ content: 'Only the buyer and seller can confirm this deal.', ephemeral: true });
    return true;
  }
  await interaction.deferUpdate().catch(() => {});
  await applyConfirm(interaction.client, interaction.channel, listing, action === 'cancel' ? 'cancel' : 'finish',
    interaction.user.id, (payload) => interaction.channel.send(payload));
  return true;
}

// ── Typed "finish" / "cancel" in a deal channel ──────────────────────────────
async function onMessage(message) {
  try {
    if (message.author?.bot) return;
    const content = (message.content || '').trim().toLowerCase();
    if (content !== 'finish' && content !== 'cancel') return;
    const listing = store.getListingByChannel(message.channelId);
    if (!listing || listing.status !== 'pending') return;
    const p = partiesFor(listing);
    if (!isParty(message.author.id, p) && !isStaff(message.member)) {
      await message.reply('Only the buyer and seller can confirm this deal.').catch(() => {});
      return;
    }
    await applyConfirm(message.client, message.channel, listing, content,
      message.author.id, (payload) => message.channel.send(payload));
  } catch (e) { console.warn('[mpDeal] onMessage error:', e.message); }
}

// ── /close command (staff force-close a deal channel) ────────────────────────
const closeCommand = {
  data: new SlashCommandBuilder()
    .setName('close')
    .setDescription('Close this marketplace deal channel (staff only).')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels.toString()),
  async execute(interaction) {
    if (!isStaff(interaction.member)) {
      await interaction.reply({ content: 'Only staff can close deal channels.', ephemeral: true });
      return;
    }
    const listing = store.getListingByChannel(interaction.channelId);
    if (!listing && !/^deal-/.test(interaction.channel?.name || '')) {
      await interaction.reply({ content: 'This is not a marketplace deal channel.', ephemeral: true });
      return;
    }
    await interaction.reply({ content: '🔒 Closing this deal channel…' });
    clearTracker(interaction.channelId);
    await deleteChannelSoon(interaction.channel, 4);
  },
};

module.exports = { onButton, onMessage, closeCommand };
