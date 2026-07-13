// /syncstore — owner-only. Classify accounts from a .txt by tier + platform,
// route each into the matching SellAuth product's stock, and auto-generate each
// variant's description from the account format. `dryrun:true` previews the
// routing + descriptions without writing anything.

const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const storeSync = require('../storeSync');
const { isOwner } = require('../util');

const data = new SlashCommandBuilder()
  .setName('syncstore')
  .setDescription('Route accounts into SellAuth products by tier + auto-build descriptions')
  .addAttachmentOption(o => o
    .setName('accounts')
    .setDescription('.txt file, one result line per account')
    .setRequired(true))
  .addBooleanOption(o => o
    .setName('dryrun')
    .setDescription('Preview routing + descriptions without writing to the store'));

async function execute(interaction) {
  if (!isOwner(interaction)) {
    return interaction.reply({ content: '⛔ Only the owner can sync the store.', flags: MessageFlags.Ephemeral });
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const file = interaction.options.getAttachment('accounts');
  const dryRun = interaction.options.getBoolean('dryrun') || false;
  const looksTxt = /\.txt$/i.test(file.name || '') || (file.contentType || '').startsWith('text/');
  if (!looksTxt) return interaction.editReply('❌ Attach a `.txt` file (one account line per row).');

  let text;
  try {
    const res = await fetch(file.url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    text = await res.text();
  } catch (e) { return interaction.editReply(`❌ Could not download the attachment: ${e.message}`); }

  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (!lines.length) return interaction.editReply('❌ That file has no non-empty lines.');

  let report;
  try { report = await storeSync.syncAccounts(lines, { dryRun }); }
  catch (e) { return interaction.editReply(`❌ Sync failed: ${e.message}`); }

  const embed = new EmbedBuilder()
    .setColor(dryRun ? 0xf0c75a : 0x42cb6e)
    .setTitle(dryRun ? '🔎 Store sync — preview' : '✅ Store synced')
    .setDescription(
      report.routed.length
        ? report.routed.map(r =>
            `**${r.product}** ${r.error ? `— ⚠️ ${r.error}` : `— +${r.added}${r.newStock != null ? ` → ${r.newStock} in stock` : ''}`}`
          ).join('\n')
        : '_No accounts matched a product._');

  const totalRouted = report.routed.reduce((a, r) => a + (r.error ? 0 : r.added), 0);
  const footer = [`${totalRouted}/${lines.length} routed`];
  if (report.unmatched.length) footer.push(`${report.unmatched.length} unmatched`);
  embed.setFooter({ text: footer.join(' · ') });

  // Show a sample generated description + the unmatched reasons (truncated).
  if (report.routed[0]?.description) {
    embed.addFields({ name: 'Sample description', value: report.routed[0].description.slice(0, 1000) });
  }
  if (report.unmatched.length) {
    const sample = report.unmatched.slice(0, 5).map(u => `• \`${u.raw.split('|')[0].trim().slice(0, 40)}\` (${u.reason})`).join('\n');
    embed.addFields({ name: `Unmatched (${report.unmatched.length})`, value: sample.slice(0, 1000) });
  }

  return interaction.editReply({ embeds: [embed] });
}

module.exports = { data, execute };
