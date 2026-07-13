'use strict';
// Per-request session token injection for rotating residential gateways.
// FlameProxies: -session-{rand} (required). DataImpulse: __sid-{rand}.
// CoreProxy / NovaProxy rotating gateways: leave username unchanged (gateway
// rotates per connection). Never collapse DataImpulse __cr.us geo markers.

const PROVIDERS = [
  {
    id: 'flame',
    test: (h) => /flameproxies\.com/i.test(h),
    tmpl: '-session-{rand}',
    strip: /-session-[a-z0-9]+/ig,
  },
  {
    id: 'dataimpulse',
    test: (h) => /dataimpulse\.com/i.test(h),
    tmpl: '__sid-{rand}',
    strip: /__sid-[a-z0-9]+/ig,
    preserveDoubleUnderscore: true,
  },
  {
    id: 'novaproxy',
    test: (h) => /novaproxy\.io/i.test(h),
    // Rotating residential — geo lives in password (_country-us); gateway rotates.
    tmpl: '',
    strip: /(?:^|[-_])session-[a-z0-9]+(?:_lifetime-[0-9]+s)?/ig,
  },
  {
    id: 'coreproxy',
    test: (h) => /coreproxy\.io/i.test(h),
    tmpl: '',
    strip: /-session-[a-z0-9]+/ig,
  },
];

const SESSION_STRIPS = [
  /__sid-[a-z0-9]+/ig,
  /-session-[a-z0-9]+/ig,
  /-sessid-[a-z0-9]+/ig,
  /-sid-[a-z0-9]+/ig,
  /(?:^|[-_])session-[a-z0-9]+(?:_lifetime-[0-9]+s)?/ig,
];

let _sidCounter = 0;

function detectProvider(hostname) {
  const h = String(hostname || '').toLowerCase();
  for (const p of PROVIDERS) {
    if (p.test(h)) return p;
  }
  return null;
}

function stripSessionTokens(username, provider) {
  let u = decodeURIComponent(username || '');
  const strips = provider && provider.strip
    ? [provider.strip, ...SESSION_STRIPS]
    : SESSION_STRIPS;
  for (const re of strips) u = u.replace(re, '');
  // Do NOT collapse __ — DataImpulse uses __cr.us / __sid.xxx markers.
  if (!provider || !provider.preserveDoubleUnderscore) {
    u = u.replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '');
  }
  return u;
}

function freshSessionProxy(proxyUrl, opts = {}) {
  if (!proxyUrl || process.env.BULK_PROXY_ROTATE === 'off') return proxyUrl;
  try {
    const u = new URL(proxyUrl);
    if (!u.username) return proxyUrl;

    const forced = (process.env.BULK_PROXY_PROVIDER || '').toLowerCase();
    const provider = forced
      ? (PROVIDERS.find((p) => p.id === forced) || null)
      : detectProvider(u.hostname);

    let tmpl = process.env.BULK_PROXY_SESSION_PARAM;
    if (tmpl == null || tmpl === '') {
      tmpl = provider ? provider.tmpl : '';
    }

    // Provider rotates at gateway — no username mutation needed.
    if (!tmpl) return proxyUrl;

    const rand = Date.now().toString(36).slice(-4)
      + (_sidCounter++).toString(36)
      + Math.random().toString(36).slice(2, 8);

    let base = stripSessionTokens(u.username, provider);

    if (provider && provider.id === 'flame' && process.env.FLAME_COUNTRIES) {
      const cs = process.env.FLAME_COUNTRIES.split(',').map((s) => s.trim()).filter(Boolean);
      const cc = cs[_sidCounter % cs.length];
      if (cc) base = base.replace(/-country-[a-z]+/i, '-country-' + cc);
    }

    u.username = base + tmpl.replace('{rand}', rand);
    return u.toString();
  } catch {
    return proxyUrl;
  }
}

function providerHint(proxyUrl) {
  try {
    const u = new URL(proxyUrl);
    const p = detectProvider(u.hostname);
    return p ? p.id : 'generic';
  } catch {
    return 'unknown';
  }
}

module.exports = { freshSessionProxy, detectProvider, providerHint, PROVIDERS };
