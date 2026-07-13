// End-to-end test of the login flow using Camoufox stealth Firefox.
// Drives the actual /login page, observes console + network, and reports
// exactly what's happening (CORS error → iframe fallback engaging, etc.)

const { firefox } = require('playwright');
let camoufoxJs;
try { camoufoxJs = require('camoufox-js'); } catch {}

const URL = process.argv[2] || 'https://r6checker.xyz/login';

async function run() {
  const opts = camoufoxJs
    ? await camoufoxJs.launchOptions({ headless: true, geoip: true, humanize: true, os: 'windows', locale: ['en-US'] })
    : { headless: true };
  console.log(`[test] launching ${camoufoxJs ? 'Camoufox' : 'plain Firefox'}...`);
  const browser = await firefox.launch(opts);
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  const consoleLines = [];
  const requests = [];
  page.on('console', msg => {
    const text = msg.text();
    consoleLines.push(`[${msg.type()}] ${text}`);
    if (/r6-client-login|r6-auth-done|engageIframe/.test(text)) console.log('  console:', text);
  });
  page.on('pageerror', err => console.log('  pageerror:', err.message));
  page.on('requestfailed', req => {
    if (/ubisoft|ubi\.com|r6checker/.test(req.url())) {
      console.log('  ✗ FAILED:', req.method(), req.url().slice(0, 100), '→', req.failure()?.errorText);
    }
  });
  page.on('response', res => {
    if (/ubisoft|ubi\.com/.test(res.url())) {
      requests.push({ url: res.url(), status: res.status(), method: res.request().method() });
    }
  });

  console.log(`[test] navigating to ${URL}`);
  await page.goto(URL, { waitUntil: 'networkidle', timeout: 30000 }).catch(e => console.log('[test] nav err:', e.message));
  console.log('[test] page loaded');

  await page.waitForTimeout(3000); // let warmer fire

  // Fill the form
  console.log('[test] filling form...');
  await page.fill('#email-input', 'fake@example.com').catch(() => {});
  await page.fill('#password-input', 'fakePassword123').catch(() => {});
  await page.click('#submit-cred-btn').catch(() => {});

  console.log('[test] waiting 8s for login attempt + fallback...');
  await page.waitForTimeout(8000);

  // Check if iframe fallback engaged
  const fallbackVisible = await page.evaluate(() => {
    const el = document.getElementById('iframe-fallback');
    return el && !el.classList.contains('hidden');
  });
  const iframeSrc = await page.evaluate(() => document.getElementById('ubi-fallback-iframe')?.src || '');
  const status = await page.evaluate(() => document.getElementById('status')?.textContent || '');

  console.log('\n══════════════════════════════════');
  console.log('RESULTS:');
  console.log('══════════════════════════════════');
  console.log(`fallback iframe visible: ${fallbackVisible}`);
  console.log(`fallback iframe src:     ${iframeSrc.slice(0, 100)}`);
  console.log(`status line:             "${status}"`);
  console.log('\nUbisoft requests observed:');
  for (const r of requests.slice(0, 20)) {
    console.log(`  ${r.status} ${r.method} ${r.url.slice(0, 100)}`);
  }
  console.log('\nConsole lines containing r6-* or CORS:');
  for (const line of consoleLines) {
    if (/r6-|CORS|preflight|datadome|engage/i.test(line)) console.log('  ', line.slice(0, 200));
  }

  await browser.close();
}

run().catch(e => { console.error(e); process.exit(1); });
