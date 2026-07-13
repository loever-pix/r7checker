require('dotenv').config(); // load .env first, before any module reads process.env
const express     = require('express');
const path        = require('path');
const fs          = require('fs');
const axios       = require('axios');
const rateLimit   = require('express-rate-limit');
const compression = require('compression');
const { BASE_HEADERS, login } = require('./lib/auth');
const { ubiRequest, queueStats } = require('./lib/api');
const { getPlayerData } = require('./lib/player');
const db        = require('./lib/db');
const discord   = require('./lib/discord');
const store     = require('./lib/store');
const crypto    = require('crypto');
const verifyStore = require('./lib/verifyStore');
const verifyTokens = require('./lib/verifyTokens');
const siteAuth  = require('./lib/siteAuth');
const nowpayments = require('./lib/payments/nowpayments');
const whop        = require('./lib/payments/whop');
const bulkRunner  = require('./lib/checker/bulkRunner');
const fmt         = require('./lib/checker/resultFormat');
const desktopActivation = require('./lib/desktopActivation');

const BILLING_ENABLED = process.env.ENABLE_BILLING === '1';
const MIN_DEPOSIT_USD = Number(process.env.MIN_DEPOSIT_USD || 10);
const MAX_DEPOSIT_USD = 1000;

const CACHE_DIR = process.env.CACHE_DIR || path.join(__dirname, '.cache');

const app = express();

// Trust the proxy in front of us (Cloudflare Tunnel, etc.) so req.ip is the real client IP.
// Without this, all requests look like they come from 127.0.0.1 and limits become global.
app.set('trust proxy', 1);

// Don't broadcast our stack — `X-Powered-By: Express` is free recon for attackers.
app.disable('x-powered-by');

// Baseline security headers on every response.
//   - X-Content-Type-Options: nosniff   — stops browsers guessing a Content-Type
//   - Referrer-Policy: strict-origin-when-cross-origin — limits Referer leaks of paths with tokens
//   - X-Frame-Options: SAMEORIGIN       — blocks clickjacking via iframe embedding
//   - Cross-Origin-Resource-Policy: same-site — blocks other origins from reading our resources
//   - Permissions-Policy                — explicitly disable features we don't need
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  next();
});

// gzip every response — playerData is ~650KB JSON, compresses to ~40KB
app.use(compression({ level: 6, threshold: 1024 }));

// Block caching of personal/authenticated data at any proxy or browser.
// Bulk results contain plaintext passwords; account/transactions/deposits
// contain balances tied to the cookie. CDN must NEVER cache these.
function noStore(_req, res, next) {
  res.setHeader('Cache-Control', 'private, no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
}
// Apply ONLY to paths that may return per-user content.
app.use('/api/auth',     noStore);
app.use('/api/deposit',  noStore);
app.use('/api/transactions', noStore);
app.use('/api/bulk',     noStore);

// NOWPayments IPN webhook — needs the raw body for HMAC verification, so it
// MUST be mounted BEFORE the global express.json() parser.
app.post('/webhook/nowpayments',
  express.raw({ type: '*/*', limit: '32kb' }),
  (req, res) => {
    if (!BILLING_ENABLED) return res.status(404).end();
    const sig = req.headers['x-nowpayments-sig'] || '';
    const rawBody = req.body; // Buffer from express.raw
    // Verify HMAC over the raw bytes — NOWPayments signs the JSON as-sent.
    // Re-parsing then re-serializing can change byte-level formatting and
    // break the signature.
    if (!nowpayments.verifyIpnSignature(rawBody, sig)) {
      console.warn('[nowpayments] webhook HMAC mismatch from', req.ip);
      return res.status(401).end();
    }
    let payload;
    try { payload = JSON.parse(rawBody.toString('utf8')); }
    catch { return res.status(400).end(); }
    const result = nowpayments.handleIpn(payload);
    if (!result.ok) return res.status(result.error === 'unknown invoice' ? 404 : 400).end();
    res.status(200).end();
  }
);

// Whop webhook — same raw-body discipline as NOWPayments (HMAC over exact bytes
// before any DB write). Standard Webhooks spec: webhook-id, webhook-timestamp,
// webhook-signature headers. Mounted BEFORE express.json() so req.body is a Buffer.
app.post('/webhook/whop',
  express.raw({ type: '*/*', limit: '64kb' }),
  (req, res) => {
    if (!BILLING_ENABLED) return res.status(404).end();
    const rawBody = req.body;   // Buffer from express.raw
    if (!whop.verifyWebhook(rawBody, req.headers)) {
      console.warn('[whop] webhook HMAC mismatch from', req.ip);
      return res.status(401).end();
    }
    let payload;
    try { payload = JSON.parse(rawBody.toString('utf8')); }
    catch { return res.status(400).end(); }
    const result = whop.handleEvent(payload);
    // 200 on unknown-order-id too — return success so Whop doesn't retry
    // forever a webhook that has no matching deposit (e.g. test payments
    // from another integration, or one fired before deposit was recorded).
    if (!result.ok && result.error !== 'unknown order_id') {
      return res.status(400).end();
    }
    res.status(200).end();
  }
);

// Only the bulk-start endpoint accepts a giant body (a paste/upload of up to
// 1M accounts ≈ 80MB of email:password lines). Mounting that large limit
// globally would let any unauthenticated request (e.g. /api/login) make the
// server buffer up to 320MB in RAM — a cheap memory-exhaustion DoS. So the
// large parser is scoped to /api/bulk/start, and every other JSON endpoint
// gets a tight 1MB cap. (express.json no-ops on the second pass because the
// first parser already set req._body.)
// JSON pastes ({input}) are parsed here; big file uploads arrive as a raw
// text/plain STREAM and are parsed line-by-line in the handler (no full-body
// buffer), so neither the browser nor the server holds a giant string.
app.use('/api/bulk/start', express.json({ limit: process.env.MAX_BODY || '768mb' }));
// Same for the desktop CLI's bulk-start — it uploads the same large account
// list. Must be registered BEFORE the global 1MB parser below, or that parser
// runs first and rejects the body as "entity too large" → "Malformed request."
app.use('/api/cli/bulk/start', express.json({ limit: process.env.MAX_BODY || '768mb' }));
// And the Discord bot's recheck endpoint (a product's full stock list = lots of lines).
app.use('/api/admin/bot/recheck', express.json({ limit: process.env.MAX_BODY || '768mb' }));
// VWI push preview + execute can carry the full result-file lines (thousands of
// accounts × ~300 bytes each) — must be mounted BEFORE the global 1MB parser
// below, or the global runs first and rejects big bodies as 'Malformed request'
// (root cause of the "Preview failed: Malformed request" dialog on Push).
app.use('/api/admin/vwi/plan', express.json({ limit: process.env.VWI_MAX_BODY || '128mb' }));
app.use('/api/admin/vwi/push', express.json({ limit: process.env.VWI_MAX_BODY || '128mb' }));
app.use(express.json({ limit: '1mb' }));

// Site-auth session middleware — attaches req.siteUser (or null) to every request.
app.use(siteAuth.siteUserMiddleware);

// ── Rate limiting ─────────────────────────────────
// Tight on expensive endpoints (Camoufox launches, Ubisoft API calls).
// Loose on cheap ones (image proxy, polling).
const loginLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,                       // 5 sign-in attempts / IP / min
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many sign-in attempts. Wait a minute and try again.' },
});
const tokenLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many token requests. Slow down.' },
});
const pollLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,                      // 1 poll/sec is plenty
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Polling too fast.' },
});
const imgLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,                     // images are cheap, but cap abuse
  standardHeaders: true,
  legacyHeaders: false,
});
// Global safety net — catches anyone hammering arbitrary paths
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
});

app.use(globalLimiter);
app.use('/api/img',             imgLimiter);
app.use('/api/login',           loginLimiter);
app.use('/api/use-token',       tokenLimiter);

// ── Cloudflare Turnstile (captcha on add-account) ──────────────────────────
// Verifies the widget token server-side. Disabled (passes through) if no
// TURNSTILE_SECRET_KEY is configured.
const TURNSTILE_SECRET = process.env.TURNSTILE_SECRET_KEY || '';
async function verifyTurnstile(token, ip) {
  if (!TURNSTILE_SECRET) return true;       // captcha off when no secret set
  if (!token) return false;
  try {
    const body = new URLSearchParams({ secret: TURNSTILE_SECRET, response: token });
    if (ip) body.append('remoteip', ip);
    const r = await axios.post(
      'https://challenges.cloudflare.com/turnstile/v0/siteverify',
      body.toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 8000, validateStatus: () => true }
    );
    if (!r.data?.success) console.warn('[turnstile] failed:', JSON.stringify(r.data?.['error-codes'] || r.data));
    return !!r.data?.success;
  } catch (e) {
    console.warn('[turnstile] verify error:', e.message);
    return false;
  }
}
function getTurnstileToken(req) {
  return req.body?.turnstileToken || req.body?.['cf-turnstile-response'] || '';
}
app.use('/api/receive-ticket',  tokenLimiter);
app.use('/api/poll-ticket',     pollLimiter);
app.use('/auth/discord',        rateLimit({ windowMs: 60_000, max: 20, standardHeaders: true, legacyHeaders: false }));

// Redirect legacy ".html" URLs to their clean equivalents (301) so the site
// only ever exposes extension-less paths like /login instead of /login.html.
// Must run before express.static, otherwise the .html file would be served directly.
const HTML_REDIRECTS = {
  'index.html':          '/',
  'login.html':          '/login',
  'locker.html':         '/locker',
  'oauth-callback.html': '/oauth-callback',
  'add.html':            '/add',
  'account.html':        '/account',
  'account-signup.html': '/account/signup',
  'account-login.html':  '/account/login',
  'account-forgot.html': '/account/forgot',
  'account-reset.html':  '/account/reset',
  'bulk.html':           '/bulk',
  'legal.html':          '/legal',
  'admin.html':          '/admin',
};
app.get(/\.html$/i, (req, res, next) => {
  const file = req.path.replace(/^.*\//, '').toLowerCase();
  const target = HTML_REDIRECTS[file] || ('/' + req.path.replace(/\.html$/i, '').replace(/^\/+/, ''));
  res.redirect(301, target);
});

// Desktop-checker .exe downloads are temporarily LOCKED until server-side DRM
// (critical-config-gated license) ships. The exe files still exist on disk (so
// deploys can push a new one), but every HTTP GET for one returns 503 so no new
// copies can be pulled from the web. Existing installs keep running their local
// exe — they'll hit /api/cli/version normally but the returned download URL
// will 503 (auto-update becomes a no-op). Set ALLOW_EXE_DOWNLOADS=1 to bypass.
app.get(/^\/downloads\/.*\.exe$/i, (req, res) => {
  if (process.env.ALLOW_EXE_DOWNLOADS === '1') return res.sendFile(path.join(__dirname, 'public', req.path));
  res.status(503).type('text/plain').send('Downloads temporarily disabled while we upgrade licensing. Come back soon.');
});

// Serve static files. Set short cache on JS/HTML so iterations land fast.
// Images + CSS get the default (long) cache.
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.js') || filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'public, max-age=60, must-revalidate');
    }
  },
}));

