'use strict';
// Real-time metrics: checks/min, active workers, queue depth, retries, failure
// rate, elapsed, throughput. Maintains a rolling window for an instantaneous
// CPM that reacts to the current pace (not just the lifetime average).

class Metrics {
  constructor({ total = 0, rollingMs = 60000 } = {}) {
    this.total = total;
    this.startedAt = Date.now();
    this.counts = { valid: 0, invalid: 0, twofa: 0, banned: 0, error: 0, retried: 0, done: 0 };
    this.activeWorkers = 0;
    this.targetWorkers = 0;
    this.queueDepth = 0;
    this.circuit = 'closed';
    this._completionTimes = []; // rolling timestamps of completions
    this._rollingMs = rollingMs;
    this._latencies = [];       // recent per-check latencies (ms), capped
    this._latencyCap = 500;
  }

  markResult(status, latencyMs) {
    if (status === 'valid') this.counts.valid++;
    else if (status === 'invalid') this.counts.invalid++;
    else if (status === 'twofa' || status === '2fa') this.counts.twofa++;
    else if (status === 'banned') this.counts.banned++;
    else this.counts.error++;
    this.counts.done++;
    const now = Date.now();
    this._completionTimes.push(now);
    if (Number.isFinite(latencyMs)) {
      this._latencies.push(latencyMs);
      if (this._latencies.length > this._latencyCap) this._latencies.shift();
    }
    this._pruneRolling(now);
  }

  markRetry() { this.counts.retried++; }

  _pruneRolling(now) {
    const cutoff = now - this._rollingMs;
    while (this._completionTimes.length && this._completionTimes[0] < cutoff) this._completionTimes.shift();
  }

  elapsedSec() { return (Date.now() - this.startedAt) / 1000; }

  // Instantaneous checks-per-minute over the rolling window.
  cpm() {
    this._pruneRolling(Date.now());
    const windowSec = Math.min(this._rollingMs / 1000, this.elapsedSec());
    if (windowSec <= 0) return 0;
    return (this._completionTimes.length / windowSec) * 60;
  }

  // Lifetime throughput (checks/sec).
  throughput() {
    const s = this.elapsedSec();
    return s > 0 ? this.counts.done / s : 0;
  }

  // Rolling failure rate (errors among recent completions).
  failureRate() {
    const recent = this._completionTimes.length;
    if (!recent) return 0;
    // Approximate: errors over the lifetime ratio scaled by recency is noisy;
    // use the simple lifetime error fraction which is stable for control.
    return this.counts.done ? this.counts.error / this.counts.done : 0;
  }

  // Median recent latency (ms) — drives the latency-based scaling decision.
  medianLatency() {
    if (!this._latencies.length) return 0;
    const arr = this._latencies.slice().sort((a, b) => a - b);
    return arr[Math.floor(arr.length / 2)];
  }

  etaSec() {
    const remaining = Math.max(0, this.total - this.counts.done);
    const cpm = this.cpm();
    if (cpm <= 0) return Infinity;
    return (remaining / cpm) * 60;
  }

  snapshot() {
    return {
      total: this.total,
      done: this.counts.done,
      valid: this.counts.valid,
      invalid: this.counts.invalid,
      twofa: this.counts.twofa,
      banned: this.counts.banned,
      error: this.counts.error,
      retried: this.counts.retried,
      activeWorkers: this.activeWorkers,
      targetWorkers: this.targetWorkers,
      queueDepth: this.queueDepth,
      circuit: this.circuit,
      cpm: Math.round(this.cpm()),
      throughput: Number(this.throughput().toFixed(2)),
      failureRate: Number((this.failureRate() * 100).toFixed(1)),
      medianLatencyMs: this.medianLatency(),
      elapsedSec: Math.round(this.elapsedSec()),
      etaSec: this.etaSec(),
    };
  }
}

function fmtDuration(sec) {
  if (!Number.isFinite(sec)) return '—';
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
}

module.exports = { Metrics, fmtDuration };
