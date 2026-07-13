'use strict';
// Exponential backoff with jitter + transient/permanent error classification.
//
// classifyOutcome() turns a check result (or thrown error) into one of:
//   'permanent'  — a definitive account answer (valid/invalid/2fa). Never retry.
//   'transient'  — network blip, timeout, 5xx, proxy tunnel, rate-limit. Retry.
//   'fatal'      — caller/config error (bad input). Never retry, surface it.

const { config } = require('./config');

// Compute the delay before attempt N (1-based) with full jitter.
function backoffDelay(attempt, rng = Math.random) {
  const { baseMs, maxMs, factor, jitter } = config.retry;
  const raw = Math.min(maxMs, baseMs * Math.pow(factor, Math.max(0, attempt - 1)));
  // "Equal jitter": half fixed, half random — bounded, still de-synchronised.
  const fixed = raw * (1 - jitter);
  const rand = raw * jitter * rng();
  return Math.round(fixed + rand);
}

// Classify a worker check result. `result.status` is the account outcome;
// `result.retryable` may be set by the worker for explicit signals.
function classifyResult(result) {
  if (!result) return 'transient';
  const s = result.status;
  if (s === 'valid' || s === 'invalid' || s === 'twofa' || s === '2fa' || s === 'banned') return 'permanent';
  if (s === 'invalid_format') return 'fatal';
  // network / ratelimit / datadome / unknown / error → retry
  return 'transient';
}

// Classify a thrown error from a network operation.
function classifyError(err) {
  const code = (err && (err.code || '')).toString().toUpperCase();
  const msg = (err && err.message ? err.message : '').toLowerCase();
  if (/ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|EPIPE|ECONNABORTED|ERR_TLS|SOCKET|TUNNEL/.test(code + ' ' + msg)) return 'transient';
  if (/timeout|timed out|429|rate|502|503|504|temporarily/.test(msg)) return 'transient';
  return 'transient'; // default to transient for network ops — the attempt cap bounds it
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { backoffDelay, classifyResult, classifyError, sleep };