// ── Image proxy ───────────────────────────────────
// Fetches item images from Ubisoft CDN server-side to avoid CORS / auth issues.
// Frontend uses /api/img?url=<encoded-url> instead of the raw CDN URL.
const ALLOWED_IMG_HOSTS = [
  'ubiservices.cdn.ubi.com',
  'ubisoft-avatars.akamaized.net',
  'cdn.jsdelivr.net',
  'r6data.com',
  'staticctf.ubisoft.com',
  // New community image sources
  'siegeskins.com',           // primary host used by lib/skins_cache.json
  'siegeskins.dev',
  'cdn.siegeskins.dev',
  'r6.skin',
  'r6.guide',
  'raw.githubusercontent.com',
  'cdn.r6stats.com',
  'r6stats.com',
  // Tracker / stats sources
  'api.tracker.gg',
  'trackercdn.com',
  'r6tracker.com',
  'cdn.r6tracker.com',
  'stats.cc',
];
// Default placeholder served when an image fails — beats the broken-image icon.
const PLACEHOLDER_IMG = Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
    <rect width="64" height="64" fill="#1a2540" rx="6"/>
    <text x="32" y="40" font-family="system-ui,sans-serif" font-size="26"
          fill="#3a8dff" text-anchor="middle" font-weight="700">?</text>
  </svg>`, 'utf8');

// Cross-space MtxAssetsDeployer fallback IDs (try these if the primary URL 404s)
const MTX_SPACE_IDS = [
  '0d2ae42d-4c27-4cb7-af6c-2099062302bb',
  '5172a557-50b5-4665-b7db-e3f2e8c5041d',
  '631d8095-c443-4e21-b301-4af1a0929c27',
  '98a601e5-ca91-4440-b1c5-753f601a2c90',
];

async function fetchUpstreamImage(url) {
  return axios({
    method: 'get', url, responseType: 'arraybuffer', timeout: 8000,
    headers: {
      'User-Agent': BASE_HEADERS['User-Agent'],
      'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8',
      'Referer': 'https://www.ubisoft.com/',
      'Origin': 'https://www.ubisoft.com',
    },
    // SSRF defence — don't follow redirects. The whitelist check is only
    // against the URL we're given; a 302 to http://169.254.169.254/ (cloud
    // metadata) or any internal IP would otherwise be followed.
    maxRedirects: 0,
    validateStatus: s => s >= 200 && s < 300,
  });
}

app.get('/api/img', async (req, res) => {
  // Accept `?url=A` (primary) and `?fallback=B` (tried if primary fails).
  // Both must pass the host allowlist. Used by skinCheck.js to point at
  // the cleaner siegeskins.com asset first while keeping the original
  // Ubisoft CDN URL as a guaranteed fallback (the cache covers most
  // items but a handful of siegeskins URLs 404 — falling back gives a
  // real image instead of the placeholder SVG).
  const raw      = req.query.url;
  const fallback = req.query.fallback;
  if (!raw) return res.status(400).end();

  // Validate every URL we might fetch before doing anything else.
  function parseAndAllow(u) {
    try {
      const p = new URL(u);
      if (!ALLOWED_IMG_HOSTS.some(h => p.hostname === h)) return null;
      return p;
    } catch { return null; }
  }
  const primary = parseAndAllow(raw);
  if (!primary) return res.status(403).end();
  let fallbackParsed = null;
  if (fallback) {
    fallbackParsed = parseAndAllow(fallback);
    if (!fallbackParsed) return res.status(403).end();
  }

  // Avatars (small files, refresh hourly) get a short cache; everything else 7 days
  const isAvatar = primary.hostname === 'ubisoft-avatars.akamaized.net';
  const cacheControl = isAvatar
    ? 'public, max-age=3600'
    : 'public, max-age=604800';

  // Build candidate list. Try primary first; then MtxAssetsDeployer space
  // variants of primary; then fallback; then MtxAssetsDeployer variants of
  // fallback. Each URL is tried until one returns a real image.
  function expandMtx(url) {
    const out = [url];
    const m = url.match(/ubiservices\.cdn\.ubi\.com\/([0-9a-f-]+)\/MtxAssetsDeployer\/(.+)/);
    if (m) for (const space of MTX_SPACE_IDS) {
      if (space !== m[1]) out.push(`https://ubiservices.cdn.ubi.com/${space}/MtxAssetsDeployer/${m[2]}`);
    }
    return out;
  }
  const urlsToTry = expandMtx(raw);
  if (fallback) for (const u of expandMtx(fallback)) urlsToTry.push(u);

  for (const url of urlsToTry) {
    try {
      const upstream = await fetchUpstreamImage(url);
      const ct = upstream.headers['content-type'] ?? 'image/png';
      // Sanity: actual image bytes, not an HTML 404 page
      if (!ct.startsWith('image/') || !upstream.data || upstream.data.byteLength < 64) {
        continue;
      }
      res.setHeader('Content-Type', ct);
      res.setHeader('Cache-Control', cacheControl);
      return res.send(Buffer.from(upstream.data));
    } catch (e) {
      // Try next candidate
    }
  }

  // All upstreams failed — placeholder SVG with a SHORT cache so the browser
  // will retry soon (image may exist later, e.g. after a CDN refresh).
  console.warn('[img-proxy] all candidates failed:', raw, fallback ? '(+' + fallback + ')' : '');
  res.setHeader('Content-Type', 'image/svg+xml');
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.send(PLACEHOLDER_IMG);
});

// Pending tokens received from bookmarklet: pollId -> { ticket, sessionId, userId, username, expiresAt }
const pendingTokens = new Map();
// Background fetch results: pollId -> { status: 'loading'|'done'|'error', playerData?, error? }
const pendingResults = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [key, val] of pendingTokens.entries()) {
    if (val.expiresAt < now) pendingTokens.delete(key);
  }
  for (const [key, val] of pendingResults.entries()) {
    if (val.expiresAt < now) pendingResults.delete(key);
  }
}, 5 * 60 * 1000);

// Bookmarklet redirects here with token in query params (avoids CORS entirely)
app.get('/auth-callback', (req, res) => {
  const { ticket, username, sessionId, userId, pollId, appId } = req.query;
  if (ticket && pollId) {
    pendingTokens.set(pollId, {
      ticket,
      sessionId: sessionId || '',
      userId: userId || '',
      username: username || '',
      appId: appId || '',
      expiresAt: Date.now() + 10 * 60 * 1000,
    });
  }
  res.send(`<!DOCTYPE html><html><head><title>R6 Locker</title>
<style>body{background:#0d0d0d;color:#e8e8e8;font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;text-align:center}</style>
</head><body><div>
<h2 style="color:#e8a53a;margin-bottom:.5rem">Session captured!</h2>
<p style="color:#888">You can close this tab. R6 Locker will load automatically.</p>
</div></body></html>`);
});

// CORS preflight — bookmarklet runs on Ubisoft's domain and POSTs back here
app.options('/api/receive-ticket', (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.sendStatus(204);
});

// Option C: bookmarklet posts the captured token here
app.post('/api/receive-ticket', (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  const { ticket, sessionId, userId, username, pollId } = req.body ?? {};
  if (!ticket || !pollId) return res.status(400).json({ error: 'Missing ticket or pollId' });
  pendingTokens.set(pollId, {
    ticket,
    sessionId: sessionId || '',
    userId: userId || '',
    username: username || '',
    expiresAt: Date.now() + 10 * 60 * 1000,
  });
  res.json({ ok: true });
});

// Option C: frontend polls this until the bookmarklet fires
app.get('/api/poll-ticket/:pollId', async (req, res) => {
  const pollId = req.params.pollId;

  // Phase 2: background fetch already running or done
  const result = pendingResults.get(pollId);
  if (result) {
    if (result.status === 'loading') return res.json({ ready: false, status: 'loading' });
    if (result.status === 'error')   { pendingResults.delete(pollId); return res.status(500).json({ error: result.error }); }
    if (result.status === 'done')    { pendingResults.delete(pollId); return res.json({ ready: true, playerData: result.playerData }); }
  }

  // Phase 1: token not yet received
  const data = pendingTokens.get(pollId);
  if (!data) return res.json({ ready: false });
  if (data.expiresAt < Date.now()) { pendingTokens.delete(pollId); return res.json({ ready: false }); }

  // Token just arrived — kick off background fetch immediately
  pendingTokens.delete(pollId);
  pendingResults.set(pollId, { status: 'loading', expiresAt: Date.now() + 10 * 60 * 1000 });
  res.json({ ready: false, status: 'loading' }); // respond immediately

  // Resolve userId then fetch in background
  let { ticket, sessionId, username, appId } = data;
  let userId = data.userId;

  // Guard: if userId was captured as a JSON blob, extract the real UUID
  if (userId && userId.startsWith('{')) {
    try {
      const parsed = JSON.parse(userId);
      userId = parsed.user_id ?? parsed.userId ?? '';
      console.log('Extracted userId from JSON blob:', userId);
    } catch { userId = ''; }
  }

  (async () => {
    try {
      if (!userId && username) {
        const r = await ubiRequest({
          method: 'get',
          url: `https://public-ubiservices.ubi.com/v3/profiles?platformType=uplay&nameOnPlatform=${encodeURIComponent(username)}`,
          headers: { ...BASE_HEADERS, Authorization: `Ubi_v1 t=${ticket}`, 'Ubi-SessionId': sessionId },
        });
        userId = r.data?.profiles?.[0]?.userId;
      }
      if (!userId) {
        pendingResults.set(pollId, { status: 'error', error: 'Could not find your Ubisoft account. Check your username.', expiresAt: Date.now() + 5 * 60 * 1000 });
        return;
      }
      const playerData = await getPlayerData(userId, ticket, sessionId, appId || '', { forceRefresh: true, bulk: true });
      pendingResults.set(pollId, { status: 'done', playerData, expiresAt: Date.now() + 5 * 60 * 1000 });
    } catch (err) {
      console.error('Background fetch error:', err.message);
      if (err.response?.data) console.error('body:', JSON.stringify(err.response.data).slice(0, 400));
      const status = err.response?.status;
      const msg = err.response?.data?.message ?? err.response?.data?.errorCode ?? err.message;
      const error = status === 401
        ? 'Token is invalid or expired. Please try again.'
        : `Failed to fetch R6 data (HTTP ${status ?? 'network'}): ${msg}`;
      pendingResults.set(pollId, { status: 'error', error, expiresAt: Date.now() + 5 * 60 * 1000 });
    }
  })();
});

// Record a successful profile fetch in the checks DB.
// Attached to the Discord user (if logged in) so others can see who checked it.
function recordPlayerCheck(req, playerData) {
  if (!playerData) return;
  const me = discord.getCurrentUserSync(req);
  const currentSeason = playerData.seasonRanks?.[0];
  const itemsCount = playerData.sections?.reduce((sum, s) => {
    if (s.grouped) return sum + (s.items?.length || 0) + (s.groups?.reduce((a, g) => a + g.items.length, 0) || 0);
    return sum + (s.items?.length || 0);
  }, 0) || 0;
  db.recordCheck({
    userId:        playerData.userId,
    username:      playerData.username,
    avatar:        playerData.avatar,
    level:         playerData.level,
    currentRank:   currentSeason?.rankName,
    currentMmr:    currentSeason?.mmr,
    sectionsCount: playerData.sections?.length || 0,
    itemsCount,
    checkedBy:     me,
  });
  // Also record that THIS SITE USER (if signed in) checked this Ubisoft profile,
  // so the marketplace can gate sell-listings to "accounts you've checked here".
  try {
    if (req.siteUser && req.siteUser.id) {
      store.recordUserProfileCheck(req.siteUser.id, playerData.userId);
    }
  } catch (e) { console.warn('[mp] user check record failed:', e.message); }
}

