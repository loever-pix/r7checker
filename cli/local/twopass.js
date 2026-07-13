'use strict';
// Two-pass bulk check for huge lists:
//   Pass 1 — fast login sweep (multiproc + fastPass): invalids at login speed.
//   Pass 2 — full enrich on hits only (valid + 2fa + banned from pass 1).

const fs = require('fs');
const path = require('path');
const { run } = require('./runner');
const { runMultiProcess } = require('./multiproc');
const { pickProcessCount } = require('./speed');
const { buildRunResult } = require('./runStatus');
const log = require('./logger');

function readLines(fp) {
  try { return fs.readFileSync(fp, 'utf8').split(/\r?\n/).map(s => s.trim()).filter(Boolean); }
  catch { return []; }
}

function toCombo(line) {
  const head = String(line || '').split('|')[0].trim();
  const ci = head.indexOf(':');
  if (ci < 0) return null;
  return head;
}

function collectHits(passDir) {
  const combos = new Set();
  for (const f of ['valid.txt', '2fa.txt', 'banned.txt']) {
    for (const line of readLines(path.join(passDir, f))) {
      const c = toCombo(line);
      if (c) combos.add(c);
    }
  }
  return [...combos];
}

async function runPass1(opts) {
  const { baseDir, input, licenseKey, processes, onProgress, onResult, onControls } = opts;
  const prevFast = process.env.R6_FAST_PASS;
  const prevEnrich = process.env.R6_ENRICH;
  process.env.R6_FAST_PASS = '1';
  process.env.R6_ENRICH = '0';
  try {
    if (processes > 1) {
      return await runMultiProcess({
        baseDir, input, licenseKey, processes,
        fastPass: true, enrich: false,
        onProgress: (snap) => { if (onProgress) onProgress({ ...snap, phase: 1 }); },
        onControls,
      });
    }
    return await run({
      baseDir, input, licenseKey,
      quiet: true,
      onResult, onControls,
    });
  } finally {
    if (prevFast == null) delete process.env.R6_FAST_PASS; else process.env.R6_FAST_PASS = prevFast;
    if (prevEnrich == null) delete process.env.R6_ENRICH; else process.env.R6_ENRICH = prevEnrich;
  }
}

async function runPass2(opts) {
  const { baseDir, hitsFile, licenseKey, outDir, onResult, onControls } = opts;
  const prevFast = process.env.R6_FAST_PASS;
  const prevEnrich = process.env.R6_ENRICH;
  delete process.env.R6_FAST_PASS;
  process.env.R6_ENRICH = '1';
  try {
    const pass2Root = path.join(outDir, 'pass2');
    fs.mkdirSync(pass2Root, { recursive: true });
    process.env.R6_OUTPUT_DIR = pass2Root;
    const res = await run({
      baseDir,
      input: hitsFile,
      licenseKey,
      quiet: true,
      onResult,
      onControls,
    });
    delete process.env.R6_OUTPUT_DIR;
    return res;
  } finally {
    if (prevFast == null) delete process.env.R6_FAST_PASS; else process.env.R6_FAST_PASS = prevFast;
    if (prevEnrich == null) delete process.env.R6_ENRICH; else process.env.R6_ENRICH = prevEnrich;
  }
}

function mergePass2IntoPass1(pass1Dir) {
  try {
    const { resolveBucketPath } = require('./outputFiles');
    const outBase = path.join(pass1Dir, 'pass2', 'output');
    if (!fs.existsSync(outBase)) return;
    const p2dirs = fs.readdirSync(outBase).filter(n => n.startsWith('run_'));
    if (!p2dirs.length) return;
    const p2latest = path.join(outBase, p2dirs.sort().pop());
    for (const bucket of ['valid.txt', '2fa.txt', 'banned.txt', 'errors.txt']) {
      const src = resolveBucketPath(p2latest, bucket);
      if (!src) continue;
      fs.writeFileSync(path.join(pass1Dir, bucket), fs.readFileSync(src, 'utf8'));
    }
    const resultsSrc = resolveBucketPath(p2latest, 'results.txt');
    if (resultsSrc) {
      fs.appendFileSync(path.join(pass1Dir, 'results.txt'), fs.readFileSync(resultsSrc, 'utf8'));
    }
    require('./outputFiles').commitPartialFiles(pass1Dir);
  } catch (e) { log.warn('pass2 merge: ' + e.message); }
}

async function runTwoPass(opts) {
  const { baseDir, input, licenseKey, totalLines, onControls } = opts;
  const total = totalLines || readLines(input).filter(l => l.includes(':')).length;
  const processes = pickProcessCount(total);
  log.info(`Two-pass: ${total.toLocaleString()} lines · pass 1 × ${processes} procs (fast login)…`);

  const pass1 = await runPass1({ ...opts, processes, onControls });
  if (!pass1.outDir) return buildRunResult({ ok: false, reason: 'pass1-failed', stopped: !!pass1.stopped });

  const pass1Dir = pass1.outDir;
  if (pass1.stopped) return { ...pass1, hits: 0, pass1Only: true };
  if (!pass1.complete) return { ...pass1, hits: 0, pass1Only: true };

  const hits = collectHits(pass1Dir);
  log.info(`Pass 1 done — ${hits.length.toLocaleString()} hit(s) to enrich.`);

  if (!hits.length) {
    return buildRunResult({ outDir: pass1Dir, total, processed: pass1.processed || total });
  }

  const hitsFile = path.join(pass1Dir, 'pass1_hits.txt');
  fs.writeFileSync(hitsFile, hits.join('\n') + '\n');

  log.info(`Pass 2 — full capture on ${hits.length.toLocaleString()} hit(s)…`);
  if (opts.onProgress) {
    opts.onProgress({
      done: 0, total: hits.length, valid: 0, invalid: 0, twofa: 0, banned: 0, error: 0, cps: 0, phase: 2,
    });
  }
  const pass2 = await runPass2({ ...opts, hitsFile, outDir: pass1Dir });
  mergePass2IntoPass1(pass1Dir);

  const pass2Done = pass2.complete && !pass2.stopped && !pass2.crashed;
  const result = buildRunResult({
    outDir: pass1Dir,
    total,
    processed: pass1.processed || total,
    stopped: pass2.stopped,
    crashed: pass2.crashed || (!pass2Done && !pass2.stopped),
    ok: pass1.complete && pass2Done,
  });
  return {
    ...result,
    hits: hits.length,
    pass2Total: hits.length,
    pass2Processed: pass2.processed || 0,
    pass2Complete: pass2.complete,
    pass1,
    pass2,
  };
}

module.exports = { runTwoPass, runPass1, runPass2, collectHits, toCombo };
