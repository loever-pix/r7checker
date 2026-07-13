// /syncallstock — owner-only. Regenerate the description of EVERY SellAuth
// product from the accounts already sitting in its stock. Saves manually
// re-uploading/formatting; one command brings every listing's description in
// line with its current stock. dryrun:true previews without writing.

const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const storeSync = require('../storeSync');
const { isOwner } = require('../util');

const data = new SlashCommandBuilder()
  .setName('syncallstock')
  .setDescription('Rebuild every product description from the accounts already in stock')
  .addBooleanOption(o => o
    .setName('dryrun')
    .setDescription('Preview the descriptions without writing to the store'));

async function execute(interaction) {
  if (!isOwner(interaction)) {
    return interaction.reply({ content: '⛔ Only the owner can sync the store.', flags: MessageFlags.Ephemeral });
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const dryRun = interaction.options.getBoolean('dryrun') || false;

  let report;
  try { report = await storeSync.syncAllStock({ dryRun }); }
  catch (e) { return interaction.editReply(`❌ Sync failed: ${e.message}`); }

  const embed = new EmbedBuilder()
    .setColor(dryRun ? 0xf0c75a : 0x42cb6e)
    .setTitle(dryRun ? '🔎 Sync all stock — preview' : '✅ All descriptions synced')
    .setDescription(
      report.updated.length
        ? report.updated.map(r => `**${r.product}** — ${r.error ? `⚠️ ${r.error}` : `${r.stock} in stock ✓`}`).join('\n').slice(0, 3800)
        : '_No products with stock to sync._')
    .setFooter({ text: `${report.updated.filter(r => !r.error).length} updated · ${report.skipped.length} skipped` });

  if (report.updated[0]?.description) {
    embed.addFields({ name: 'Sample description', value: report.updated[0].description.slice(0, 1000) });
  }
  return interaction.editReply({ embeds: [embed] });
}

module.exports = { data, execute };