// Option A: email + password login
//   ?quick=1 OR { quickOnly: true } in body
//     → ONLY try fast paths (memory/persistent/cookie). Skips Camoufox entirely.
//     → 202 + { needsFullLogin: true } if no fast path hits.
//     → Lets the client show a snappy result (~50ms) for cached users, then
//       upgrade to a slow Camoufox path with progress UI only if needed.
app.post('/api/login', async (req, res) => {
  const t0 = Date.now();
  const { email, password } = req.body ?? {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password required.' });
  const ip = req.headers['cf-connecting-ip'] || req.ip || '';
  if (!(await verifyTurnstile(getTurnstileToken(req), ip))) {
    return res.status(403).json({ error: 'Captcha check failed — complete the challenge and try again.' });
  }
  try {
    // Simple flow: POST credentials to the sessions endpoint through the
    // DataImpulse proxy, then fetch this player's inventory with the session.
    const session = await login(email, password);
    const tLogin = Date.now();
    const playerData = await getPlayerData(session.userId, session.ticket, session.sessionId, session.appId, { forceRefresh: true, bulk: true });
    const tData = Date.now();
    recordPlayerCheck(req, playerData);
    res.setHeader('X-Timing', `login=${tLogin - t0}ms data=${tData - tLogin}ms total=${tData - t0}ms`);
    console.log(`[/api/login] ${email} done in ${tData - t0}ms (login=${tLogin - t0}ms data=${tData - tLogin}ms)`);
    res.json({ playerData });
  } catch (err) {
    const status = err.response?.status || 500;
    console.error('[/api/login] error:', status, err.message);
    res.status(status).json({ error: err.message });
  }
});

// ── /api/save-session ────────────────────────────────────────────────────
// Receives a Ubisoft session pasted into the /add "Paste Ticket" tab
// ({ ticket, userId, sessionId }). We verify the ticket is legit (cheap
// GET /v3/users/me), then fetch player data and return it like /api/login.
//
// Rate-limited same as /api/login.
app.use('/api/save-session', loginLimiter);
app.post('/api/save-session', async (req, res) => {
  const { email, session } = req.body ?? {};
  if (!session?.ticket || !session?.userId) {
    return res.status(400).json({ error: 'session{ticket,userId} required.' });
  }
  if (!(await verifyTurnstile(getTurnstileToken(req), req.headers['cf-connecting-ip'] || req.ip || ''))) {
    return res.status(403).json({ error: 'Captcha check failed — complete the challenge and try again.' });
  }
  // Iframe flow doesn't expose the user's email — use the userId as the
  // session-store key when no email is provided. This is fine: the session
  // store hashes the key for the filename, and rm-refreshes work just as
  // well keyed by userId.
  const cacheKey = email || ('user:' + session.userId);
  const t0 = Date.now();
  try {
    // 1. Validate the ticket actually works (cheap authenticated GET).
    const ax = require('axios');
    const me = await ax.get('https://public-ubiservices.ubi.com/v3/users/me', {
      headers: {
        'Content-Type':  'application/json',
        'Ubi-AppId':     session.appId || '4391c956-8943-48eb-8859-07b0778f47b9',
        'User-Agent':    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0',
        'Authorization': `Ubi_v1 t=${session.ticket}`,
        ...(session.sessionId ? { 'Ubi-SessionId': session.sessionId } : {}),
      },
      timeout: 8000,
      validateStatus: () => true,
    });
    if (me.status !== 200 || !me.data?.userId) {
      console.warn(`[/api/save-session] ticket validation HTTP ${me.status}`);
      return res.status(401).json({ error: 'Submitted ticket is not valid.' });
    }
    // Ensure the userId from the ticket matches the one the client sent
    if (me.data.userId !== session.userId) {
      return res.status(400).json({ error: 'userId mismatch — refusing to save.' });
    }

    // 2. Cache in the in-memory pool so /api/refresh can reuse the session.
    require('./lib/loginPool').cacheSession(cacheKey, {
      ticket: session.ticket, sessionId: session.sessionId, userId: session.userId, appId: session.appId,
    });

    // 3. Fetch player data using the submitted ticket
    const tValid = Date.now();
    const playerData = await getPlayerData(session.userId, session.ticket, session.sessionId, session.appId, { forceRefresh: true, bulk: true });
    const tData = Date.now();
    recordPlayerCheck(req, playerData);
    res.setHeader('X-Timing', `validate=${tValid - t0}ms data=${tData - tValid}ms total=${tData - t0}ms`);
    console.log(`[/api/save-session] ${cacheKey} ok (validate=${tValid - t0}ms data=${tData - tValid}ms)${session.rememberMeTicket ? ' [+rm-ticket]' : ''}`);
    res.json({ ok: true, playerData });
  } catch (err) {
    const status = err.response?.status;
    console.error('[/api/save-session] error:', status, err.message);
    res.status(status ?? 500).json({ error: err.response?.data?.message ?? err.message });
  }
});

// ── Discord OAuth ─────────────────────────────────
app.get('/auth/discord', (req, res) => {
  if (!discord.isConfigured()) {
    return res.status(503).send('Discord OAuth is not configured on this server. Set DISCORD_CLIENT_ID + DISCORD_CLIENT_SECRET.');
  }
  const state = Math.random().toString(36).slice(2);
  // Stash an optional return_to path (e.g. "/marketplace/sell") in the state
  // cookie so the callback can bounce the user back where they came from.
  const rt = (req.query.return_to || '').toString();
  const safeReturn = /^\/[a-zA-Z0-9/_\-?=&%.+]*$/.test(rt) ? rt : '/';
  res.setHeader('Set-Cookie', [
    `r6locker_oauth_state=${state}; HttpOnly; SameSite=Lax; Path=/; Max-Age=600`,
    `r6locker_oauth_return=${encodeURIComponent(safeReturn)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=600`,
  ]);
  // Optional ?prompt=consent (used by /verify) so Discord always shows the
  // authorize screen instead of silently reusing prior consent — needed when
  // adding new scopes (e.g. email) or when the user has a stale site session.
  const opts = req.query.prompt === 'consent' ? { prompt: 'consent' } : {};
  res.redirect(302, discord.authorizeUrl(state, opts));
});

app.get('/auth/discord/callback', async (req, res) => {
  const { code, state } = req.query;
  // Verify state to prevent CSRF
  const cookieHeader = req.headers.cookie || '';
  const stateCookie  = (cookieHeader.match(/r6locker_oauth_state=([^;]+)/) || [])[1];
  if (!code || !state || state !== stateCookie) {
    return res.status(400).send('OAuth state mismatch or missing code. Try logging in again.');
  }
  try {
    const tokenData   = await discord.exchangeCode(code);
    const discordUser = await discord.fetchUser(tokenData.access_token);
    discord.startSession(res, discordUser, tokenData);
    // Persist the refresh token + email so the bot can RE-ADD this user to a
    // new server later (refresh access_token → guilds.join). Best-effort.
    try {
      verifyTokens.save({
        discordId:   discordUser.id,
        username:    discordUser.username || discordUser.global_name || null,
        email:       discordUser.email || null,
        refreshToken: tokenData.refresh_token,
        accessToken:  tokenData.access_token,
        expiresIn:    tokenData.expires_in,
        scope:        tokenData.scope,
      });
    } catch (e) { console.warn('[discord] verifyTokens.save failed:', e.message); }
    // Auto-join our Discord guild — uses guilds.join scope + bot token. No-op
    // if the user is already a member. Best-effort; logged but not fatal.
    let joined = null;
    try {
      const r = await discord.joinGuild(tokenData.access_token, discordUser.id);
      joined = r.ok ? (r.alreadyJoined ? 'already' : 'added') : null;
      if (!r.ok) console.warn('[discord] auto-join failed:', r.error);
      else console.log(`[discord] guild auto-join: ${joined} for ${discordUser.username || discordUser.id}`);
    } catch (e) { console.warn('[discord] joinGuild threw:', e.message); }
    // If a SITE session is active, ALSO attach this Discord identity to the
    // site user — that's how the marketplace knows who's linked.
    if (req.siteUser && req.siteUser.id) {
      store.linkUserDiscord(req.siteUser.id, {
        discordId: discordUser.id,
        discordUsername: discordUser.username || discordUser.global_name || null,
        // If they're already in (or we just added them), mark guild membership
        // fresh so we don't redundantly call the bot listener on the next action.
        inGuildAt: joined ? Date.now() : null,
      });
    }
    // Read the stashed return_to from the cookie (set by /auth/discord above).
    const cookies = req.headers.cookie || '';
    const rtMatch = cookies.match(/r6locker_oauth_return=([^;]+)/);
    const after = rtMatch ? decodeURIComponent(rtMatch[1]) : '/';
    // Clear both transient cookies.
    res.setHeader('Set-Cookie', [
      res.getHeader('Set-Cookie'),
      `r6locker_oauth_state=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`,
      `r6locker_oauth_return=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`,
    ].flat().filter(Boolean));
    res.redirect(302, /^\/[a-zA-Z0-9/_\-?=&%.+]*$/.test(after) ? after : '/');
  } catch (e) {
    console.error('[discord] callback error:', e.message);
    res.status(500).send('Discord login failed. Try again.');
  }
});

app.post('/auth/logout', async (req, res) => {
  await discord.endSession(req, res);
  res.json({ ok: true });
});

app.get('/api/me', async (req, res) => {
  const user = await discord.getCurrentUser(req);
  res.json({ user, oauthConfigured: discord.isConfigured() });
});

// ── Verification (Discord OAuth + anti-alt) ───────────────────────────────────
// Member clicks "Verify" in Discord → here. We OAuth them (identify), set a
// long-lived device cookie, and check whether that device/IP already verified a
// DIFFERENT Discord account. Clean → bot grants the Verified role; alt → blocked
// + staff alerted. IP matching is opt-in (VERIFY_IP_CHECK=true; device + cookie
// is always on).
const verifyLimiter = rateLimit({ windowMs: 60_000, max: 30, standardHeaders: true, legacyHeaders: false });
function vEsc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function vClientIp(req) { return String(req.headers['cf-connecting-ip'] || req.ip || (req.socket && req.socket.remoteAddress) || '').replace(/^::ffff:/, ''); }
function vDeviceCookie(req, res) {
  const m = (req.headers.cookie || '').match(/r6_device=([a-f0-9]{32})/);
  if (m) return m[1];
  const id = crypto.randomBytes(16).toString('hex');
  const prev = res.getHeader('Set-Cookie');
  res.setHeader('Set-Cookie', [].concat(prev || [], `r6_device=${id}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${5 * 365 * 86400}`).filter(Boolean));
  return id;
}
function verifyPage(status, opts = {}) {
  const u = opts.user || {};
  const accent = status === 'ok' ? '#34d399' : status === 'alt' ? '#f87171' : '#cad3dc';
  let body;
  if (status === 'ok') body = `<h1 style="color:#34d399">✓ You're verified</h1><p>Welcome, <b>${vEsc(u.username)}</b>. Your access role has been granted — head back to Discord.</p>`;
  else if (status === 'alt') body = `<h1 style="color:#f87171">⛔ Verification blocked</h1><p>This device or account looks like a <b>duplicate</b> (${vEsc(opts.reason || 'alt')}). Only one account per person is allowed.<br><br>If you believe this is a mistake, contact staff.</p>`;
  else if (status === 'pending') body = `<h1>⌛ Almost there</h1><p>You're recorded as verified, but the role couldn't be granted automatically${opts.err ? ` (${vEsc(opts.err)})` : ''}. Make sure you're in the server — staff can grant it manually.</p>`;
  else body = `<h1>Verification</h1><p>${vEsc(opts.msg || 'Something went wrong. Try again.')}</p>`;
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>R6Checker — Verify</title><link rel="icon" href="/img/logo.png">
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#080b14;color:#e7ecf6;font-family:'Inter',system-ui,-apple-system,sans-serif;padding:1.5rem}
.card{max-width:460px;width:100%;background:#111827;border:1px solid #1e2842;border-radius:16px;padding:2.2rem 1.9rem;text-align:center;box-shadow:0 24px 70px rgba(0,0,0,.55)}
h1{font-size:1.5rem;margin:.2rem 0 .9rem;letter-spacing:-.02em} p{color:#8593ad;line-height:1.6;font-size:.95rem;margin:0} b{color:#e7ecf6}
.dot{width:56px;height:56px;border-radius:15px;margin:0 auto 1.1rem;background:${accent}1f;border:1px solid ${accent}55;box-shadow:0 0 30px -6px ${accent}66}</style></head>
<body><div class="card"><div class="dot"></div>${body}<p style="margin-top:1.5rem;font-size:.78rem;opacity:.55">R6CHECKER.XYZ · Classroom of the Elite</p></div></body></html>`;
}

app.get('/verify', verifyLimiter, async (req, res) => {
  if (!discord.isConfigured()) return res.status(503).send(verifyPage('error', { msg: 'Verification is not configured on this server.' }));
  // Always force a fresh OAuth authorize screen on FIRST hit (no &did=token), so
  // the user sees the consent UI even with a stale site session AND we capture
  // their email/refresh_token. The callback bounces them back here with a flag.
  if (!req.query.fresh) return res.redirect(302, '/auth/discord?return_to=' + encodeURIComponent('/verify?fresh=1') + '&prompt=consent');
  const user = await discord.getCurrentUser(req);
  if (!user) return res.redirect(302, '/auth/discord?return_to=' + encodeURIComponent('/verify?fresh=1') + '&prompt=consent');

  const deviceId = vDeviceCookie(req, res);
  const ip = vClientIp(req);
  const ua = String(req.headers['user-agent'] || '').slice(0, 300);
  const ipCheck = process.env.VERIFY_IP_CHECK === 'true';
  // Comma-separated IPs / CIDRs that bypass the IP-match check (your own home/
  // office, known mobile-carrier ranges, etc). Lets you keep VERIFY_IP_CHECK on
  // without false-positiving trusted shared networks.
  const ipAllowlist = String(process.env.VERIFY_IP_ALLOWLIST || '').split(',').map(s => s.trim()).filter(Boolean);

  const alt = verifyStore.checkAlt(user.id, deviceId, ip, { ipCheck, ipAllowlist });
  // Soft-flag mode: ALERT staff but still grant the role. Lets the owner review
  // borderline cases (shared Wi-Fi, mobile carriers) without auto-blocking real
  // members. Strict (default) keeps the hard block.
  const softFlag = process.env.VERIFY_SOFT_FLAG === 'true';
  if (alt.isAlt) {
    botFetch('POST', '/verify/alt-alert', { discordId: user.id, username: user.username, reason: alt.reason, matchedDiscordId: alt.matchedDiscordId, matchedUsername: alt.matchedUsername, ip: ipCheck ? ip : undefined, softFlagged: softFlag }).catch(() => {});
    if (!softFlag) return res.status(403).send(verifyPage('alt', { user, reason: alt.reason }));
    // fall through: record + grant role like a normal verification.
  }

  verifyStore.record({ discordId: user.id, username: user.username, deviceId, ip, ua });
  let granted = false, err = null;
  try { const r = await botFetch('POST', '/verify/grant-role', { discordId: user.id }); granted = !!(r && r.ok); }
  catch (e) { err = e.message; console.warn('[verify] grant failed:', e.message); }
  return res.send(verifyPage(granted ? 'ok' : 'pending', { user, err }));
});

// Profile-check stats for the home page
app.get('/api/stats',  (_req, res) => res.json(db.stats()));
app.get('/api/recent', (req, res)  => {
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || '20', 10) || 20));
  res.json({ checks: db.recentChecks(limit) });
});
// Individual profile check info (used by locker page to render "checked by")
app.get('/api/check/:userId', (req, res) => {
  res.json({ check: db.getCheck(req.params.userId) });
});

// Manual refresh — invalidate caches for this profile so next render is fresh.
// Rate-limited so it can't be abused.
const refreshLimiter = rateLimit({
  windowMs: 60 * 1000, max: 6,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many refresh requests. Wait a minute.' },
});
app.post('/api/refresh/:userId', refreshLimiter, async (req, res) => {
  const userId = req.params.userId;
  if (!userId) return res.status(400).json({ error: 'userId required' });

  const pool = require('./lib/loginPool');
  // Bust in-memory player cache so next fetch hits upstream
  pool.invalidatePlayerData(userId);

  // Try to re-fetch using cached Ubisoft session — this gives the caller
  // fresh data WITHOUT requiring them to re-enter creds.
  const session = pool.getCachedSessionByUserId(userId);
  if (session?.ticket) {
    try {
      // This re-pulls and overwrites disk cache with fresh data
      const fresh = await getPlayerData(session.userId, session.ticket, session.sessionId, session.appId, { forceRefresh: true, bulk: true });
      return res.json({ ok: true, refreshed: true, hasData: !!fresh });
    } catch (e) {
      console.warn('[refresh] re-fetch failed:', e.message);
      // Fall through to soft-refresh below
    }
  }

  // No session cached → DON'T delete disk cache (would break the public profile page).
  // Just clear memory so a logged-in user re-fetching will pull fresh.
  res.json({ ok: true, refreshed: false, hint: 'log in to refresh with live data' });
});

// Option B: direct token + username paste
app.post('/api/use-token', async (req, res) => {
  let { ticket, username, sessionId, userId } = req.body ?? {};
  if (!ticket) return res.status(400).json({ error: 'Token required' });
  ticket = ticket.replace(/^ubi_?v1\s+t=/i, '').trim();

  try {
    if (!userId) {
      if (!username) return res.status(400).json({ error: 'Ubisoft username required' });
      const r = await ubiRequest({
        method: 'get',
        url: `https://public-ubiservices.ubi.com/v3/profiles?platformType=uplay&nameOnPlatform=${encodeURIComponent(username)}`,
        headers: { ...BASE_HEADERS, Authorization: `Ubi_v1 t=${ticket}`, 'Ubi-SessionId': sessionId || '' },
      });
      userId = r.data?.profiles?.[0]?.userId;
    }

    if (!userId) return res.status(400).json({ error: 'Username not found. Check your Ubisoft display name.' });

    const playerData = await getPlayerData(userId, ticket, sessionId || '', undefined, { forceRefresh: true, bulk: true });
    res.json({ playerData });
  } catch (err) {
    const status = err.response?.status;
    console.error('use-token error:', status, JSON.stringify(err.response?.data ?? err.message));
    if (status === 401) return res.status(401).json({ error: 'Token is invalid or expired.' });
    const msg = err.response?.data?.message ?? err.message;
    res.status(500).json({ error: `Error (${status ?? 'network'}): ${msg}` });
  }
});

