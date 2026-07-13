// /syncvariants — owner-only. Convert stocked rank products into one SellAuth
// variant per account so buyers can choose the exact account. Mystery Wanted
// Items products intentionally stay pooled.

const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const sa = require('../sellauth');
const storeSync = require('../storeSync');
const { isOwner } = require('../util');

const data = new SlashCommandBuilder()
  .setName('syncvariants')
  .setDescription('Create one buyable SellAuth variant per stocked account')
  .addStringOption(o => o
    .setName('product')
    .setDescription('Optional product to split; omit to process all rank products')
    .setRequired(false)
    .setAutocomplete(true))
  .addBooleanOption(o => o
    .setName('dryrun')
    .setDescription('Preview account variants without writing to SellAuth'));

async function autocomplete(interaction) {
  const focused = (interaction.options.getFocused() || '').toLowerCase();
  let products = [];
  try { products = await sa.listProducts(); } catch { /* empty on failure */ }
  const choices = products
    .filter(p => !/mystery|wanted/i.test(p.name))
    .filter(p => !focused || p.name.toLowerCase().includes(focused))
    .slice(0, 25)
    .map(p => ({ name: `${p.name} — stock ${p.stock}`.slice(0, 100), value: String(p.id) }));
  await interaction.respond(choices);
}

function summarizeResult(r) {
  if (r.dryRun) return `**${r.product}** — would create ${r.variants.length} account variant(s)`;
  return `**${r.product}** — ${r.written}/${r.sourceStock} account variant(s) synced`;
}

async function execute(interaction) {
  if (!isOwner(interaction)) {
    return interaction.reply({ content: '⛔ Only the owner can sync account variants.', flags: MessageFlags.Ephemeral });
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const productId = interaction.options.getString('product');
  const dryRun = interaction.options.getBoolean('dryrun') || false;

  let report;
  try {
    if (productId) {
      const r = await storeSync.splitProductAccountVariants(productId, { dryRun });
      report = { updated: r.skipped ? [] : [r], skipped: r.skipped ? [r] : [], dryRun };
    } else {
      report = await storeSync.splitAllAccountVariants({ dryRun });
    }
  } catch (e) {
    return interaction.editReply(`❌ Variant sync failed: ${e.message}`);
  }

  const title = dryRun ? '🔎 Account variants — preview' : '✅ Account variants synced';
  const lines = report.updated.length
    ? report.updated.map(summarizeResult)
    : ['_No stocked rank products found to split._'];
  const embed = new EmbedBuilder()
    .setColor(dryRun ? 0xf0c75a : 0x42cb6e)
    .setTitle(title)
    .setDescription(lines.join('\n').slice(0, 3800))
    .setFooter({ text: `${report.updated.length} updated · ${report.skipped.length} skipped · Mystery products skipped` });

  const sample = report.updated[0]?.variants?.slice(0, 8).map(v => `• ${v.name}`).join('\n');
  if (sample) embed.addFields({ name: dryRun ? 'Sample variants' : 'Synced variants', value: sample.slice(0, 1000) });
  if (report.skipped.length) {
    const skipped = report.skipped.slice(0, 8).map(s => `• ${s.product}: ${s.reason}`).join('\n');
    embed.addFields({ name: 'Skipped', value: skipped.slice(0, 1000) });
  }

  return interaction.editReply({ embeds: [embed] });
}

module.exports = { data, execute, autocomplete };
