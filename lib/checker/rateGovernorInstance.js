'use strict';
// Process-wide singleton rate governor for the Ubi upstream. Both the bulk
// worker pool (acquire/release) and the HTTP layer (report success/throttle)
// hit the SAME instance — matches Ubi's per-fingerprint anti-bot state.
//
// Env knobs (all optional):
//   BULK_GOV_INITIAL_CONCURRENCY   default = 128 (slow-start; NOT the max)
//   BULK_GOV_MIN_CONCURRENCY       default = 8
//   BULK_GOV_MAX_CONCURRENCY       default = BULK_MAX_CONCURRENCY
//   BULK_GOV_WINDOW_MS             default = 15000
//   BULK_GOV_PAUSE_MS              default = 60000
//   BULK_GOV_BREAKER_THRESHOLD     default = 0.7
//   BULK_GOV_MIN_SAMPLES           default = 20
//   BULK_GOV_INCREASE_STEP         default = 8   (slots added per interval)
//   BULK_GOV_INCREASE_INTERVAL_MS  default = 500 (min gap between increases)
//
// SLOW-START RATIONALE: the pool used to START at the 2000 ceiling and slam Ubi
// with 2000 concurrent logins before any feedback — instant overshoot → 429
// storm → Ubi masks valids as 401 ("all invalid"). We now start near the real
// operating point (~128) and let the TIME-gated additive increase probe upward
// to wherever the 429s begin, then hold there. maxConcurrency is unchanged, so a
// healthy upstream can still be ridden all the way to the ceiling — it just gets
// there by converging instead of overshooting.

const { createGovernor, isThrottleStatus, parseRetryAfter } = require('./rateGovernor');

const maxC   = Number(process.env.BULK_MAX_CONCURRENCY) || 2000;
// Start well below the ceiling. Clamp to max so a tiny BULK_MAX can't be exceeded.
const initC  = Math.min(maxC, Number(process.env.BULK_GOV_INITIAL_CONCURRENCY) || 128);
const gov = createGovernor({
  initialConcurrency:   initC,
  minConcurrency:       Number(process.env.BULK_GOV_MIN_CONCURRENCY)     || 8,
  maxConcurrency:       Number(process.env.BULK_GOV_MAX_CONCURRENCY)     || maxC,
  windowMs:             Number(process.env.BULK_GOV_WINDOW_MS)           || 15_000,
  throttlePauseMs:      Number(process.env.BULK_GOV_PAUSE_MS)            || 60_000,
  breakerThresholdRate: Number(process.env.BULK_GOV_BREAKER_THRESHOLD)   || 0.7,
  breakerMinSamples:    Number(process.env.BULK_GOV_MIN_SAMPLES)         || 20,
  invalid401Threshold: Number(process.env.BULK_GOV_INVALID_THRESHOLD) || 0.5,
  invalidMinSamples:   Number(process.env.BULK_GOV_INVALID_MIN_SAMPLES) || 20,
  increaseStep:        Number(process.env.BULK_GOV_INCREASE_STEP)        || 8,
  increaseIntervalMs:  Number(process.env.BULK_GOV_INCREASE_INTERVAL_MS) || 500,
  decreaseIntervalMs:  Number(process.env.BULK_GOV_DECREASE_INTERVAL_MS) || 1000,
  onEvent: (e) => {
    // One-line structured log so ops can see the governor working. Sampled
    // (only "state-change" events fire) so a healthy run stays quiet.
    if (e.type === 'breaker-open')  console.warn(`[gov] BREAKER OPEN pause=${e.pausedUntilTs - Date.now()}ms reason=${e.reason} concurrency=${e.concurrency}`);
    if (e.type === 'breaker-close') console.log(`[gov] BREAKER CLOSED concurrency=${e.concurrency}`);
    if (e.type === 'concurrency-down') console.warn(`[gov] throttled: cutting concurrency ${e.from}→${e.to}`);
  },
});

module.exports = { gov, isThrottleStatus, parseRetryAfter };
