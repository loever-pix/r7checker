'use strict';
// Circuit breaker — prevents cascading failures when the upstream (proxy /
// Ubisoft) is unhealthy. Three states:
//   CLOSED    — normal; failures counted in a rolling window.
//   OPEN      — too many failures; calls are short-circuited for `openMs`.
//   HALF_OPEN — after the cool-down, a few probe calls are allowed; enough
//               successes → CLOSED, any failure → OPEN again.

const { config } = require('./config');

const STATES = { CLOSED: 'closed', OPEN: 'open', HALF_OPEN: 'half_open' };

class CircuitBreaker {
  constructor(opts = {}) {
    const c = config.circuit;
    this.enabled = opts.enabled ?? c.enabled;
    this.failureThreshold = opts.failureThreshold ?? c.failureThreshold;
    this.rollingMs = opts.rollingMs ?? c.rollingMs;
    this.openMs = opts.openMs ?? c.openMs;
    this.halfOpenSuccesses = opts.halfOpenSuccesses ?? c.halfOpenSuccesses;
    this.now = opts.now || (() => Date.now());

    this.state = STATES.CLOSED;
    this.failTimes = [];        // timestamps of recent failures (rolling window)
    this.openedAt = 0;
    this.halfOpenOk = 0;
    this.transitions = [];      // history for metrics/logging
  }

  _prune(t) {
    const cutoff = t - this.rollingMs;
    while (this.failTimes.length && this.failTimes[0] < cutoff) this.failTimes.shift();
  }

  // Should a call be allowed right now? Also drives OPEN→HALF_OPEN.
  canRequest() {
    if (!this.enabled) return true;
    const t = this.now();
    if (this.state === STATES.OPEN) {
      if (t - this.openedAt >= this.openMs) {
        this.state = STATES.HALF_OPEN;
        this.halfOpenOk = 0;
        this.transitions.push({ t, to: STATES.HALF_OPEN });
        return true; // allow a probe
      }
      return false;
    }
    return true; // CLOSED or HALF_OPEN both allow (HALF_OPEN is probing)
  }

  recordSuccess() {
    if (!this.enabled) return;
    if (this.state === STATES.HALF_OPEN) {
      if (++this.halfOpenOk >= this.halfOpenSuccesses) {
        this.state = STATES.CLOSED;
        this.failTimes = [];
        this.transitions.push({ t: this.now(), to: STATES.CLOSED });
      }
    } else if (this.state === STATES.CLOSED) {
      // Successes gradually relieve pressure.
      if (this.failTimes.length) this.failTimes.shift();
    }
  }

  recordFailure() {
    if (!this.enabled) return;
    const t = this.now();
    if (this.state === STATES.HALF_OPEN) {
      this.state = STATES.OPEN;
      this.openedAt = t;
      this.transitions.push({ t, to: STATES.OPEN, reason: 'probe-failed' });
      return;
    }
    this.failTimes.push(t);
    this._prune(t);
    if (this.failTimes.length >= this.failureThreshold) {
      this.state = STATES.OPEN;
      this.openedAt = t;
      this.failTimes = [];
      this.transitions.push({ t, to: STATES.OPEN, reason: 'threshold' });
    }
  }

  // Milliseconds until the breaker will allow a probe (0 if already allowed).
  retryAfter() {
    if (this.state !== STATES.OPEN) return 0;
    return Math.max(0, this.openMs - (this.now() - this.openedAt));
  }

  snapshot() {
    return { state: this.state, recentFailures: this.failTimes.length, retryAfterMs: this.retryAfter() };
  }
}

module.exports = { CircuitBreaker, STATES };
