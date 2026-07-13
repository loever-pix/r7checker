'use strict';
// Adaptive rate governor for upstream APIs that 429 you back.
//
// Three cooperating mechanisms:
//   1. AIMD adaptive concurrency (TCP-style congestion control) — start LOW and
//      grow the concurrency limit by `increaseStep` at most once per
//      `increaseIntervalMs` (additive increase, TIME-gated — NOT once per call).
//      Every 429 halves it (multiplicative decrease). This converges on the
//      upstream's real capacity and STAYS there instead of oscillating.
//   2. Circuit breaker — if the throttle rate in a rolling window crosses a
//      threshold, PAUSE all workers for `throttlePauseMs`. Prevents the pool
//      from hammering an already-angry upstream and turning a 5-minute cooldown
//      into a 45-minute hard block.
//   3. Retry-After compliance — if the upstream sends the header, respect it
//      exactly. Never retry earlier than told.
//
// WHY time-gated increase matters: reportSuccess() is called after EVERY
// successful upstream call, and one account check fans out to ~5 of them (login
// + several data calls). The old code did `concurrency++` per call, so the limit
// rocketed from any value straight back to the ceiling in ~1-2s — pure overshoot.
// That overshoot is what produced the 429 storms (and Ubi's load-shedding 401
// masks that showed up as "all invalid"). Additive increase must be paced by
// WALL-CLOCK (one step per RTT-ish interval), exactly like a TCP congestion
// window, so the pool probes upward gently and settles at the throttle edge.
//
// Wire it in two places:
//   - Worker pool: `await gov.acquire()` before each check → gov.release() after.
//     Gates the pool's concurrency AND blocks entirely while the breaker is open.
//     Parked workers wait on a queue (no busy-poll) and are woken when a slot
//     frees, the limit grows, or the breaker closes.
//   - HTTP layer: gov.reportSuccess() / reportThrottle({retryAfterSec}) after
//     each upstream call. Feeds the AIMD + circuit-breaker signals.
//
// Pure orchestration. now() and sleep() are injectable for tests.

