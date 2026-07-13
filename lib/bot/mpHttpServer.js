// Marketplace HTTP listener inside the bot process.
//
// The website's /api/mp/buy endpoint calls these routes on the bot over
// localhost (same VPS) to create the private Discord channel for a sale and
// to verify guild membership. Auth: shared BOT_INBOUND_TOKEN env var.
//
//   POST /mp/create-channel
//     body: { listingId, sellerDiscordId, buyerDiscordId, listingSummary }
//     → { ok, channelId }
//
//   GET /mp/in-guild/:discordId
//     → { ok, inGuild }
//
// Kept intentionally small — error handling is the bot's responsibility, not
// the protocol's.

const http = require('http');
const { ChannelType, PermissionFlagsBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { cfg } = require('./config');
const verifyConfig = require('./verifyConfig');

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function send(res, status, body) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': buf.length });
  res.end(buf);
}

// Create a private channel under the configured marketplace category. Visible
// only to: the bot, the buyer, the seller, and the owner role. @everyone is
// explicitly denied so the channel is fully private.
async function createMarketplaceChannel(client, opts) {
  const { listingId, sellerDiscordId, buyerDiscordId } = opts;
  if (!cfg.mpCategoryId) throw new Error('MP_CATEGORY_ID not configured');
  const guild = await client.guilds.fetch(cfg.guildId);
  const overwrites = [
    { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },        // @everyone hidden
    { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels] },
    { id: cfg.ownerRoleId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
  ];
  if (buyerDiscordId)  overwrites.push({ id: buyerDiscordId,  allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] });
  if (sellerDiscordId) overwrites.push({ id: sellerDiscordId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] });

  const name = `deal-${listingId}`.toLowerCase().slice(0, 90);
  const channel = await guild.channels.create({
    name,
    type: ChannelType.GuildText,
    parent: cfg.mpCategoryId,
    permissionOverwrites: overwrites,
    reason: `Marketplace listing ${listingId} sale`,
  });

  const embed = new EmbedBuilder()
    .setColor(0x3a8dff)
    .setTitle(`🛒 Marketplace Deal #${listingId}`)
    .setDescription(
      `**Buyer:** <@${buyerDiscordId || '0'}>\n` +
      `**Seller:** <@${sellerDiscordId || '0'}>\n\n` +
      `Discuss and complete the trade here. This channel is private — only you two and staff can see it.`)
    .addFields(
      { name: 'Account',     value: opts.accountName || '—', inline: true },
      { name: 'Access',      value: opts.accessType  || '—', inline: true },
      { name: 'Price',       value: opts.priceText   || '—', inline: true },
    )
    .setFooter({ text: 'Both parties must confirm Finish to complete · both must confirm Cancel to call it off' });
  if (opts.profileUrl) embed.addFields({ name: 'Account profile', value: opts.profileUrl });

  // Finish / Cancel each require BOTH parties to click. Listing id is encoded in
  // the custom_id so the handler works even after a bot restart.
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`mpdeal:finish:${listingId}`).setLabel('Finish deal').setEmoji('✅').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`mpdeal:cancel:${listingId}`).setLabel('Cancel deal').setEmoji('✖️').setStyle(ButtonStyle.Danger),
  );

  try {
    await channel.send({
      content: `<@${buyerDiscordId || '0'}> <@${sellerDiscordId || '0'}>`,
      embeds: [embed],
      components: [row],
    });
  } catch (e) { console.warn('[mp] intro send failed:', e.message); }
  return channel.id;
}

// Grant the configured Verified role to a member (called by the site after a
// successful, non-alt verification).
async function grantVerified(client, discordId) {
  const vc = verifyConfig.get();
  if (!vc.roleId) throw new Error('verified role not set — run /setupverify');
  const guild = await client.guilds.fetch(cfg.guildId);
  const member = await guild.members.fetch(discordId).catch(() => null);
  if (!member) throw new Error('member not in guild');
  await member.roles.add(vc.roleId, 'Verified via r6checker.xyz');
  return true;
}

// Post an alt-alert to the configured log channel (best-effort). Hard-block →
// red "BLOCKED"; soft-flag (VERIFY_SOFT_FLAG=true) → amber "FLAGGED — role
// granted, please review".
async function altAlert(client, info) {
  try {
    const vc = verifyConfig.get();
    if (!vc.logChannelId) return;
    const ch = await client.channels.fetch(vc.logChannelId).catch(() => null);
    if (!ch || typeof ch.send !== 'function') return;
    const soft = !!info.softFlagged;
    const embed = new EmbedBuilder()
      .setColor(soft ? 0xfbbf24 : 0xf87171)
      .setTitle(soft ? '⚠️ Possible alt FLAGGED at verification — role granted' : '🚨 Possible alt BLOCKED at verification')
      .setDescription(
        `<@${info.discordId}> (\`${info.username || '?'}\`) — ${soft ? 'role was granted automatically (soft-flag mode); review and revoke manually if needed.' : 'verification was blocked.'}\n` +
        `**Match:** ${info.reason || '?'} → <@${info.matchedDiscordId}> (\`${info.matchedUsername || '?'}\`)` +
        (info.ip ? `\n**IP:** \`${info.ip}\`` : ''))
      .setTimestamp(new Date());
    await ch.send({ embeds: [embed] });
  } catch (e) { console.warn('[verify] alt alert failed:', e.message); }
}

// List every guild the bot is in, with member counts. Used by the admin panel
// to populate the destination dropdown for mass-invite.
async function listBotGuilds(client) {
  const out = [];
  for (const g of client.guilds.cache.values()) {
    out.push({ id: g.id, name: g.name, memberCount: g.memberCount });
  }
  // Sort biggest first — usually the most-likely target.
  return out.sort((a, b) => b.memberCount - a.memberCount);
}

