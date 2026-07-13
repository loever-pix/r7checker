'use strict';
// Detects prolonged 0-throughput stalls and force-stops the run so the UI
// can leave raw-mode stdin and return to the menu.

const { intEnv } = require('./config');

function createStallWatch({
  getDone,
  onStall,
  stallMs,
  graceMs,
  label = 'run',
} = {}) {
  // Default 90s — short 45s was too aggressive on large multiproc + 429 backoff
  // (looked like "crashed" after ~2.5k lines).
  const limit = stallMs ?? intEnv('R6_STALL_MS', 90000, 15000, 600000);
  const grace = graceMs ?? intEnv('R6_STALL_GRACE_MS', 30000, 5000, 300000);
  const startedAt = Date.now();
  let lastDone = typeof getDone === 'function' ? (getDone() || 0) : 0;
  let lastProgressAt = Date.now();
  let fired = false;
  let timer = null;

  const tick = () => {
    if (fired) return;
    const now = Date.now();
    if (now - startedAt < grace) return;
    const done = typeof getDone === 'function' ? (getDone() || 0) : 0;
    if (done > lastDone) {
      lastDone = done;
      lastProgressAt = now;
      return;
    }
    if (now - lastProgressAt >= limit) {
      fired = true;
      try {
        onStall({
          stalledForMs: now - lastProgressAt,
          done: lastDone,
          label,
        });
      } catch { /* ignore */ }
    }
  };

  const interval = Math.min(2000, Math.max(200, Math.floor(limit / 4)));
  timer = setInterval(tick, interval);
  if (timer.unref) timer.unref();

  return {
    bump(done) {
      const n = done == null ? (typeof getDone === 'function' ? getDone() : lastDone) : done;
      if (n > lastDone) {
        lastDone = n;
        lastProgressAt = Date.now();
      }
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}

module.exports = { createStallWatch };
