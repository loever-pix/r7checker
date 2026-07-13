// Self-assign restock-ping role via a reaction. On startup we ensure exactly
// one self-assign message exists in the configured channel; its ID is persisted
// so restarts reuse it instead of spamming duplicates.

const fs = require('fs');
const path = require('path');
const { EmbedBuilder } = require('discord.js');
const { cfg } = require('./config');

const STATE_PATH = path.join(__dirname, '..', '..', '.cache', 'reactionrole.json');
try { fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true }); } catch {}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); } catch { return {}; }
}
function saveState(s) {
  try { fs.writeFileSync(STATE_PATH, JSON.stringify(s)); } catch (e) {
    console.warn('[bot] could not persist reaction-role state:', e.message);
  }
}

// Matches the configured emoji whether it's a unicode char or a custom emoji.
function emojiMatches(reactionEmoji) {
  const want = cfg.reactionEmoji;
  return reactionEmoji.name === want || reactionEmoji.toString() === want || reactionEmoji.id === want;
}

let messageId = null;

async function ensureMessage(client) {
  const channel = await client.channels.fetch(cfg.reactionChannelId);
  const state = loadState();

  if (state.messageId) {
    try {
      const existing = await channel.messages.fetch(state.messageId);
      messageId = existing.id;
      // Make sure our own reaction is present as the click target.
      const mine = existing.reactions.cache.find(r => emojiMatches(r.emoji));
      if (!mine) await existing.react(cfg.reactionEmoji);
      return;
    } catch { /* stored message gone — fall through and repost */ }
  }

  const embed = new EmbedBuilder()
    .setTitle('🔔 Restock Pings')
    .setDescription(`React with ${cfg.reactionEmoji} to get pinged whenever accounts are restocked.\nRemove your reaction to stop the pings.`)
    .setColor(0x5865f2);
  const msg = await channel.send({ embeds: [embed] });
  await msg.react(cfg.reactionEmoji);
  messageId = msg.id;
  saveState({ messageId });
  console.log(`[bot] posted reaction-role message ${messageId} in ${cfg.reactionChannelId}`);
}

async function resolveFull(reaction) {
  if (reaction.partial) { try { await reaction.fetch(); } catch { return false; } }
  return true;
}

async function onAdd(reaction, user) {
  if (user.bot) return;
  if (!(await resolveFull(reaction))) return;
  if (reaction.message.id !== messageId) return;
  if (!emojiMatches(reaction.emoji)) return;
  try {
    const member = await reaction.message.guild.members.fetch(user.id);
    await member.roles.add(cfg.restockPingRoleId);
  } catch (e) { console.warn('[bot] add role failed:', e.message); }
}

async function onRemove(reaction, user) {
  if (user.bot) return;
  if (!(await resolveFull(reaction))) return;
  if (reaction.message.id !== messageId) return;
  if (!emojiMatches(reaction.emoji)) return;
  try {
    const member = await reaction.message.guild.members.fetch(user.id);
    await member.roles.remove(cfg.restockPingRoleId);
  } catch (e) { console.warn('[bot] remove role failed:', e.message); }
}

module.exports = { ensureMessage, onAdd, onRemove };
