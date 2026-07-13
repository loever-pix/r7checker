// Discord OAuth2 with persistent sessions + auto-refresh.
//
// Flow:
//   /auth/discord                  → redirect to Discord
//   /auth/discord/callback?code=X  → exchange code → store tokens → set cookie
//   getCurrentUser(req)            → reads cookie; if access_token expired,
//                                    silently refreshes via refresh_token
//                                    so user stays logged in indefinitely
//   /auth/logout                   → clear cookie + revoke session

const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');
const fetch  = require('node-fetch');

const CLIENT_ID     = process.env.DISCORD_CLIENT_ID     || '';
const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || '';
const REDIRECT_URI  = process.env.DISCORD_REDIRECT_URI  || 'http://localhost:3000/auth/discord/callback';
const COOKIE_SECRET = process.env.COOKIE_SECRET         || crypto.randomBytes(32).toString('hex');

const COOKIE_NAME = 'r6locker_sid';
// 90 days — refresh token is valid much longer; we keep the session as long as we can refresh
const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000;
// Refresh when the access token has less than 5 minutes left
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

const SESSIONS_PATH = path.join(__dirname, '..', '.cache', 'sessions.json');
try { fs.mkdirSync(path.dirname(SESSIONS_PATH), { recursive: true }); } catch {}

let sessionsCache = null;
function loadSessions() {
  if (sessionsCache) return sessionsCache;
  try { sessionsCache = JSON.parse(fs.readFileSync(SESSIONS_PATH, 'utf8')); }
  catch { sessionsCache = {}; }
  return sessionsCache;
}
function saveSessionsAtomic() {
  try {
    const tmp = SESSIONS_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(sessionsCache));
    fs.renameSync(tmp, SESSIONS_PATH);
  } catch (e) { console.warn('[discord] sessions save failed:', e.message); }
}

function signValue(value) {
  const sig = crypto.createHmac('sha256', COOKIE_SECRET).update(value).digest('hex').slice(0, 16);
  return `${value}.${sig}`;
}
function verifyValue(signed) {
  if (!signed || typeof signed !== 'string') return null;
  const idx = signed.lastIndexOf('.');
  if (idx < 0) return null;
  const value = signed.slice(0, idx);
  const sig   = signed.slice(idx + 1);
  const expected = crypto.createHmac('sha256', COOKIE_SECRET).update(value).digest('hex').slice(0, 16);
  if (sig !== expected) return null;
  return value;
}

function parseCookies(req) {
  const out = {};
  const header = req.headers.cookie;
  if (!header) return out;
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    out[k] = decodeURIComponent(rest.join('='));
  }
  return out;
}

function isConfigured() {
  return !!(CLIENT_ID && CLIENT_SECRET);
}

function authorizeUrl(state, opts = {}) {
  const url = new URL('https://discord.com/oauth2/authorize');
  url.searchParams.set('client_id',     CLIENT_ID);
  url.searchParams.set('redirect_uri',  REDIRECT_URI);
  url.searchParams.set('response_type', 'code');
  // identify    = read profile (id, username, avatar)
  // email       = read the user's email so the bot can contact / re-invite them
  // guilds.join = lets us auto-add the user to our server (current AND future)
  url.searchParams.set('scope',         'identify email guilds.join');
  url.searchParams.set('state',         state);
  // prompt=consent forces Discord to show the authorize screen even when the
  // user has previously authorized — used by /verify so the OAuth UI is
  // always visible and any newly-added scopes (e.g. email) get re-consented.
  if (opts.prompt === 'consent') url.searchParams.set('prompt', 'consent');
  return url.toString();
}

// Refresh an expired access_token using a stored refresh_token. Returns the new
// token bundle on success, throws on failure. Used by the bot to re-add a user
// to a new guild weeks/months after their original verification.
async function refreshAccessToken(refreshToken) {
  if (!CLIENT_ID || !CLIENT_SECRET || !refreshToken) throw new Error('missing creds');
  const body = new URLSearchParams({
    client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
    grant_type: 'refresh_token', refresh_token: refreshToken,
  });
  const r = await fetch('https://discord.com/api/oauth2/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body,
  });
  if (!r.ok) throw new Error(`refresh failed: HTTP ${r.status}`);
  return r.json();   // { access_token, refresh_token, expires_in, scope, ... }
}

