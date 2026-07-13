'use strict';
// Central configuration for the local-distributed checker. Every value is
// overridable via an environment variable so the same exe can be tuned per
// machine without a rebuild. Defaults are chosen for a typical desktop.

const os = require('os');

function intEnv(name, def, min, max) {
  const v = parseInt(process.env[name], 10);
  if (Number.isNaN(v)) return def;
  return Math.min(max ?? Infinity, Math.max(min ?? -Infinity, v));
}
function numEnv(name, def, min, max) {
  const v = Number(process.env[name]);
  if (!Number.isFinite(v)) return def;
  return Math.min(max ?? Infinity, Math.max(min ?? -Infinity, v));
}
function boolEnv(name, def) {
  const v = process.env[name];
  if (v == null) return def;
  return /^(1|true|yes|on)$/i.test(v);
}

const CPU = os.cpus().length || 4;

const config = {
  // ── Control plane (VPS) — DISABLED BY DEFAULT ────────────────────────────
  // The desktop runs PURELY locally: license check, update check, and mid-run
  // revalidation are all skipped unless R6_ONLINE=1 is explicitly set. This
  // means: no VPS downtime can ever stall the desktop, no license revocation
  // can mid-run kill a job, and no slow VPS network can throttle startup.
  // Set R6_ONLINE=1 to restore the legacy online behavior.
  controlPlane: {
    offline: !boolEnv('R6_ONLINE', false),
    baseUrl: (process.env.R6_SERVER_URL || 'https://r6checker.xyz').replace(/\/+$/, ''),
    licensePath: process.env.R6_LICENSE_PATH || '/api/cli/me',
    loginPath: '/api/cli/login',
    updatePath: process.env.R6_UPDATE_PATH || '/api/cli/version',
    timeoutMs: intEnv('R6_CP_TIMEOUT_MS', 15000, 2000, 60000),
    // How often to re-verify the license while a long job runs (ms). 0 = once.
    // In offline mode this timer is never armed regardless of the value here.
    revalidateMs: intEnv('R6_CP_REVALIDATE_MS', 15 * 60 * 1000, 0, 24 * 60 * 60 * 1000),
  },

  // ── Worker pool ──────────────────────────────────────────────────────────
  // Account checks are I/O-bound (each is a few HTTPS round-trips that spend
  // almost all their time waiting on the network/proxy), NOT CPU-bound. So a
  // small fixed set of THREADS each runs MANY concurrent async checks. Total
  // concurrency = the adaptive `target` (in-flight checks), spread across
  // `threads`. This is the difference between ~10 CPM and thousands.
  pool: {
    // Worker THREADS — each runs hundreds of concurrent async checks. With
    // UV_THREADPOOL_SIZE bumped to 64 (in main.js), more threads now actually
    // parallelize I/O instead of contending on the default 4-slot libuv pool,
    // so the default ceiling is higher: ≈ 2× cores, capped at 32.
    threads: intEnv('R6_THREADS', Math.max(4, Math.min(CPU * 2, 32)), 1, 64),
    // Total concurrent in-flight checks. The adaptive controller scales the
    // live target between min and max based on the live error/latency/memory.
    maxConcurrency: intEnv('R6_MAX_CONCURRENCY', 1024, 1, 100000),
    minConcurrency: intEnv('R6_MIN_CONCURRENCY', 16, 1, 100000),
    startConcurrency: intEnv('R6_START_CONCURRENCY', 256, 1, 100000),
    // A single check with no result within this window is considered hung; its
    // thread is recycled (its other in-flight checks are requeued). Full-capture
    // enrichment (login 429 retries + stats.cc + inventory) can take 2+ min.
    workerTimeoutMs: intEnv('R6_WORKER_TIMEOUT_MS', 180000, 5000, 600000),
    // Max consecutive crashes for one thread before we stop respawning it.
    maxRespawns: intEnv('R6_MAX_RESPAWNS', 8, 0, 1000),
  },

  // ── Adaptive concurrency controller ──────────────────────────────────────
  adaptive: {
    enabled: boolEnv('R6_ADAPTIVE', true),
    // Evaluate scaling decisions on this cadence.
    intervalMs: intEnv('R6_ADAPT_INTERVAL_MS', 3000, 500, 60000),
    // Scale DOWN when free system memory drops below this fraction.
    memFloorFree: numEnv('R6_MEM_FLOOR_FREE', 0.12, 0.02, 0.9),
    // Scale DOWN when the rolling failure rate exceeds this.
    failHigh: numEnv('R6_FAIL_HIGH', 0.35, 0.05, 0.95),
    // Scale UP again only when failure rate is below this.
    failLow: numEnv('R6_FAIL_LOW', 0.12, 0.01, 0.9),
    // Scale DOWN when median check latency exceeds this (ms) — backend is slow.
    latencyHighMs: intEnv('R6_LATENCY_HIGH_MS', 9000, 1000, 120000),
    latencyLowMs: intEnv('R6_LATENCY_LOW_MS', 4000, 500, 120000),
    // How many workers to add/remove per scaling step.
    step: intEnv('R6_ADAPT_STEP', 2, 1, 64),
  },

  // ── Job queue ────────────────────────────────────────────────────────────
  queue: {
    // Bounded in-memory window of jobs held ready for workers. The full job
    // list is streamed from the input file via the cursor, so this caps memory.
    capacity: intEnv('R6_QUEUE_CAPACITY', 5000, 100, 1000000),
    // Persist the cursor + counts every N completed jobs (crash recovery).
    persistEvery: intEnv('R6_PERSIST_EVERY', 100, 1, 100000),
    maxLines: intEnv('R6_MAX_LINES', 10000000, 1, 100000000),
  },

  // ── Retry / backoff ──────────────────────────────────────────────────────
  // "Never skip a line" — the engine REQUEUES every transient outcome until a
  // definitive answer (success/invalid/2fa) is recorded. maxAttempts is the
  // FAST lane cap; after that the slow lane retries with a long delay until
  // slowLaneMax (default ∞) is reached. So a brief proxy hiccup never marks
  // an account ERROR; only persistent failure across BOTH lanes does.
  retry: {
    maxAttempts:  intEnv('R6_RETRY_MAX',         25, 0, 200),
    slowLaneMax:  intEnv('R6_RETRY_SLOW_MAX',    50, 0, 1000),
    slowLaneMs:   intEnv('R6_RETRY_SLOW_MS', 60_000, 1000, 3_600_000),
    baseMs:       intEnv('R6_RETRY_BASE_MS',    400, 10, 60000),
    maxMs:        intEnv('R6_RETRY_MAX_MS',  15_000, 100, 300_000),
    factor:       numEnv('R6_RETRY_FACTOR',       2, 1.1, 10),
    jitter:       numEnv('R6_RETRY_JITTER',     0.5, 0, 1),
  },

  // ── Circuit breaker (per upstream, e.g. the proxy/Ubisoft) ───────────────
  circuit: {
    enabled: boolEnv('R6_CIRCUIT', true),
    // Open after this many failures within the rolling window.
    failureThreshold: intEnv('R6_CB_THRESHOLD', 20, 1, 10000),
    rollingMs: intEnv('R6_CB_WINDOW_MS', 30000, 1000, 600000),
    // Stay open this long, then allow a probe (half-open).
    openMs: intEnv('R6_CB_OPEN_MS', 15000, 1000, 600000),
    // Successful probes needed to fully close again.
    halfOpenSuccesses: intEnv('R6_CB_HALF_OPEN', 3, 1, 100),
  },

  // ── Output / writer ──────────────────────────────────────────────────────
  output: {
    dir: process.env.R6_OUTPUT_DIR || null, // null → dated folder next to the exe
    // Flush the OS write buffers if the stream reports backpressure.
    highWaterMark: intEnv('R6_WRITE_HWM', 1 << 20, 1 << 14, 1 << 26),
  },

  // ── Checks (the actual account check the worker performs) ────────────────
  check: {
    requestTimeoutMs: intEnv('R6_REQ_TIMEOUT_MS', 20000, 2000, 120000),
    // Enrich VALID accounts with level/items/rank/ban from the Ubisoft API.
    enrich: boolEnv('R6_ENRICH', true),
    proxyFile: process.env.R6_PROXY_FILE || 'proxies.txt',
  },

  // ── Metrics / logging ────────────────────────────────────────────────────
  metrics: {
    renderMs: intEnv('R6_METRICS_MS', 1000, 200, 10000),
  },
  logLevel: (process.env.R6_LOG_LEVEL || 'info').toLowerCase(), // error|warn|info|debug
};

module.exports = { config, CPU, intEnv, numEnv, boolEnv };
