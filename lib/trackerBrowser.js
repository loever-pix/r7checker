// Camoufox (anti-detect Firefox) fetcher for tracker.gg.
//
// cycletls mimics a JA3 fingerprint but Cloudflare's behavioural/JS challenge
// still 403s it once a flow gets "hot". A REAL browser executes the challenge
// JS, earns a cf_clearance cookie, and then the API returns JSON normally.
// Camoufox is purpose-built to pass these checks. We run it headless through
// the rotating residential proxy so the exit IP is clean too.
//
// One browser is kept warm and reused. The cf_clearance cookie persists in the
// browser context, so after the first challenge-solve subsequent fetches are
// fast (no re-challenge) until the cookie expires.

const { firefox } = require('playwright');
let camoufoxJs = null;
try { camoufoxJs = require('camoufox-js'); } catch {}

const { proxyUrl } = require('./cycletlsClient');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0';

let _browser = null;
let _context = null;
let _launching = null;
let _lastProxyAttempt = 0;

function parseProxy(url) {
  // http://user:pass@host:port  →  { server, username, password }
  try {
    const u = new URL(url);
    return {
      server: `http://${u.hostname}:${u.port}`,
      username: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
    };
  } catch { return null; }
}

async function launch(proxyAttempt) {
  const proxyStr = proxyUrl(proxyAttempt);
  const proxy = proxyStr ? parseProxy(proxyStr) : undefined;

  const opts = { headless: true };
  if (camoufoxJs) {
    const cam = await camoufoxJs.launchOptions({
      headless: true,
      humanize: false,
      os: 'windows',
      locale: ['en-US'],
      // Camoufox accepts a proxy in its launch options; also pass on context.
      ...(proxy ? { proxy } : {}),
    });
    Object.assign(opts, cam);
  }
  if (proxy && !opts.proxy) opts.proxy = proxy;

  const browser = await firefox.launch(opts);
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    userAgent: UA,
    ...(proxy ? { proxy } : {}),
  });
  return { browser, context };
}

async function getContext() {
  if (_context) return _context;
  if (_launching) return _launching;
  _launching = (async () => {
    const { browser, context } = await launch(_lastProxyAttempt);
    _browser = browser;
    _context = context;
    console.log('[trackerBrowser] camoufox ready');
    return _context;
  })().catch(e => {
    console.warn('[trackerBrowser] launch failed:', e.message);
    _launching = null;
    throw e;
  });
  return _launching;
}

async function recycle() {
  try { if (_browser) await _browser.close(); } catch {}
  _browser = null; _context = null; _launching = null;
  _lastProxyAttempt++; // next launch uses a different proxy geo/IP
}

// Fetch a URL and return parsed JSON, solving any Cloudflare challenge.
// Retries with a fresh browser+proxy if blocked.
async function fetchJson(url, { retries = 3 } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    let page;
    try {
      const ctx = await getContext();
      page = await ctx.newPage();
      // Navigate; CF may serve a challenge that resolves to the JSON.
      const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      let status = resp ? resp.status() : 0;

      // If we landed on a Cloudflare interstitial, wait for it to clear.
      // The challenge auto-redirects to the real content within a few seconds.
      for (let i = 0; i < 8; i++) {
        const txt = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
        if (txt.includes('Just a moment') || txt.includes('Checking your browser') || txt.includes('Enable JavaScript')) {
          await page.waitForTimeout(1500);
          continue;
        }
        break;
      }

      const body = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
      await page.close().catch(() => {});
      page = null;

      // Try to parse JSON out of the page text.
      try {
        const json = JSON.parse(body);
        return { status: 200, data: json };
      } catch {
        // Not JSON — likely still blocked. Recycle to a fresh IP and retry.
        if (attempt < retries) { await recycle(); continue; }
        return { status: status || 403, data: null };
      }
    } catch (e) {
      if (page) await page.close().catch(() => {});
      console.warn(`[trackerBrowser] attempt ${attempt + 1} failed: ${e.message}`);
      if (attempt < retries) { await recycle(); continue; }
      return { status: 0, data: null };
    }
  }
  return { status: 0, data: null };
}

async function shutdown() {
  try { if (_browser) await _browser.close(); } catch {}
  _browser = null; _context = null; _launching = null;
}
process.on('exit', () => { try { _browser && _browser.close(); } catch {} });

module.exports = { fetchJson, shutdown, recycle };
