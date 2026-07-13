const assert = require('assert');
const http = require('http');

const desktopActivation = require('../lib/desktopActivation');
const cp = require('../cli/local/control-plane');

function makeStore({ user, subscription = { active: true, expiresAt: Date.now() + 1000, msLeft: 1000 }, key = 'R6-ABCDEF-123456-789ABC' } = {}) {
  const calls = [];
  return {
    calls,
    subscriptionStatus(userId) {
      calls.push(['subscriptionStatus', userId]);
      return subscription;
    },
    setUserHwid(userId, hwid) {
      calls.push(['setUserHwid', userId, hwid]);
      user.hwid = hwid;
      return 1;
    },
    getOrCreateCliKey(userId) {
      calls.push(['getOrCreateCliKey', userId]);
      return key;
    },
    getUserProxies(userId) {
      calls.push(['getUserProxies', userId]);
      return ['http://proxy.example:1234'];
    },
  };
}

function makeSiteAuth({ owner = false } = {}) {
  return { isOwner: () => owner };
}

function activate(opts) {
  const user = opts.user || { id: 7, email: 'buyer@example.com', hwid: null };
  const store = makeStore({ user, subscription: opts.subscription, key: opts.key });
  const result = desktopActivation.createDesktopActivation({
    user,
    hwid: opts.hwid || 'HWID-ONE',
    callback: opts.callback || 'http://127.0.0.1:43123/callback',
    store,
    siteAuth: makeSiteAuth({ owner: !!opts.owner }),
  });
  return { result, user, store };
}

{
  const { result, user, store } = activate({});
  assert.strictEqual(result.status, 302);
  assert.strictEqual(user.hwid, 'HWID-ONE');
  assert.deepStrictEqual(store.calls.some(c => c[0] === 'setUserHwid' && c[2] === 'HWID-ONE'), true);
  const loc = new URL(result.location);
  assert.strictEqual(loc.origin, 'http://127.0.0.1:43123');
  assert.strictEqual(loc.pathname, '/callback');
  assert.strictEqual(loc.searchParams.get('key'), 'R6-ABCDEF-123456-789ABC');
  assert.strictEqual(loc.searchParams.get('email'), 'buyer@example.com');
}

{
  const { result } = activate({
    subscription: { active: false, expiresAt: Date.now() - 1000, msLeft: 0 },
  });
  assert.strictEqual(result.status, 402);
  assert.match(result.body.error, /expired|access pass/i);
}

{
  const { result } = activate({
    user: { id: 7, email: 'buyer@example.com', hwid: 'HWID-ONE' },
    hwid: 'HWID-TWO',
  });
  assert.strictEqual(result.status, 423);
  assert.match(result.body.error, /another device|locked/i);
}

{
  const { result } = activate({ callback: 'https://evil.example/callback' });
  assert.strictEqual(result.status, 400);
  assert.match(result.body.error, /callback/i);
}

{
  const redirect = desktopActivation.buildActivationLoginRedirect('/api/cli/activate?hwid=HWID-ONE&callback=http%3A%2F%2F127.0.0.1%3A43123%2Fcallback%3Fstate%3Dabc');
  assert.strictEqual(
    redirect,
    '/account/login?return_to=%2Fapi%2Fcli%2Factivate%3Fhwid%3DHWID-ONE%26callback%3Dhttp%253A%252F%252F127.0.0.1%253A43123%252Fcallback%253Fstate%253Dabc',
  );
}

{
  const launch = cp.browserOpenCommand(new URL('https://r6checker.xyz/api/cli/activate?hwid=HWID-ONE&callback=http%3A%2F%2F127.0.0.1%3A43123%2Fcallback%3Fstate%3Dabc'), 'win32');
  assert.strictEqual(launch.command, 'rundll32.exe');
  assert.deepStrictEqual(launch.args, [
    'url.dll,FileProtocolHandler',
    'https://r6checker.xyz/api/cli/activate?hwid=HWID-ONE&callback=http%3A%2F%2F127.0.0.1%3A43123%2Fcallback%3Fstate%3Dabc',
  ]);
}

{
  const url = cp.buildWebsiteActivationUrl({
    callback: 'http://127.0.0.1:45678/callback',
    hwid: 'HWID-ONE',
  });
  assert.strictEqual(url.origin, 'https://r6checker.xyz');
  assert.strictEqual(url.pathname, '/api/cli/activate');
  assert.strictEqual(url.searchParams.get('hwid'), 'HWID-ONE');
  assert.strictEqual(url.searchParams.get('callback'), 'http://127.0.0.1:45678/callback');
}

{
  const html = cp.renderActivationSuccessPage({ email: 'owner@example.com' });
  assert.match(html, /<!doctype html>/i);
  assert.match(html, /R6Checker Desktop/i);
  assert.match(html, /owner@example\.com/);
  assert.match(html, /window\.close/);
  assert.doesNotMatch(html, /<body style=/i);
  assert.doesNotMatch(html, /font-family:system-ui;background:#0b1020;color:#f6f7fb;padding:2rem/);
}

console.log('desktop activation tests passed');

(async () => {
  const seen = {};
  const server = http.createServer((req, res) => {
    seen.url = req.url;
    seen.headers = req.headers;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, email: 'owner@example.com', owner: true, active: true }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const oldServer = process.env.R6_SERVER_URL;
  process.env.R6_SERVER_URL = `http://127.0.0.1:${server.address().port}`;
  delete require.cache[require.resolve('../cli/local/config')];
  delete require.cache[require.resolve('../cli/local/control-plane')];
  const freshCp = require('../cli/local/control-plane');
  const result = await freshCp.verifyLicense('R6-VERIFY-KEY');
  await new Promise(resolve => server.close(resolve));
  if (oldServer == null) delete process.env.R6_SERVER_URL;
  else process.env.R6_SERVER_URL = oldServer;

  assert.strictEqual(result.ok, true);
  assert.strictEqual(seen.url, '/api/cli/me');
  assert.strictEqual(seen.headers['x-api-key'], 'R6-VERIFY-KEY');
  assert.ok(seen.headers['x-hwid']);
  assert.strictEqual(seen.headers['x-cli-key'], undefined);
  console.log('license verification header test passed');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
