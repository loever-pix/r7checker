'use strict';
// Bounded "slow lane" so no account is ever silently left as a transient error.
// After the fast lane gives up on a network/retry outcome, the account is
// deferred here and retried in ROUNDS with backoff; only after the round budget
// is spent is a terminal outcome recorded. Pure orchestration — the caller
// supplies attempt/record/sleep/aborted so it works in-process AND in the worker
// child, and is unit-testable with fakes.

const TRANSIENT = new Set(['network', 'retry']);

// deferred: array of opaque items (the caller's account refs).
// deps.attempt(item, round) -> Promise<{ outcome, playerData }>
// deps.record(item, outcome, playerData) -> void   (caller bills/writes/counts)
// deps.sleep(ms) -> Promise   deps.aborted() -> bool   deps.concurrency (int)
// opts.rounds (default 8), opts.delayMs (default 30000)
async function drainSlowLane(deferred, deps, opts = {}) {
  const attempt = deps.attempt;
  const record = deps.record;
  const sleep = deps.sleep || ((ms) => new Promise(r => setTimeout(r, ms)));
  const aborted = deps.aborted || (() => false);
  const concurrency = Math.max(1, deps.concurrency || 1);
  // Optional rate-governor gate. When supplied, every retry attempt acquires a
  // governor slot first, so the slow lane obeys the SAME adaptive concurrency +
  // circuit breaker as the fast lane instead of slamming the upstream at full
  // batch width (which would re-trigger the 429 storms the governor prevents).
  // Defaults to no-op so callers that don't pass them (and the unit tests) are
  // unaffected.
  const acquire = deps.acquire || (async () => {});
  const release = deps.release || (() => {});
  const rounds = opts.rounds != null ? opts.rounds : 8;
  const delayMs = opts.delayMs != null ? opts.delayMs : 30000;

  let queue = (deferred || []).slice();

  for (let round = 1; round <= rounds && queue.length && !aborted(); round++) {
    await sleep(delayMs);
    if (aborted()) break;
    const batch = queue; queue = [];
    let cursor = 0;
    const work = async () => {
      while (cursor < batch.length && !aborted()) {
        const item = batch[cursor++];
        let r;
        await acquire();
        try { r = await attempt(item, round); }
        catch { r = { outcome: 'network' }; }
        finally { release(); }
        if (aborted()) return;
        if (r && TRANSIENT.has(r.outcome)) queue.push(item);
        else record(item, r ? r.outcome : 'network', r ? r.playerData : null);
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, batch.length) }, work));
  }

  // Survivors couldn't be resolved within the budget. By DEFAULT we leave them
  // UNRECORDED — so the results file has NO error lines and the survivors fall
  // into the job's "unchecked" set (resumable "later"). Set opts.recordTerminalAs
  // (e.g. 'network') to restore the old behavior of writing a terminal error.
  let terminal = 0;
  if (opts.recordTerminalAs) {
    for (const item of queue) {
      if (aborted()) break;          // cancelled / out-of-funds mid-drain → stop
      record(item, opts.recordTerminalAs, null);
      terminal++;
    }
  }
  // unresolved = accounts left for a future resume (NOT errors, NOT recorded).
  return { terminal, unresolved: queue.length - terminal };
}

module.exports = { drainSlowLane, TRANSIENT };