// Auto-add a user to our Discord guild using the bot token + the user's fresh
// OAuth access_token (which must have been issued with the guilds.join scope).
// Returns { ok, alreadyJoined } — silently no-ops if already a member (Discord
// returns 204 in that case). Bot must have CREATE_INSTANT_INVITE in the guild.
async function joinGuild(accessToken, userId) {
  const guildId  = process.env.DISCORD_GUILD_ID;
  const botToken = process.env.DISCORD_BOT_TOKEN;
  if (!guildId || !botToken || !accessToken || !userId) {
    return { ok: false, error: 'missing config' };
  }
  try {
    const res = await fetch(`https://discord.com/api/v10/guilds/${guildId}/members/${userId}`, {
      method: 'PUT',
      headers: { Authorization: `Bot ${botToken}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ access_token: accessToken }),
    });
    // 201 = added, 204 = already a member, anything else is an error.
    if (res.status === 201) return { ok: true, alreadyJoined: false };
    if (res.status === 204) return { ok: true, alreadyJoined: true };
    const text = await res.text().catch(() => '');
    return { ok: false, error: `HTTP ${res.status} ${text.slice(0, 120)}` };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function exchangeCode(code) {
  const body = new URLSearchParams({
    client_id:     CLIENT_ID,
    client_secret: CLIENT_SECRET,
    grant_type:    'authorization_code',
    code,
    redirect_uri:  REDIRECT_URI,
  });
  const res = await fetch('https://discord.com/api/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Discord token exchange failed: HTTP ${res.status} ${t.slice(0, 200)}`);
  }
  return res.json(); // { access_token, refresh_token, expires_in, scope, token_type }
}

async function refreshAccessToken(refreshToken) {
  const body = new URLSearchParams({
    client_id:     CLIENT_ID,
    client_secret: CLIENT_SECRET,
    grant_type:    'refresh_token',
    refresh_token: refreshToken,
  });
  const res = await fetch('https://discord.com/api/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Discord refresh failed: HTTP ${res.status} ${t.slice(0, 200)}`);
  }
  return res.json();
}

async function fetchUser(accessToken) {
  const res = await fetch('https://discord.com/api/users/@me', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Discord /users/@me failed: HTTP ${res.status}`);
  return res.json();
}

function avatarUrl(user) {
  if (!user.avatar) {
    const idx = BigInt(user.id) >> 22n;
    return `https://cdn.discordapp.com/embed/avatars/${Number(idx % 6n)}.png`;
  }
  const ext = user.avatar.startsWith('a_') ? 'gif' : 'png';
  return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.${ext}?size=128`;
}

// Persist a brand-new session after the OAuth code exchange.
function startSession(res, discordUser, tokens) {
  const sessions = loadSessions();
  const sid = crypto.randomBytes(24).toString('hex');
  sessions[sid] = {
    id:           discordUser.id,
    username:     discordUser.global_name || discordUser.username,
    avatar:       avatarUrl(discordUser),
    accessToken:  tokens.access_token,
    refreshToken: tokens.refresh_token,
    tokenExpiresAt: Date.now() + (tokens.expires_in * 1000),
    createdAt:    Date.now(),
    lastSeenAt:   Date.now(),
    expiresAt:    Date.now() + SESSION_TTL_MS,
  };
  saveSessionsAtomic();
  const signed = signValue(sid);
  res.setHeader('Set-Cookie',
    `${COOKIE_NAME}=${encodeURIComponent(signed)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${REDIRECT_URI.startsWith('https') ? '; Secure' : ''}`);
  return sid;
}

// Best-effort silent refresh: returns updated session or null on failure.
async function silentRefresh(sid, sess) {
  if (!sess.refreshToken) return null;
  try {
    const tokens = await refreshAccessToken(sess.refreshToken);
    sess.accessToken    = tokens.access_token;
    sess.refreshToken   = tokens.refresh_token || sess.refreshToken;
    sess.tokenExpiresAt = Date.now() + (tokens.expires_in * 1000);
    sess.expiresAt      = Date.now() + SESSION_TTL_MS; // extend rolling window
    sess.lastSeenAt     = Date.now();

    // Re-fetch user info — username/avatar may have changed
    try {
      const u = await fetchUser(sess.accessToken);
      sess.username = u.global_name || u.username || sess.username;
      sess.avatar   = avatarUrl(u);
    } catch { /* keep stale display info */ }

    sessionsCache[sid] = sess;
    saveSessionsAtomic();
    return sess;
  } catch (e) {
    console.warn('[discord] silent refresh failed:', e.message);
    return null;
  }
}

// Returns { id, username, avatar } or null. Auto-refreshes expired tokens.
async function getCurrentUser(req) {
  const cookies = parseCookies(req);
  const signed = cookies[COOKIE_NAME];
  const sid = verifyValue(signed);
  if (!sid) return null;
  const sessions = loadSessions();
  const sess = sessions[sid];
  if (!sess) return null;

  // Session totally expired (90 days) — give up
  if (sess.expiresAt && sess.expiresAt < Date.now()) {
    delete sessions[sid];
    saveSessionsAtomic();
    return null;
  }

  // Access token expired or about to expire? Silently refresh.
  const needsRefresh = !sess.tokenExpiresAt
    || (sess.tokenExpiresAt - Date.now()) < REFRESH_BUFFER_MS;
  if (needsRefresh && sess.refreshToken) {
    const refreshed = await silentRefresh(sid, sess);
    if (!refreshed) {
      // Refresh failed → token revoked → drop session
      delete sessions[sid];
      saveSessionsAtomic();
      return null;
    }
  } else {
    // Just bump lastSeenAt
    sess.lastSeenAt = Date.now();
  }

  return { id: sess.id, username: sess.username, avatar: sess.avatar };
}

// Synchronous variant — does NOT refresh. Use when you can't await
// (e.g. inside an Express middleware that needs to be cheap). Returns
// the cached user info — may be slightly stale.
function getCurrentUserSync(req) {
  const cookies = parseCookies(req);
  const signed = cookies[COOKIE_NAME];
  const sid = verifyValue(signed);
  if (!sid) return null;
  const sess = loadSessions()[sid];
  if (!sess) return null;
  if (sess.expiresAt && sess.expiresAt < Date.now()) return null;
  return { id: sess.id, username: sess.username, avatar: sess.avatar };
}

async function endSession(req, res) {
  const cookies = parseCookies(req);
  const signed = cookies[COOKIE_NAME];
  const sid = verifyValue(signed);
  if (sid) {
    const sessions = loadSessions();
    const sess = sessions[sid];
    // Tell Discord to revoke the tokens (best-effort)
    if (sess?.accessToken) {
      try {
        await fetch('https://discord.com/api/oauth2/token/revoke', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
            token: sess.accessToken, token_type_hint: 'access_token',
          }),
        });
      } catch {}
    }
    delete sessions[sid];
    saveSessionsAtomic();
  }
  res.setHeader('Set-Cookie',
    `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${REDIRECT_URI.startsWith('https') ? '; Secure' : ''}`);
}

// Periodic cleanup: drop expired sessions every hour
setInterval(() => {
  const sessions = loadSessions();
  let removed = 0;
  for (const [k, v] of Object.entries(sessions)) {
    if (v.expiresAt && v.expiresAt < Date.now()) { delete sessions[k]; removed++; }
  }
  if (removed) { saveSessionsAtomic(); console.log(`[discord] dropped ${removed} expired session(s)`); }
}, 60 * 60 * 1000).unref();

module.exports = {
  isConfigured, authorizeUrl, exchangeCode, refreshAccessToken, fetchUser, joinGuild,
  startSession, getCurrentUser, getCurrentUserSync, endSession,
};
