// /invites — show who joined via a user's invites, with each joiner's account
// age at the time they joined and whether they're still in the server.

const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const inviteLog = require('../inviteLog');
const { cfg } = require('../config');

const data = new SlashCommandBuilder()
  .setName('invites')
  .setDescription('Check who joined through your invites (with their account age)')
  .addUserOption(o => o
    .setName('user')
    .setDescription('Whose invites to check (defaults to you)')
    .setRequired(false));

async function execute(interaction) {
  const target = interaction.options.getUser('user') || interaction.user;
  const records = inviteLog.forInviter(target.id);
  const total = records.length;
  const present = records.filter(r => !r.left).length;
  const left = total - present;

  const recent = records.slice(-15).reverse();   // newest first
  const lines = recent.map(r => {
    const createdStr = r.createdAt ? `<t:${Math.floor(r.createdAt / 1000)}:R>` : '?';
    const joinedStr = `<t:${Math.floor(r.joinedAt / 1000)}:R>`;
    const ageDays = r.createdAt ? Math.floor((r.joinedAt - r.createdAt) / 86400000) : null;
    const ageStr = ageDays != null ? ` · acct **${ageDays}d** old at join` : '';
    const name = r.joinerName ? r.joinerName : `user ${r.joinerId}`;
    return `${r.left ? '❌' : '✅'} **${name}** — joined ${joinedStr}${ageStr} (created ${createdStr})`;
  });

  const embed = new EmbedBuilder()
    .setColor((cfg.theme && cfg.theme.color) || 0xCAD3DC)
    .setAuthor({ name: `${target.username}'s invites`, iconURL: target.displayAvatarURL({ size: 128 }) })
    .setTitle('Invites')
    .setDescription(`**${present}** still here · **${left}** left · **${total}** total joins tracked.`)
    .addFields({
      name: recent.length ? 'Recent joins' : 'Joins',
      value: lines.length ? lines.join('\n').slice(0, 1024) : '_No tracked joins yet._',
    })
    .setFooter({ text: 'Classroom of the Elite · invite tracking is live going forward' })
    .setTimestamp(new Date());

  await interaction.reply({ embeds: [embed], allowedMentions: { parse: [] }, flags: MessageFlags.Ephemeral });
}

module.exports = { data, execute };
