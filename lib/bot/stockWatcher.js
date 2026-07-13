// Polls SellAuth and posts an alert whenever a product's stock or price changes
// — no matter the source (the bot's own /restock & /price, OR the owner editing
// the SellAuth website directly). It's the SINGLE source of stock/price alerts,
// so restock.js/price.js don't post their own (avoids duplicates).
//
// A snapshot of {stock, price} per product is persisted so changes are detected
// across restarts. On first ever run the snapshot is seeded WITHOUT alerting.

const fs = require('fs');
const path = require('path');
const { EmbedBuilder } = require('discord.js');
const sa = require('./sellauth');
const { cfg } = require('./config');

const STATE_PATH = path.join(__dirname, '..', '..', '.cache', 'stock-snapshot.json');
const POLL_MS = Math.max(15000, Number(process.env.STOCK_POLL_MS) || 30000);

function load() { try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); } catch { return null; } }
function save(snap) { try { fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true }); fs.writeFileSync(STATE_PATH, JSON.stringify(snap)); } catch (e) { console.warn('[bot] stock snapshot save failed:', e.message); } }

let client = null;
async function channel() {
  try { return await client.channels.fetch(cfg.restockAlertChannelId); } catch (e) { console.warn('[bot] alert channel fetch failed:', e.message); return null; }
}

async function postStock(p, delta, newStock) {
  const ch = await channel(); if (!ch) return;
  const added = delta > 0;
  const embed = new EmbedBuilder()
    .setTitle(`${added ? '🔄 Restock' : '📉 Stock down'}: ${p.name}`)
    .setColor(added ? 0x2ecc71 : 0xe74c3c)
    .addFields(
      { name: added ? 'Added' : 'Removed', value: `${added ? '+' : '−'}${Math.abs(delta)}`, inline: true },
      { name: 'Price', value: `${p.currency || 'USD'} ${Number(p.price).toFixed(2)}`, inline: true },
      { name: 'Inventory', value: `${newStock} in stock`, inline: true },
    )
    .setTimestamp();
  if (p.image) embed.setImage(p.image);
  // Ping only on genuine restocks (stock increase).
  await ch.send({
    content: added ? `<@&${cfg.restockPingRoleId}>` : '',
    embeds: [embed],
    allowedMentions: added ? { roles: [cfg.restockPingRoleId] } : { parse: [] },
  }).catch(e => console.warn('[bot] stock alert send failed:', e.message));
}

async function postPrice(p, oldPrice, newPrice) {
  const ch = await channel(); if (!ch) return;
  const dropped = newPrice < oldPrice;
  const cur = p.currency || 'USD';
  const pct = oldPrice > 0 ? Math.round((1 - newPrice / oldPrice) * 100) : 0;
  const embed = new EmbedBuilder()
    .setTitle(`${dropped ? '💸 Price drop' : '🏷️ Price change'}: ${p.name}`)
    .setColor(dropped ? 0xe67e22 : 0x95a5a6)
    .setDescription(`~~${cur} ${oldPrice.toFixed(2)}~~ → **${cur} ${newPrice.toFixed(2)}**${dropped && pct > 0 ? `  (−${pct}%)` : ''}`)
    .addFields({ name: 'Inventory', value: `${p.stock} in stock`, inline: true })
    .setTimestamp();
  if (p.image) embed.setImage(p.image);
  await ch.send({
    content: dropped ? `<@&${cfg.restockPingRoleId}>` : '',
    embeds: [embed],
    allowedMentions: dropped ? { roles: [cfg.restockPingRoleId] } : { parse: [] },
  }).catch(e => console.warn('[bot] price alert send failed:', e.message));
}

async function tick() {
  let products;
  try { products = await sa.listProducts(); } catch (e) { console.warn('[bot] stock poll failed:', e.message); return; }
  const prev = load();
  const snap = {};
  for (const p of products) {
    const price = parseFloat(p.price);
    snap[p.id] = { stock: p.stock, price, name: p.name };
    if (!prev) continue;                 // first ever run — seed silently, no alerts
    const before = prev[p.id];
    // A brand-new product (added after the baseline existed) gets a baseline of
    // 0, so adding it with stock posts a restock alert (+stock).
    const beforeStock = before && typeof before.stock === 'number' ? before.stock : 0;
    if (typeof p.stock === 'number' && p.stock !== beforeStock) {
      await postStock(p, p.stock - beforeStock, p.stock);
    }
    // Price-change alerts only for products we already had a price for.
    if (before && typeof before.price === 'number' && Number.isFinite(price) && price !== before.price) {
      await postPrice(p, before.price, price);
    }
  }
  save(snap);
}

function start(discordClient) {
  client = discordClient;
  // Seed immediately (no alerts if first run), then poll.
  tick().catch(() => {});
  setInterval(() => { tick().catch(() => {}); }, POLL_MS).unref();
  console.log(`[bot] stock/price watcher started (every ${POLL_MS / 1000}s → channel ${cfg.restockAlertChannelId})`);
}

// ── Manual batched restock notifications ─────────────────────────────────────
// When the owner stocks via the bot we DON'T want the auto-watcher to fire a
// per-product alert — they want to stock everything, then press one button to
// announce it all. markRestocked() records the change into a batch AND advances
// the snapshot so tick() sees no delta (no auto-alert). announceBatch() posts a
// single combined embed and clears the batch.
const _batch = new Map();   // productId → { name, image, price, currency, added, newStock }
function markRestocked({ id, name, image, price, currency }, added, newStock) {
  // Advance the snapshot so the poller treats this as already-seen.
  try {
    const snap = load() || {};
    snap[id] = { stock: newStock, price: parseFloat(price) || 0, name };
    save(snap);
  } catch {}
  const prev = _batch.get(id);
  _batch.set(id, {
    name, image, price, currency: currency || 'USD',
    added: (prev ? prev.added : 0) + (added || 0),
    newStock,
  });
}
function batchSize() { return _batch.size; }
function batchTotal() { let n = 0; for (const v of _batch.values()) n += v.added; return n; }

async function announceBatch() {
  if (!_batch.size) return { posted: false, reason: 'nothing batched' };
  const ch = await channel(); if (!ch) return { posted: false, reason: 'no channel' };
  const items = [..._batch.values()].filter(v => v.added > 0);
  const totalAdded = items.reduce((a, v) => a + v.added, 0);
  const embed = new EmbedBuilder()
    .setTitle('🔄 Restock')
    .setColor(0x2ecc71)
    .setDescription(items.map(v =>
      `**${v.name}** — +${v.added} → ${v.newStock} in stock · ${v.currency} ${Number(v.price).toFixed(2)}`
    ).join('\n') || 'Restocked.')
    .setFooter({ text: `${totalAdded} account${totalAdded === 1 ? '' : 's'} added across ${items.length} product${items.length === 1 ? '' : 's'}` })
    .setTimestamp();
  // Use the first product image as the banner if available.
  const withImg = items.find(v => v.image);
  if (withImg) embed.setThumbnail(withImg.image);
  await ch.send({
    content: `<@&${cfg.restockPingRoleId}>`,
    embeds: [embed],
    allowedMentions: { roles: [cfg.restockPingRoleId] },
  }).catch(e => console.warn('[bot] batch restock send failed:', e.message));
  _batch.clear();
  return { posted: true, products: items.length, total: totalAdded };
}

module.exports = { start, markRestocked, announceBatch, batchSize, batchTotal };
