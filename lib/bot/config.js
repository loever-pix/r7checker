// Central config for the Discord bot. Reads everything from .env and fails
// fast on boot if a required value is missing, so we never start half-wired.

require('dotenv').config();

const cfg = {
  token:        process.env.DISCORD_BOT_TOKEN || '',
  guildId:      process.env.DISCORD_GUILD_ID  || '',
  sellauth: {
    key:    process.env.SELLAUTH_API_KEY || '',
    shopId: process.env.SELLAUTH_SHOP_ID || '',
    base:   process.env.SELLAUTH_BASE || 'https://api.sellauth.com',
  },
  ownerRoleId:        process.env.OWNER_ROLE_ID            || '',
  restockPingRoleId:  process.env.RESTOCK_PING_ROLE_ID     || '',
  // Reaction-role + buyer-claim embed live here; restock/stock-change alerts go
  // to the separate alert channel.
  reactionChannelId:  process.env.REACTION_ROLE_CHANNEL_ID || '1512288064683114536',
  restockAlertChannelId: process.env.RESTOCK_ALERT_CHANNEL_ID || '1512944096057233521',
  reactionEmoji:      process.env.REACTION_EMOJI           || '🔔',
  // Role auto-granted to every member on join (and backfilled to existing).
  joinRoleId:         process.env.JOIN_ROLE_ID             || '1511885922868662282',
  // Buyer role granted after a verified PAID SellAuth invoice.
  buyerRoleId:        process.env.BUYER_ROLE_ID            || '1513308086947938365',
  buyerClaimChannelId: process.env.BUYER_CLAIM_CHANNEL_ID  || process.env.REACTION_ROLE_CHANNEL_ID || '1512288064683114536',
  // /recheck — extra role IDs allowed alongside the owner role. Comma-separated.
  rechekRoleIds: (process.env.RECHECK_ROLE_IDS || '000000000000000000')
    .split(',').map(s => s.trim()).filter(Boolean),
  // Auth + URL for the bot → website-server recheck handoff (same VPS, localhost).
  botApiToken: process.env.BOT_API_TOKEN || '',
  serverUrl:   process.env.BOT_SERVER_URL || 'http://127.0.0.1:3000',
  // Public URL of the website — used for USER-FACING links (download buttons in
  // Discord embeds, etc.). serverUrl is intentionally localhost for the internal
  // bot→server hop, so it must NOT leak into a clickable user link.
  publicUrl:   (process.env.SITE_URL || process.env.PUBLIC_URL || 'https://r6checker.xyz').replace(/\/+$/, ''),
  // Marketplace category to put per-deal private channels under (Discord).
  mpCategoryId: process.env.MP_CATEGORY_ID || '',
  // ── Public sales feed ──────────────────────────────────────────────────
  // Channel the bot posts purchase embeds to (pending → paid). If unset here,
  // /setupsales creates one and persists its id to .cache/sales-feed.json.
  salesChannelId: process.env.SALES_CHANNEL_ID || '',
  salesPollMs:    Math.max(15000, Number(process.env.SALES_POLL_MS) || 45000),
  // Base for the clickable invoice link in the embed. {id} ← invoice unique_id.
  salesInvoiceBase: process.env.SALES_INVOICE_BASE || 'https://r6checker.mysellauth.com/invoice/{id}',
  // ── Owner-message-to-embed ─────────────────────────────────────────────
  // Messages from these usernames (handles) are auto-converted to themed embeds.
  ownerEmbedUsers: (process.env.OWNER_EMBED_USERS || 'brandonari2025,brandonari2026,notephishing')
    .split(',').map(s => s.trim().toLowerCase().replace(/^@/, '')).filter(Boolean),
  // ── Ayanokoji theme (Classroom of the Elite) ───────────────────────────
  // Accent + optional media. Media URLs default to env so links are never
  // broken by default; paste Tenor/Imgur direct URLs to enable images.
  theme: {
    color:      Number(process.env.THEME_COLOR) || 0xCAD3DC,   // cool silver
    accent:     Number(process.env.THEME_ACCENT) || 0x9AA6B2,
    welcomeGif: process.env.AYANOKOJI_WELCOME_GIF || '',
    bannerGif:  process.env.AYANOKOJI_BANNER_GIF  || '',
    rulesImage: process.env.AYANOKOJI_RULES_IMAGE || '',
    thumb:      process.env.AYANOKOJI_THUMB       || '',
    serverIcon: process.env.AYANOKOJI_SERVER_ICON || '',
  },
};

const REQUIRED = [
  ['DISCORD_BOT_TOKEN',        cfg.token],
  ['DISCORD_GUILD_ID',         cfg.guildId],
  ['SELLAUTH_API_KEY',         cfg.sellauth.key],
  ['SELLAUTH_SHOP_ID',         cfg.sellauth.shopId],
  ['OWNER_ROLE_ID',            cfg.ownerRoleId],
  ['RESTOCK_PING_ROLE_ID',     cfg.restockPingRoleId],
  ['REACTION_ROLE_CHANNEL_ID', cfg.reactionChannelId],
];

function assertConfigured() {
  const missing = REQUIRED.filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) {
    throw new Error(`[bot] missing required .env keys: ${missing.join(', ')}`);
  }
}

module.exports = { cfg, assertConfigured };
