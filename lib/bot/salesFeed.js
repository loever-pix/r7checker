// Public sales feed. Polls SellAuth for orders and posts a purchase embed to a
// public channel so everyone sees live sales:
//   • a Pending order  → 🕒 Pending embed
//   • it gets paid      → the SAME message is edited to ✅ Paid
//   • it expires/cancels→ the pending message is deleted (only real orders stay)
//
// The buyer's email is BLURRED (owner@example.com → b*******@icloud.com).
// On first run we SEED the currently-known invoices (no posts) so we never
// backfill the channel with historical orders — only activity from now on shows.

const fs = require('fs');
const path = require('path');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const sa = require('./sellauth');
const { cfg } = require('./config');

const STATE = path.join(__dirname, '..', '..', '.cache', 'sales-feed.json');
const MAX_TRACKED = 800;           // prune old entries so the file stays small
const FETCH_PER_POLL = 25;         // most-recent N invoices each poll

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return { seeded: false, channelId: '', invoices: {} }; }
}
function saveState(s) {
  try { fs.mkdirSync(path.dirname(STATE), { recursive: true }); fs.writeFileSync(STATE, JSON.stringify(s)); }
  catch (e) { console.warn('[sales] state save failed:', e.message); }
}

// owner@example.com → b*******@icloud.com (first char + fixed mask).
function blurEmail(email) {
  const e = String(email || '').trim();
  const at = e.indexOf('@');
  if (at < 1) return '—';
  return e[0] + '*******' + e.slice(at).toLowerCase();
}

// Normalise SellAuth status → 'paid' | 'pending' | 'dead' (expired/cancelled).
function normStatus(inv) {
  const s = String(inv.status || '').toLowerCase();
  if (s === 'completed' || s === 'complete' || s === 'paid' || inv.completed_at && inv.completed_at !== 'null') return 'paid';
  if (s === 'pending' || s === 'processing' || s === 'new' || s === 'created' || s === 'waiting' || s === '') return 'pending';
  return 'dead'; // expired, cancelled, refunded, chargeback, …
}

function moneyOf(inv) {
  const amt = Number(inv.price || inv.total || inv.paid_usd || 0);
  const cur = (inv.currency || 'USD').toUpperCase();
  return `${cur === 'USD' ? '$' : ''}${amt.toFixed(2)} ${cur}`;
}

function itemsOf(inv) {
  const items = Array.isArray(inv.items) ? inv.items : [];
  const names = items.map(it => {
    const p = (it.product && it.product.name) || inv.product || 'Account';
    const v = it.variant && it.variant.name;
    return v && !/^default$/i.test(v) ? `${p} — ${v}` : p;
  }).filter(Boolean);
  if (!names.length && inv.product && inv.product !== 'null') names.push(String(inv.product));
  return names.length ? names : ['Account'];
}

function invoiceUrl(inv) {
  const id = inv.unique_id || inv.id;
  if (!id || !cfg.salesInvoiceBase) return null;
  return cfg.salesInvoiceBase.replace('{id}', encodeURIComponent(id));
}

function buildMessage(inv, status) {
  const names = itemsOf(inv);
  const paid = status === 'paid';
  const embed = new EmbedBuilder()
    .setColor(paid ? 0x42cb6e : 0xf0c75a)
    .setTitle(paid ? '🛒 New Purchase' : '🧾 Pending Order')
    .addFields(
      { name: '📦 Product', value: names.join('\n').slice(0, 1024), inline: false },
      { name: '💵 Cost', value: moneyOf(inv), inline: true },
      { name: '💳 Payment', value: ((inv.payment_method && inv.payment_method.name) || inv.gateway || '—').toString().slice(0, 60), inline: true },
      { name: '📊 Status', value: paid ? '✅ Paid' : '🕒 Pending', inline: true },
      { name: '📧 Buyer', value: blurEmail(inv.email), inline: false },
    )
    .setFooter({ text: `Invoice #${inv.id} · R6Checker Store` })
    .setTimestamp(new Date());

  const url = invoiceUrl(inv);
  const components = url
    ? [new ActionRowBuilder().addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('🧾 View Invoice').setURL(url))]
    : [];
  return { embeds: [embed], components };
}

