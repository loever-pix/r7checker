function isAllowedLoopbackCallback(callback) {
  let url;
  try { url = new URL(callback); } catch { return false; }
  if (url.protocol !== 'http:') return false;
  const host = url.hostname.toLowerCase();
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) return false;
  const port = Number(url.port);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) return false;
  return true;
}

function response(status, body) {
  return { status, body };
}

function buildActivationLoginRedirect(originalUrl) {
  const path = String(originalUrl || '');
  const safePath = /^\/api\/cli\/activate(?:\?|$)/.test(path) ? path : '/account';
  return '/account/login?return_to=' + encodeURIComponent(safePath);
}

function createDesktopActivation({ user, hwid, callback, store, siteAuth }) {
  if (!user) return response(401, { error: 'Sign in required.' });
  const cleanHwid = String(hwid || '').trim().slice(0, 128);
  if (!cleanHwid) return response(400, { error: 'Missing device id.' });
  if (!isAllowedLoopbackCallback(callback)) {
    return response(400, { error: 'Invalid desktop callback.' });
  }

  const owner = siteAuth.isOwner(user);
  const sub = store.subscriptionStatus(user.id);
  if (!owner && !sub.active) {
    return response(402, {
      error: 'Your access pass has expired. Renew it on the website to use the desktop checker.',
      expiresAt: sub.expiresAt,
    });
  }

  if (!user.hwid) store.setUserHwid(user.id, cleanHwid);
  else if (user.hwid !== cleanHwid) {
    return response(423, { error: 'Your account is locked to another device. Ask support to reset it.' });
  }

  const key = store.getOrCreateCliKey(user.id);
  const url = new URL(callback);
  url.searchParams.set('key', key);
  url.searchParams.set('email', user.email);
  url.searchParams.set('owner', owner ? '1' : '0');
  url.searchParams.set('active', '1');
  if (sub.expiresAt) url.searchParams.set('expiresAt', String(sub.expiresAt));
  url.searchParams.set('proxies', String(store.getUserProxies(user.id).length));
  return { status: 302, location: url.toString() };
}

module.exports = {
  createDesktopActivation,
  isAllowedLoopbackCallback,
  buildActivationLoginRedirect,
};
