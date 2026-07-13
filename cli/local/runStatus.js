'use strict';
// Shared completion flags so menu/CLI never show "✓ done" on partial or crashed runs.

function buildRunResult({
  outDir = null,
  total = 0,
  processed = 0,
  stopped = false,
  crashed = false,
  stalled = false,
  ok,
  reason,
} = {}) {
  const p = Math.max(0, processed | 0);
  const t = Math.max(0, total | 0);
  // Stall = auto-stop after no progress — not a process crash.
  const wasStalled = !!stalled || reason === 'stalled' || /^no progress/i.test(String(reason || ''));
  const wasStopped = !!stopped || wasStalled;
  // Only trust an explicit crash flag — do NOT infer crash from incompleteness
  // (that made every stall / early child exit look like "crashed").
  const wasCrashed = !!crashed && !wasStalled && !wasStopped;
  const complete = !wasStopped && !wasCrashed && t > 0 && p >= t;
  const partial = !complete && (wasStopped || wasCrashed || wasStalled || (t > 0 && p < t));
  return {
    ok: ok != null ? ok : complete,
    outDir,
    total: t,
    processed: p,
    complete,
    partial,
    stopped: wasStopped && !wasCrashed,
    stalled: wasStalled,
    crashed: wasCrashed,
    reason: reason || (wasStalled ? 'stalled' : null),
  };
}

function mergePhases(a, b, { totalInput = 0 } = {}) {
  if (!a) return b || buildRunResult();
  if (!b) return a;
  return buildRunResult({
    outDir: a.outDir || b.outDir,
    total: totalInput || Math.max(a.total, b.total),
    processed: (a.complete && b.complete)
      ? (totalInput || a.total)
      : Math.max(a.processed || 0, b.processed || 0),
    stopped: a.stopped || b.stopped,
    stalled: a.stalled || b.stalled,
    crashed: a.crashed || b.crashed,
    reason: a.reason || b.reason,
  });
}

function formatOutcome(res) {
  if (!res) return { headline: 'failed', kind: 'failed' };
  if (!res.outDir && res.ok === false) return { headline: 'failed', kind: 'failed', hint: res.reason };
  if (res.stalled) return { headline: 'stalled', kind: 'stalled', hint: res.reason };
  if (res.stopped) return { headline: 'stopped', kind: 'stopped' };
  if (res.crashed) return { headline: 'crashed', kind: 'crashed', hint: res.reason };
  if (res.partial || !res.complete) return { headline: 'partial', kind: 'partial' };
  return { headline: 'done', kind: 'done' };
}

function countOutputLines(outDir) {
  if (!outDir) return 0;
  const fs = require('fs');
  const path = require('path');
  const buckets = ['valid.txt', 'invalid.txt', '2fa.txt', 'banned.txt', 'errors.txt'];
  let n = 0;
  for (const f of buckets) {
    for (const fp of [path.join(outDir, f), path.join(outDir, f + '.part')]) {
      try {
        if (!fs.existsSync(fp)) continue;
        const buf = fs.readFileSync(fp);
        for (let i = 0; i < buf.length; i++) if (buf[i] === 0x0A) n++;
      } catch { /* ignore */ }
    }
  }
  return n;
}

module.exports = { buildRunResult, mergePhases, formatOutcome, countOutputLines };