// Mass-invite: call guilds.join for each user in `users` (each = { discordId,
// accessToken }) into `guildId`. Throttled to ~2/s to stay under Discord's rate
// limits. The site refreshes expired tokens BEFORE calling us, so accessToken
// is fresh on entry. Status per user is sent back so the panel can show them.
async function massInvite(client, guildId, users) {
  const guild = await client.guilds.fetch(guildId);
  const botToken = process.env.DISCORD_BOT_TOKEN;
  const results = [];
  for (const u of users) {
    let status;
    try {
      const r = await fetch(`https://discord.com/api/v10/guilds/${guildId}/members/${u.discordId}`, {
        method: 'PUT',
        headers: { Authorization: `Bot ${botToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ access_token: u.accessToken }),
      });
      if (r.status === 201) status = 'added';
      else if (r.status === 204) status = 'already-in';
      else {
        const t = await r.text();
        status = `http-${r.status}`;
        // Stop on hard auth errors — every subsequent call will fail the same way.
        if (r.status === 401 || r.status === 403) { results.push({ discordId: u.discordId, status, error: t.slice(0, 200) }); break; }
      }
    } catch (e) { status = 'error'; results.push({ discordId: u.discordId, status, error: e.message }); continue; }
    results.push({ discordId: u.discordId, status });
    // ~2 calls/sec keeps us comfortably inside Discord's per-route rate limit
    // (10/10s for guilds.join) with headroom for retries elsewhere.
    await new Promise(r => setTimeout(r, 500));
  }
  return { guildName: guild.name, results };
}

async function isInGuild(client, discordId) {
  if (!discordId) return false;
  try {
    const guild = await client.guilds.fetch(cfg.guildId);
    const member = await guild.members.fetch(discordId).catch(() => null);
    return !!member;
  } catch (e) {
    console.warn('[mp] guild membership check failed:', e.message);
    return false;
  }
}

function start(client) {
  const port = Number(process.env.BOT_HTTP_PORT) || 4242;
  const token = process.env.BOT_INBOUND_TOKEN || '';
  if (!token) { console.warn('[mp] BOT_INBOUND_TOKEN not set — refusing to start mp listener'); return; }

  const server = http.createServer(async (req, res) => {
    // Auth on every request — same secret for all marketplace endpoints.
    if (req.headers['x-bot-inbound-token'] !== token) {
      return send(res, 401, { error: 'unauthorized' });
    }
    try {
      if (req.method === 'POST' && req.url === '/mp/create-channel') {
        const body = await readJson(req);
        const channelId = await createMarketplaceChannel(client, body);
        return send(res, 200, { ok: true, channelId });
      }
      const m = req.method === 'GET' && req.url.match(/^\/mp\/in-guild\/(\d+)$/);
      if (m) {
        const inGuild = await isInGuild(client, m[1]);
        return send(res, 200, { ok: true, inGuild });
      }
      if (req.method === 'POST' && req.url === '/verify/grant-role') {
        const body = await readJson(req);
        await grantVerified(client, body.discordId);
        return send(res, 200, { ok: true });
      }
      if (req.method === 'POST' && req.url === '/verify/alt-alert') {
        const body = await readJson(req);
        altAlert(client, body);   // fire-and-forget
        return send(res, 200, { ok: true });
      }
      // Admin: list guilds the bot is in (for the mass-invite dropdown).
      if (req.method === 'GET' && req.url === '/admin/bot-guilds') {
        const guilds = await listBotGuilds(client);
        return send(res, 200, { ok: true, guilds });
      }
      // Admin: bulk guilds.join. body = { guildId, users:[{discordId, accessToken}, …] }
      if (req.method === 'POST' && req.url === '/admin/mass-invite') {
        const body = await readJson(req);
        const out = await massInvite(client, body.guildId, body.users || []);
        return send(res, 200, { ok: true, ...out });
      }
      // VWI sorter → SellAuth. The website posts result lines; the bot (which
      // owns SellAuth) prices + buckets them. /plan is a read-only dry-run;
      // /push performs the live writes (create products, add priced variants).
      if (req.method === 'POST' && (req.url === '/vwi/plan' || req.url === '/vwi/push')) {
        const body = await readJson(req);
        const lines = Array.isArray(body.lines) ? body.lines : String(body.text || '').split(/\r?\n/);
        const sa = require('./sellauth');
        const vwiPush = require('./vwiPush');
        const VB = require('../../public/js/vwiBuckets');
        const sk = require('../checker/skinCheck');
        const buckets = VB.bucketAccounts(lines, sk.vwiMeta());
        const products = await sa.listProducts();
        if (req.url === '/vwi/plan') {
          return send(res, 200, { ok: true, plan: vwiPush.buildPlan(buckets, products) });
        }
        const storeSync = require('./storeSync');
        const out = await vwiPush.execute(buckets, products, { sellauth: sa, storeSync }, { visibility: body.visibility || 'public' });
        return send(res, 200, { ok: true, ...out });
      }
      send(res, 404, { error: 'not found' });
    } catch (e) {
      console.error('[mp] handler error:', e.message);
      send(res, 500, { error: e.message });
    }
  });
  // Bind to localhost ONLY so the listener is unreachable from outside the VPS.
  server.listen(port, '127.0.0.1', () => {
    console.log(`[mp] bot listener on 127.0.0.1:${port}`);
  });
}

module.exports = { start };
