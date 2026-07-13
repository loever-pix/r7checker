// Emails a user their desktop CLI checker license key. Called when a BYO-proxy
// access pass is purchased (NOWPayments) or granted by the owner. The key is
// persistent per user; it only works while the subscription is active.

const store = require('./store');
const email = require('./email');

const APP_NAME = process.env.CLI_APP_NAME || 'R6Checker Desktop';
const DOWNLOAD_URL = process.env.CLI_DOWNLOAD_URL || `${process.env.SITE_URL || ''}/download`;

function buildText(key, expStr) {
  return [
    `Thanks for your purchase!`,
    ``,
    `Your ${APP_NAME} license key:`,
    ``,
    `    ${key}`,
    ``,
    `Access active until: ${expStr}`,
    DOWNLOAD_URL ? `Download the checker: ${DOWNLOAD_URL}` : '',
    ``,
    `Paste this key into the checker when it asks. Keep it private — it's tied`,
    `to your account. Renew your access pass on the website to keep it working.`,
  ].filter(Boolean).join('\n');
}

function buildHtml(key, expStr) {
  return `
    <div style="font-family:system-ui,Segoe UI,sans-serif;color:#e8eef7;background:#0c1424;padding:24px;border-radius:12px;max-width:520px">
      <h2 style="color:#5aa3ff;margin:0 0 12px">Your ${APP_NAME} key</h2>
      <p style="color:#7d8aa3;margin:0 0 16px">Thanks for your purchase! Paste this key into the checker when prompted.</p>
      <div style="font-family:ui-monospace,Consolas,monospace;font-size:20px;font-weight:700;letter-spacing:1px;background:#070d1a;border:1px solid #1a2540;border-radius:8px;padding:14px;text-align:center;color:#fff">${key}</div>
      <p style="color:#7d8aa3;margin:16px 0 0">Access active until <b style="color:#e8eef7">${expStr}</b>.</p>
      ${DOWNLOAD_URL ? `<p style="margin:12px 0 0"><a href="${DOWNLOAD_URL}" style="color:#5aa3ff">Download the checker</a></p>` : ''}
      <p style="color:#56607a;font-size:12px;margin:18px 0 0">Keep this key private — it's tied to your account. Renew your access pass on the website to keep it working.</p>
    </div>`;
}

// Generate (if needed) + email the key. Best-effort; never throws to callers.
// Returns { ok, key, to, error } so a caller (e.g. the owner "test purchase"
// button) can tell whether the email actually went out.
async function sendKey(userId, expiresAt) {
  try {
    const user = store.getUserById(userId);
    if (!user) return { ok: false, error: 'user not found' };
    const key = store.getOrCreateCliKey(userId);
    const expStr = expiresAt ? new Date(expiresAt).toUTCString() : 'while your access is active';
    await email.send({
      to: user.email,
      subject: `Your ${APP_NAME} license key`,
      text: buildText(key, expStr),
      html: buildHtml(key, expStr),
    });
    console.log(`[keyMailer] emailed CLI key to user ${userId} (${user.email})`);
    return { ok: true, key, to: user.email };
  } catch (e) {
    console.warn('[keyMailer] failed:', e.message);
    return { ok: false, error: e.message };
  }
}

module.exports = { sendKey };
