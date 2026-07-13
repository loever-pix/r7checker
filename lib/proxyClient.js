// DataImpulse proxy client.
//
// Every request goes through the rotating residential gateway, so each call
// gets a fresh (US) residential IP. This is a drop-in axios replacement used
// for all outbound Ubisoft / data calls.
//
// Credentials are resolved DYNAMICALLY (not frozen at module load) so the owner
// can change them from the dashboard and have them take effect immediately with
// no restart. Resolution order: runtime override file (.cache/proxy-config.json,
// written by the owner endpoint) → environment → built-in default.
//
// Configure via env (defaults / fallback):
//   USE_PROXY=true                              ← on by default; set 'false' to go direct
//   PROXY_HOST=gw.dataimpulse.com
//   PROXY_PORT=823
//   PROXY_USER=<gateway-user>                   ← e.g. `__cr.us` suffix targets US
//   PROXY_PASS=<gateway-pass>                    ← REDACTED for public distribution

const fs    = require('fs');
const path  = require('path');
const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { HttpProxyAgent }  = require('http-proxy-agent');
const { cachedLookup }    = require('./dnsCache');

// Shared agent options — TTL-cached DNS for the gateway hostname so a fresh
// agent per request still gets sub-ms hostname resolution.
const AGENT_OPTS = { lookup: cachedLookup };

const CONFIG_PATH = path.join(
  process.env.CACHE_DIR || path.join(__dirname, '..', '.cache'),
  'proxy-config.json'
);

// REDACTED for public distribution — hardcoded fallback creds removed.
// Set PROXY_HOST / PROXY_PORT / PROXY_USER / PROXY_PASS in .env (see .env.example).
// USE_PROXY=false runs direct (no proxy) — fine for local dev.
const DEFAULTS = {
  useProxy: process.env.USE_PROXY === 'true',
  host: process.env.PROXY_HOST || 'proxy.example.com',
  port: String(process.env.PROXY_PORT || '8080'),
  user: process.env.PROXY_USER || '',
  pass: process.env.PROXY_PASS || '',
};

// Read the owner-written override file (if any). Only fields present override.
function readOverrides() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) || {}; }
  catch { return {}; }
}

// In-memory live config. Initialised from env+file at load; mutated in-process
// by setProxyConfig so changes apply instantly with zero per-request fs cost.
let CURRENT = (() => {
  const o = readOverrides();
  return {
    useProxy: o.useProxy != null ? !!o.useProxy : DEFAULTS.useProxy,
    host: o.host || DEFAULTS.host,
    port: String(o.port || DEFAULTS.port),
    user: o.user != null ? o.user : DEFAULTS.user,
    pass: o.pass != null ? o.pass : DEFAULTS.pass,
  };
})();

function getProxyConfig() { return { ...CURRENT }; }

// Owner-facing view: never leak the full password.
function getProxyConfigPublic() {
  const c = CURRENT;
  const mask = (s) => {
    s = String(s || '');
    if (!s) return '';
    if (s.length <= 4) return '••••';
    return s.slice(0, 2) + '•'.repeat(Math.max(4, s.length - 4)) + s.slice(-2);
  };
  return { useProxy: c.useProxy, host: c.host, port: c.port, user: c.user, passMasked: mask(c.pass), hasPass: !!c.pass };
}

function persist() {
  try {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(CURRENT), { mode: 0o600 });
    try { fs.chmodSync(CONFIG_PATH, 0o600); } catch {}
  } catch (e) { console.warn('[proxy] persist failed:', e.message); }
}

// Update live config (and persist). Accepts a partial patch; only provided
// fields change. Returns the new public view.
function setProxyConfig(patch = {}) {
  const next = { ...CURRENT };
  if (patch.useProxy != null) next.useProxy = !!patch.useProxy;
  if (patch.host  != null && String(patch.host).trim())  next.host = String(patch.host).trim();
  if (patch.port  != null && String(patch.port).trim())  next.port = String(patch.port).trim();
  if (patch.user  != null && String(patch.user).trim())  next.user = String(patch.user).trim();
  // Only change the password when a non-empty one is supplied (so the UI can
  // submit the form without re-typing the password to tweak other fields).
  if (patch.pass  != null && String(patch.pass) !== '')  next.pass = String(patch.pass);
  CURRENT = next;
  persist();
  return getProxyConfigPublic();
}

function proxyUrlFrom(c) {
  const auth = c.user && c.pass ? `${encodeURIComponent(c.user)}:${encodeURIComponent(c.pass)}@` : '';
  return `http://${auth}${c.host}:${c.port}`;
}
function proxyUrl() { return proxyUrlFrom(CURRENT); }

// Fresh agents per request → rotating gateway hands out a new IP each time.
function makeAgents() {
  const url = proxyUrl();
  return { http: new HttpProxyAgent(url, AGENT_OPTS), https: new HttpsProxyAgent(url, AGENT_OPTS) };
}

// Drop-in axios replacement. Routes through DataImpulse when enabled,
// otherwise a plain direct request.
async function proxiedRequest(config) {
  if (!CURRENT.useProxy) return axios({ timeout: 15000, ...config });
  const agents = makeAgents();
  return axios({
    ...config,
    httpAgent:  agents.http,
    httpsAgent: agents.https,
    proxy:      false,
    timeout:    config.timeout ?? 15000,
  });
}

proxiedRequest.get  = (url, config = {}) => proxiedRequest({ ...config, method: 'get',  url });
proxiedRequest.post = (url, data, config = {}) => proxiedRequest({ ...config, method: 'post', url, data });
proxiedRequest.put  = (url, data, config = {}) => proxiedRequest({ ...config, method: 'put',  url, data });
proxiedRequest.head = (url, config = {}) => proxiedRequest({ ...config, method: 'head', url });

function isProxyEnabled() { return !!CURRENT.useProxy; }

// Verify a set of proxy creds actually works by fetching an IP echo through it.
// Used by the owner endpoint to validate before saving. `cfgOverride` lets the
// caller test creds WITHOUT committing them. Returns { ok, ip, ms, error }.
async function testProxy(cfgOverride) {
  const c = { ...CURRENT, ...(cfgOverride || {}) };
  if (!c.useProxy) return { ok: true, direct: true };
  const url = proxyUrlFrom(c);
  const t0 = Date.now();
  try {
    const res = await axios({
      method: 'get', url: 'https://api.ipify.org?format=json',
      httpAgent: new HttpProxyAgent(url, AGENT_OPTS), httpsAgent: new HttpsProxyAgent(url, AGENT_OPTS),
      proxy: false, timeout: 20000, validateStatus: () => true,
    });
    if (res.status === 200 && res.data?.ip) return { ok: true, ip: res.data.ip, ms: Date.now() - t0 };
    return { ok: false, error: `HTTP ${res.status}`, ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, error: e.message, ms: Date.now() - t0 };
  }
}

module.exports = {
  proxiedRequest,
  isProxyEnabled,
  isAnyRotationEnabled: isProxyEnabled, // back-compat alias (player.js / rankSources.js)
  proxyUrl,
  getProxyConfig,
  getProxyConfigPublic,
  setProxyConfig,
  testProxy,
};
