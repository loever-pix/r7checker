'use strict';
// Control plane client — talks to the VPS for the ONLY two things the VPS does
// in this architecture: license/subscription verification and update checks.
// It NEVER submits jobs or accounts. All compute is local.

const https = require('https');
const http = require('http');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const childProcess = require('child_process');
const { config } = require('./config');

// Stable per-machine HWID (matches the desktop checker's existing scheme:
// hostname + platform + cpu model + arch, hashed). Used for the HWID lock.
function hwid() {
  try {
    const parts = [os.hostname(), os.platform(), os.arch(), (os.cpus()[0] || {}).model || ''];
    return crypto.createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 32);
  } catch {
    return crypto.createHash('sha256').update(String(Date.now())).digest('hex').slice(0, 32);
  }
}

function request(method, urlStr, { headers = {}, body = null, timeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch (e) { return reject(e); }
    const lib = u.protocol === 'http:' ? http : https;
    const data = body != null ? JSON.stringify(body) : null;
    const req = lib.request({
      method,
      hostname: u.hostname,
      port: u.port || (u.protocol === 'http:' ? 80 : 443),
      path: u.pathname + u.search,
      headers: {
        Accept: 'application/json',
        'x-hwid': hwid(),
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
        ...headers,
      },
      timeout: timeoutMs || config.controlPlane.timeoutMs,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let parsed = null;
        const text = Buffer.concat(chunks).toString('utf8');
        try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('control-plane request timed out')));
    if (data) req.write(data);
    req.end();
  });
}

const base = () => config.controlPlane.baseUrl;

function buildWebsiteActivationUrl({ callback, hwid: deviceId = hwid() }) {
  const u = new URL(base() + '/api/cli/activate');
  u.searchParams.set('hwid', deviceId);
  u.searchParams.set('callback', callback);
  return u;
}

function browserOpenCommand(url, platform = process.platform) {
  const href = url.toString();
  if (platform === 'win32') return { command: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', href], windowsHide: true };
  if (platform === 'darwin') return { command: 'open', args: [href] };
  return { command: 'xdg-open', args: [href] };
}

function openBrowser(url) {
  const launch = browserOpenCommand(url);
  childProcess.spawn(launch.command, launch.args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: !!launch.windowsHide,
  }).unref();
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderActivationSuccessPage({ email = '' } = {}) {
  const safeEmail = escapeHtml(email);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>R6Checker Desktop Activated</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #090d14;
      --panel: #111826;
      --panel-2: #151f30;
      --line: #263247;
      --text: #eef3fb;
      --muted: #9ba8bb;
      --brand: #3a8dff;
      --ok: #35d08a;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 24px;
      background: var(--bg);
      color: var(--text);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      letter-spacing: 0;
    }
    main {
      width: min(560px, 100%);
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel);
      box-shadow: 0 18px 60px rgba(0, 0, 0, .36);
      overflow: hidden;
    }
    .bar {
      height: 4px;
      background: linear-gradient(90deg, var(--brand), var(--ok));
    }
    .content { padding: 28px; }
    .brand {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 24px;
    }
    .mark {
      width: 40px;
      height: 40px;
      display: grid;
      place-items: center;
      border-radius: 8px;
      background: var(--panel-2);
      border: 1px solid var(--line);
      color: var(--brand);
      font-weight: 800;
    }
    .name { font-size: 14px; color: var(--muted); }
    h1 {
      margin: 0 0 10px;
      font-size: 26px;
      line-height: 1.15;
      letter-spacing: 0;
    }
    p {
      margin: 0;
      color: var(--muted);
      line-height: 1.55;
      font-size: 15px;
    }
    .account {
      margin: 22px 0;
      padding: 14px 16px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel-2);
      color: var(--text);
      font-size: 14px;
      overflow-wrap: anywhere;
    }
    .actions {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
      align-items: center;
    }
    button {
      border: 0;
      border-radius: 6px;
      padding: 11px 14px;
      background: var(--brand);
      color: white;
      font-weight: 700;
      cursor: pointer;
    }
    .hint { font-size: 13px; color: var(--muted); }
  </style>
</head>
<body>
  <main>
    <div class="bar"></div>
    <section class="content">
      <div class="brand">
        <div class="mark">R6</div>
        <div>
          <strong>R6Checker Desktop</strong>
          <div class="name">Website activation complete</div>
        </div>
      </div>
      <h1>Desktop app activated</h1>
      <p>Your desktop checker is linked to your website account and this device.</p>
      ${safeEmail ? `<div class="account">Signed in as <strong>${safeEmail}</strong></div>` : ''}
      <div class="actions">
        <button type="button" onclick="window.close()">Close tab</button>
        <span class="hint">Return to the R6Checker window to continue.</span>
      </div>
    </section>
  </main>
