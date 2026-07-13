'use strict';
// Bounded, persistent job queue with an atomic cursor.
//
// The full account list is read from the input file ONCE into an in-memory
// array (capped at config.queue.maxLines). Jobs are handed out via an atomic
// integer cursor — Node's single-threaded event loop makes `cursor++` atomic
// across async workers (no lock needed). The queue is "bounded" in the sense
// that no more than `capacity` jobs are ever in-flight + buffered at once;
// workers pull lazily so memory stays flat regardless of list size.
//
// Crash recovery: the cursor + counts are persisted to a sidecar JSON file every
// `persistEvery` completions and on shutdown. On resume we fast-forward the
// cursor and skip already-written results.

const fs = require('fs');
const path = require('path');
const { config } = require('./config');

class JobQueue {
  constructor(items, statePath) {
    this.items = items;                 // array of { id, line, email, password }
    this.cursor = 0;                    // atomic next-index
    this.inFlight = 0;
    this.capacity = config.queue.capacity;
    this.statePath = statePath;
    this.completed = 0;
    this._sincePersist = 0;
    this._retryHeap = [];               // jobs to re-attempt: { item, attempt, readyAt }
  }

  get total() { return this.items.length; }
  get remaining() { return this.items.length - this.cursor + this._retryHeap.length; }
  get depth() { return this.remaining + this.inFlight; }
  get done() { return this.cursor >= this.items.length && this._retryHeap.length === 0 && this.inFlight === 0; }

  // Backpressure: refuse to dispatch more if too many are already in flight.
  canDispatch() { return this.inFlight < this.capacity; }

  // Atomically claim the next job (a due retry first, then a fresh one).
  // Returns { item, attempt } or null if nothing is ready right now.
  next() {
    if (!this.canDispatch()) return null;
    const now = Date.now();
    // Due retries take priority so failures don't starve behind fresh work.
    for (let i = 0; i < this._retryHeap.length; i++) {
      if (this._retryHeap[i].readyAt <= now) {
        const job = this._retryHeap.splice(i, 1)[0];
        this.inFlight++;
        return { item: job.item, attempt: job.attempt };
      }
    }
    if (this.cursor < this.items.length) {
      const item = this.items[this.cursor++];
      this.inFlight++;
      return { item, attempt: 1 };
    }
    return null;
  }

  // Re-enqueue a job for a later attempt (used by the retry logic).
  requeue(item, attempt, delayMs) {
    this.inFlight = Math.max(0, this.inFlight - 1);
    this._retryHeap.push({ item, attempt, readyAt: Date.now() + Math.max(0, delayMs) });
  }

  // Mark a job finished (terminal). Persists state periodically.
  complete() {
    this.inFlight = Math.max(0, this.inFlight - 1);
    this.completed++;
    if (++this._sincePersist >= config.queue.persistEvery) {
      this._sincePersist = 0;
      this.persist();
    }
  }

  // ms until the next retry becomes ready (Infinity if none) — lets the
  // scheduler idle efficiently instead of busy-spinning.
  nextReadyInMs() {
    if (this.cursor < this.items.length && this.canDispatch()) return 0;
    if (!this._retryHeap.length) return Infinity;
    const now = Date.now();
    let min = Infinity;
    for (const j of this._retryHeap) min = Math.min(min, Math.max(0, j.readyAt - now));
    return min;
  }

  persist() {
    if (!this.statePath) return;
    try {
      const tmp = this.statePath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({
        version: 1,
        cursor: this.cursor,
        completed: this.completed,
        total: this.items.length,
        savedAt: Date.now(),
      }));
      fs.renameSync(tmp, this.statePath); // atomic replace
    } catch { /* best-effort */ }
  }

  // Restore cursor from a prior run; returns the recovered cursor or 0.
  restore() {
    if (!this.statePath) return 0;
    try {
      const st = JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
      if (st && Number.isInteger(st.cursor) && st.total === this.items.length) {
        this.cursor = Math.min(st.cursor, this.items.length);
        this.completed = st.completed || this.cursor;
        return this.cursor;
      }
    } catch { /* no prior state */ }
    return 0;
  }
}

// Stream the input file into normalized job items (email:pass per line).
function loadJobs(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const items = [];
  let id = 0;
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    if (items.length >= config.queue.maxLines) break;
    const ci = t.indexOf(':');
    const email = (ci >= 0 ? t.slice(0, ci) : t).trim();
    const password = ci >= 0 ? t.slice(ci + 1) : '';
    items.push({ id: id++, line: t, email, password });
  }
  return items;
}

module.exports = { JobQueue, loadJobs };
