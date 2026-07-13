'use strict';
// Inline pipeline: fast login sweep + background full capture on hits.
// Invalids write immediately; hits enrich inline — no hollow valids, no pass-2 wait.

const fs = require('fs');
const path = require('path');
const os = require('os');
const childProcess = require('child_process');
const { config, intEnv } = require('./config');
const log = require('./logger');
const { JobQueue, loadJobs } = require('./queue');
const { EnrichQueue } = require('./enrichQueue');
const { ResultWriter } = require('./writer');
const { Metrics } = require('./metrics');
const { CircuitBreaker } = require('./circuit-breaker');
const { WorkerPool } = require('./pool');
const { setupDesktopGovernor } = require('./governorSetup');
const { buildRunResult } = require('./runStatus');
const { pickProcessCount, applyPipelineTuning } = require('./speed');
const { createStallWatch } = require('./stallWatch');
const { resolveBucketPath, commitPartialFiles } = require('./outputFiles');
const { run } = require('./runner');

const BUCKETS = ['valid.txt', 'invalid.txt', '2fa.txt', 'banned.txt', 'errors.txt', 'results.txt'];

function isSea() { try { return !!require('node:sea').isSea(); } catch { return false; } }

function resolveWorkerSpec() {
  try {
    const sea = require('node:sea');
    if (sea && sea.isSea && sea.isSea()) {
      return { source: sea.getAsset('check-worker', 'utf8') };
    }
  } catch {}
  const bundled = path.join(__dirname, '..', 'worker.bundle.js');
  if (fs.existsSync(bundled)) return { file: bundled };
  return { file: path.join(__dirname, 'check-worker.js') };
}

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
  if (line && line.includes(' | User: ')) {
    await writer.write('valid', 'valid.txt', line);
    await writer.write('all', 'results.txt', line);
  } else if (msg.status === 'valid') {
    await writer.write('errors', 'errors.txt', `${job.item.line} | capture incomplete — will retry on resume`);
  }
}

function applyPipelineRetryTuning() {
  if (!process.env.R6_RETRY_SLOW_MS) config.retry.slowLaneMs = 3000;
  if (!process.env.R6_RETRY_MAX) config.retry.maxAttempts = 14;
  if (!process.env.R6_RETRY_SLOW_MAX) config.retry.slowLaneMax = 20;
  if (!process.env.R6_WORKER_TIMEOUT_MS) config.pool.workerTimeoutMs = 90000;
  if (!process.env.R6_LOGIN_ATTEMPTS) process.env.R6_LOGIN_ATTEMPTS = '4';
}