// ── Live billing config (so the UI doesn't hardcode the price) ──────────
app.get('/api/config', (_req, res) => {
  res.json({
    priceCents:      bulkRunner.PRICE_CENTS,
    pricePerCheckUsd: bulkRunner.PRICE_PER_CHECK_USD,
    minDepositUsd:   MIN_DEPOSIT_USD,
    maxDepositUsd:   MAX_DEPOSIT_USD,
    maxAccounts:     bulkRunner.MAX_LINES,
    ownerMaxAccounts: bulkRunner.OWNER_MAX_LINES,
    billingEnabled:  BILLING_ENABLED,
    // Volume pricing tiers (sorted high→low min). The per-check price for a
    // job is the cents of the highest tier whose `min` the count meets.
    pricingTiers:    bulkRunner.PRICING_TIERS,
    // Marginal sub-cent brackets — server-proxy jobs are billed up front using
    // these (charge = sum over brackets). upTo:null = the top (unbounded) bracket.
    pricingBrackets: bulkRunner.PRICING_BRACKETS_PUBLIC,
  });
});

// ── Site auth (email + password, separate from Discord OAuth) ───────────
const siteAuthLimiter = rateLimit({
  windowMs: 60 * 1000, max: 5,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many auth attempts. Wait a minute.' },
});
// No captcha on site signup/login — the rate limiter (5/min/IP) is enough
// for an endpoint that only creates a credentialled session. The captcha is
// kept on the Ubisoft credential flow where DataDome bots are the real risk.
app.post('/api/auth/signup', siteAuthLimiter, async (req, res) => {
  try { await siteAuth.handleSignup(req, res, null, null); }
  catch (e) { console.error('[auth/signup]', e); res.status(500).json({ error: 'Internal error' }); }
});
app.post('/api/auth/login', siteAuthLimiter, async (req, res) => {
  try { await siteAuth.handleLogin(req, res, null, null); }
  catch (e) { console.error('[auth/login]', e); res.status(500).json({ error: 'Internal error' }); }
});
app.post('/api/auth/logout', (req, res) => siteAuth.handleLogout(req, res));
app.get ('/api/auth/me',     (req, res) => siteAuth.handleMe(req, res));

// Password reset — tighter rate limit on /forgot to prevent email-spam abuse
const forgotLimiter = rateLimit({
  windowMs: 60 * 1000, max: 3,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many requests. Try again in a minute.' },
});
app.post('/api/auth/forgot', forgotLimiter, async (req, res) => {
  try { await siteAuth.handleForgot(req, res); }
  catch (e) { console.error('[auth/forgot]', e); res.status(500).json({ error: 'Internal error' }); }
});
app.post('/api/auth/reset', siteAuthLimiter, async (req, res) => {
  try { await siteAuth.handleReset(req, res); }
  catch (e) { console.error('[auth/reset]', e); res.status(500).json({ error: 'Internal error' }); }
});
// Token-info endpoint for the reset page to check link validity before submit.
// Rate-limited as defense-in-depth — token entropy (32 random bytes hex) makes
// brute force infeasible anyway, but no reason to allow unlimited probes.
const resetInfoLimiter = rateLimit({
  windowMs: 60 * 1000, max: 30,
  standardHeaders: true, legacyHeaders: false,
});
app.get('/api/auth/reset-info', resetInfoLimiter, (req, res) => {
  const token = String(req.query.token || '');
  if (!/^[a-f0-9]{64}$/.test(token)) return res.json({ valid: false });
  const info = siteAuth.getResetTokenInfo(token);
  res.json(info || { valid: false });
});

