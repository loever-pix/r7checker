// Owner-message-to-embed. Any message a configured owner (e.g. brandonari2025 /
// brandonari2026) sends in a guild channel is deleted and reposted as a clean,
// Ayanokoji-themed embed — author + avatar, the message text, and any image
// re-shown. Keeps announcements looking polished without manual embed JSON.
//
// Needs the Message Content privileged intent (already required for DM claims).

const { EmbedBuilder } = require('discord.js');
const { cfg } = require('./config');

const IMG_RE = /\.(png|jpe?g|gif|webp)(\?|$)/i;

// Skip control-ish messages so we don't eat commands / one-word acks meant to
// stay plain (and never touch threads/system messages).
function shouldConvert(message) {
  if (!message || message.author?.bot) return false;
  if (!message.guildId) return false;                       // guild only
  if (message.system) return false;
  const users = cfg.ownerEmbedUsers || [];
  const uname = (message.author?.username || '').toLowerCase();
  if (!users.includes(uname)) return false;
  // Leave bot/prefix commands and empty messages alone.
  const content = (message.content || '').trim();
  if (!content && message.attachments.size === 0) return false;
  if (/^[!/.$%>-]/.test(content)) return false;             // prefix command-ish
  return true;
}

async function onMessage(message) {
  try {
    if (!shouldConvert(message)) return false;

    const content = (message.content || '').trim();
    const attachments = [...message.attachments.values()];
    const firstImage = attachments.find(a => IMG_RE.test(a.url) || (a.contentType || '').startsWith('image/'));
    const nonImages = attachments.filter(a => a !== firstImage);

    const member = message.member;
    const display = member?.displayName || message.author.globalName || message.author.username;
    const avatar = (member?.displayAvatarURL?.({ size: 128 })) || message.author.displayAvatarURL({ size: 128 });

    // If the owner REPLIED to someone, capture that context BEFORE we delete the
    // message, so the reposted embed can both quote it and link to the original.
    let repliedTo = null;
    if (message.reference?.messageId) {
      try {
        const ref = await message.fetchReference();
        const refName = ref.member?.displayName || ref.author?.globalName || ref.author?.username || 'someone';
        const refText = (ref.content || '').replace(/\s+/g, ' ').trim();
        repliedTo = { id: ref.id, name: refName, text: refText };
      } catch { repliedTo = { id: message.reference.messageId }; }
    }

    const embed = new EmbedBuilder()
      .setColor(cfg.theme?.color || 0xCAD3DC)
      .setAuthor({ name: display, iconURL: avatar })
      .setTimestamp(new Date());
    // Quote the replied-to message at the top so the context is visible even if
    // the original later gets deleted.
    if (repliedTo?.text) {
      const snip = repliedTo.text.slice(0, 160);
      embed.addFields({ name: `↩︎ Replying to ${repliedTo.name}`, value: `> ${snip}${repliedTo.text.length > 160 ? '…' : ''}` });
    } else if (repliedTo) {
      embed.addFields({ name: '↩︎ Reply', value: `In reply to a previous message` });
    }
    if (content) embed.setDescription(content.slice(0, 4000));
    if (cfg.theme?.thumb && !firstImage) embed.setThumbnail(cfg.theme.thumb);

    // Re-UPLOAD attachments (fetch the bytes BEFORE we delete the original) so the
    // picture survives the message being removed — the raw CDN URL expires/404s
    // once the source message is gone. The first image becomes the embed image.
    const files = [];
    if (firstImage) {
      const name = (firstImage.name && /\.(png|jpe?g|gif|webp)$/i.test(firstImage.name)) ? firstImage.name : 'image.png';
      let buf = null;
      try { const r = await fetch(firstImage.url); if (r.ok) buf = Buffer.from(await r.arrayBuffer()); } catch {}
      if (buf) { files.push({ attachment: buf, name }); embed.setImage(`attachment://${name}`); }
      else embed.setImage(firstImage.url);   // fallback: reference the URL directly
    }
    for (const a of nonImages) {
      let buf = null;
      try { const r = await fetch(a.url); if (r.ok) buf = Buffer.from(await r.arrayBuffer()); } catch {}
      files.push(buf ? { attachment: buf, name: a.name || 'file' } : { attachment: a.url, name: a.name || 'file' });
    }

    // Delete first so a failure (missing Manage Messages) means we DON'T post a
    // duplicate — the original simply stays as-is.
    try { await message.delete(); }
    catch (e) { console.warn('[ownerEmbed] cannot delete (need Manage Messages):', e.message); return false; }

    // Repost the embed — AS A REPLY to the original target when there was one, so
    // Discord shows the native "replying to" link. Never a mass-ping vector.
    const sendOpts = { embeds: [embed], files, allowedMentions: { parse: ['users', 'roles'], repliedUser: false } };
    if (repliedTo?.id) sendOpts.reply = { messageReference: repliedTo.id, failIfNotExists: false };
    await message.channel.send(sendOpts);
    return true;
  } catch (e) {
    console.warn('[ownerEmbed] error:', e.message);
    return false;
  }
}

module.exports = { onMessage, shouldConvert };
