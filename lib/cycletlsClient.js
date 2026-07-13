// Lazy-init cycleTLS singleton.
//
// cycleTLS spawns a Go subprocess that mimics a real browser's JA3 TLS
// fingerprint. It's how we get past Cloudflare's bot check on tracker.gg.
// Spawning the subprocess takes ~200ms so we share ONE instance across the
// whole server, not per-request.

const initCycleTLS = require('cycletls');

let _instance = null;
let _initPromise = null;
let _shutdownRegistered = false;

// Firefox 128 JA3 — matches what real users send. If tracker.gg ever tightens
// to ja3+ja4+http2 fingerprint we can swap this with a Chrome variant.
const FIREFOX_JA3 = '771,4865-4866-4867-49195-49199-49196-49200-52393-52392-49171-49172-156-157-47-53,0-23-65281-10-11-35-16-5-13-18-51-45-43-27-17513-21,29-23-24,0';
const FIREFOX_UA  = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0';

async function getClient() {
  if (_instance) return _instance;
  if (_initPromise) return _initPromise;
  _initPromise = (async () => {
    const inst = await initCycleTLS();  // accepts no options at init time
    _instance = inst;
    if (!_shutdownRegistered) {
      _shutdownRegistered = true;
      const exit = () => { try { inst.exit(); } catch {} };
      process.on('exit', exit);
      process.on('SIGINT',  () => { exit(); process.exit(); });
      process.on('SIGTERM', () => { exit(); process.exit(); });
    }
    console.log('[cycletls] subprocess ready');
    return inst;
  })().catch(e => {
    console.error('[cycletls] init failed:', e.message);
    _initPromise = null;
    throw e;
  });
  return _initPromise;
}

// Countries to rotate through (DataImpulse __cr.<cc> targeting). Cycling the
// country per attempt opens the ENTIRE global residential pool instead of a
// single country's IPs — far more clean exits when one geo gets flagged by
// Cloudflare. tracker.gg serves all regions identically, so geo doesn't
// affect the data.
const PROXY_COUNTRIES = ['us', 'gb', 'ca', 'de', 'fr', 'nl', 'au', 'es', 'it', 'se', 'pl', 'br'];

// Build the rotating-residential proxy URL (DataImpulse). `attempt` varies the
// country + a session token so each retry is guaranteed a DIFFERENT exit IP
// from a DIFFERENT geo pool — "rotate until it works".
function proxyUrl(attempt = 0, country = null) {
  const { PROXY_HOST, PROXY_PORT, PROXY_USER, PROXY_PASS } = process.env;
  if (!PROXY_HOST || !PROXY_PORT) return null;
  // FlameProxies rotate syntax differs from DataImpulse: the package username
  // already encodes country/pool, and a fresh "-session-<rand>" suffix forces
  // a new exit IP per request (DataImpulse uses "__sessid" instead).
  if (/flameproxies\.com/i.test(PROXY_HOST)) {
    const base = (PROXY_USER || '').replace(/-session-[^-]*$/i, '');
    const sess = `${attempt}${Math.random().toString(36).slice(2, 8)}`;
    const user = `${base}-session-${sess}`;
    return `http://${encodeURIComponent(user)}:${encodeURIComponent(PROXY_PASS || '')}@${PROXY_HOST}:${PROXY_PORT}`;
  }
  // Base login is everything before the first "__" suffix.
  const baseUser = (PROXY_USER || '').split('__')[0];
  if (!baseUser) {
    const auth = PROXY_USER ? `${encodeURIComponent(PROXY_USER)}:${encodeURIComponent(PROXY_PASS || '')}@` : '';
    return `http://${auth}${PROXY_HOST}:${PROXY_PORT}`;
  }
  // Pin to a specific country when asked (e.g. 'us' for tracker.gg, whose CF
  // edge trusts US residential IPs); otherwise rotate the global pool.
  const cc = country || PROXY_COUNTRIES[attempt % PROXY_COUNTRIES.length];
  // A per-attempt session id forces DataImpulse to allocate a fresh IP rather
  // than reusing a sticky one. Vary it every attempt. (Date/Math are fine in
  // this non-workflow context.)
  const sess = `${attempt}${Math.random().toString(36).slice(2, 8)}`;
  const user = `${baseUser}__cr.${cc}__sessid.${sess}`;
  return `http://${encodeURIComponent(user)}:${encodeURIComponent(PROXY_PASS || '')}@${PROXY_HOST}:${PROXY_PORT}`;
}

// Thin GET wrapper returning axios-shaped { status, data, headers }.
//
// opts.proxy  — true to route through the rotating residential proxy.
// opts.retries — retry count on 403/429/5xx/network error. With the proxy on,
//                each retry hits a fresh IP, which is what actually beats the
//                transient Cloudflare 403s that were hiding seasons.
async function get(url, extraHeaders = {}, opts = {}) {
  const client = await getClient();
  const useProxy = opts.proxy !== false;            // default ON
  // Each attempt uses a DIFFERENT country + session = different exit IP.
  // 3 quick rotations — if those are all blocked, rankSources escalates to
  // the camoufox real-browser bypass (which passes Cloudflare reliably), so
  // there's no point burning many cycletls attempts first.
  const maxAttempts = (opts.retries ?? 3) + 1;

  let last = { status: 0, data: null, headers: {} };
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // opts.proxyUrl pins a specific proxy (e.g. FlameProxies for tracker.gg);
    // otherwise rotate the configured residential pool. opts.country pins geo.
    const proxy = opts.proxyUrl ? opts.proxyUrl : (useProxy ? proxyUrl(attempt - 1, opts.country) : null);
    try {
      const cfg = {
        ja3: FIREFOX_JA3,
        userAgent: FIREFOX_UA,
        timeout: 20,
        headers: {
          Accept: 'application/json, text/plain, */*',
          'Accept-Language': 'en-US,en;q=0.9',
          Referer: 'https://r6.tracker.network/',
          Origin:  'https://r6.tracker.network',
          ...extraHeaders,
        },
      };
      if (proxy) cfg.proxy = proxy;
      const res = await client.get(url, cfg);
      last = { status: res.status, headers: res.headers, data: res.data };
      // Retry transient blocks/errors with a fresh IP from a new geo; accept
      // everything else (200, 404, etc.) immediately.
      if (res.status === 403 || res.status === 429 || res.status >= 500) {
        if (attempt < maxAttempts) {
          if (attempt % 4 === 0) console.warn(`[cycletls] ${res.status} on attempt ${attempt}/${maxAttempts} — rotating proxy geo`);
          // Tiny jitter so we don't hammer CF's rate-limit window in lockstep.
          await new Promise(r => setTimeout(r, 150 + Math.floor(Math.random() * 250)));
          continue;
        }
      }
      return last;
    } catch (e) {
      if (attempt >= maxAttempts) throw e;
      await new Promise(r => setTimeout(r, 150));
    }
  }
  return last;
}

module.exports = { get, getClient, proxyUrl };
