// /recheck — pull a SellAuth product's full stock list and run it through the
// site checker (BYO-proxy bulk job under the configured site owner). Live
// progress is edited into the original reply every few seconds; on completion
// it shows valid/invalid/banned counts and where to download from.

const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const sa = require('../sellauth');
const { cfg } = require('../config');
const { canRecheck } = require('../util');

const POLL_INTERVAL_MS = 5000;
const POLL_MAX_MS      = 60 * 60 * 1000;   // hard cap so we never poll forever

const data = new SlashCommandBuilder()
  .setName('recheck')
  .setDescription("Recheck a SellAuth product's stock through the checker")
  .addStringOption(o => o
    .setName('product')
    .setDescription('Product to recheck (autocompletes by title)')
    .setRequired(true)
    .setAutocomplete(true));

async function autocomplete(interaction) {
  const focused = (interaction.options.getFocused() || '').toLowerCase();
  let products = [];
  try { products = await sa.listProducts(); } catch { /* empty on failure */ }
  const choices = products
    .filter(p => !focused || p.name.toLowerCase().includes(focused))
    .filter(p => Number(p.stock) > 0)
    .slice(0, 25)
    .map(p => ({ name: `${p.name} — stock ${p.stock}`.slice(0, 100), value: String(p.id) }));
  await interaction.respond(choices);
}

function progressBar(done, total, width = 20) {
  const pct = total ? Math.min(1, done / total) : 0;
  const fill = Math.round(pct * width);
  return `\`${'█'.repeat(fill)}${'░'.repeat(width - fill)}\` ${(pct * 100).toFixed(1)}%`;
}

function buildEmbed({ productName, jobId, status, done, total, counts, etaSec, link }) {
  const c = counts || {};
  const e = new EmbedBuilder()
    .setColor(status === 'finished' ? 0x42cb6e : status === 'cancelled' ? 0xd0a04a : 0x3a8dff)
    .setTitle(`🔁 Rechecking ${productName}`)
    .setDescription(`${progressBar(done, total)}\n**${done.toLocaleString()} / ${total.toLocaleString()}**  ·  status: \`${status}\`${etaSec != null && status === 'running' ? `  ·  ETA \`${fmtEta(etaSec)}\`` : ''}`)
    .addFields(
      { name: '✅ Valid',   value: String(c.valid   || 0), inline: true },
      { name: '⭐ VWI',     value: String(c.vwi     || 0), inline: true },
      { name: '🔐 2FA',     value: String(c.twofa   || 0), inline: true },
      { name: '🚫 Banned',  value: String(c.banned  || 0), inline: true },
      { name: '❌ Invalid', value: String(c.invalid || 0), inline: true },
      { name: '⚠️ Error',   value: String((c.retry || 0) + (c.err || 0)), inline: true },
    )
    .setFooter({ text: `Job ${jobId}` })
    .setTimestamp(new Date());
  if (link) e.addFields({ name: 'Download results', value: link, inline: false });
  return e;
}
function fmtEta(s) {
  if (!s || !isFinite(s) || s < 0) return '—';
  if (s >= 3600) return `${Math.floor(s/3600)}h${Math.floor((s%3600)/60)}m`;
  if (s >= 60)   return `${Math.floor(s/60)}m${s%60}s`;
  return `${s}s`;
}

async function execute(interaction) {
  if (!canRecheck(interaction)) {
    return interaction.reply({ content: '⛔ You\'re not authorised to use /recheck.', flags: MessageFlags.Ephemeral });
  }
  if (!cfg.botApiToken) {
    return interaction.reply({ content: '❌ BOT_API_TOKEN not configured on server. Ask the owner to set it.', flags: MessageFlags.Ephemeral });
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const productId = interaction.options.getString('product');

  // Resolve product → variant → deliverables
  let product;
  try { product = await sa.getProduct(productId); }
  catch (e) { return interaction.editReply(`❌ Could not load that product: ${e.message}`); }
  if (!product || !product.variantId) return interaction.editReply('❌ That product has no variant to recheck.');

  let lines;
  try { lines = await sa.getDeliverables(product.id, product.variantId); }
  catch (e) { return interaction.editReply(`❌ Could not fetch stock from SellAuth: ${e.message}`); }
  // SellAuth stock can be either raw `email:password` or a full RESULT line from
  // a previous check ("email:pass | User: … | Lvl: … | Profile: …"). Strip
  // anything after the first " | " so the checker doesn't try to log in with
  // the metadata appended to the password (was the cause of every recheck
  // result coming back INVALID).
  const accountLines = (lines || [])
    .map(s => String(s).split(/\s+\|\s+/)[0].trim())
    .filter(l => l && l.includes(':'));
  if (!accountLines.length) return interaction.editReply(`❌ **${product.name}** has no email:password lines in stock.`);

  // Kick off the job on the server (runs under the configured site owner).
  let started;
  try {
    const resp = await fetch(`${cfg.serverUrl}/api/admin/bot/recheck`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-bot-token': cfg.botApiToken },
      body: JSON.stringify({ accounts: accountLines.join('\n'), label: product.name }),
    });
    const j = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(j.error || `HTTP ${resp.status}`);
    started = j;
  } catch (e) {
    return interaction.editReply(`❌ Could not start the recheck job: ${e.message}`);
  }

  // Initial embed
  await interaction.editReply({ embeds: [buildEmbed({
    productName: product.name, jobId: started.jobId, status: 'running',
    done: 0, total: started.total, counts: {},
  })] });

  // Poll until done (or POLL_MAX_MS).
  const t0 = Date.now();
  let lastDone = 0, lastT = t0;
  while (Date.now() - t0 < POLL_MAX_MS) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    let s;
    try {
      const resp = await fetch(`${cfg.serverUrl}/api/admin/bot/recheck/${encodeURIComponent(started.jobId)}`, {
        headers: { 'x-bot-token': cfg.botApiToken },
      });
      if (!resp.ok) continue;
      s = await resp.json();
    } catch { continue; }
    const now = Date.now();
    const cps = (s.done - lastDone) / Math.max(0.1, (now - lastT) / 1000);
    const eta = cps > 0 ? Math.round((s.total - s.done) / cps) : null;
    lastDone = s.done; lastT = now;
    try {
      await interaction.editReply({ embeds: [buildEmbed({
        productName: product.name, jobId: started.jobId, status: s.status || 'running',
        done: s.done || 0, total: s.total || started.total, counts: s.counts || {}, etaSec: eta,
      })] });
    } catch { /* message edits can transiently fail — keep polling */ }
    if (s.status && s.status !== 'running') break;
  }

  // Final embed with a link to the dashboard for downloads.
  const link = `${cfg.publicUrl}/bulk#job=${encodeURIComponent(started.jobId)}`;
  try {
    const resp = await fetch(`${cfg.serverUrl}/api/admin/bot/recheck/${encodeURIComponent(started.jobId)}`, {
      headers: { 'x-bot-token': cfg.botApiToken },
    });
    const s = resp.ok ? await resp.json() : null;
    if (s) {
      await interaction.editReply({ embeds: [buildEmbed({
        productName: product.name, jobId: started.jobId, status: s.status || 'finished',
        done: s.done || 0, total: s.total || started.total, counts: s.counts || {}, link,
      })] });
    }
  } catch { /* leave the last polled embed in place */ }
}

module.exports = { data, execute, autocomplete };
