'use strict';
// Desktop rate governor — holds ~1.2k–2k CPM without 429 storms.
// Creates a fresh governor instance (SEA-safe: no require.resolve / cache bust).

const { intEnv } = require('./config');
const { createGovernor } = require('../../lib/checker/rateGovernor');

function setupDesktopGovernor({ processes = 1 } = {}) {
  const minCpm = intEnv('R6_MIN_CPM', 1200, 100, 50000);
  const maxCpm = intEnv('R6_TARGET_CPM', 2000, minCpm, 50000);
  const n = Math.max(1, processes);

  // ~2–3s avg login RTT → concurrency ≈ (CPM/60) × RTT
  const minConc = Math.max(16, Math.ceil((minCpm / 60) * 2.5));
  const maxConc = Math.max(minConc, Math.ceil((maxCpm / 60) * 3.5));
  const perMax = Math.max(32, Math.min(256, Math.ceil(maxConc / n)));
  const perInit = Math.max(24, Math.min(perMax, Math.ceil(minConc / n)));
  const perMin = Math.max(12, Math.min(perInit, Math.ceil(minConc / n / 2)));

  // Keep env in sync for child processes / HTTP layer that read BULK_GOV_*.
  if (!process.env.BULK_GOV_MAX_CONCURRENCY) process.env.BULK_GOV_MAX_CONCURRENCY = String(perMax);
  if (!process.env.BULK_GOV_INITIAL_CONCURRENCY) process.env.BULK_GOV_INITIAL_CONCURRENCY = String(perInit);
  if (!process.env.BULK_GOV_MIN_CONCURRENCY) process.env.BULK_GOV_MIN_CONCURRENCY = String(perMin);
  if (!process.env.BULK_MAX_CONCURRENCY) process.env.BULK_MAX_CONCURRENCY = process.env.BULK_GOV_MAX_CONCURRENCY;
  if (!process.env.BULK_GOV_PAUSE_MS) process.env.BULK_GOV_PAUSE_MS = '6000';
  if (!process.env.BULK_GOV_INCREASE_STEP) process.env.BULK_GOV_INCREASE_STEP = '6';
  if (!process.env.BULK_GOV_INCREASE_INTERVAL_MS) process.env.BULK_GOV_INCREASE_INTERVAL_MS = '400';

  return createGovernor({
    initialConcurrency:   Number(process.env.BULK_GOV_INITIAL_CONCURRENCY) || perInit,
    minConcurrency:       Number(process.env.BULK_GOV_MIN_CONCURRENCY) || perMin,
    maxConcurrency:       Number(process.env.BULK_GOV_MAX_CONCURRENCY) || perMax,
    windowMs:             Number(process.env.BULK_GOV_WINDOW_MS) || 15_000,
    throttlePauseMs:      Number(process.env.BULK_GOV_PAUSE_MS) || 6_000,
    breakerThresholdRate: Number(process.env.BULK_GOV_BREAKER_THRESHOLD) || 0.7,
    breakerMinSamples:    Number(process.env.BULK_GOV_MIN_SAMPLES) || 20,
    increaseStep:         Number(process.env.BULK_GOV_INCREASE_STEP) || 6,
    increaseIntervalMs:   Number(process.env.BULK_GOV_INCREASE_INTERVAL_MS) || 400,
    decreaseIntervalMs:   Number(process.env.BULK_GOV_DECREASE_INTERVAL_MS) || 1000,
  });
}

module.exports = { setupDesktopGovernor };
