'use strict';
// Multi-process orchestrator. The single biggest desktop throughput win.
//
// Why: each Node process gets its own libuv thread pool (capped at 64 by main.js
// via UV_THREADPOOL_SIZE). Worker_threads inside one process all SHARE that
// single 64-slot pool for DNS/TLS, so per-process throughput plateaus once the
// pool saturates. Forking N child processes multiplies the effective libuv
// budget Nx — what 1 process can do at ~150/s, 4 procs can do at ~500/s.
//
// Mechanism:
//   1. Round-robin-split the accounts file into N chunks.
//   2. Spawn N copies of the SAME exe (process.execPath) with R6_WORKER_CHILD=1
//      and a slice file each. The child path falls through to runner.run()
//      against its slice (the env-flag prevents recursive forking).
//   3. Aggregate per-child stdout status lines into ONE live dashboard.
//   4. On completion, concatenate per-child output buckets into top-level files.
//
// Output layout:
//   output/run_<stamp>/
//     valid.txt   invalid.txt   2fa.txt   banned.txt   errors.txt   results.txt
//     proc_0/...  proc_1/...  proc_N-1/...     ← per-child runner output
//     accounts_split/p<i>.txt                  ← input slice handed to child i

const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');
const log = require('./logger');
const { applyProxyPoolTuning, childEnv } = require('./speed');
const { buildRunResult, countOutputLines } = require('./runStatus');
const { createStallWatch } = require('./stallWatch');
const { resolveBucketPath, commitPartialFiles } = require('./outputFiles');

const BUCKETS = ['valid.txt', 'invalid.txt', '2fa.txt', 'banned.txt', 'errors.txt', 'results.txt'];

function splitAccountsRoundRobin(input, N) {
  const lines = fs.readFileSync(input, 'utf8').split(/\r?\n/).filter(l => l.trim());
  const chunks = Array.from({ length: N }, () => []);
  lines.forEach((line, i) => chunks[i % N].push(line));
  return { lines, chunks };
}

function fmtDuration(sec) {
  if (!Number.isFinite(sec)) return '—';
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
}