</body>
</html>`;
}

function waitForWebsiteActivation({ timeoutMs = 120000, opener = openBrowser } = {}) {
  return new Promise((resolve) => {
    const state = crypto.randomBytes(16).toString('hex');
    let server;
    let settled = false;
    let timer;

    function finish(result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { server.close(); } catch {}
      resolve(result);
    }

    server = http.createServer((req, res) => {
      let u;
      try { u = new URL(req.url, 'http://127.0.0.1'); } catch {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Invalid activation response.');
        return;
      }
      if (u.pathname !== '/callback' || u.searchParams.get('state') !== state) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not found.');
        return;
      }
      const key = u.searchParams.get('key') || '';
      const email = u.searchParams.get('email') || '';
      if (!key) {
        const reason = u.searchParams.get('error') || 'missing license key';
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Desktop activation failed. You can close this tab and return to the app.');
        finish({ ok: false, reason });
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderActivationSuccessPage({ email }));
      finish({ ok: true, key, account: { email } });
    });

    server.on('error', (e) => finish({ ok: false, reason: e.message }));
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const callback = `http://127.0.0.1:${address.port}/callback?state=${state}`;
      const url = buildWebsiteActivationUrl({ callback });
      try { opener(url); } catch (e) { finish({ ok: false, reason: e.message }); return; }
      timer = setTimeout(() => finish({ ok: false, reason: 'website activation timed out' }), timeoutMs);
      if (timer.unref) timer.unref();
    });
  });
}

async function activateWithWebsite(opts = {}) {
  return waitForWebsiteActivation(opts);
}

// Locally-minted owner license (see main.js mintOwnerLicense). Recognized
// without a network round-trip so the desktop checker keeps working when the
// VPS is down. Not a security boundary — anyone who manages to forge one still
// only unlocks LOCAL compute; the VPS continues to verify keys for everything
// else (web checks, paid jobs).
function isOwnerLicense(key) { return typeof key === 'string' && key.startsWith('OWNER-'); }

// Verify the license/subscription with the current key + HWID. Returns
// { ok, account, reason }. The server enforces the HWID lock and unlimited flag.
async function verifyLicense(key) {
  if (!key) return { ok: false, reason: 'no license key' };
  if (isOwnerLicense(key)) return { ok: true, account: { email: 'owner (local)', unlimited: true, offline: true } };
  try {
    const r = await request('GET', base() + config.controlPlane.licensePath, { headers: { 'x-api-key': key } });
    if (r.status === 200 && r.body && (r.body.ok !== false)) {
      return { ok: true, account: r.body };
    }
    if (r.status === 401 || r.status === 403) return { ok: false, reason: r.body?.error || 'license invalid or HWID locked' };
    return { ok: false, reason: `license check HTTP ${r.status}` };
  } catch (e) {
    // Network down → degrade gracefully: caller decides whether to allow an
    // offline grace period. We report the network failure distinctly.
    return { ok: false, offline: true, reason: e.message };
  }
}

// Exchange email + password for a license key (first-run activation).
async function login(email, password) {
  const r = await request('POST', base() + config.controlPlane.loginPath, { body: { email, password } });
  if (r.status === 200 && r.body && r.body.key) return { ok: true, key: r.body.key, account: r.body };
  return { ok: false, reason: r.body?.error || `login HTTP ${r.status}` };
}

// Stream a local results file to the website so a finished/stopped local run
// shows up in the user's web Bulk Jobs for easy download. Best-effort: returns
// { ok, jobId, total, url } or { ok:false, reason }. Skipped for the local
// OWNER- key (the server doesn't know it) — that path stays fully offline.
function uploadResults(key, filePath, { stopped = false } = {}) {
  return new Promise((resolve) => {
    if (!key || isOwnerLicense(key)) return resolve({ ok: false, reason: 'offline key' });
    let size = 0;
    try { size = fs.statSync(filePath).size; } catch { return resolve({ ok: false, reason: 'no results file' }); }
    if (!size) return resolve({ ok: false, reason: 'empty results' });
    let u;
    try { u = new URL(base() + '/api/cli/bulk/upload' + (stopped ? '?stopped=1' : '')); } catch (e) { return resolve({ ok: false, reason: e.message }); }
    const lib = u.protocol === 'http:' ? http : https;
    const req = lib.request({
      method: 'POST', hostname: u.hostname, port: u.port || (u.protocol === 'http:' ? 80 : 443),
      path: u.pathname + u.search,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': size, 'x-api-key': key, 'x-hwid': hwid() },
      timeout: 10 * 60 * 1000, // big result files take a while to upload
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let body = null; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {}
        if (res.statusCode === 200 && body) resolve({ ok: true, ...body });
        else resolve({ ok: false, reason: (body && body.error) || `HTTP ${res.statusCode}` });
      });
    });
    req.on('error', (e) => resolve({ ok: false, reason: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, reason: 'upload timed out' }); });
    fs.createReadStream(filePath).pipe(req);
  });
}

// Check for a newer build. Returns { current, latest, updateAvailable, url }.
// brand (optional) routes the update to the matching exe (r6checker | ubivm).
async function checkUpdate(currentVersion, brand) {
  try {
    const sep = config.controlPlane.updatePath.includes('?') ? '&' : '?';
    const updatePath = config.controlPlane.updatePath + (brand ? `${sep}brand=${encodeURIComponent(brand)}` : '');
    const r = await request('GET', base() + updatePath, {});
    const latest = r.body && (r.body.version || r.body.latest);
    if (r.status === 200 && latest) {
      return { current: currentVersion, latest, updateAvailable: cmpVersion(latest, currentVersion) > 0, url: r.body.url || null };
    }
  } catch { /* update check is best-effort */ }
  return { current: currentVersion, latest: currentVersion, updateAvailable: false, url: null };
}

function cmpVersion(a, b) {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

module.exports = {
  hwid,
  verifyLicense,
  login,
  checkUpdate,
  isOwnerLicense,
  uploadResults,
  buildWebsiteActivationUrl,
  browserOpenCommand,
  renderActivationSuccessPage,
  activateWithWebsite,
};