// ── Deposits (NOWPayments) ──────────────────────────────────────────────
const depositLimiter = rateLimit({
  windowMs: 60 * 1000, max: 10,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many deposit requests.' },
});
app.post('/api/deposit', depositLimiter, siteAuth.requireUser, async (req, res) => {
  if (!BILLING_ENABLED) return res.status(503).json({ error: 'Billing disabled.' });
  // Provider: 'crypto' (NOWPayments, default) or 'card' (Whop). UI in phase 2c
  // sends the selector; until then, crypto remains the silent default.
  const provider = req.body?.provider === 'card' ? 'card' : 'crypto';
  const pay = provider === 'card' ? whop : nowpayments;
  if (!pay.isConfigured()) return res.status(503).json({ error: `Payment provider (${provider}) not configured.` });
  const amountUsd = Number(req.body?.amountUsd);
  if (!Number.isFinite(amountUsd) || amountUsd < MIN_DEPOSIT_USD || amountUsd > MAX_DEPOSIT_USD) {
    return res.status(400).json({ error: `Amount must be between $${MIN_DEPOSIT_USD} and $${MAX_DEPOSIT_USD}.` });
  }
  try {
    const { invoiceUrl, invoiceId } = await pay.createInvoice(req.siteUser.id, Math.round(amountUsd));
    res.json({ invoiceUrl, invoiceId, provider });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});
app.get('/api/deposit/history', siteAuth.requireUser, (req, res) => {
  res.json({ deposits: store.listDeposits(req.siteUser.id, 50) });
});
app.get('/api/transactions', siteAuth.requireUser, (req, res) => {
  res.json({ transactions: store.listTransactions(req.siteUser.id, 50) });
});

// ── BYO-proxy: user proxies + time-based subscription ──────────────────────
app.use('/api/proxies',      noStore);
app.use('/api/subscription', noStore);

// Get saved proxies + subscription status + available plans.
app.get('/api/proxies', siteAuth.requireUser, (req, res) => {
  res.json({
    proxies: store.getUserProxies(req.siteUser.id),
    subscription: store.subscriptionStatus(req.siteUser.id),
    plans: store.SUBSCRIPTION_PLANS,
  });
});
// Save proxies (newline-separated). Accepts host:port[:user:pass] or URLs.
app.post('/api/proxies', express.json({ limit: '1mb' }), siteAuth.requireUser, (req, res) => {
  const text = typeof req.body?.proxies === 'string' ? req.body.proxies
             : Array.isArray(req.body?.proxies) ? req.body.proxies.join('\n') : '';
  const count = store.setUserProxies(req.siteUser.id, text);
  res.json({ ok: true, count });
});
// Subscription status only.
app.get('/api/subscription', siteAuth.requireUser, (req, res) => {
  res.json({ subscription: store.subscriptionStatus(req.siteUser.id), plans: store.SUBSCRIPTION_PLANS });
});
// Buy a plan (daily/weekly/monthly) → returns hosted checkout URL. Provider:
// 'crypto' (NOWPayments, default) or 'card' (Whop). Same selector as /api/deposit.
app.post('/api/subscription/buy', depositLimiter, express.json(), siteAuth.requireUser, async (req, res) => {
  const provider = req.body?.provider === 'card' ? 'card' : 'crypto';
  const pay = provider === 'card' ? whop : nowpayments;
  if (!pay.isConfigured()) return res.status(503).json({ error: `Payment provider (${provider}) not configured.` });
  const plan = String(req.body?.plan || '');
  if (!store.getPlan(plan)) return res.status(400).json({ error: 'Unknown plan.' });
  try {
    const { invoiceUrl, invoiceId } = await pay.createSubscriptionInvoice(req.siteUser.id, plan);
    res.json({ invoiceUrl, invoiceId, provider });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// ── Bulk checker ────────────────────────────────────────────────────────
const bulkLimiter = rateLimit({
  windowMs: 60 * 1000, max: 4,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many bulk jobs queued. Wait a minute.' },
});
// Stream-parse a raw request body into the accounts array line-by-line, so a
// big upload never buffers as one giant string (only the parsed array lives in
// RAM, which the job needs anyway). Dedups by email; stops one past the cap so
// startJob returns a proper 400 on overflow.
function parseAccountsStream(req, maxLines) {
  return new Promise((resolve, reject) => {
    const rl = require('readline').createInterface({ input: req, crlfDelay: Infinity });
    const seen = new Set(); const out = []; let over = false;
    rl.on('line', (raw) => {
      if (over) return;
      const line = String(raw).trim();
      if (!line || line[0] === '#') return;
      const colon = line.indexOf(':');
      if (colon < 1 || colon === line.length - 1) return;
      const email = line.slice(0, colon).trim(); const password = line.slice(colon + 1);
      if (!email || !password) return;
      const key = email.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ email, password, raw: `${email}:${password}` });
      if (out.length > maxLines) { over = true; rl.close(); }
    });
    rl.on('close', () => resolve(out));
    rl.on('error', reject);
    req.on('error', reject);
  });
}

// ── Chunked upload (gets big files past Cloudflare's ~100MB body cap) ────────
// The browser slices the file into <100MB chunks and POSTs each here; we append
// them to one .part file per (user, uploadId). /api/bulk/start then references
// the uploadId, stream-parses the assembled file, and deletes it.
const BULK_UPLOAD_DIR = path.join(CACHE_DIR, 'bulk-uploads');
const BULK_UPLOAD_MAX = 450 * 1024 * 1024;   // assembled cap per upload
function uploadPartPath(userId, id) {
  const safe = String(id || '').replace(/[^a-z0-9]/gi, '').slice(0, 48);
  return safe ? path.join(BULK_UPLOAD_DIR, `${userId}_${safe}.part`) : null;
}
// Best-effort sweep of abandoned uploads (start never called) older than 2h.
function sweepBulkUploads() {
  try {
    for (const f of fs.readdirSync(BULK_UPLOAD_DIR)) {
      const p = path.join(BULK_UPLOAD_DIR, f);
      try { if (Date.now() - fs.statSync(p).mtimeMs > 2 * 3600e3) fs.unlinkSync(p); } catch {}
    }
  } catch {}
}
try { fs.mkdirSync(BULK_UPLOAD_DIR, { recursive: true }); } catch {}
setInterval(sweepBulkUploads, 30 * 60e3).unref?.();

app.post('/api/bulk/upload-chunk', siteAuth.requireUser, (req, res) => {
  const file = uploadPartPath(req.siteUser.id, req.query.id);
  if (!file) return res.status(400).json({ error: 'bad upload id' });
  try { fs.mkdirSync(BULK_UPLOAD_DIR, { recursive: true }); } catch {}
  if (String(req.query.seq || '') === '0') { try { fs.unlinkSync(file); } catch {} }  // fresh on first chunk
  let existing = 0; try { existing = fs.statSync(file).size; } catch {}
  if (existing > BULK_UPLOAD_MAX) { req.destroy(); return res.status(413).json({ error: 'Upload exceeds 400MB.' }); }
  const ws = fs.createWriteStream(file, { flags: 'a' });
  let done = false;
  req.on('error', () => { done = true; ws.destroy(); });
  ws.on('error', (e) => { if (!done) { done = true; res.status(500).json({ error: e.message }); } });
  ws.on('finish', () => { if (!done) { done = true; res.json({ ok: true }); } });
  req.pipe(ws);
});

app.post('/api/bulk/start', bulkLimiter, siteAuth.requireUser, async (req, res) => {
  // Streamed file uploads arrive as raw text/plain; pastes arrive as JSON.
  // byoProxy rides the query string for the streamed path.
  const isText = String(req.headers['content-type'] || '').includes('text/plain');
  const byoProxy = isText ? (String(req.query.byo || '') === '1') : !!req.body?.byoProxy;
  // BYO-proxy jobs are paid via time-based subscription, not per-check balance,
  // so they don't require BILLING_ENABLED. Normal (server-proxy) jobs do.
  if (!byoProxy && !BILLING_ENABLED) return res.status(503).json({ error: 'Billing disabled.' });
  const limit = bulkRunner.maxLinesFor(req.siteUser); // owners get the bigger cap
  const uploadId = (!isText && req.body && req.body.uploadId) ? req.body.uploadId : null;
  let parsed;
  try {
    if (uploadId) {
      // Reassembled chunked upload — stream-parse the .part file, then delete it.
      const file = uploadPartPath(req.siteUser.id, uploadId);
      if (!file || !fs.existsSync(file)) return res.status(400).json({ error: 'Upload not found — please re-upload the file.' });
      parsed = await parseAccountsStream(fs.createReadStream(file), limit);
      fs.unlink(file, () => {});
    } else if (isText) {
      parsed = await parseAccountsStream(req, limit);
    } else {
      parsed = bulkRunner.parseAccounts(req.body?.input ?? req.body?.accounts ?? '', limit);
    }
  } catch (e) {
    return res.status(400).json({ error: 'Upload failed: ' + e.message });
  }
  if (!parsed.length) return res.status(400).json({ error: 'No valid email:password lines found.' });
  try {
    const job = bulkRunner.startJob(req.siteUser.id, parsed, { byoProxy });
    res.json({ jobId: job.id, total: job.total, byoProxy, priceCents: byoProxy ? 0 : bulkRunner.PRICE_CENTS });
  } catch (e) {
    const out = { error: e.message };
    if (e.needed_cents != null) { out.needed_cents = e.needed_cents; out.have_cents = e.have_cents; }
    res.status(e.status || 500).json(out);
  }
});
app.get('/api/bulk/jobs', siteAuth.requireUser, (req, res) => {
  res.json({ jobs: store.listJobs(req.siteUser.id, 20) });
});
app.get('/api/bulk/:jobId', siteAuth.requireUser, (req, res) => {
  const job = store.getJob(req.params.jobId);
  if (!job || job.user_id !== req.siteUser.id) return res.status(404).json({ error: 'Job not found.' });
  const status = bulkRunner.getStatus(req.params.jobId);
  res.json(status);
});
app.post('/api/bulk/:jobId/cancel', siteAuth.requireUser, (req, res) => {
  const job = store.getJob(req.params.jobId);
  if (!job || job.user_id !== req.siteUser.id) return res.status(404).json({ error: 'Job not found.' });
  bulkRunner.cancelJob(req.params.jobId);
  res.json({ ok: true });
});
// Resume: start a NEW job for the accounts that were never checked in this one.
app.post('/api/bulk/:jobId/resume', bulkLimiter, siteAuth.requireUser, async (req, res) => {
  if (!BILLING_ENABLED) return res.status(503).json({ error: 'Billing disabled.' });
  const job = store.getJob(req.params.jobId);
  if (!job || job.user_id !== req.siteUser.id) return res.status(404).json({ error: 'Job not found.' });
  if (job.status === 'running') return res.status(409).json({ error: 'Job still running.' });
  if (!bulkRunner.hasInput(job.id)) {
    return res.status(404).json({ error: 'Original input not stored for this job — cannot resume (run a new job to enable this).' });
  }
  try {
    const { accounts } = await bulkRunner.computeUnchecked(job.id);
    if (!accounts.length) return res.status(400).json({ error: 'Nothing to resume — every account was already checked.' });
    const newJob = bulkRunner.startJob(req.siteUser.id, accounts);
    res.json({ jobId: newJob.id, total: newJob.total, priceCents: bulkRunner.PRICE_CENTS, resumedFrom: job.id });
  } catch (e) {
    const out = { error: e.message };
    if (e.needed_cents != null) { out.needed_cents = e.needed_cents; out.have_cents = e.have_cents; }
    res.status(e.status || 500).json(out);
  }
});
app.get('/api/bulk/:jobId/download', siteAuth.requireUser, async (req, res) => {
  const job = store.getJob(req.params.jobId);
  if (!job || job.user_id !== req.siteUser.id) return res.status(404).end();
  if (job.status === 'running')     return res.status(409).json({ error: 'Job still running.', done: job.done, total: job.total });

  // type=unchecked → accounts in the original input that were never checked
  // (computed server-side from the stored input, so no re-upload needed).
  if (req.query.type === 'unchecked') {
    if (!bulkRunner.hasInput(job.id)) {
      return res.status(404).json({ error: 'Original input not stored for this job (run a new job to enable this).' });
    }
    try {
      const { accounts } = await bulkRunner.computeUnchecked(job.id);
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="bulk-${job.id}-unchecked.txt"`);
      res.end(accounts.map(a => a.raw).join('\n') + (accounts.length ? '\n' : ''));
    } catch (e) {
      console.error('[bulk/download unchecked]', e.message);
      if (!res.headersSent) res.status(500).json({ error: 'Failed to build unchecked list.' });
    }
    return;
  }

  if (!job.results_path || !fs.existsSync(job.results_path)) {
    return res.status(404).json({ error: 'Results expired or not available.' });
  }
  // ?type=all (default) | valid (logins that worked) | invalid (wrong password)
  //      | vwi (valid accounts with a wanted item OR a Plat–Champ rank)
  const type = ['valid', 'invalid', 'vwi', 'banned'].includes(req.query.type) ? req.query.type : 'all';
  const suffix = type === 'all' ? '' : `-${type}`;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="bulk-${job.id}${suffix}.txt"`);
  // Stream-decrypt + line-filter so a 1M-line (~200MB) result file downloads
  // without buffering the whole thing in server memory.
  fmt.decryptFileToStream(job.results_path, res, { filter: type }).catch((e) => {
    console.error('[bulk/download]', e.message);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to decrypt results.' });
    else res.end();
  });
});

// ── Desktop CLI checker API (key-authenticated) ────────────────────────────
// The .exe authenticates with a license key (emailed on purchase) instead of a
// cookie session. The key only works while the user's BYO-proxy access pass is
// active. All CLI jobs run in BYO-proxy mode (the user's own proxies, free).
app.use('/api/cli', noStore);
function requireKey(req, res, next) {
  const hdr = req.get('authorization') || '';
  const key = (req.get('x-api-key') || hdr.replace(/^(Key|Bearer)\s+/i, '')).trim();
  if (!key) return res.status(401).json({ error: 'Missing license key.' });
  const user = store.getUserByCliKey(key);
  if (!user) return res.status(403).json({ error: 'Invalid license key.' });
  if (!siteAuth.isOwner(user) && !store.isSubscriptionActive(user.id)) {
    const s = store.subscriptionStatus(user.id);
    return res.status(402).json({ error: 'Your access pass has expired. Renew it on the website.', expiresAt: s.expiresAt });
  }
  // HWID lock — bind the key to the first device that uses it; reject others.
  const hwid = (req.get('x-hwid') || '').trim().slice(0, 128);
  if (!hwid) return res.status(400).json({ error: 'Missing device id.' });
  if (!user.hwid) store.setUserHwid(user.id, hwid);
  else if (user.hwid !== hwid) {
    return res.status(423).json({ error: 'This key is locked to another device. Ask support to reset it.' });
  }
  req.cliUser = user;
  next();
}
const cliBulkLimiter = rateLimit({ windowMs: 60 * 1000, max: 6, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many jobs — wait a minute.' } });

// Log in with the WEBSITE account (email + password) → returns the license key
// if the access pass is active. Binds/checks the device. The exe then uses the
// returned key for subsequent calls (same as pasting a key).
app.post('/api/cli/login', siteAuthLimiter, express.json(), (req, res) => {
  const email = String(req.body?.email || '').trim();
  const password = String(req.body?.password || '');
  const hwid = (req.get('x-hwid') || '').trim().slice(0, 128);
  if (!email || !password) return res.status(400).json({ error: 'Email and password required.' });
  if (!hwid) return res.status(400).json({ error: 'Missing device id.' });
  const user = store.getUserByEmail(email);
  if (!user || !siteAuth.verifyPassword(password, user.password_hash)) {
    return res.status(403).json({ error: 'Invalid email or password.' });
  }
  if (!siteAuth.isOwner(user) && !store.isSubscriptionActive(user.id)) {
    const s = store.subscriptionStatus(user.id);
    return res.status(402).json({ error: 'No active access pass — buy one on the website to use the checker.', expiresAt: s.expiresAt });
  }
  if (!user.hwid) store.setUserHwid(user.id, hwid);
  else if (user.hwid !== hwid) return res.status(423).json({ error: 'Your account is locked to another device. Ask support to reset it.' });
  const key = store.getOrCreateCliKey(user.id);
  const s = store.subscriptionStatus(user.id);
  const owner = siteAuth.isOwner(user);
  res.json({ ok: true, key, email: user.email, owner, active: owner || s.active, expiresAt: s.expiresAt, msLeft: s.msLeft, proxies: store.getUserProxies(user.id).length });
});

// Browser-assisted desktop activation. The exe opens this URL in the user's
// normal browser, so the existing website session cookie proves the email.
// The CLI key is redirected only to a loopback callback owned by the exe.
app.get('/api/cli/activate', siteAuthLimiter, (req, res) => {
  if (!req.siteUser) return res.redirect(302, desktopActivation.buildActivationLoginRedirect(req.originalUrl));
  const result = desktopActivation.createDesktopActivation({
    user: req.siteUser,
    hwid: req.query.hwid,
    callback: req.query.callback,
    store,
    siteAuth,
  });
  if (result.status === 302) return res.redirect(result.location);
  return res.status(result.status).json(result.body);
});

// Validate key + show account/access info.
app.get('/api/cli/me', requireKey, (req, res) => {
  const s = store.subscriptionStatus(req.cliUser.id);
  const owner = siteAuth.isOwner(req.cliUser);
  res.json({ email: req.cliUser.email, owner, active: owner || s.active, expiresAt: s.expiresAt, msLeft: s.msLeft, proxies: store.getUserProxies(req.cliUser.id).length });
});

app.get('/api/cli/version', (req, res) => {
  // Brand-aware so each desktop build auto-updates to ITS OWN exe (the lite
  // "Ubisoft VM" must not pull the full R6Checker, and vice-versa). The exe
  // sends ?brand=<id>; unknown/absent → R6Checker for backward compatibility.
  const EXES = { r6checker: 'R6Checker.exe', ubivm: 'UbisoftVM.exe' };
  const brand = String(req.query.brand || 'r6checker').toLowerCase();
  const file = EXES[brand] || EXES.r6checker;
  const version = process.env.CLI_VERSION || '2.0.2';
  res.json({
    version,
    latest: version,
    url: '/downloads/' + file,
    mandatory: true,
  });
});

// Save the user's proxies (newline-separated or array).
app.post('/api/cli/proxies', express.json({ limit: '2mb' }), requireKey, (req, res) => {
  const text = typeof req.body?.proxies === 'string' ? req.body.proxies
             : Array.isArray(req.body?.proxies) ? req.body.proxies.join('\n') : '';
  const count = store.setUserProxies(req.cliUser.id, text);
  res.json({ ok: true, count });
});
// Start a BYO-proxy bulk job (free; needs active pass + saved proxies).
app.post('/api/cli/bulk/start', cliBulkLimiter, express.json({ limit: process.env.MAX_BODY || '768mb' }), requireKey, (req, res) => {
  const raw = req.body?.accounts ?? req.body?.input ?? '';
  const parsed = bulkRunner.parseAccounts(raw, bulkRunner.maxLinesFor(req.cliUser));
  if (!parsed.length) return res.status(400).json({ error: 'No valid email:password lines found.' });
  try {
    const job = bulkRunner.startJob(req.cliUser.id, parsed, { byoProxy: true });
    res.json({ jobId: job.id, total: job.total });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});
// Upload a LOCALLY-computed result set (desktop checker) → store it as a normal
// downloadable bulk job owned by this user, so finished/stopped local runs show
// up in their website Bulk Jobs for easy download. Body is the plaintext
// results.txt streamed as text/plain (the global json parser ignores it).
app.post('/api/cli/bulk/upload', cliBulkLimiter, requireKey, async (req, res) => {
  try {
    const r = await bulkRunner.ingestUpload(req.cliUser.id, req, { stopped: String(req.query.stopped || '') === '1' });
    res.json({ ok: true, jobId: r.jobId, total: r.total, url: `${process.env.SITE_URL || 'https://r6checker.xyz'}/bulk` });
  } catch (e) {
    console.error('[cli/bulk/upload]', e.message);
    if (!res.headersSent) res.status(500).json({ error: 'Upload failed: ' + e.message });
  }
});
// Poll job status.
app.get('/api/cli/bulk/:jobId', requireKey, (req, res) => {
  const job = store.getJob(req.params.jobId);
  if (!job || job.user_id !== req.cliUser.id) return res.status(404).json({ error: 'Job not found.' });
  res.json(bulkRunner.getStatus(req.params.jobId));
});
// Download results (type: all | valid | invalid | vwi).
app.get('/api/cli/bulk/:jobId/download', requireKey, (req, res) => {
  const job = store.getJob(req.params.jobId);
  if (!job || job.user_id !== req.cliUser.id) return res.status(404).json({ error: 'Job not found.' });
  if (!job.results_path || !fs.existsSync(job.results_path)) return res.status(404).json({ error: 'Results expired or not available.' });
  const type = ['valid', 'invalid', 'vwi', 'banned'].includes(req.query.type) ? req.query.type : 'all';
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  fmt.decryptFileToStream(job.results_path, res, { filter: type }).catch((e) => {
    console.error('[cli/download]', e.message);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to decrypt results.' });
    else res.end();
  });
});
// Stop (cancel) a running job.
app.post('/api/cli/bulk/:jobId/cancel', requireKey, (req, res) => {
  const job = store.getJob(req.params.jobId);
  if (!job || job.user_id !== req.cliUser.id) return res.status(404).json({ error: 'Job not found.' });
  bulkRunner.cancelJob(req.params.jobId);
  res.json({ ok: true });
});
// Resume — start a NEW job for the accounts not yet checked in :jobId.
app.post('/api/cli/bulk/:jobId/resume', cliBulkLimiter, requireKey, async (req, res) => {
  const job = store.getJob(req.params.jobId);
  if (!job || job.user_id !== req.cliUser.id) return res.status(404).json({ error: 'Job not found.' });
  try {
    const { accounts } = await bulkRunner.computeUnchecked(req.params.jobId);
    if (!accounts.length) return res.status(400).json({ error: 'Nothing left to check.' });
    const newJob = bulkRunner.startJob(req.cliUser.id, accounts, { byoProxy: true });
    res.json({ jobId: newJob.id, total: newJob.total });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// Public profile page — works on any device, no login needed
// Pretty routes for the static pages (so /login works, not just /login.html)
app.get('/login', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/locker', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'locker.html')));
app.get('/oauth-callback', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'oauth-callback.html')));
app.get('/add',            (_req, res) => res.sendFile(path.join(__dirname, 'public', 'add.html')));
app.get('/account/signup', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'account-signup.html')));
app.get('/account/login',  (_req, res) => res.sendFile(path.join(__dirname, 'public', 'account-login.html')));
app.get('/account/forgot', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'account-forgot.html')));
app.get('/account/reset',  (_req, res) => res.sendFile(path.join(__dirname, 'public', 'account-reset.html')));
app.get('/account',        (_req, res) => res.sendFile(path.join(__dirname, 'public', 'account.html')));
app.get('/bulk',           (_req, res) => res.sendFile(path.join(__dirname, 'public', 'bulk.html')));
app.get('/download',       (_req, res) => res.sendFile(path.join(__dirname, 'public', 'download.html')));
app.get('/marketplace',         (_req, res) => res.sendFile(path.join(__dirname, 'public', 'marketplace.html')));
app.get('/marketplace/sell',    (_req, res) => res.sendFile(path.join(__dirname, 'public', 'marketplace-sell.html')));
app.get('/marketplace/mine',    (_req, res) => res.sendFile(path.join(__dirname, 'public', 'marketplace-mine.html')));
app.get('/legal',          (_req, res) => res.sendFile(path.join(__dirname, 'public', 'legal.html')));
// Owner-only analytics dashboard. Page + API both gated to OWNER_EMAILS.
app.get('/admin', noStore, siteAuth.requireOwner, (_req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
// ── Marketplace ──────────────────────────────────────────────────────────
// Public listings + sell/buy flows. Buying creates a private Discord channel
// (via the bot's localhost HTTP listener) where the buyer and seller settle
// the trade — the site itself never handles money.
const MP_BOT_URL = process.env.MP_BOT_URL || 'http://127.0.0.1:4242';
const MP_BOT_TOKEN = process.env.BOT_INBOUND_TOKEN || '';

async function botFetch(method, path, body) {
  const url = MP_BOT_URL.replace(/\/+$/, '') + path;
  const resp = await fetch(url, {
    method, headers: { 'x-bot-inbound-token': MP_BOT_TOKEN, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await resp.text();
  let data; try { data = text ? JSON.parse(text) : {}; } catch { data = { error: text }; }
  if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
  return data;
}

// Resolve a profile (name, avatar, rank) from disk cache for showing in listings.
function profileSummary(profileUserId) {
  try {
    const p = path.join(CACHE_DIR, `${profileUserId}.json`);
    if (!fs.existsSync(p)) return null;
    const { data } = JSON.parse(fs.readFileSync(p, 'utf8'));
    const s = data.seasonRanks?.[0];
    return {
      userId: data.userId, username: data.username, avatar: data.avatar, level: data.level,
      banned: data.banned, banReason: data.banReason,
      currentRank: s?.rankName, currentTier: s?.rankTier,
      items: data.sections?.reduce((a, sec) => a + (sec.items?.length || 0) + (sec.groups?.reduce((b, g) => b + (g.items?.length || 0), 0) || 0), 0) || 0,
      profileUrl: `/profile/${data.userId}`,
    };
  } catch { return null; }
}

// LIST active listings (public — no auth needed to browse).
app.get('/api/mp', noStore, (req, res) => {
  const wantTrust = req.query.trust;   // '1' = trusted-only, '0' = untrusted-only, else all
  const wantAccess = req.query.access;  // 'fa' | 'nfa'
  const max = Number(req.query.max) || null;
  let rows = store.listActiveListings();
  if (wantTrust === '1') rows = rows.filter(r => r.seller_trusted);
  else if (wantTrust === '0') rows = rows.filter(r => !r.seller_trusted);
  if (wantAccess === 'fa' || wantAccess === 'nfa') rows = rows.filter(r => r.access_type === wantAccess);
  if (max) rows = rows.filter(r => r.price_cents <= max);
  res.json({
    listings: rows.map(r => ({
      id: r.id, accessType: r.access_type, priceCents: r.price_cents,
      title: r.title, description: r.description, createdAt: r.created_at,
      seller: {
        id: r.seller_id,
        discordId: r.seller_discord_id,
        discordUsername: r.seller_discord_username,
        trusted: !!r.seller_trusted,
      },
      profile: profileSummary(r.profile_user_id),
    })),
  });
});

// Accounts the current site user has checked here — for the sell-listing dropdown.
app.get('/api/mp/my-accounts', noStore, siteAuth.requireUser, (req, res) => {
  const rows = store.listUserChecks(req.siteUser.id);
  res.json({
    accounts: rows.map(r => ({
      profileUserId: r.profile_user_id,
      lastCheckedAt: r.last_checked_at,
      profile: profileSummary(r.profile_user_id),
    })).filter(a => a.profile),   // drop entries whose cache was pruned
  });
});

// My listings + my purchases.
app.get('/api/mp/my', noStore, siteAuth.requireUser, (req, res) => {
  const listings = store.listMyListings(req.siteUser.id).map(l => ({
    id: l.id, profileUserId: l.profile_user_id, accessType: l.access_type, priceCents: l.price_cents,
    status: l.status, createdAt: l.created_at, soldAt: l.sold_at, channelId: l.discord_channel_id,
    profile: profileSummary(l.profile_user_id),
  }));
  res.json({ listings, user: { trusted: !!req.siteUser.is_trusted, discordLinked: !!req.siteUser.discord_id } });
});

// Create a listing. Requires: signed in + Discord linked + in the guild + has
// actually checked this Ubisoft account on the site.
app.post('/api/mp', express.json(), siteAuth.requireUser, async (req, res) => {
  const u = req.siteUser;
  if (!u.discord_id) return res.status(403).json({ error: 'Link your Discord account first.' });
  // Verify guild membership (cached for 15 min).
  const guildOk = u.discord_in_guild_at && (Date.now() - u.discord_in_guild_at < 15 * 60 * 1000);
  if (!guildOk) {
    try {
      const r = await botFetch('GET', `/mp/in-guild/${u.discord_id}`);
      if (!r.inGuild) return res.status(403).json({ error: 'You must be in our Discord server to list.' });
      store.linkUserDiscord(u.id, { discordId: u.discord_id, discordUsername: u.discord_username, inGuildAt: Date.now() });
    } catch (e) {
      return res.status(503).json({ error: 'Could not verify guild membership: ' + e.message });
    }
  }
  const { profileUserId, accessType, priceCents, title, description } = req.body || {};
  if (!profileUserId || !/^[0-9a-f-]{36}$/i.test(profileUserId)) return res.status(400).json({ error: 'Invalid profile id.' });
  if (!['fa', 'nfa'].includes(accessType))                       return res.status(400).json({ error: 'accessType must be "fa" or "nfa".' });
  const cents = Math.max(1, Math.floor(Number(priceCents) || 0));
  if (cents < 100 || cents > 1_000_000)                           return res.status(400).json({ error: 'Price out of range ($1–$10,000).' });
  if (!store.userHasCheckedProfile(u.id, profileUserId))         return res.status(403).json({ error: "You haven't checked this account through r6checker — can't list it." });
  const id = store.createListing({
    sellerUserId: u.id, profileUserId, accessType, priceCents: cents,
    title: (title || '').slice(0, 120), description: (description || '').slice(0, 1000),
  });
  res.json({ ok: true, id });
});

// Cancel my own listing.
app.post('/api/mp/:id/cancel', siteAuth.requireUser, (req, res) => {
  const id = Number(req.params.id);
  const changed = store.cancelListing(id, req.siteUser.id);
  if (!changed) return res.status(404).json({ error: 'Listing not found or not yours.' });
  res.json({ ok: true });
});

// Buy a listing — creates the private Discord channel.
app.post('/api/mp/:id/buy', siteAuth.requireUser, async (req, res) => {
  const u = req.siteUser;
  if (!u.discord_id) return res.status(403).json({ error: 'Link your Discord account first.' });
  const guildOk = u.discord_in_guild_at && (Date.now() - u.discord_in_guild_at < 15 * 60 * 1000);
  if (!guildOk) {
    try {
      const r = await botFetch('GET', `/mp/in-guild/${u.discord_id}`);
      if (!r.inGuild) return res.status(403).json({ error: 'You must be in our Discord server to buy.' });
      store.linkUserDiscord(u.id, { discordId: u.discord_id, discordUsername: u.discord_username, inGuildAt: Date.now() });
    } catch (e) {
      return res.status(503).json({ error: 'Guild check failed: ' + e.message });
    }
  }
  const id = Number(req.params.id);
  const listing = store.getListing(id);
  if (!listing || listing.status !== 'active') return res.status(404).json({ error: 'Listing not available.' });
  if (listing.seller_user_id === u.id)         return res.status(400).json({ error: "You can't buy your own listing." });

  // Reserve the listing FIRST (atomic), then ask the bot to create the channel.
  // If channel creation fails we re-open the listing.
  const claimed = store.markListingPending(id, u.id);
  if (!claimed) return res.status(409).json({ error: 'Already taken — try another.' });

  const seller = store.getUserById(listing.seller_user_id);
  const summary = profileSummary(listing.profile_user_id);
  try {
    const r = await botFetch('POST', '/mp/create-channel', {
      listingId: id,
      sellerDiscordId: seller?.discord_id || null,
      buyerDiscordId: u.discord_id,
      priceText: `$${(listing.price_cents/100).toFixed(2)}`,
      accessType: listing.access_type.toUpperCase(),
      accountName: summary?.username || '(unknown)',
      profileUrl: summary ? `${process.env.SITE_URL || 'https://r6checker.xyz'}${summary.profileUrl}` : null,
    });
    // RESERVE the listing — it stays 'pending' (hidden from browse) and is NOT
    // sold until BOTH parties confirm the deal finished in the Discord channel.
    // If they cancel, it returns to the marketplace.
    store.setListingChannel(id, r.channelId);
    res.json({ ok: true, channelId: r.channelId });
  } catch (e) {
    // Channel creation failed → un-reserve so the listing is browsable again.
    try { store.reopenListing(id); } catch {}
    res.status(503).json({ error: 'Could not create Discord channel: ' + e.message });
  }
});

app.get('/api/admin/stats', noStore, siteAuth.requireOwner, (_req, res) => {
  try { res.json(store.adminStats()); }
  catch (e) { console.error('[admin/stats]', e.message); res.status(500).json({ error: 'Internal error' }); }
});
// Owner-only: manually credit a user's balance by their registered email.
// Backed by store.adminAdjust → logs a kind='adjust' transaction (audit trail
// distinct from real deposits). Strictly gated to OWNER_EMAILS and never billed
// to anyone; amount capped to guard against fat-finger typos.
const GRANT_MAX_USD = 100000;
app.post('/api/admin/grant-balance', noStore, siteAuth.requireOwner, (req, res) => {
  const email     = String(req.body?.email || '').trim();
  const amountUsd = Number(req.body?.amountUsd);
  const reason    = String(req.body?.reason || '').trim();
  if (!email) return res.status(400).json({ error: 'Email is required.' });
  if (!Number.isFinite(amountUsd) || amountUsd <= 0 || amountUsd > GRANT_MAX_USD) {
    return res.status(400).json({ error: `Amount must be between $0.01 and $${GRANT_MAX_USD.toLocaleString('en-US')}.` });
  }
  const cents = Math.round(amountUsd * 100);
  if (cents <= 0) return res.status(400).json({ error: 'Amount rounds to $0.00.' });
  const user = store.getUserByEmail(email);
  if (!user) return res.status(404).json({ error: 'No user is registered with that email.' });
  // adminAdjust requires a >=3 char audit reason; a short/empty one falls back
  // to a descriptive note rather than failing the whole grant.
  const note = (reason && reason.length >= 3) ? reason : `Manual balance grant by owner ${req.siteUser.email}`;
  try {
    const balanceCents = store.adminAdjust(user.id, cents, note);
    console.log(`[admin/grant] owner ${req.siteUser.email} +${cents}¢ → user ${user.id} (${user.email}); bal=${balanceCents}¢`);
    res.json({ ok: true, email: user.email, addedCents: cents, balanceCents });
  } catch (e) {
    console.error('[admin/grant]', e.message);
    res.status(500).json({ error: `Failed to credit balance: ${e.message}` });
  }
});

// Owner: grant N days of BYO-proxy access (free-proxy bulk) to a user by email.
// Stacks onto any remaining time. This is the access PASS, separate from the
// USD balance grant above.
app.post('/api/admin/grant-access', noStore, siteAuth.requireOwner, (req, res) => {
  const email = String(req.body?.email || '').trim();
  const days  = Number(req.body?.days);
  if (!email) return res.status(400).json({ error: 'Email is required.' });
  if (!Number.isInteger(days) || days <= 0 || days > 3650) {
    return res.status(400).json({ error: 'Days must be a whole number between 1 and 3650.' });
  }
  const user = store.getUserByEmail(email);
  if (!user) return res.status(404).json({ error: 'No user is registered with that email.' });
  try {
    const expiresAt = store.extendSubscription(user.id, days, 'admin');
    const status = store.subscriptionStatus(user.id);
    console.log(`[admin/grant-access] owner ${req.siteUser.email} +${days}d → user ${user.id} (${user.email}); until ${new Date(expiresAt).toISOString()}`);
    // Email them their desktop CLI key (fire-and-forget).
    require('./lib/keyMailer').sendKey(user.id, expiresAt).catch(() => {});
    res.json({ ok: true, email: user.email, days, expiresAt, status });
  } catch (e) {
    console.error('[admin/grant-access]', e.message);
    res.status(500).json({ error: `Failed to grant access: ${e.message}` });
  }
});

// Owner: send a test email (to a given address or the owner) to verify SMTP.
app.post('/api/admin/test-email', noStore, express.json(), siteAuth.requireOwner, async (req, res) => {
  const to = String(req.body?.to || req.siteUser.email || '').trim();
  if (!to) return res.status(400).json({ error: 'No recipient.' });
  try {
    const r = await require('./lib/email').send({
      to,
      subject: 'R6Checker — test email',
      text: `This is a test email from your R6Checker server, sent ${new Date().toUTCString()}. If you received this, SMTP is working.`,
      html: `<p>This is a <b>test email</b> from your R6Checker server.</p><p>Sent ${new Date().toUTCString()}. If you received this, SMTP is working ✅.</p>`,
    });
    if (r && r.ok === false) return res.status(503).json({ error: `Email not sent (${r.reason || 'SMTP not configured'}). Set SMTP_* in .env.` });
    console.log(`[admin/test-email] owner ${req.siteUser.email} → ${to}`);
    res.json({ ok: true, to });
  } catch (e) {
    res.status(500).json({ error: `Send failed: ${e.message}` });
  }
});

// Owner: simulate a purchase end-to-end — runs the EXACT key-email path a real
// NOWPayments purchase triggers (keyMailer.sendKey) and reports whether the
// license-key email actually went out. Does NOT charge or extend real access;
// it only verifies the buy→email→key delivery works.
app.post('/api/admin/test-purchase', noStore, express.json(), siteAuth.requireOwner, async (req, res) => {
  const to = String(req.body?.email || req.siteUser.email || '').trim().toLowerCase();
  if (!to) return res.status(400).json({ error: 'No recipient email.' });
  try {
    const user = store.getUserByEmail(to);
    if (!user) return res.status(404).json({ error: `No account for ${to}. They must sign up on the site first.` });
    const expiresAt = Date.now() + 30 * 24 * 60 * 60 * 1000; // simulated 30-day pass (email text only)
    const r = await require('./lib/keyMailer').sendKey(user.id, expiresAt);
    if (!r || !r.ok) return res.status(503).json({ error: `Key email failed: ${r && r.error ? r.error : 'SMTP not configured'}.` });
    const masked = r.key ? `${r.key.slice(0, 6)}…${r.key.slice(-4)}` : null;
    console.log(`[admin/test-purchase] owner ${req.siteUser.email} → key email to ${r.to} (key ${masked})`);
    res.json({ ok: true, to: r.to, keyMasked: masked, expiresAt });
  } catch (e) {
    res.status(500).json({ error: `Test purchase failed: ${e.message}` });
  }
});

// ── Discord bot → server: kick off a "recheck stock" bulk job ─────────────
// Authenticated by a shared BOT_API_TOKEN (the bot runs on the same VPS over
// localhost). The job runs under the configured site owner's user, so results
// land in their bulk-jobs dashboard and download endpoints work as normal.
function requireBotToken(req, res, next) {
  const expected = process.env.BOT_API_TOKEN || '';
  const got = req.get('x-bot-token') || '';
  if (!expected) return res.status(503).json({ error: 'BOT_API_TOKEN not configured on server.' });
  if (got !== expected) return res.status(401).json({ error: 'Bad bot token.' });
  next();
}
function ownerUserForBot() {
  const emails = (process.env.OWNER_EMAILS || 'owner@example.com')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  for (const e of emails) {
    const u = store.getUserByEmail(e);
    if (u) return u;
  }
  return null;
}
app.post('/api/admin/bot/recheck', noStore, requireBotToken, (req, res) => {
  const owner = ownerUserForBot();
  if (!owner) return res.status(503).json({ error: 'Owner user account not provisioned on site yet.' });
  const raw = req.body?.accounts ?? req.body?.input ?? '';
  const parsed = bulkRunner.parseAccounts(raw, bulkRunner.maxLinesFor(owner));
  if (!parsed.length) return res.status(400).json({ error: 'No valid email:password lines found.' });
  try {
    // BYO-proxy mode → free (owner is unlimited), uses the owner's stored proxies.
    const job = bulkRunner.startJob(owner.id, parsed, { byoProxy: true });
    console.log(`[bot/recheck] kicked off job ${job.id} for ${parsed.length} accounts (label="${req.body?.label || ''}")`);
    res.json({ jobId: job.id, total: job.total, ownerEmail: owner.email });
  } catch (e) {
    console.error('[bot/recheck] start failed:', e.message);
    res.status(e.status || 500).json({ error: e.message });
  }
});
app.get('/api/admin/bot/recheck/:jobId', noStore, requireBotToken, (req, res) => {
  const owner = ownerUserForBot();
  if (!owner) return res.status(503).json({ error: 'Owner user account not provisioned on site yet.' });
  const job = store.getJob(req.params.jobId);
  if (!job || job.user_id !== owner.id) return res.status(404).json({ error: 'Job not found.' });
  res.json(bulkRunner.getStatus(req.params.jobId));
});
// Full result lines of a finished recheck job — bot-token auth so /checkall can
// re-sort the store from fresh results. type: all|valid|invalid|vwi|banned.
app.get('/api/admin/bot/recheck/:jobId/results', noStore, requireBotToken, (req, res) => {
  const owner = ownerUserForBot();
  if (!owner) return res.status(503).json({ error: 'Owner user account not provisioned on site yet.' });
  const job = store.getJob(req.params.jobId);
  if (!job || job.user_id !== owner.id) return res.status(404).json({ error: 'Job not found.' });
  if (!job.results_path || !fs.existsSync(job.results_path)) return res.status(404).json({ error: 'Results not available.' });
  const type = ['valid', 'invalid', 'vwi', 'banned'].includes(req.query.type) ? req.query.type : 'all';
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  fmt.decryptFileToStream(job.results_path, res, { filter: type }).catch((e) => {
    if (!res.headersSent) res.status(500).json({ error: 'decrypt failed' }); else res.end();
  });
});

// Owner: reset a user's CLI device lock (so they can use their key on a new PC).
// Owner: grant/revoke trusted-seller badge on a user by email.
app.post('/api/admin/mp-trust', noStore, express.json(), siteAuth.requireOwner, (req, res) => {
  const email = String(req.body?.email || '').trim();
  const trusted = req.body?.trusted ? 1 : 0;
  if (!email) return res.status(400).json({ error: 'Email required.' });
  const u = store.getUserByEmail(email);
  if (!u) return res.status(404).json({ error: 'No user with that email.' });
  store.setUserTrusted(u.id, trusted);
  console.log(`[admin/mp-trust] ${trusted ? 'granted' : 'revoked'} trusted to ${email} by ${req.siteUser.email}`);
  res.json({ ok: true, email, trusted: !!trusted, discordUsername: u.discord_username || null });
});

app.post('/api/admin/reset-hwid', noStore, express.json(), siteAuth.requireOwner, (req, res) => {
  const email = String(req.body?.email || '').trim();
  if (!email) return res.status(400).json({ error: 'Email is required.' });
  const ok = store.clearUserHwidByEmail(email);
  if (!ok) return res.status(404).json({ error: 'No user with that email.' });
  console.log(`[admin/reset-hwid] owner ${req.siteUser.email} reset HWID for ${email}`);
  res.json({ ok: true, email });
});

// ── Owner-only: live proxy credential management ────────────────────────────
// View current (password masked) proxy config, and update user/pass/host/port.
// Changes apply LIVE (proxyClient reads creds dynamically) and persist to
// .cache/proxy-config.json — no restart needed. New creds are validated against
// the provider before saving so a bad paste can't silently break every check.
const proxyClient = require('./lib/proxyClient');
const fmt_skin = require('./lib/checker/skinCheck');
app.get('/api/admin/proxy', noStore, siteAuth.requireOwner, (_req, res) => {
  res.json({ proxy: proxyClient.getProxyConfigPublic() });
});
// Bucket definitions for the owner VWI sorter (kept server-side so the UI
// always matches the detector). items = wanted-skin family names exactly as
// they appear in a result line's "Skins:" column; ranks = the short tier
// labels as they appear in the "Ranks:" column.
// ── Live pricing overrides (JSON file, hot-reloaded on every read) ─────────
// GET returns the full effective config: { defaults, overrides, effective }.
// PUT { overrides } atomically replaces the whole overrides blob. Missing keys
// fall back to code defaults. Owner-gated.
app.get('/api/admin/pricing', noStore, siteAuth.requireOwner, (_req, res) => {
  const pricingStore = require('./lib/pricingStore');
  const vwi = require('./lib/bot/vwiPricing');
  const overrides = pricingStore.all();
  res.json({
    defaults:  { vwiPricing: vwi.DEFAULTS },
    overrides,
    effective: {
      vwiPricing: {
        RANK_BASE: vwi.RANK_BASE, MULTI_RANK_ADD: vwi.MULTI_RANK_ADD,
        MYSTERY_FLAT: vwi.MYSTERY_FLAT, GLOBAL_MIN: vwi.GLOBAL_MIN,
        PLATFORM_PREMIUM: vwi.PLATFORM_PREMIUM, BANNED_PRICE: vwi.BANNED_PRICE,
        ITEM_FLOOR: vwi.ITEM_FLOOR,
      },
    },
    file: pricingStore.FILE,
  });
});
app.put('/api/admin/pricing', noStore, express.json({ limit: '256kb' }), siteAuth.requireOwner, (req, res) => {
  const pricingStore = require('./lib/pricingStore');
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const overrides = body.overrides;
  if (overrides == null || typeof overrides !== 'object' || Array.isArray(overrides)) {
    return res.status(400).json({ error: 'overrides must be an object.' });
  }
  // Cheap defence: JSON already parsed by express, sanity-check the top-level
  // shape so we don't persist obvious garbage.
  for (const k of Object.keys(overrides)) {
    if (!['vwiPricing', 'subscriptionPlans', 'serverCheckerBrackets'].includes(k)) {
      return res.status(400).json({ error: `Unknown pricing section: ${k}` });
    }
  }
  try {
    pricingStore.save(overrides);
    console.log(`[admin/pricing] updated by ${req.siteUser.email}`);
    res.json({ ok: true });
  } catch (e) {
    console.error('[admin/pricing] save failed:', e.message);
    res.status(500).json({ error: 'Failed to persist pricing overrides: ' + e.message });
  }
});

app.get('/api/admin/vwi/meta', noStore, siteAuth.requireOwner, (_req, res) => {
  // Extended payload: ranks + all wanted items + the 5 named-only item buckets
  // + the banned-VWI qualifiers. The sorter (public/js/vwiBuckets.js) is driven
  // entirely by this, so skinCheck.vwiMeta() is the single source of truth.
  res.json(fmt_skin.vwiMeta());
});

// VWI → SellAuth push. The website proxies sorter result lines to the bot (which
// owns SellAuth). /plan is a READ-ONLY dry-run (price + match + to-create list);
// /push performs the live writes. Owner-only; bodies can be large (whole runs).
function vwiLinesFromBody(body) {
  return Array.isArray(body?.lines) ? body.lines : String(body?.text || '').split(/\r?\n/);
}
app.post('/api/admin/vwi/plan', noStore, express.json({ limit: '64mb' }), siteAuth.requireOwner, async (req, res) => {
  try { res.json(await botFetch('POST', '/vwi/plan', { lines: vwiLinesFromBody(req.body) })); }
  catch (e) { res.status(502).json({ error: 'push planner unreachable: ' + e.message }); }
});
app.post('/api/admin/vwi/push', noStore, express.json({ limit: '64mb' }), siteAuth.requireOwner, async (req, res) => {
  try { res.json(await botFetch('POST', '/vwi/push', { lines: vwiLinesFromBody(req.body), visibility: req.body?.visibility })); }
  catch (e) { res.status(502).json({ error: 'push failed: ' + e.message }); }
});

// ── Mass-invite Discord OAuths to a guild ────────────────────────────────────
app.get('/api/admin/oauths/summary', noStore, siteAuth.requireOwner, async (_req, res) => {
  let guilds = [];
  try { const r = await botFetch('GET', '/admin/bot-guilds'); guilds = r.guilds || []; }
  catch (e) { return res.status(502).json({ error: 'bot listener unreachable: ' + e.message }); }
  res.json({
    total: store.countDiscordOauths(),
    guilds,
  });
});

// Run mass-invite. body = { guildId }. Refreshes each user's access token if
// expired, then asks the bot to PUT-add them one-by-one (throttled). Returns a
// summary so the admin panel can show per-user outcomes.
app.post('/api/admin/oauths/mass-invite', noStore, express.json(), siteAuth.requireOwner, async (req, res) => {
  const guildId = String(req.body?.guildId || '');
  if (!/^\d{10,25}$/.test(guildId)) return res.status(400).json({ error: 'invalid guildId' });
  const all = store.listDiscordOauths().filter(r => r.refresh_token);
  // Refresh tokens that are within 60s of expiring, in small parallel batches.
  const NOW = Date.now();
  const STALE = (r) => !r.access_token || !r.access_token_expires_at || r.access_token_expires_at - NOW < 60_000;
  const users = [];
  const refreshErrors = [];
  const CONCURRENCY = 8;
  let idx = 0;
  async function refreshOne(r) {
    if (!STALE(r)) { users.push({ discordId: r.discord_id, accessToken: r.access_token }); return; }
    try {
      const td = await discord.refreshAccessToken(r.refresh_token);
      store.upsertDiscordOauth({
        discordId: r.discord_id, username: r.username, email: r.email,
        refreshToken: td.refresh_token || r.refresh_token,
        accessToken:  td.access_token,
        expiresIn:    td.expires_in,
        scope:        td.scope || r.scope,
      });
      users.push({ discordId: r.discord_id, accessToken: td.access_token });
    } catch (e) { refreshErrors.push({ discordId: r.discord_id, error: e.message }); }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => { while (idx < all.length) await refreshOne(all[idx++]); }));

  let r;
  try { r = await botFetch('POST', '/admin/mass-invite', { guildId, users }); }
  catch (e) { return res.status(502).json({ error: 'bot mass-invite failed: ' + e.message }); }

  // Persist per-user outcome (so the admin panel can show "last invited" status).
  for (const u of (r.results || [])) store.markDiscordInvited(u.discordId, guildId, u.status);

  const counts = (r.results || []).reduce((m, u) => { m[u.status] = (m[u.status] || 0) + 1; return m; }, {});
  res.json({
    ok: true,
    guildName: r.guildName,
    totalSelected: all.length,
    refreshed: users.length,
    refreshErrors,
    counts,
    results: r.results,
  });
});
app.post('/api/admin/proxy', noStore, siteAuth.requireOwner, async (req, res) => {
  const { user, pass, host, port, useProxy, test } = req.body || {};
  const patch = {};
  if (user     !== undefined) patch.user = String(user || '').trim();
  if (host     !== undefined) patch.host = String(host || '').trim();
  if (port     !== undefined) patch.port = String(port || '').trim();
  if (useProxy !== undefined) patch.useProxy = !!useProxy;
  if (pass     !== undefined && pass !== '') patch.pass = String(pass);
  if (port !== undefined && patch.port && !/^\d{1,5}$/.test(patch.port)) {
    return res.status(400).json({ error: 'Port must be numeric.' });
  }
  // Validate the *candidate* creds (current merged with the patch) before saving.
  // Skip the live test only when the owner is turning the proxy off.
  const candidate = { ...proxyClient.getProxyConfig(), ...patch };
  if (candidate.useProxy) {
    const result = await proxyClient.testProxy(candidate);
    if (!result.ok) {
      return res.status(400).json({ error: `Proxy test failed (${result.error}) — not saved.`, test: result });
    }
    const saved = proxyClient.setProxyConfig(patch);
    console.log(`[admin/proxy] owner ${req.siteUser.email} updated proxy creds (exit IP ${result.ip}, ${result.ms}ms)`);
    return res.json({ ok: true, proxy: saved, test: result });
  }
  const saved = proxyClient.setProxyConfig(patch);
  console.log(`[admin/proxy] owner ${req.siteUser.email} set proxy enabled=${saved.useProxy}`);
  res.json({ ok: true, proxy: saved });
});
app.get('/terms',          (_req, res) => res.redirect('/legal'));
app.get('/privacy',        (_req, res) => res.redirect('/legal'));
// Support → redirect straight to the Discord invite.
app.get('/support',        (_req, res) => res.redirect('https://discord.gg/gnPB2JBPS6'));
app.get('/discord',        (_req, res) => res.redirect('https://discord.gg/gnPB2JBPS6'));

// Ubisoft userIds are UUIDv4. Validate strictly so attacker-controlled
// path-traversal segments can't reach files outside CACHE_DIR.
const USERID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

app.get('/profile/:userId', (req, res) => {
  const userId    = req.params.userId;
  if (!USERID_RE.test(userId)) return res.status(404).send('Not found.');
  const cachePath = path.join(CACHE_DIR, `${userId}.json`);
  if (!fs.existsSync(cachePath)) {
    return res.status(404).send(`<!DOCTYPE html><html lang="en"><head>
<title>R6Checker — Profile not found</title>
<link rel="icon" type="image/png" href="/img/logo.png">
<style>
  body{background:#050b18;color:#e8eef7;font-family:system-ui,-apple-system,sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;margin:0;text-align:center;padding:1rem;
    background-image:radial-gradient(circle at 20% 0%,rgba(58,141,255,.08),transparent 60%),radial-gradient(circle at 80% 100%,rgba(58,141,255,.05),transparent 50%)}
  h1{color:#3a8dff;margin:.5rem 0;font-size:1.6rem;font-weight:800}
  p{color:#7d8aa3;max-width:480px;line-height:1.5;margin:.5rem 0}
  a.btn{display:inline-block;background:#3a8dff;color:#fff;padding:.7rem 1.4rem;border-radius:8px;text-decoration:none;font-weight:600;margin-top:1rem;box-shadow:0 0 20px rgba(58,141,255,.25)}
  a.btn:hover{background:#5aa3ff}
  img.logo{width:64px;height:64px;margin-bottom:.5rem}
</style></head><body>
<img class="logo" src="/img/logo.png" alt="" onerror="this.style.display='none'">
<h1>Profile not loaded yet</h1>
<p>This account hasn't been checked yet. Sign in once with your Ubisoft credentials and the profile page will be created automatically — then shareable to anyone.</p>
<a class="btn" href="/login">Check My Account</a>
<p style="margin-top:1.5rem"><a href="/" style="color:#5aa3ff;font-size:.85rem">← Back to home</a></p>
</body></html>`);
  }
  try {
    const { data } = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    // Serve locker page — inject player data so no sessionStorage needed
    const lockerHtml = fs.readFileSync(path.join(__dirname, 'public', 'locker.html'), 'utf8');
    // SAFE JSON for <script> embedding. JSON.stringify alone is NOT safe to
    // inline because a `</script>` sequence in any field (an attacker-
    // controlled Ubisoft username, item title, etc.) would break out of
    // the script tag. Escape every `<`, `>`, `&` and U+2028/U+2029 to their
    // `\u...` form — keeps the JSON valid and parsable, makes it impossible
    // to break out of the surrounding <script>.
    const toUni = c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0');
    // RegExp constructor (not literal) so the source doesn't contain raw
    // U+2028 / U+2029 chars (a regex literal can't carry them).
    const lsepRe = new RegExp('[' + String.fromCharCode(0x2028, 0x2029) + ']', 'g');
    const safeJson = JSON.stringify(data)
      .replace(/[<>&]/g, toUni)
      .replace(lsepRe,   toUni);

    // ── Rich link embed (Discord / Twitter / iMessage) ────────────────────
    // Open Graph + Twitter Card meta. Username/values are attacker-controlled
    // (Ubisoft usernames), so escape for HTML attribute context to prevent
    // injection.
    const attr = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;')
      .replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/'/g, '&#39;');
    const itemCount = (data.sections || []).reduce((sum, sec) => {
      const items = sec.items || [];
      const groups = sec.groups || [];
      const flat = sec.grouped ? items.concat(groups.flatMap(g => g.items || [])) : items;
      return sum + flat.length;
    }, 0);
    const uname  = data.username || 'R6 Player';
    const lvl    = data.level ?? '?';
    const banTag = data.banned ? ' | ⛔ BANNED' : '';
    const desc   = `Level: ${lvl} | Total Items: ${itemCount.toLocaleString('en-US')}${banTag}`;
    const ogImage = data.avatar
      ? (data.avatar.startsWith('http') ? data.avatar : `https://r6checker.xyz${data.avatar}`)
      : 'https://r6checker.xyz/img/logo.png';
    const ogUrl  = `https://r6checker.xyz/profile/${userId}`;
    const ogTags = [
      `<meta property="og:site_name" content="R6Checker.XYZ">`,
      `<meta property="og:title" content="${attr(uname)}'s R6 Profile">`,
      `<meta property="og:description" content="${attr(desc)}">`,
      `<meta property="og:type" content="profile">`,
      `<meta property="og:url" content="${attr(ogUrl)}">`,
      `<meta property="og:image" content="${attr(ogImage)}">`,
      `<meta name="twitter:card" content="summary">`,
      `<meta name="twitter:title" content="${attr(uname)}'s R6 Profile">`,
      `<meta name="twitter:description" content="${attr(desc)}">`,
      `<meta name="twitter:image" content="${attr(ogImage)}">`,
      `<meta name="theme-color" content="#3a8dff">`,
    ].join('\n');

    const injected = lockerHtml.replace(
      '</head>',
      `${ogTags}\n<script>window.__PROFILE_DATA__ = ${safeJson};</script></head>`
    );
    res.send(injected);
  } catch {
    res.status(500).send('Error loading profile.');
  }
});

// Health + monitoring endpoint — scrape this from your dashboard/uptime check
app.get('/health', (_req, res) => {
  const mem = process.memoryUsage();
  res.json({
    ok: true,
    uptime: Math.floor(process.uptime()),
    memoryMB: { rss: (mem.rss / 1024 / 1024) | 0, heap: (mem.heapUsed / 1024 / 1024) | 0 },
    ubiQueue: queueStats(),
    proxy: require('./lib/proxyClient').isProxyEnabled(),
  });
});

// ── Final error handler ──────────────────────────────────────────────────
// Catches anything route handlers forgot to handle. Logs the full error
// server-side; returns a generic message to the client. Prevents stack
// traces, file paths, dependency versions, or other internals from
// leaking to a probing attacker.
app.use((err, req, res, _next) => {
  console.error('[unhandled]', req.method, req.path, '—', err.stack || err.message || err);
  if (res.headersSent) return;            // bail if response already started
  // Honour an explicit status set on the error, otherwise default to 500.
  const status = Number.isInteger(err.status) && err.status >= 400 && err.status < 600 ? err.status : 500;

  // Generic message for: internal errors AND framework errors that would
  // leak details (SyntaxError from body-parser, entity-too-large, etc.).
  // Our own thrown errors with explicit statuses pass through unchanged
  // (e.g. "Amount must be between $20 and $1000.").
  const isFrameworkErr =
    err instanceof SyntaxError ||
    err.type === 'entity.parse.failed' ||
    err.type === 'entity.too.large' ||
    err.type === 'parameters.too.many';
  const safeMessage =
    status === 500    ? 'Internal error' :
    isFrameworkErr    ? 'Malformed request.' :
    (typeof err.message === 'string' && err.message.length < 200 ? err.message : 'Request failed');

  res.status(status).json({ error: safeMessage });
});

// Background sweepers + payment poller
store.startSweeper();
if (BILLING_ENABLED && nowpayments.isConfigured()) nowpayments.startPoller();
if (BILLING_ENABLED && whop.isConfigured())        whop.startPoller();

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`R6 Locker running at http://localhost:${PORT}`));
