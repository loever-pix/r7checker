'use strict';
// Throughput helpers — multiproc count, per-process concurrency, fast-pass flags.

const os = require('os');
const { config, CPU, intEnv, boolEnv } = require('./config');

const TWOPASS_MIN = intEnv('R6_TWOPASS_MIN', 5000, 100, 100000000);
const MULTIPROC_MIN = intEnv('R6_MULTIPROC_MIN', 2000, 1, 100000000);
const PIPELINE_MIN = intEnv('R6_PIPELINE_MIN', 2000, 100, 100000000);

function pickProcessCount(totalLines) {
  const req = parseInt(process.env.R6_PROCESSES || '', 10);
  if (Number.isFinite(req) && req > 0) return Math.max(1, Math.min(req, CPU * 2));
  if (process.env.R6_MULTIPROC === '0') return 1;
  if (totalLines < MULTIPROC_MIN) return 1;
  return Math.max(2, Math.min(4, Math.floor(CPU / 2) || 2));
}

function wantPipeline(totalLines) {
  if (process.env.R6_PIPELINE === '0') return false;
  if (process.env.R6_TWOPASS === '1') return false;
  if (boolEnv('R6_PIPELINE', true)) return totalLines >= PIPELINE_MIN;
  return false;
}

function wantTwoPass(totalLines) {
  if (process.env.R6_TWOPASS === '0') return false;
  if (boolEnv('R6_TWOPASS', false)) return totalLines >= TWOPASS_MIN;
  return false;
}

function applyProxyPoolTuning({ hasProxy, processes = 1 } = {}) {
  if (!hasProxy) return;
  const n = Math.max(1, processes);
  const perProcMax = intEnv('R6_MAX_CONCURRENCY', 0, 0, 100000)
    || Math.min(160, Math.max(48, Math.floor(320 / n)));
  const perProcStart = intEnv('R6_START_CONCURRENCY', 0, 0, 100000)
    || Math.min(perProcMax, Math.max(32, Math.floor(perProcMax * 0.6)));

  if (!process.env.R6_MAX_CONCURRENCY) config.pool.maxConcurrency = perProcMax;
  if (!process.env.R6_START_CONCURRENCY) config.pool.startConcurrency = perProcStart;
  if (!process.env.R6_MIN_CONCURRENCY) config.pool.minConcurrency = Math.max(24, Math.floor(perProcStart / 2));
  if (!process.env.R6_PROXY_POOL) process.env.R6_PROXY_POOL = '0';
}

function applyPipelineTuning({ hasProxy, processes = 1 } = {}) {
  applyProxyPoolTuning({ hasProxy, processes });
  if (!process.env.R6_RETRY_SLOW_MS) config.retry.slowLaneMs = 3000;
  if (!process.env.R6_RETRY_MAX) config.retry.maxAttempts = 14;
  if (!process.env.R6_MIN_CONCURRENCY) {
    config.pool.minConcurrency = Math.max(config.pool.minConcurrency, 24);
  }
}

function childEnv(base, { fastPass = false, enrich = true } = {}) {
  const env = {
    ...base,
    R6_FAST_PASS: fastPass ? '1' : '0',
    R6_ENRICH: enrich ? '1' : '0',
  };
  if (fastPass) {
    if (!process.env.R6_LOGIN_ATTEMPTS) env.R6_LOGIN_ATTEMPTS = '4';
    // Login-only checks should fail fast — not wait 3 min per hung worker.
    if (!process.env.R6_WORKER_TIMEOUT_MS) env.R6_WORKER_TIMEOUT_MS = '45000';
    // Slow-lane 60s backoff stalls the whole pool at 0/s when proxies 429.
    if (!process.env.R6_RETRY_SLOW_MS) env.R6_RETRY_SLOW_MS = '8000';
    if (!process.env.R6_RETRY_SLOW_MAX) env.R6_RETRY_SLOW_MAX = '8';
    if (!process.env.R6_RETRY_MAX) env.R6_RETRY_MAX = '12';
  }
  return env;
}

// Mutate live config when fast-pass env is set after module load (single-process path).
function applyFastPassTuning() {
  if (process.env.R6_FAST_PASS !== '1') return;
  if (!process.env.R6_WORKER_TIMEOUT_MS) config.pool.workerTimeoutMs = 45000;
  if (!process.env.R6_RETRY_SLOW_MS) config.retry.slowLaneMs = 8000;
  if (!process.env.R6_RETRY_SLOW_MAX) config.retry.slowLaneMax = 8;
  if (!process.env.R6_RETRY_MAX) config.retry.maxAttempts = 12;
  if (!process.env.R6_LOGIN_ATTEMPTS) process.env.R6_LOGIN_ATTEMPTS = '4';
  if (!process.env.R6_MIN_CONCURRENCY) config.pool.minConcurrency = Math.max(config.pool.minConcurrency, 32);
  if (!process.env.R6_CB_OPEN_MS) config.circuit.openMs = 5000;
}

module.exports = {
  pickProcessCount, wantTwoPass, wantPipeline, applyProxyPoolTuning, applyPipelineTuning,
  applyFastPassTuning, childEnv,
  TWOPASS_MIN, MULTIPROC_MIN, PIPELINE_MIN,
};
