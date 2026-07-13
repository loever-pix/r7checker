'use strict';
// Dynamic queue for pipeline enrich jobs (hits from the login sweep).

const { intEnv } = require('./config');

class EnrichQueue {
  constructor({ capacity } = {}) {
    this._pending = [];
    this.inFlight = 0;
    this.capacity = capacity || intEnv('R6_ENRICH_QUEUE_CAP', 2000, 50, 100000);
    this.completed = 0;
    this._open = true;
  }

  close() { this._open = false; }

  push(item) {
    this._pending.push({ item, attempt: 1, readyAt: 0 });
  }

  get depth() { return this._pending.length + this.inFlight; }
  get done() {
    if (this._open) return false;
    return this._pending.length === 0 && this.inFlight === 0;
  }
  get remaining() { return this._pending.length; }
  get total() { return this.completed + this._pending.length + this.inFlight; }

  canDispatch() { return this.inFlight < this.capacity; }

  next() {
    if (!this.canDispatch() || !this._pending.length) return null;
    const now = Date.now();
    let idx = -1;
    for (let i = 0; i < this._pending.length; i++) {
      if (this._pending[i].readyAt <= now) { idx = i; break; }
    }
    if (idx < 0) return null;
    const job = this._pending.splice(idx, 1)[0];
    this.inFlight++;
    return { item: job.item, attempt: job.attempt };
  }

  requeue(item, attempt, delayMs) {
    this.inFlight = Math.max(0, this.inFlight - 1);
    this._pending.push({ item, attempt, readyAt: Date.now() + Math.max(0, delayMs) });
  }

  complete() {
    this.inFlight = Math.max(0, this.inFlight - 1);
    this.completed++;
  }

  nextReadyInMs() {
    if (this.canDispatch() && this._pending.length) return 0;
    if (!this._pending.length) return Infinity;
    const now = Date.now();
    let min = Infinity;
    for (const j of this._pending) min = Math.min(min, Math.max(0, j.readyAt - now));
    return min;
  }
}

module.exports = { EnrichQueue };
