// Ubisoft API client with concurrency control.
//
// Old behavior: single serial queue (max ~2 req/s globally). Won't scale.
// New behavior:
//   • Global cap on inflight requests (CONCURRENCY)
//   • Per-host token bucket so we don't trip Ubisoft's rate limits
//   • 429 backoff with exponential delay + jitter
//   • Per-userId mini-queue so one user's requests don't starve others

const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');

// Authenticated Ubisoft API calls (inventory, profile, ranks) are NOT
// DataDome-gated, so on the SERVER they go DIRECT (one datacenter IP — fast,
// and the rotating proxy actually made the locker slower + dropped items).
//
// On the DESKTOP checker it's the opposite: hundreds of these authenticated
// calls per second from ONE residential IP get rate-limited, so level / items /
// credits / renown / ranks come back EMPTY. So when UBI_PROXY_URL is set (the
// desktop worker sets it to a BYO rotating-residential proxy), we route every
// ubiRequest through a FRESH proxy session — same as login. Unset on the server
// → unchanged direct behavior.
let _freshProxy = null;
function freshProxy(url) {
  if (_freshProxy === null) { try { _freshProxy = require('./auth').freshProxy; } catch { _freshProxy = (u) => u; } }
  try { return _freshProxy(url); } catch { return url; }
}
function proxyConfig() {
  const url = process.env.UBI_PROXY_URL;
  if (!url) return null;
  try { return { httpsAgent: new HttpsProxyAgent(freshProxy(url)), proxy: false }; }
  catch { return null; }
}

const CONCURRENCY      = parseInt(process.env.UBI_CONCURRENCY || '8', 10);
const REQ_PER_SEC_HOST = parseFloat(process.env.UBI_RPS       || '15');
const TIMEOUT_MS       = parseInt(process.env.UBI_TIMEOUT     || '12000', 10);
// Default retry count (desktop bulk sets UBI_RETRIES=2 to fail fast). Server unset → 4.
const DEFAULT_RETRIES  = parseInt(process.env.UBI_RETRIES     || '4', 10);
// Cap a single 429 backoff so one rate-limited call can't park a worker slot
// indefinitely (it was 2^attempt seconds, unbounded — up to 16s). 8s default is
// safe for the server; the desktop's 8s request timeout makes it moot there.
const MAX_BACKOFF_MS   = parseInt(process.env.UBI_MAX_BACKOFF || '8000', 10);

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Token bucket for per-host rate limiting ────────────────────────────
const bucket = { tokens: REQ_PER_SEC_HOST, last: Date.now() };
async function takeToken() {
  while (true) {
    const now = Date.now();
    const elapsed = (now - bucket.last) / 1000;
    bucket.tokens = Math.min(REQ_PER_SEC_HOST, bucket.tokens + elapsed * REQ_PER_SEC_HOST);
    bucket.last = now;
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return;
    }
    const waitMs = Math.ceil((1 - bucket.tokens) / REQ_PER_SEC_HOST * 1000);
    await sleep(waitMs);
  }
}

// ── Global concurrency semaphore ───────────────────────────────────────
let active = 0;
const waiters = [];
function acquire() {
  if (active < CONCURRENCY) { active++; return Promise.resolve(); }
  return new Promise(res => waiters.push(res));
}
function release() {
  active = Math.max(0, active - 1);
  const next = waiters.shift();
  if (next) { active++; next(); }
}

async function execute(config, retries) {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      // Direct on the server; through a fresh BYO proxy session on desktop
      // (UBI_PROXY_URL). proxyConfig is applied LAST so it isn't overridden.
      const px = proxyConfig();
      const res = await axios({ timeout: TIMEOUT_MS, ...config, ...(px || {}) });
      // Feed the adaptive rate governor: any non-throttle response is a
      // "success" from Ubi's rate-limit perspective, even 401 (wrong password).
      try { require('./checker/rateGovernorInstance').gov.reportSuccess(); } catch {}
      return res;
    } catch (err) {
      const status = err.response?.status;
      // Log only the path (not the multi-KB itemIds query) so a flood of failed
      // enrichment calls can't dump megabytes to stderr and block the loop.
      console.error(`[api] ${status} on ${config.method?.toUpperCase()} ${String(config.url).split('?')[0]}`);
      // Report to the governor: 429 → cut concurrency + maybe open breaker.
      if (status === 429) {
        try {
          const { gov, parseRetryAfter } = require('./checker/rateGovernorInstance');
          gov.reportThrottle({ retryAfterSec: parseRetryAfter(err.response.headers && (err.response.headers['retry-after'] || err.response.headers['Retry-After'])) });
        } catch {}
      }
      if (status === 429 && attempt < retries - 1) {
        // Exponential backoff with jitter, CAPPED so a slot isn't parked for 8s+.
        const backoff = Math.min(MAX_BACKOFF_MS, Math.pow(2, attempt + 1) * 1000) + Math.random() * 500;
        await sleep(backoff);
        continue;
      }
      throw err;
    }
  }
}

async function ubiRequest(config, retries = DEFAULT_RETRIES) {
  await takeToken();
  await acquire();
  try {
    return await execute(config, retries);
  } finally {
    release();
  }
}

function queueStats() {
  return {
    activeRequests: active,
    queuedRequests: waiters.length,
    tokens: Math.floor(bucket.tokens),
    concurrency: CONCURRENCY,
    rps: REQ_PER_SEC_HOST,
  };
}

module.exports = { ubiRequest, queueStats };
