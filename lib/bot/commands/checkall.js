// /checkall — owner-only. Audit EVERY SellAuth product's stock and re-sort any
// mis-placed account: banned → the matching [platform] Banned product (≤$1), and
// any non-banned account in the wrong tier/item product → its correct product.
//
//   recheck (default true)  — re-run the checker on all stock for CURRENT status
//                              before deciding placement (uses proxy bandwidth).
//                              recheck:false re-sorts from the tags already in stock.
//   dryrun  (default true)  — preview the moves; a button confirms the live move.

const { SlashCommandBuilder, EmbedBuilder, MessageFlags, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const sa = require('../sellauth');
const resort = require('../vwiResort');
const storeSync = require('../storeSync');
const sk = require('../../checker/skinCheck');
const { cfg } = require('../config');
const { isOwner } = require('../util');

const POLL_MS = 5000, POLL_MAX_MS = 60 * 60 * 1000;
const pending = new Map();   // dryrun message id → { moves, products, ts }
setInterval(() => { const now = Date.now(); for (const [k, v] of pending) if (now - v.ts > 20 * 60 * 1000) pending.delete(k); }, 60000).unref();

const data = new SlashCommandBuilder()
  .setName('checkall')
  .setDescription('Audit all stock and re-sort mis-placed / banned accounts')
  .addBooleanOption(o => o.setName('recheck').setDescription('Re-run the checker on all stock for current status (default: true)'))
  .addBooleanOption(o => o.setName('dryrun').setDescription('Preview moves without writing (default: true)'));

function bannedPlatform(name) {
  if (/\[xbx\/psn\]/i.test(name)) return 'double';
  if (/\[xbx\]/i.test(name)) return 'xbx';
  return 'psn';
}

// Gather all stock, optionally re-check it live, and compute the re-sort moves.
async function gatherAndPlan(doRecheck) {
  const meta = sk.vwiMeta();
  const { products, locations, lines, counts } = await resort.gatherStock(sa);
  let freshLines = lines;
  if (doRecheck && lines.length) {
    const accounts = [...new Set(lines.map(l => String(l).split(/\s+\|\s+/)[0].trim()).filter(l => l.includes(':')))];
    const r = await fetch(`${cfg.serverUrl}/api/admin/bot/recheck`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-bot-token': cfg.botApiToken }, body: JSON.stringify({ accounts: accounts.join('\n'), label: 'checkall' }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `recheck start HTTP ${r.status}`);
    const t0 = Date.now();
    while (Date.now() - t0 < POLL_MAX_MS) {
      await new Promise(res => setTimeout(res, POLL_MS));
      const sr = await fetch(`${cfg.serverUrl}/api/admin/bot/recheck/${encodeURIComponent(j.jobId)}`, { headers: { 'x-bot-token': cfg.botApiToken } });
      if (!sr.ok) continue;
      const s = await sr.json().catch(() => ({}));
      if (s.status && s.status !== 'running') break;
    }
    const rr = await fetch(`${cfg.serverUrl}/api/admin/bot/recheck/${encodeURIComponent(j.jobId)}/results?type=all`, { headers: { 'x-bot-token': cfg.botApiToken } });
    if (!rr.ok) throw new Error('could not download recheck results');
    freshLines = (await rr.text()).split(/\r?\n/).filter(Boolean);
  }
  const moves = resort.computeResort(freshLines, locations, meta, resort.DEFAULT_BANNED_PRICE);
  return { products, moves, counts };
}

function summarize(moves) {
  const by = {};
  for (const m of moves) {
    // kind:'remove' has no toProductName — group under a single label so the
    // preview embed reads clearly (e.g. "🗑 Remove — no PhoneVerified ← 42").
    const key = m.kind === 'remove' ? '🗑 Remove — no PhoneVerified' : m.toProductName;
    (by[key] = by[key] || { count: 0 }).count++;
  }
  return Object.entries(by).sort((a, b) => b[1].count - a[1].count);
}

// Set every Banned product's price to its ≤$1 platform price.
async function repriceBanned(products) {
  for (const p of products) {
    if (!/banned/i.test(p.name)) continue;
    const price = resort.DEFAULT_BANNED_PRICE[bannedPlatform(p.name)] || 1;
    try { await sa.updatePrice(p.id, price); } catch { /* best-effort */ }
  }
}

function resultEmbed(title, color, results, moveCount) {
  return new EmbedBuilder().setColor(color).setTitle(title)
    .setDescription(results.map(r => `**${r.target}** ${r.error ? `⚠️ ${r.error}` : `+${r.added}/-${r.removed}${r.errors ? ` · ${r.errors} err` : ''}`}`).join('\n').slice(0, 3800) || '_nothing_')
    .setFooter({ text: `${moveCount} move(s) executed · banned repriced ≤ $1` });
}

// Owner Discord user id to DM the results to (overridable via env).
const OWNER_DM_ID = process.env.OWNER_DISCORD_ID || '000000000000000000';

// DM-safe owner check: role check inside a guild, user-id check in a DM (a button
// clicked from the DM message has no guild member, so isOwner() can't apply).
function isOwnerCtx(interaction) {
  if (isOwner(interaction)) return true;
  return !!(interaction.user && interaction.user.id === OWNER_DM_ID);
}

async function fetchOwner(interaction) {
  try { return await interaction.client.users.fetch(OWNER_DM_ID); }
  catch { return interaction.user || null; }
}

// Deliver a payload to the owner's DMs (not hidden in-channel). Falls back to the
// ephemeral interaction reply if the DM can't be sent. Returns the delivered
// Message so a button's plan can be keyed to it.
async function deliver(owner, interaction, payload) {
  if (owner) {
    try {
      const m = await owner.send(payload);
      await interaction.editReply('📬 Sent to your DMs.').catch(() => {});
      return m;
    } catch { /* DMs closed → fall back to an ephemeral reply */ }
  }
  return interaction.editReply({ content: '', ...payload });
}

async function execute(interaction) {
  if (!isOwner(interaction)) return interaction.reply({ content: '⛔ Owner only.', flags: MessageFlags.Ephemeral });
  if (!cfg.botApiToken) return interaction.reply({ content: '❌ BOT_API_TOKEN not configured on the server.', flags: MessageFlags.Ephemeral });
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const doRecheck = interaction.options.getBoolean('recheck'); const recheck = doRecheck === null ? true : doRecheck;
  const dryOpt = interaction.options.getBoolean('dryrun'); const dryrun = dryOpt === null ? true : dryOpt;

  await interaction.editReply(`🔎 Scanning all stock${recheck ? ' + re-checking live (this can take a while)…' : ' (tag audit)…'} I’ll DM you the result.`);
  let plan;
  try { plan = await gatherAndPlan(recheck); }
  catch (e) { return interaction.editReply(`❌ Check-all failed: ${e.message}`); }

  const { moves, products, counts } = plan;
  const rows = summarize(moves);
  const preview = new EmbedBuilder()
    .setColor(dryrun ? 0xf0c75a : 0x42cb6e)
    .setTitle(dryrun ? '🔎 Check-all — preview (nothing moved yet)' : '✅ Check-all')
    .setDescription(rows.length ? rows.map(([name, info]) => `**${name}** ← ${info.count}`).join('\n').slice(0, 3800) : '_Everything is already in the right spot._')
    .setFooter({ text: `${moves.length} move(s) · scanned ${counts.accounts} account(s) across ${counts.variants} variant(s) / ${counts.products} product(s) · ${recheck ? 're-checked live' : 'tag audit'}` });

  const owner = await fetchOwner(interaction);

  if (!moves.length) { await deliver(owner, interaction, { embeds: [preview] }); return; }

  if (dryrun) {
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('checkall:go').setLabel(`✅ Move ${moves.length} account(s)`).setStyle(ButtonStyle.Success));
    const msg = await deliver(owner, interaction, { embeds: [preview], components: [row] });
    if (msg) pending.set(msg.id, { moves, products, ts: Date.now() });
    return;
  }
  const results = await resort.executeResort(moves, { sellauth: sa, storeSync }, { products });
  await repriceBanned(products);
  await deliver(owner, interaction, { embeds: [resultEmbed('✅ Check-all — re-sorted', 0x42cb6e, results, moves.length)] });
}

async function onButton(interaction) {
  if (interaction.customId !== 'checkall:go') return false;
  if (!isOwnerCtx(interaction)) { await interaction.reply({ content: '⛔ Owner only.', flags: MessageFlags.Ephemeral }); return true; }
  const plan = pending.get(interaction.message.id);
  if (!plan) { await interaction.reply({ content: '⚠️ This preview expired — run `/checkall` again.', flags: MessageFlags.Ephemeral }); return true; }
  pending.delete(interaction.message.id);
  await interaction.deferUpdate().catch(() => {});
  const results = await resort.executeResort(plan.moves, { sellauth: sa, storeSync }, { products: plan.products });
  await repriceBanned(plan.products);
  await interaction.editReply({ content: '', embeds: [resultEmbed('✅ Check-all — re-sorted', 0x42cb6e, results, plan.moves.length)], components: [] }).catch(() => {});
  return true;
}

module.exports = { data, execute, onButton };
