'use strict';
// Unit tests for the adaptive rate governor. Uses injected clock + sleep so
// tests run in milliseconds instead of the real 15s window.

const assert = require('assert');
const { createGovernor } = require('../lib/checker/rateGovernor');

(async () => {
  // ── AIMD: TIME-gated additive increase (the anti-overshoot fix) ────────────
  // A controllable clock so we can prove the increase is paced by WALL-CLOCK,
  // not by call count. reportSuccess() fires ~5× per account check, so a per-call
  // bump used to rocket the limit straight back to the ceiling. It must not.
  let mockNow = 1000;
  const g = createGovernor({
    initialConcurrency: 8,
    minConcurrency: 1,
    maxConcurrency: 64,
    windowMs: 1000,
    throttlePauseMs: 500,
    breakerThresholdRate: 0.7,
    breakerMinSamples: 4,
    increaseStep: 4,
    increaseIntervalMs: 500,
    now: () => mockNow,
  });

  // Fresh governor starts at initial concurrency.
  assert.strictEqual(g.concurrency(), 8, 'starts at initialConcurrency');

  // First success takes ONE step (8 → 12); further successes in the SAME instant
  // take NONE — the increase is time-gated, so a burst of acks can't ramp it.
  for (let i = 0; i < 20; i++) g.reportSuccess();
  assert.strictEqual(g.concurrency(), 12, 'time-gated: one step per interval, not per call');

  // Advance past the interval → exactly one more step is allowed.
  mockNow += 500;
  for (let i = 0; i < 20; i++) g.reportSuccess();
  assert.strictEqual(g.concurrency(), 16, 'one more step after the interval elapses');

  // A single throttle halves concurrency (multiplicative decrease).
  g.reportThrottle();
  assert.strictEqual(g.concurrency(), 8, 'halves on throttle (16 → 8)');

  // A SECOND throttle in the SAME interval does NOT re-halve — one congestion
  // response per interval, so a burst of rotation-429s can't collapse the pool.
  g.reportThrottle();
  assert.strictEqual(g.concurrency(), 8, 'gated: second throttle in-interval does not re-halve');

  // Post-throttle, an immediate success must NOT re-climb (gate was reset).
  g.reportSuccess();
  assert.strictEqual(g.concurrency(), 8, 'no instant re-climb right after a backoff');

  // Concurrency floors at minConcurrency — one halving per interval, so we
  // advance the clock between throttles. 8→4→2→1→1.
  for (let i = 0; i < 5; i++) { mockNow += 1000; g.reportThrottle(); }
  assert.strictEqual(g.concurrency(), 1, 'floors at min (gated halving)');

  // Recovery: after the interval, successes step it back up.
  mockNow += 500;
  g.reportSuccess();
  assert.strictEqual(g.concurrency(), 5, 'recovers a step after the interval');

  console.log('  ✓ AIMD time-gated increase + gated multiplicative decrease');

  // ── Circuit breaker: opens on high 429 rate, closes after pause ────────────
  mockNow = 100_000;
  const now = () => mockNow;
  const g2 = createGovernor({
    initialConcurrency: 4,
    minConcurrency: 1,
    maxConcurrency: 16,
    windowMs: 1000,
    throttlePauseMs: 500,
    breakerThresholdRate: 0.7,
    breakerMinSamples: 4,
    now,
  });

  // Fresh governor: circuit is CLOSED (allowed).
  assert.strictEqual(g2.isOpen(), false, 'starts closed');

  // Report a burst of throttles that crosses the threshold.
  for (let i = 0; i < 5; i++) g2.reportThrottle();
  assert.strictEqual(g2.isOpen(), true, 'opens on high throttle rate');

  // While open, acquire() blocks. Advance the clock past the pause window.
  const opened = g2.pausedUntil();
  assert(opened > mockNow, 'pausedUntil is in the future');

  // Advance clock past the pause. Circuit auto-closes.
  mockNow = opened + 1;
  g2.tick();
  assert.strictEqual(g2.isOpen(), false, 'closes after pause elapses');

  console.log('  ✓ circuit breaker opens + auto-closes');

  // ── Retry-After header wins over the default pause ─────────────────────────
  mockNow = 200_000;
  const g3 = createGovernor({
    initialConcurrency: 4, minConcurrency: 1, maxConcurrency: 16,
    windowMs: 1000, throttlePauseMs: 500,
    breakerThresholdRate: 0.7, breakerMinSamples: 1, now,
  });
  // Retry-After says wait 10 seconds (much longer than the default 500ms).
  g3.reportThrottle({ retryAfterSec: 10 });
  assert(g3.pausedUntil() - mockNow >= 10_000, 'Retry-After honored (>=10s)');

  console.log('  ✓ Retry-After honored');

  // ── acquire() gates workers when open, unblocks when closed ────────────────
  const g4 = createGovernor({
    initialConcurrency: 4, minConcurrency: 1, maxConcurrency: 16,
    windowMs: 1000, throttlePauseMs: 20,
    breakerThresholdRate: 0.5, breakerMinSamples: 2,
    now: () => Date.now(),   // real clock so the unpause timer fires
    sleep: (ms) => new Promise(r => setTimeout(r, ms)),
  });
  // Open the breaker via a burst.
  for (let i = 0; i < 3; i++) g4.reportThrottle();
  assert(g4.isOpen(), 'burst opens breaker');

  const t0 = Date.now();
  await g4.acquire();
  const elapsed = Date.now() - t0;
  assert(elapsed >= 18, `acquire() blocked for ~pause window (got ${elapsed}ms)`);
  console.log('  ✓ acquire() blocks while open, unblocks when closed');

  // ── Concurrency semaphore: at most N in-flight at once ─────────────────────
  const g5 = createGovernor({
    initialConcurrency: 3, minConcurrency: 1, maxConcurrency: 3,
    windowMs: 1000, throttlePauseMs: 20,
    breakerThresholdRate: 0.99, breakerMinSamples: 999,   // effectively off
    increaseIntervalMs: 1, increaseStep: 1,
    now: () => Date.now(), sleep: (ms) => new Promise(r => setTimeout(r, ms)),
  });
  let active = 0, peak = 0;
  await Promise.all(Array.from({ length: 10 }, async () => {
    await g5.acquire();
    active++; peak = Math.max(peak, active);
    await new Promise(r => setTimeout(r, 5));
    active--;
    g5.release();
  }));
  assert(peak <= 3, `at most 3 concurrent, saw peak ${peak}`);
  console.log('  ✓ concurrency semaphore caps at N (waiter queue, no busy-poll)');

  // ── Waiter queue: a parked acquire() is granted when the LIMIT grows ───────
  // Start at 1 slot, take it, park a second acquire, then a success step opens
  // room and the parked worker must proceed (proves _pump wakes on increase).
  const g7 = createGovernor({
    initialConcurrency: 1, minConcurrency: 1, maxConcurrency: 16,
    windowMs: 1000, throttlePauseMs: 20,
    breakerThresholdRate: 0.99, breakerMinSamples: 999,   // breaker off
    increaseStep: 4, increaseIntervalMs: 0,               // every success may step
    now: () => Date.now(), sleep: (ms) => new Promise(r => setTimeout(r, ms)),
  });
  await g7.acquire();                     // take the only slot
  let secondGranted = false;
  const second = g7.acquire().then(() => { secondGranted = true; });
  await new Promise(r => setTimeout(r, 10));
  assert.strictEqual(secondGranted, false, 'second acquire parks while full');
  assert.strictEqual(g7.waiting(), 1, 'one worker queued');
  g7.reportSuccess();                     // 1 → 5 slots; must wake the parked one
  await second;
  assert.strictEqual(secondGranted, true, 'parked acquire granted when limit grew');
  console.log('  ✓ waiter queue wakes on additive-increase');

  // ── 401 rate tracking (anti-mask signal) ──────────────────────────────────
  const g6 = createGovernor({
    initialConcurrency: 8, minConcurrency: 1, maxConcurrency: 64,
    windowMs: 1000, throttlePauseMs: 500,
    breakerThresholdRate: 0.99, breakerMinSamples: 999,   // effectively off
    invalidMinSamples: 4,
    now: () => Date.now(),
  });
  // A calm start: mostly success + a few real 401s = baseline
  for (let i = 0; i < 20; i++) g6.reportSuccess();
  for (let i = 0; i < 2; i++) g6.reportInvalid();
  assert(g6.invalidRate() < 0.2, `baseline invalid-rate low, got ${g6.invalidRate()}`);
  assert.strictEqual(g6.suspicious401(), false, 'not suspicious at low invalid rate');

  // Now a burst of 401s (Ubi masking pattern) — rate should spike
  for (let i = 0; i < 20; i++) g6.reportInvalid();
  assert(g6.invalidRate() > 0.5, `spike detected, got ${g6.invalidRate()}`);
  assert.strictEqual(g6.suspicious401(), true, 'suspicious when 401 rate spikes');

  console.log('  ✓ 401-rate tracking + suspicious401 signal');

  // ── soft (login rotation-429) never pauses the pool; hard (data path) does ─
  const softNow = 500_000;
  const gSoft = createGovernor({
    initialConcurrency: 64, minConcurrency: 1, maxConcurrency: 64,
    windowMs: 10_000, throttlePauseMs: 500,
    breakerThresholdRate: 0.5, breakerMinSamples: 4,
    decreaseIntervalMs: 1, now: () => softNow,
  });
  // A flood of SOFT throttles (100% of samples) must NOT pause the pool — these
  // are the rotation-recoverable login-429s that used to perma-open the breaker.
  for (let i = 0; i < 30; i++) gSoft.reportThrottle({ soft: true });
  assert.strictEqual(gSoft.isOpen(), false, 'soft-only throttles never open the breaker');
  assert(gSoft.concurrency() < 64, 'soft throttles still trim concurrency (gently)');

  // HARD throttles (data path / direct IP — no rotation to save us) DO pause.
  const gHard = createGovernor({
    initialConcurrency: 64, minConcurrency: 1, maxConcurrency: 64,
    windowMs: 10_000, throttlePauseMs: 500,
    breakerThresholdRate: 0.5, breakerMinSamples: 4,
    decreaseIntervalMs: 1, now: () => softNow,
  });
  for (let i = 0; i < 10; i++) gHard.reportThrottle();   // hard (no soft flag)
  assert.strictEqual(gHard.isOpen(), true, 'hard throttles still open the breaker');

  // Retry-After pauses even a SOFT throttle (explicit upstream instruction wins).
  const gRetry = createGovernor({
    initialConcurrency: 64, minConcurrency: 1, maxConcurrency: 64,
    windowMs: 10_000, throttlePauseMs: 500,
    breakerThresholdRate: 0.99, breakerMinSamples: 999, now: () => softNow,
  });
  gRetry.reportThrottle({ soft: true, retryAfterSec: 5 });
  assert.strictEqual(gRetry.isOpen(), true, 'Retry-After pauses even a soft throttle');

  console.log('  ✓ soft login-429 trims but never pauses; hard + Retry-After pause');

  // ── Rolling window is bounded on a HEALTHY run (no memory leak) ────────────
  // reportSuccess/reportInvalid must prune, not just reportThrottle — otherwise
  // an all-success run grows the samples array without bound.
  let leakNow = 0;
  const g8 = createGovernor({
    initialConcurrency: 8, minConcurrency: 1, maxConcurrency: 64,
    windowMs: 1000, increaseIntervalMs: 1_000_000,   // freeze increase; isolate pruning
    breakerThresholdRate: 0.99, breakerMinSamples: 999,
    now: () => leakNow,
  });
  for (let i = 0; i < 500; i++) g8.reportSuccess();     // 500 samples at t=0
  assert.strictEqual(g8.sampleCount(), 500, 'all in-window samples retained');
  leakNow = 2000;                                        // jump past the 1s window
  g8.reportSuccess();                                    // one fresh sample → prunes the 500 stale
  assert.strictEqual(g8.sampleCount(), 1, 'stale samples pruned on success (no leak)');
  console.log('  ✓ rolling window bounded on healthy run (no leak)');

  console.log('OK test-rate-governor');
})().catch(e => { console.error(e); process.exit(1); });