let _client = null;
let _timer = null;
let _running = false;

async function resolveChannel() {
  const state = loadState();
  const id = cfg.salesChannelId || state.channelId;
  if (!id) return null;
  try { return await _client.channels.fetch(id); } catch { return null; }
}

async function poll() {
  if (_running) return; _running = true;
  try {
    const channel = await resolveChannel();
    if (!channel) return;                       // not configured yet — idle
    const state = loadState();

    let invoices = [];
    try { invoices = await sa.listInvoices(FETCH_PER_POLL); } catch (e) { console.warn('[sales] listInvoices failed:', e.message); return; }

    // First run: seed everything we can see as already-handled, post nothing.
    if (!state.seeded) {
      for (const inv of invoices) state.invoices[inv.id] = { status: normStatus(inv), messageId: null };
      state.seeded = true;
      saveState(state);
      console.log(`[sales] seeded ${invoices.length} existing invoice(s) — feed live from now`);
      return;
    }

    // Oldest-first so a create→pay within one poll posts then edits in order.
    for (const inv of invoices.slice().reverse()) {
      const id = String(inv.id);
      const status = normStatus(inv);
      const prev = state.invoices[id];

      if (!prev) {
        // Brand-new invoice we've never seen.
        if (status === 'dead') { state.invoices[id] = { status, messageId: null }; continue; }
        try {
          const msg = await channel.send(buildMessage(inv, status));
          state.invoices[id] = { status, messageId: msg.id };
        } catch (e) { console.warn(`[sales] post failed for ${id}:`, e.message); state.invoices[id] = { status, messageId: null }; }
        continue;
      }

      if (prev.status === status) continue;     // unchanged

      // Transition.
      if (status === 'paid') {
        if (prev.messageId) {
          try { const m = await channel.messages.fetch(prev.messageId); await m.edit(buildMessage(inv, 'paid')); }
          catch { try { const msg = await channel.send(buildMessage(inv, 'paid')); prev.messageId = msg.id; } catch {} }
        } else {
          try { const msg = await channel.send(buildMessage(inv, 'paid')); prev.messageId = msg.id; } catch {}
        }
        prev.status = 'paid';
      } else if (status === 'dead') {
        // Expired/cancelled → remove the pending post so only real orders remain.
        if (prev.messageId) { try { const m = await channel.messages.fetch(prev.messageId); await m.delete(); } catch {} prev.messageId = null; }
        prev.status = 'dead';
      } else {
        prev.status = status;
      }
    }

    // Prune to keep the state file small (drop oldest ids beyond the cap).
    const ids = Object.keys(state.invoices);
    if (ids.length > MAX_TRACKED) {
      for (const id of ids.sort((a, b) => Number(a) - Number(b)).slice(0, ids.length - MAX_TRACKED)) delete state.invoices[id];
    }
    saveState(state);
  } finally { _running = false; }
}

function start(client) {
  _client = client;
  if (_timer) return;
  // Kick shortly after boot, then on the configured cadence.
  setTimeout(() => poll().catch(e => console.warn('[sales] poll error:', e.message)), 8000);
  _timer = setInterval(() => poll().catch(e => console.warn('[sales] poll error:', e.message)), cfg.salesPollMs);
  if (_timer.unref) _timer.unref();
  console.log(`[sales] feed poller started (every ${Math.round(cfg.salesPollMs / 1000)}s)`);
}

// Used by /setupsales to persist the channel id without an env var + restart.
function setChannelId(id) { const s = loadState(); s.channelId = String(id); saveState(s); }
function getChannelId() { return cfg.salesChannelId || loadState().channelId || ''; }

module.exports = { start, setChannelId, getChannelId, blurEmail, buildMessage, _poll: poll };