async function runMultiProcess(opts) {
  const { baseDir, input, licenseKey, onProgress, fastPass = false, enrich = true } = opts;
  const N = Math.max(1, Math.min(Number(opts.processes) || 1, os.cpus().length * 2));

  const proxyFp = path.join(baseDir, process.env.R6_PROXY_FILE || 'proxies.txt');
  const hasProxy = fs.existsSync(proxyFp) && fs.readFileSync(proxyFp, 'utf8').trim().replace(/^#.*$/gm, '').trim().length > 0;
  if (hasProxy) applyProxyPoolTuning({ hasProxy: true, processes: N });
  const perProcMax = parseInt(process.env.R6_MAX_CONCURRENCY || String(Math.min(192, Math.max(64, Math.floor(384 / N)))), 10) || 128;
  const perProcStart = parseInt(process.env.R6_START_CONCURRENCY || String(Math.min(perProcMax, 96)), 10) || 96;

  let aborted = false;
  const abortHandlers = [];
  const requestAbort = () => {
    if (aborted) return;
    aborted = true;
    for (const h of abortHandlers) { try { h(); } catch {} }
  };

  const total0 = (fs.readFileSync(input, 'utf8').match(/\n/g) || []).length + 1;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const runRoot = path.join(baseDir, 'output', `run_${stamp}`);
  const splitDir = path.join(runRoot, 'accounts_split');
  fs.mkdirSync(splitDir, { recursive: true });

  const { lines, chunks } = splitAccountsRoundRobin(input, N);
  log.info(`Multi-process: ${N} children × ${Math.ceil(lines.length / N)} accounts each (total ${lines.length}).`);

  // Write each slice + spawn its child.
  const children = chunks.map((chunk, i) => {
    const subDir = path.join(runRoot, `proc_${i}`);
    const childOutBase = path.join(subDir, 'output');   // runner.js appends run_<stamp> under this
    fs.mkdirSync(childOutBase, { recursive: true });
    const sliceFile = path.join(splitDir, `p${i}.txt`);
    fs.writeFileSync(sliceFile, chunk.join('\n'));

    // The child can be either a SEA exe (process.execPath === the .exe) or a
    // Node invocation in dev (process.execPath === node, plus our entry script).
    const isSea = (() => { try { return !!require('node:sea').isSea(); } catch { return false; } })();
    const cmd = process.execPath;
    const baseArgs = isSea ? [] : [process.argv[1]];
    const args = [...baseArgs, '--input', sliceFile, '--key', licenseKey];

    const env = childEnv({
      ...process.env,
      R6_WORKER_CHILD: '1',
      R6_OUTPUT_DIR: childOutBase,
      R6_QUIET: '1',
      R6_LOG_LEVEL: 'error',
      R6_MAX_CONCURRENCY: String(perProcMax),
      R6_START_CONCURRENCY: String(perProcStart),
      R6_PROCESSES: '1',
    }, { fastPass, enrich });

    const proc = childProcess.spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const state = { idx: i, subDir, proc, done: 0, valid: 0, invalid: 0, twofa: 0, banned: 0, error: 0, exited: false, code: null };

    // Children don't post structured progress yet, so we read their queue
    // state.json (already written by queue.persist()) for cursor / cps.
    proc.stdout.on('data', (d) => { /* logs silenced; ignore */ });
    proc.stderr.on('data', (d) => { /* logs silenced; ignore */ });
    proc.on('exit', (code) => { state.exited = true; state.code = code; });

    abortHandlers.push(() => {
      try { proc.kill('SIGTERM'); } catch {}
      setTimeout(() => { try { if (!state.exited) proc.kill('SIGKILL'); } catch {} }, 2000);
    });

    return state;
  });

  if (typeof opts.onControls === 'function') {
    opts.onControls({
      stop: () => {
        requestAbort();
        if (typeof opts.onProgress === 'function') {
          opts.onProgress({ done: 0, total: total0, cps: 0, phase: 'stopping', aborted: true });
        }
      },
    });
  }

  // Aggregate progress via per-child output dirs. Each child's runner writes
  // BUCKETS files into its proc_<i>/run_<stamp>/. We sample line counts every
  // 1.5s for a live aggregate.
  function sampleChildProgress(c) {
    try {
      // Each child creates output/run_<stamp> INSIDE R6_OUTPUT_DIR (which is proc_<i>).
      // Find the latest run_<stamp> subdir.
      const dirs = fs.readdirSync(path.join(c.subDir, 'output')).filter(n => n.startsWith('run_'));
      if (!dirs.length) return;
      dirs.sort();
      const latest = path.join(c.subDir, 'output', dirs[dirs.length - 1]);
      for (const f of BUCKETS) {
        const fp = path.join(latest, f);
        const src = resolveBucketPath(latest, f);
        if (!src) continue;
        // Count newlines without buffering the whole file (good for huge outputs).
        const buf = Buffer.alloc(65536);
        const fd = fs.openSync(src, 'r');
        let count = 0; let r;
        try { while ((r = fs.readSync(fd, buf, 0, buf.length)) > 0) for (let i = 0; i < r; i++) if (buf[i] === 0x0A) count++; }
        finally { fs.closeSync(fd); }
        if (f === 'valid.txt')   c.valid   = count;
        if (f === 'invalid.txt') c.invalid = count;
        if (f === '2fa.txt')     c.twofa   = count;
        if (f === 'banned.txt')  c.banned  = count;
        if (f === 'errors.txt')  c.error   = count;
      }
      c.done = c.valid + c.invalid + c.twofa + c.banned + c.error;
    } catch { /* not ready yet */ }
  }

  const startedAt = Date.now();
  let lastDone = 0; let lastSampleAt = startedAt;
  let lastAggDone = 0;
  let stalled = false;
  const stallWatch = createStallWatch({
    getDone: () => lastAggDone,
    label: 'multiproc',
    onStall: ({ stalledForMs, done }) => {
      stalled = true;
      log.warn(`Stall watchdog: no progress for ${Math.round(stalledForMs / 1000)}s at ${done}/${total0} — killing children.`);
      requestAbort();
    },
  });
  const render = () => {
    children.forEach(sampleChildProgress);
    const agg = children.reduce((a, c) => ({
      done: a.done + c.done, valid: a.valid + c.valid, invalid: a.invalid + c.invalid,
      twofa: a.twofa + c.twofa, banned: a.banned + c.banned, error: a.error + c.error,
    }), { done: 0, valid: 0, invalid: 0, twofa: 0, banned: 0, error: 0 });
    lastAggDone = agg.done;
    stallWatch.bump(agg.done);
    const now = Date.now();
    const pct = total0 ? ((agg.done / total0) * 100).toFixed(1) : '0.0';
    const cps = Math.max(0, (agg.done - lastDone) / Math.max(0.001, (now - lastSampleAt) / 1000));
    lastDone = agg.done; lastSampleAt = now;
    const elapsed = (now - startedAt) / 1000;
    const eta = cps > 0 ? (total0 - agg.done) / cps : Infinity;
    const live = children.filter(c => !c.exited).length;
    const snap = {
      done: agg.done, total: total0, valid: agg.valid, invalid: agg.invalid,
      twofa: agg.twofa, banned: agg.banned, error: agg.error, cps, processes: N, live,
    };
    if (typeof onProgress === 'function') { try { onProgress(snap); } catch {} }
    const title = `MP × ${N} | ${agg.valid}V ${agg.invalid}I ${agg.twofa}2F ${agg.banned}B ${agg.error}E | ${agg.done}/${total0} (${pct}%) | ${cps.toFixed(1)}/s`;
    process.stdout.write(`\x1b]0;${title}\x07`);
    process.stdout.write(
      `\r\x1b[K` +
      `\x1b[36m[mp×${N}]\x1b[0m ` +
      `\x1b[32m✓${agg.valid}\x1b[0m \x1b[31m✗${agg.invalid}\x1b[0m \x1b[33m2FA ${agg.twofa}\x1b[0m ban ${agg.banned} err ${agg.error} ` +
      `\x1b[90m| ${agg.done}/${total0} ${pct}%\x1b[0m | ` +
      `\x1b[36m${cps.toFixed(1)}/s\x1b[0m | live ${live}/${N} | ` +
      `${fmtDuration(elapsed)} eta ${fmtDuration(eta)}`
    );
  };
  const renderTimer = setInterval(render, 1500);
  renderTimer.unref();

  // Wait for children to exit. On abort/stall, don't wait forever — kill and merge.
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
      if (aborted && !abortTimer) {
        // After abort, give SIGKILL window then continue even if a child hangs.
        abortTimer = setTimeout(finish, 4500);
      }
    }, 500);
    check();
  });
  stallWatch.stop();
  clearInterval(renderTimer);
  render(); process.stdout.write('\n');

  // Final aggregate for completion checks.
  children.forEach(sampleChildProgress);
  const finalAgg = children.reduce((a, c) => ({
    done: a.done + c.done, valid: a.valid + c.valid, invalid: a.invalid + c.invalid,
    twofa: a.twofa + c.twofa, banned: a.banned + c.banned, error: a.error + c.error,
  }), { done: 0, valid: 0, invalid: 0, twofa: 0, banned: 0, error: 0 });
  const childCrashed = !aborted && children.some((c) => c.code !== 0 && c.code != null);
  const processed = Math.max(finalAgg.done, countOutputLines(runRoot));

  // Merge per-child output buckets into top-level runRoot files.
  log.info(aborted ? 'Merging partial output (stopped early)…' : 'Merging per-child output...');
  for (const bucket of BUCKETS) {
    const dest = path.join(runRoot, bucket);
    const ws = fs.createWriteStream(dest);
    for (const c of children) {
      try {
        const dirs = fs.readdirSync(path.join(c.subDir, 'output')).filter(n => n.startsWith('run_'));
        if (!dirs.length) continue;
        const latest = path.join(c.subDir, 'output', dirs.sort()[dirs.length - 1]);
        const src = resolveBucketPath(latest, bucket);
        if (!src) continue;
        await new Promise((resolve, reject) => {
          const rs = fs.createReadStream(src);
          rs.on('error', reject); rs.on('end', resolve);
          rs.pipe(ws, { end: false });
        });
      } catch (e) { log.warn(`merge ${bucket} from proc_${c.idx}: ${e.message}`); }
    }
    await new Promise((resolve) => ws.end(resolve));
  }
  log.info(`Done. Merged output: ${runRoot}`);
  commitPartialFiles(runRoot);

  if (childCrashed) {
    log.warn(`One or more worker processes exited with an error — ${processed}/${total0} lines saved. Resume to continue.`);
  } else if (!aborted && processed < total0) {
    log.warn(`Run incomplete — ${processed}/${total0} lines saved. Resume to continue.`);
  }

  const hardCrash = !aborted && !stalled && children.some((c) => {
    if (c.signal) return true;
    if (c.code === 0 || c.code == null) return false;
    return c.done === 0 && c.code !== 0 && c.code !== 1;
  });
  return buildRunResult({
    outDir: runRoot,
    total: total0,
    processed,
    stopped: aborted && !stalled,
    stalled,
    crashed: hardCrash,
    reason: stalled ? 'stalled' : (aborted ? 'stopped' : (hardCrash ? 'child-crash' : null)),
  });
}

module.exports = { runMultiProcess };