async function runPipelineSingle(opts = {}) {
  const key = opts.licenseKey || process.env.R6_LICENSE_KEY;
  if (!key) return buildRunResult({ ok: false, reason: 'license' });

  // Small lists: full inline capture in one pool (no sweep/enrich split).
  if ((opts.totalLines || 0) > 0 && opts.totalLines < intEnv('R6_PIPELINE_MIN', 2000, 100, 100000000)) {
    return run({ ...opts, quiet: opts.quiet !== false });
  }

  applyPipelineRetryTuning();
  const gov = setupDesktopGovernor({ processes: 1 });
  const enrichConc = intEnv('R6_ENRICH_CONCURRENCY', 24, 4, 128);

  const baseDir = opts.baseDir || (isSea() ? path.dirname(process.execPath) : process.cwd());
  const quiet = opts.quiet !== false;
  const onResult = typeof opts.onResult === 'function' ? opts.onResult : null;
  log.setLevel(quiet ? 'error' : config.logLevel);

  const inputPath = opts.input || path.join(baseDir, 'accounts.txt');
  const items = loadJobs(inputPath);
  if (!items.length) return buildRunResult({ ok: false, reason: 'empty' });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outDir = opts.resumeDir || path.join(config.output.dir || path.join(baseDir, 'output'), `run_${stamp}`);
  fs.mkdirSync(outDir, { recursive: true });
  log.attachFile(path.join(outDir, 'run.log'));

  const sweepQueue = new JobQueue(items, path.join(outDir, 'state.json'));
  const resumed = sweepQueue.restore();
  const enrichQueue = new EnrichQueue();
  const writer = new ResultWriter(outDir);
  const metrics = new Metrics({ total: items.length });
  metrics.counts.done = resumed;

  const { loadProxies, probeProxies } = require('./runner');
  let proxies = loadProxies(baseDir, (m) => log.warn(m));
  if (proxies.length && process.env.R6_SKIP_PROXY_PROBE !== '1') {
    const live = await probeProxies(proxies, log);
    if (live.length) proxies = live;
  }
  applyPipelineTuning({ hasProxy: proxies.length > 0, processes: 1 });

  const workerSpec = resolveWorkerSpec();
  const enrichProxy = proxies[0] || null;
  let writeChain = Promise.resolve();
  let shuttingDown = false;
  let shutdownPromise = null;
  let enrichPending = 0;

  const sweepBreaker = new CircuitBreaker();
  const enrichBreaker = new CircuitBreaker();

  const sweepPool = new WorkerPool({
    name: 'sweep',
    workerSpec,
    workerData: { sweepOnly: true, fastPass: true, enrich: false, enrichProxy, requestTimeoutMs: config.check.requestTimeoutMs },
    proxies, queue: sweepQueue, breaker: sweepBreaker, metrics, governor: gov,
    startConcurrency: config.pool.startConcurrency,
  });

  const enrichPool = new WorkerPool({
    name: 'enrich',
    workerSpec,
    workerData: { enrichOnly: true, fastPass: false, enrich: true, enrichProxy, requestTimeoutMs: config.check.requestTimeoutMs },
    proxies, queue: enrichQueue, breaker: enrichBreaker, metrics,
    maxConcurrency: enrichConc,
    startConcurrency: Math.min(enrichConc, 12),
  });

  function emitResult(line, status) {
    if (onResult) { try { onResult(line, status, metrics.snapshot()); } catch {} }
  }

  sweepPool.on('needsEnrich', ({ job }) => {
    enrichPending++;
    enrichQueue.push(job.item);
    enrichPool._tick();
  });

  sweepPool.on('result', ({ job, msg }) => {
    writeChain = writeChain.then(async () => {
      await routeResult(writer, job, msg);
      emitResult(msg.line || job.item.line, msg.status);
    }).catch((e) => log.error('write failed: ' + e.message));
  });

  enrichPool.on('result', ({ job, msg }) => {
    writeChain = writeChain.then(async () => {
      await routeResult(writer, job, msg);
      emitResult(msg.line || job.item.line, msg.status);
      if (enrichPending > 0) enrichPending--;
    }).catch((e) => log.error('enrich write failed: ' + e.message));
  });

  const enrichKick = setInterval(() => { if (!shuttingDown) enrichPool._tick(); }, 200);
  if (enrichKick.unref) enrichKick.unref();

  let stallReason = null;
  const stallWatch = createStallWatch({
    getDone: () => metrics.counts.done + enrichQueue.completed,
    label: 'pipeline',
    onStall: ({ stalledForMs, done }) => {
      stallReason = `no progress for ${Math.round(stalledForMs / 1000)}s at ${done}/${items.length}`;
      log.warn(`Stall watchdog: ${stallReason} — force stopping.`);
      shutdown('stalled');
    },
  });

  async function shutdown(reason) {
    if (shuttingDown) return shutdownPromise;
    shuttingDown = true;
    clearInterval(enrichKick);
    stallWatch.stop();
    const userStop = reason === 'stopped' || reason === 'stalled';
    log.warn(userStop ? `Stopping pipeline (${reason})…` : `Shutdown (${reason})…`);
    const enrichDrainMs = enrichPending > 0
      ? intEnv('R6_ENRICH_DRAIN_MS', 45000, 5000, 180000)
      : (userStop ? 6000 : 20000);
    shutdownPromise = (async () => {
      await Promise.all([
        sweepPool.drain({ maxMs: userStop ? 4000 : 12000 }),
        enrichPool.drain({ maxMs: enrichDrainMs }),
      ]);
      await Promise.race([
        writeChain,
        new Promise((resolve) => setTimeout(resolve, 15000)),
      ]);
      try { sweepQueue.persist(); } catch { /* ignore */ }
      try { await writer.finalize(); } catch { await writer.flushPartial(); }
      commitPartialFiles(outDir);
    })();
    return shutdownPromise;
  }

  if (typeof opts.onControls === 'function') {
    // Fire-and-forget so S-key never blocks the UI thread waiting on drain.
    opts.onControls({ stop: () => { shutdown('stopped'); } });
  }

  let progressTimer = null;
  if (typeof opts.onProgress === 'function') {
    progressTimer = setInterval(() => {
      const s = metrics.snapshot();
      stallWatch.bump(s.done);
      try {
        opts.onProgress({
          done: s.done, total: s.total, valid: s.valid, invalid: s.invalid,
          twofa: s.twofa, banned: s.banned, error: s.error,
          cps: s.throughput, cpm: s.cpm, phase: 'pipeline',
        });
      } catch {}
    }, 1500);
    if (progressTimer.unref) progressTimer.unref();
  }

  log.info(`Pipeline: ${items.length.toLocaleString()} lines · sweep + inline enrich (gov min ${process.env.BULK_GOV_MIN_CONCURRENCY} conc).`);

  try {
    const enrichPoolDone = enrichPool.start();
    await sweepPool.start();
    enrichQueue.close();
    await enrichPoolDone;
  } finally {
    stallWatch.stop();
    clearInterval(enrichKick);
    if (progressTimer) clearInterval(progressTimer);
    if (shutdownPromise) await shutdownPromise;
  }

  if (!shuttingDown) {
    await Promise.race([
      writeChain,
      new Promise((resolve) => setTimeout(resolve, 15000)),
    ]);
    try { sweepQueue.persist(); } catch { /* ignore */ }
    try { await writer.finalize(); } catch { await writer.flushPartial(); }
    commitPartialFiles(outDir);
  }

  const processed = metrics.counts.done;
  const complete = sweepQueue.done && enrichQueue.done && !shuttingDown;
  return buildRunResult({
    outDir,
    total: items.length,
    processed,
    stopped: shuttingDown && !stallReason,
    stalled: !!stallReason,
    crashed: false,
    reason: stallReason || (!complete && shuttingDown ? 'stopped' : null),
  });
}