function createGovernor(opts = {}) {
  const initialConcurrency  = Math.max(1, Number(opts.initialConcurrency)  || 100);
  const minConcurrency      = Math.max(1, Number(opts.minConcurrency)      || 1);
  const maxConcurrency      = Math.max(minConcurrency, Number(opts.maxConcurrency) || 2000);
  const windowMs            = Math.max(1000, Number(opts.windowMs) || 15_000);
  const throttlePauseMs     = Math.max(1000, Number(opts.throttlePauseMs) || 60_000);
  const breakerThresholdRate = Math.min(1, Math.max(0, Number(opts.breakerThresholdRate) || 0.7));
  const breakerMinSamples   = Math.max(1, Number(opts.breakerMinSamples) || 20);
  const invalid401Threshold = Math.min(1, Math.max(0, Number(opts.invalid401Threshold) || 0.5));
  const invalidMinSamples   = Math.max(1, Number(opts.invalidMinSamples) || 20);
  // Additive-increase pacing. One step per interval — NOT per successful call.
  const increaseStep        = Math.max(1, Number(opts.increaseStep) || 8);
  const increaseIntervalMs  = Math.max(1, Number(opts.increaseIntervalMs) || 500);
  // Multiplicative decrease is likewise gated: one congestion RESPONSE per this
  // interval, so a burst of (rotation-recoverable) login-429s in one moment
  // halves the window ONCE instead of collapsing it to the floor.
  const decreaseIntervalMs  = Math.max(1, Number(opts.decreaseIntervalMs) || 1000);
  const now = opts.now || Date.now;
  const sleep = opts.sleep || ((ms) => new Promise(r => setTimeout(r, ms)));
  const onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : () => {};

  let concurrency = Math.min(maxConcurrency, Math.max(minConcurrency, initialConcurrency));
  let inFlight = 0;
  let pausedUntilTs = 0;                 // 0 = closed (allowed)
  let lastIncreaseTs = 0;                // wall-clock gate for additive increase
  let lastDecreaseTs = 0;                // wall-clock gate for multiplicative decrease
  // Rolling-window samples. `kind` ∈ 'ok' (2xx or non-throttle-non-401 error),
  // 'throttle' (429/503), 'invalid' (401 → Ubi says "wrong password"; may be a
  // MASK under sustained throttle).
  const samples = [];
  // Parked acquire() callers, woken FIFO when a slot opens. No busy-poll.
  const waiters = [];
  let breakerTimer = null;               // single shared timer to wake on unpause

  function _pruneWindow() {
    const cutoff = now() - windowMs;
    while (samples.length && samples[0].t < cutoff) samples.shift();
  }

  // Breaker rate counts only HARD throttles. Soft (login, rotation-recoverable)
  // 429s are routine and self-heal via fingerprint+IP rotation — letting them
  // drive the global pause perma-opened the breaker and starved the pool.
  function _rate() {
    _pruneWindow();
    if (samples.length < breakerMinSamples) return 0;
    let bad = 0;
    for (const s of samples) if (s.kind === 'throttle' && !s.soft) bad++;
    return bad / samples.length;
  }

  function _invalidRate() {
    _pruneWindow();
    if (samples.length < invalidMinSamples) return 0;
    let bad = 0;
    for (const s of samples) if (s.kind === 'invalid') bad++;
    return bad / samples.length;
  }

  function _openBreaker(untilTs, reason) {
    if (untilTs <= pausedUntilTs) return;   // don't shorten an already-longer pause
    pausedUntilTs = untilTs;
    onEvent({ type: 'breaker-open', pausedUntilTs, concurrency, reason });
  }

  // Idempotent: closes the breaker if the pause has elapsed.
  function tick() {
    if (pausedUntilTs && now() >= pausedUntilTs) {
      pausedUntilTs = 0;
      onEvent({ type: 'breaker-close', concurrency });
    }
  }

  // Arm the single wake-up timer that reopens the pool when the pause elapses.
  // Only needed while workers are actually parked behind an open breaker.
  function _armBreakerTimer() {
    if (breakerTimer || !pausedUntilTs) return;
    const wait = Math.max(1, pausedUntilTs - now());
    // NOT unref'd on purpose: while workers are parked behind an open breaker,
    // this timer is what resumes the job. In the desktop checker (no web server
    // holding the loop open) an unref'd timer would let the process exit
    // mid-run. It fires once then clears, so it never lingers past its purpose.
    breakerTimer = setTimeout(() => { breakerTimer = null; _pump(); }, wait);
  }

  // Grant parked waiters into any free slots. Called whenever capacity opens up:
  // a release, an additive-increase step, or the breaker closing. While paused,
  // grants nothing and (re)arms the unpause timer if anyone is waiting.
  function _pump() {
    tick();
    if (pausedUntilTs) { if (waiters.length) _armBreakerTimer(); return; }
    while (waiters.length && inFlight < concurrency) {
      inFlight++;
      (waiters.shift())();
    }
  }

  // Called by the HTTP layer AFTER each upstream call succeeds (2xx or 4xx that
  // isn't 429/503/401). Records a sample and, at most once per interval, takes
  // one additive-increase step. Pacing the increase by wall-clock (not per call)
  // is what keeps the pool from rocketing back to the ceiling after every dip.
  function reportSuccess() {
    const t = now();
    samples.push({ t, kind: 'ok' });
    // Prune on every mutation, not just on reportThrottle. A long HEALTHY run is
    // almost all successes with few 429s; without pruning here the window array
    // grows unbounded (~5 samples/account × millions) — a real memory leak on a
    // big job. Pruning keeps it bounded to actual window occupancy (amortized O(1)).
    _pruneWindow();
    if (concurrency < maxConcurrency && (t - lastIncreaseTs) >= increaseIntervalMs) {
      lastIncreaseTs = t;
      const prev = concurrency;
      concurrency = Math.min(maxConcurrency, concurrency + increaseStep);
      if (concurrency !== prev) { onEvent({ type: 'concurrency-up', from: prev, to: concurrency }); _pump(); }
    }
    tick();
  }

  // Called by the HTTP layer AFTER an upstream 429/503 signal. Records a sample
  // and applies the appropriate backoff:
  //   HARD (data path / direct-IP 429): halve concurrency; maybe open breaker.
  //   SOFT (login-layer 429, rotation-recoverable): TRIM by one step; no breaker.
  //     The next login attempt exits a fresh IP with a fresh fingerprint, so a
  //     single soft 429 doesn't mean the upstream is angry — it means THIS
  //     fingerprint is throttled. Halving on every soft-429 strangled the pool
  //     to the floor (live-log: 13k login-429s vs 149 successes → concurrency
  //     stuck at 8). Trimming by one step still gives gentle backpressure while
  //     letting the pool grow.
  //   Retry-After ALWAYS wins (soft or hard): the upstream told us EXACTLY how
  //     long to wait. Halve + pause the breaker for the specified interval.
  // Both concurrency changes are gated by decreaseIntervalMs so a burst can't
  // collapse the pool in one moment.
  function reportThrottle(info = {}) {
    const t = now();
    const soft = !!info.soft;
    samples.push({ t, kind: 'throttle', soft });
    const gateOpen = (t - lastDecreaseTs) >= decreaseIntervalMs;

    if (info.retryAfterSec && info.retryAfterSec > 0) {
      // Retry-After: halve concurrency AND pause the breaker (overrides soft).
      if (gateOpen) {
        lastDecreaseTs = t;
        const prev = concurrency;
        concurrency = Math.max(minConcurrency, Math.floor(concurrency / 2));
        if (concurrency !== prev) onEvent({ type: 'concurrency-down', from: prev, to: concurrency });
      }
      _openBreaker(now() + info.retryAfterSec * 1000, 'retry-after');
    } else if (soft) {
      // Soft: gentle single-step trim (much less than a halve). Ungated
      // decrease would let a burst collapse the pool; gate it same as hard.
      if (gateOpen) {
        lastDecreaseTs = t;
        const prev = concurrency;
        concurrency = Math.max(minConcurrency, concurrency - increaseStep);
        if (concurrency !== prev) onEvent({ type: 'concurrency-down', from: prev, to: concurrency, soft: true });
      }
      // NOTE: soft does NOT feed the breaker rate (see _rate: it excludes soft).
    } else {
      // Hard: multiplicative decrease + maybe open the breaker on high hard-rate.
      if (gateOpen) {
        lastDecreaseTs = t;
        const prev = concurrency;
        concurrency = Math.max(minConcurrency, Math.floor(concurrency / 2));
        if (concurrency !== prev) onEvent({ type: 'concurrency-down', from: prev, to: concurrency });
      }
      if (_rate() >= breakerThresholdRate) {
        _openBreaker(now() + throttlePauseMs, `throttle-rate>=${breakerThresholdRate}`);
      }
    }
    // Reset the increase gate so recovery starts a fresh interval — never re-climb
    // in the same breath we just backed off.
    lastIncreaseTs = t;
    if (pausedUntilTs && waiters.length) _armBreakerTimer();
    tick();
  }

  // Called on HTTP 401 (Ubi "wrong password"). Tracked separately because under
  // sustained rate-limit pressure, Ubi MASKS legit accounts as 401 to shed load
  // — every 401 without verification produced 100% false-invalid runs. The
  // caller (auth.js) uses `suspicious401()` to decide whether to trust the 401
  // or retry on fresh state. 401 does NOT touch concurrency (real invalids are
  // not a "back off" signal).
  function reportInvalid() {
    samples.push({ t: now(), kind: 'invalid' });
    _pruneWindow();   // keep the window bounded (see reportSuccess)
    tick();
  }

  // True when the rolling window's 401 rate crosses the configured threshold —
  // signal to the caller that any new 401 should be verified before being
  // accepted as a real invalid. Requires at least `invalidMinSamples` samples
  // in the window so a cold-start baseline doesn't over-trigger.
  function suspicious401() {
    return _invalidRate() >= invalid401Threshold;
  }

  // Awaits a slot. Resolves immediately when the breaker is closed and a slot is
  // free (and no one is already queued, for FIFO fairness); otherwise parks on
  // the waiter queue until _pump() grants it. No polling.
  async function acquire() {
    tick();
    if (!pausedUntilTs && waiters.length === 0 && inFlight < concurrency) {
      inFlight++;
      return;
    }
    await new Promise((resolve) => {
      waiters.push(resolve);
      if (pausedUntilTs) _armBreakerTimer();
    });
  }

  function release() {
    if (inFlight > 0) inFlight--;
    _pump();
  }

  return {
    acquire, release,
    reportSuccess, reportThrottle, reportInvalid,
    tick,
    concurrency: () => concurrency,
    inFlight: () => inFlight,
    waiting: () => waiters.length,
    sampleCount: () => samples.length,   // observability: rolling-window size
    isOpen: () => { tick(); return pausedUntilTs > 0; },
    pausedUntil: () => pausedUntilTs,
    throttleRate: _rate,
    invalidRate: _invalidRate,
    suspicious401,
  };
}

// Recognize the "back off" signals: 429 (rate-limited) and 503 (unavailable).
// 403 is intentionally NOT here — Ubi returns 403 for the DataDome anti-bot
// challenge, which auth.js handles with fingerprint rotation, not a global
// backoff. Bundling them would over-pause the pool.
function isThrottleStatus(status) {
  return status === 429 || status === 503;
}

// Parse a Retry-After header value (RFC 7231): either a delta-seconds integer
// OR an HTTP-date. Returns seconds (Number), or null if unparseable/absent.
function parseRetryAfter(headerVal) {
  if (headerVal == null) return null;
  const s = String(headerVal).trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) return Math.max(0, parseInt(s, 10));
  const t = Date.parse(s);
  if (Number.isFinite(t)) return Math.max(0, Math.ceil((t - Date.now()) / 1000));
  return null;
}

module.exports = { createGovernor, isThrottleStatus, parseRetryAfter };