async function runPipelineMultiProcess(opts) {
  const { baseDir, input, licenseKey, onProgress, onControls } = opts;
  const N = pickProcessCount(opts.totalLines || 0);
  setupDesktopGovernor({ processes: N });
  applyPipelineTuning({ hasProxy: true, processes: N });

  const total0 = (fs.readFileSync(input, 'utf8').match(/\n/g) || []).length + 1;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const runRoot = path.join(baseDir, 'output', `run_${stamp}`);
  const splitDir = path.join(runRoot, 'accounts_split');
  fs.mkdirSync(splitDir, { recursive: true });

  const lines = fs.readFileSync(input, 'utf8').split(/\r?\n/).filter((l) => l.trim());
  const chunks = Array.from({ length: N }, () => []);
  lines.forEach((line, i) => chunks[i % N].push(line));

  let aborted = false;
  let stalled = false;
  const abortHandlers = [];
  const requestAbort = () => {
    if (aborted) return;
    aborted = true;
    for (const h of abortHandlers) { try { h(); } catch {} }
  };

  const children = chunks.map((chunk, i) => {
    const subDir = path.join(runRoot, `proc_${i}`);
    fs.mkdirSync(subDir, { recursive: true });
    const sliceFile = path.join(splitDir, `p${i}.txt`);
    fs.writeFileSync(sliceFile, chunk.join('\n'));

    const isSeaExe = isSea();
    const cmd = process.execPath;
    const args = isSeaExe ? [] : [process.argv[1]];
    args.push('--input', sliceFile, '--key', licenseKey, '--pipeline');

    const perMax = parseInt(process.env.BULK_GOV_MAX_CONCURRENCY || '96', 10) || 96;
    const env = {
      ...process.env,
      R6_WORKER_CHILD: '1',
      R6_PIPELINE: '1',
      R6_OUTPUT_DIR: path.join(subDir, 'output'),
      R6_QUIET: '1',
      R6_LOG_LEVEL: 'error',
      R6_PROCESSES: '1',
      // Children must not fork again; keep stall watchdog a bit looser than parent.
      R6_STALL_MS: process.env.R6_STALL_MS || '90000',
      BULK_GOV_MAX_CONCURRENCY: String(perMax),
      BULK_GOV_INITIAL_CONCURRENCY: String(Math.max(24, Math.floor(perMax / 2))),
    };

    const proc = childProcess.spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const state = { idx: i, subDir, proc, done: 0, valid: 0, invalid: 0, twofa: 0, banned: 0, error: 0, exited: false, code: null, signal: null };
    proc.on('exit', (code, signal) => { state.exited = true; state.code = code; state.signal = signal; });
    abortHandlers.push(() => {
      try { proc.kill('SIGTERM'); } catch {}
      setTimeout(() => { try { if (!state.exited) proc.kill('SIGKILL'); } catch {} }, 2000);
    });
    return state;
  });

  if (typeof onControls === 'function') {
    onControls({ stop: () => requestAbort() });
  }

  function sampleChild(c) {
    try {
      const dirs = fs.readdirSync(path.join(c.subDir, 'output')).filter((n) => n.startsWith('run_'));
      if (!dirs.length) return;
      const latest = path.join(c.subDir, 'output', dirs.sort().pop());
      for (const f of BUCKETS) {
        const src = resolveBucketPath(latest, f);
        if (!src) continue;
        const n = (fs.readFileSync(src, 'utf8').match(/\n/g) || []).length;
        if (f === 'valid.txt') c.valid = n;
        if (f === 'invalid.txt') c.invalid = n;
        if (f === '2fa.txt') c.twofa = n;
        if (f === 'banned.txt') c.banned = n;
        if (f === 'errors.txt') c.error = n;
      }
      c.done = c.valid + c.invalid + c.twofa + c.banned + c.error;
    } catch {}
  }

  let lastDone = 0;
  let lastSampleAt = Date.now();
  let lastAggDone = 0;
  const stallWatch = createStallWatch({
    getDone: () => lastAggDone,
    label: 'pipeline-mp',
    onStall: ({ stalledForMs, done }) => {
      stalled = true;
      log.warn(`Stall watchdog: no progress for ${Math.round(stalledForMs / 1000)}s at ${done}/${total0} — stopping children.`);
      requestAbort();
    },
  });

  const renderTimer = setInterval(() => {
    children.forEach(sampleChild);
    const agg = children.reduce((a, c) => ({
      done: a.done + c.done, valid: a.valid + c.valid, invalid: a.invalid + c.invalid,
      twofa: a.twofa + c.twofa, banned: a.banned + c.banned, error: a.error + c.error,
    }), { done: 0, valid: 0, invalid: 0, twofa: 0, banned: 0, error: 0 });
    lastAggDone = agg.done;
    stallWatch.bump(agg.done);
    const now = Date.now();
    const cps = Math.max(0, (agg.done - lastDone) / Math.max(0.001, (now - lastSampleAt) / 1000));
    lastDone = agg.done;
    lastSampleAt = now;
    if (typeof onProgress === 'function') {
      try {
        onProgress({
          done: agg.done, total: total0, valid: agg.valid, invalid: agg.invalid,
          twofa: agg.twofa, banned: agg.banned, error: agg.error, cps, processes: N,
          phase: 'pipeline',
        });
      } catch {}
    }
  }, 1500);
  renderTimer.unref();

  await new Promise((resolve) => {
    let settled = false;
    let abortTimer = null;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      if (abortTimer) clearTimeout(abortTimer);
      resolve();
    };
    const check = () => { if (children.every(c => c.exited)) finish(); };
    children.forEach(c => { if (!c.exited) c.proc.on('exit', check); });
    const poll = setInterval(() => {
      check();
      if (aborted && !abortTimer) abortTimer = setTimeout(finish, 4500);
    }, 500);
    check();
  });
  stallWatch.stop();
  clearInterval(renderTimer);

  for (const bucket of BUCKETS) {
    const dest = path.join(runRoot, bucket);
    const ws = fs.createWriteStream(dest);
    for (const c of children) {
      try {
        const dirs = fs.readdirSync(path.join(c.subDir, 'output')).filter((n) => n.startsWith('run_'));
        if (!dirs.length) continue;
        const src = resolveBucketPath(path.join(c.subDir, 'output', dirs.sort().pop()), bucket);
        if (!src) continue;
        await new Promise((resolve, reject) => {
          const rs = fs.createReadStream(src);
          rs.on('error', reject);
          rs.on('end', resolve);
          rs.pipe(ws, { end: false });
        });
      } catch {}
    }
    await new Promise((resolve) => ws.end(resolve));
  }

  children.forEach(sampleChild);
  const finalAgg = children.reduce((a, c) => ({
    done: a.done + c.done, valid: a.valid + c.valid, invalid: a.invalid + c.invalid,
    twofa: a.twofa + c.twofa, banned: a.banned + c.banned, error: a.error + c.error,
  }), { done: 0, valid: 0, invalid: 0, twofa: 0, banned: 0, error: 0 });
  // Exit code 1 often means "incomplete" (child sets exitCode from !complete), not a hard crash.
  // Treat signal kills / null code with zero output as real crashes.
  const hardCrash = !aborted && !stalled && children.some((c) => {
    if (c.signal) return true;
    if (c.code === 0 || c.code == null) return false;
    return c.done === 0 && c.code !== 0 && c.code !== 1;
  });

  commitPartialFiles(runRoot);
  return buildRunResult({
    outDir: runRoot,
    total: total0,
    processed: finalAgg.done,
    stopped: aborted && !stalled,
    stalled,
    crashed: hardCrash,
    reason: stalled ? 'stalled' : (aborted ? 'stopped' : (hardCrash ? 'child-crash' : null)),
  });
}

async function runPipeline(opts = {}) {
  const total = opts.totalLines || loadJobs(opts.input || path.join(opts.baseDir, 'accounts.txt')).length;
  const N = pickProcessCount(total);
  if (N > 1 && !opts.resumeDir && process.env.R6_WORKER_CHILD !== '1') {
    return runPipelineMultiProcess({ ...opts, totalLines: total, processes: N });
  }
  return runPipelineSingle({ ...opts, totalLines: total });
}

module.exports = { runPipeline, runPipelineSingle, runPipelineMultiProcess };
