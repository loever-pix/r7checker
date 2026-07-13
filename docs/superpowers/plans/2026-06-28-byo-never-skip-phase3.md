# BYO Never-Skip Slow-Lane (Phase 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or executing-plans. Checkbox steps.

**Goal:** No BYO server-side account is ever left as a transient ERROR without a fair fight — after the fast lane exhausts, defer to a bounded slow lane that retries in rounds before any terminal outcome.

**Architecture:** Extract a pure, testable `drainSlowLane` into `lib/checker/neverSkip.js`, shared by BOTH the in-process worker (`bulkRunner.js`) and the worker child (`bulkWorker.js`). Each caller supplies context-specific `attempt`/`record`/`sleep`/`aborted` so the orchestration is identical while billing/IPC stay local.

**Tech Stack:** Node CommonJS. Tests: `node scripts/test-*.js` with `assert`.

---

## Task 1: `neverSkip.js` slow-lane orchestrator + tests

**Files:**
- Create: `lib/checker/neverSkip.js`
- Test: `scripts/test-never-skip.js`

- [ ] **Step 1: Write the failing test** — `scripts/test-never-skip.js`:

```js
'use strict';
const assert = require('assert');
const { drainSlowLane, TRANSIENT } = require('../lib/checker/neverSkip');

assert(TRANSIENT.has('network') && TRANSIENT.has('retry') && !TRANSIENT.has('invalid'), 'transient set');

(async () => {
  const sleep = async () => {};                 // no real waiting in tests

  // Case 1: an account that fails (network) twice then succeeds is RECORDED as
  // success, never as an error.
  {
    const tries = {};
    const recorded = [];
    const deferred = [{ id: 'a' }, { id: 'b' }];
    const attempt = async (item) => {
      tries[item.id] = (tries[item.id] || 0) + 1;
      return tries[item.id] >= 3 ? { outcome: 'success', playerData: { u: item.id } } : { outcome: 'network' };
    };
    const record = (item, outcome, pd) => recorded.push({ id: item.id, outcome, pd });
    const res = await drainSlowLane(deferred, { attempt, record, sleep }, { rounds: 5, delayMs: 0 });
    assert.strictEqual(recorded.length, 2, 'both eventually recorded');
    assert(recorded.every(r => r.outcome === 'success'), 'recorded as success not error');
    assert.strictEqual(res.terminal, 0, 'no terminal errors');
  }

  // Case 2: an account that ALWAYS fails is recorded ONCE as terminal network
  // after the round budget — never silently dropped.
  {
    const recorded = [];
    const attempt = async () => ({ outcome: 'retry' });
    const record = (item, outcome) => recorded.push({ id: item.id, outcome });
    const res = await drainSlowLane([{ id: 'x' }], { attempt, record, sleep }, { rounds: 3, delayMs: 0 });
    assert.strictEqual(recorded.length, 1, 'recorded exactly once');
    assert.strictEqual(recorded[0].outcome, 'network', 'terminal network');
    assert.strictEqual(res.terminal, 1, 'one terminal');
  }

  // Case 3: abort stops the drain and stops recording.
  {
    const recorded = [];
    let calls = 0;
    const attempt = async () => ({ outcome: 'network' });
    const record = (item, o) => recorded.push(o);
    const aborted = () => (++calls > 1);         // abort after first check
    await drainSlowLane([{ id: 'q' }, { id: 'r' }], { attempt, record, sleep, aborted }, { rounds: 5, delayMs: 0 });
    assert(recorded.length === 0, 'nothing terminal-recorded once aborted');
  }

  console.log('OK test-never-skip');
})().catch(e => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Run — MUST fail** (`Cannot find module '../lib/checker/neverSkip'`).

Run: `node scripts/test-never-skip.js`

- [ ] **Step 3: Create `lib/checker/neverSkip.js`:**

```js
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
        try { r = await attempt(item, round); } catch { r = { outcome: 'network' }; }
        if (aborted()) return;
        if (r && TRANSIENT.has(r.outcome)) queue.push(item);
        else record(item, r ? r.outcome : 'network', r ? r.playerData : null);
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, batch.length) }, work));
  }

  // Survivors after the budget → terminal network error (recorded, NEVER dropped).
  let terminal = 0;
  for (const item of queue) {
    if (aborted()) break;
    record(item, 'network', null);
    terminal++;
  }
  return { terminal, remaining: queue.length };
}

module.exports = { drainSlowLane, TRANSIENT };
```

- [ ] **Step 4: Run — MUST print `OK test-never-skip`.**

- [ ] **Step 5: Commit** `lib/checker/neverSkip.js scripts/test-never-skip.js` with message
`feat(bulk): never-skip slow-lane orchestrator (pure + tested)`.

---

## Task 2: wire the slow lane into `bulkRunner.js` (in-process path)

**Files:** Modify `lib/checker/bulkRunner.js` (the `runJob` function, ~330–505).

- [ ] **Step 1:** Inside `runJob`, after `const total = accounts.length;`, add slow-lane config + state:

```js
  const NET_RETRIES = Math.max(0, Number(process.env.BULK_NETWORK_RETRIES) || 3);
  const SLOW_ROUNDS = Math.max(0, Number(process.env.BULK_SLOW_RETRIES) || 8);
  const SLOW_MS = Math.max(1000, Number(process.env.BULK_SLOW_MS) || 30_000);
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const deferred = [];     // transient failures handed to the slow lane
```

- [ ] **Step 2:** Replace the body of `worker()` so its fast-retry loop becomes `attempt(...)`, its recording becomes `record(...)`, and a transient result defers instead of recording. Add these two helpers ABOVE `worker()` and rewrite `worker()`:

```js
  async function attempt(acc, idxSeed) {
    let outcome, playerData;
    for (let a = 0; a <= NET_RETRIES; a++) {
      const proxyUrl = (reg.proxies && reg.proxies.length) ? reg.proxies[(idxSeed + a) % reg.proxies.length] : null;
      try {
        const r = await withTimeout(checkOne(acc.email, acc.password, proxyUrl), CHECK_TIMEOUT_MS, 'check timeout');
        outcome = r.outcome; playerData = r.playerData;
      } catch (e) {
        if (e && e.message === 'check timeout') console.warn(`[bulk] check timed out for ${acc.email} after ${CHECK_TIMEOUT_MS}ms`);
        else console.error(`[bulk] worker error on ${acc.email}: ${e.message}`);
        outcome = 'network';
      }
      if (outcome !== 'network' && outcome !== 'retry') break;
      if (a < NET_RETRIES && !reg.abort.aborted && !reg.finalized) await sleep(400 + a * 600);
    }
    return { outcome, playerData };
  }

  function record(acc, outcome, playerData) {
    if (reg.abort.aborted || reg.finalized) return;
    if (fmt.isBillable(outcome) && !reg.unlimited) {
      try { store.chargeUser(userId, reg.priceCents, jobId, acc.email); }
      catch (e) {
        if (e instanceof store.InsufficientFundsError) { reg.abort.aborted = true; reg.stoppedEarly = 'insufficient_balance'; return; }
        throw e;
      }
    }
    const line = fmt.formatLine(acc.email, acc.password, outcome, playerData);
    try { reg.stream.write(line + '\n'); } catch { return; }
    reg.recent.push(line);
    if (reg.recent.length > RECENT_WINDOW) reg.recent.shift();
    const st = fmt.feedStatus(line);
    if (reg.counts[st] != null) reg.counts[st]++;
    if (st === 'valid' || st === 'vwi' || st === 'banned' || st === 'twofa') {
      reg.recentValid.push(line);
      if (reg.recentValid.length > RECENT_WINDOW) reg.recentValid.shift();
    }
    store.bumpJobDone(jobId);
  }

  async function worker() {
    while (cursor < total && !reg.abort.aborted) {
      const idx = cursor++;
      const acc = accounts[idx];
      const r = await attempt(acc, idx);
      if (reg.abort.aborted || reg.finalized) continue;
      if (r.outcome === 'network' || r.outcome === 'retry') deferred.push({ acc, idx });
      else record(acc, r.outcome, r.playerData);
    }
  }
```

(Delete the old inline `NET_RETRIES` const that was inside the while loop and the old recording block it replaced.)

- [ ] **Step 3:** In the in-process branch, drain the slow lane after the main pass. Replace:

```js
    } else {
      const workers = Array.from({ length: workerCount }, () => worker());
      await Promise.all(workers);
    }
```

with:

```js
    } else {
      await Promise.all(Array.from({ length: workerCount }, () => worker()));
      if (deferred.length) {
        console.log(`[bulk] job ${jobId}: slow lane — ${deferred.length} transient account(s) deferred for retry`);
        const { drainSlowLane } = require('./neverSkip');
        const res = await drainSlowLane(deferred, {
          attempt: (item, round) => attempt(item.acc, item.idx + round * 7),
          record: (item, outcome, pd) => record(item.acc, outcome, pd),
          sleep, concurrency: workerCount,
          aborted: () => reg.abort.aborted || reg.finalized,
        }, { rounds: SLOW_ROUNDS, delayMs: SLOW_MS });
        if (res.terminal) console.log(`[bulk] job ${jobId}: ${res.terminal} account(s) ended ERROR after slow lane`);
      }
    }
```

- [ ] **Step 4:** Verify: `node --check lib/checker/bulkRunner.js`. Run the full test suite (`node scripts/test-never-skip.js`).

- [ ] **Step 5:** Commit `lib/checker/bulkRunner.js` —
`feat(bulk): in-process BYO never-skip slow-lane (defer transient, retry in rounds)`.

---

## Task 3: wire the slow lane into `bulkWorker.js` (child path)

**Files:** Modify `lib/checker/bulkWorker.js` (`runChunk`, the worker fast loop).

- [ ] **Step 1:** Add config near the other consts (after `CHECK_2FA`):

```js
const SLOW_ROUNDS = Math.max(0, Number(process.env.BULK_SLOW_RETRIES) || 8);
const SLOW_MS = Math.max(1000, Number(process.env.BULK_SLOW_MS) || 30_000);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
```

- [ ] **Step 2:** Refactor `runChunk` so the fast loop becomes a reusable `attemptAccount(acc, idxSeed)` and a transient result defers; then drain. Replace the whole `runChunk` body with:

```js
async function runChunk() {
  let cursor = 0;
  const total = accounts.length;
  const deferred = [];

  async function attemptAccount(acc, idxSeed) {
    let outcome, playerData;
    for (let attempt = 0; attempt <= NET_RETRIES; attempt++) {
      const proxyUrl = (proxies && proxies.length) ? proxies[(idxSeed + attempt) % proxies.length] : null;
      try {
        const r = await withTimeout(checkOne(acc.email, acc.password, proxyUrl), CHECK_TIMEOUT_MS, 'check timeout');
        outcome = r.outcome; playerData = r.playerData;
      } catch (e) { outcome = 'network'; }
      if (outcome !== 'network' && outcome !== 'retry') break;
      if (attempt < NET_RETRIES && !aborted) await sleep(400 + attempt * 600);
    }
    return { outcome, playerData };
  }

  function emit(acc, outcome, playerData) {
    if (aborted) return;
    const line = fmt.formatLine(acc.email, acc.password, outcome, playerData);
    try { process.send({ type: 'result', email: acc.email, outcome, line }); } catch { aborted = true; }
  }

  const workers = [];
  for (let i = 0; i < PER_WORKER_CONCURRENCY; i++) {
    workers.push((async () => {
      while (cursor < total && !aborted) {
        const idx = cursor++;
        const acc = accounts[idx];
        const r = await attemptAccount(acc, idx);
        if (aborted) continue;
        if (r.outcome === 'network' || r.outcome === 'retry') deferred.push({ acc, idx });
        else emit(acc, r.outcome, r.playerData);
      }
    })());
  }
  await Promise.all(workers);

  if (deferred.length && !aborted) {
    const { drainSlowLane } = require('./neverSkip');
    await drainSlowLane(deferred, {
      attempt: (item, round) => attemptAccount(item.acc, item.idx + round * 7),
      record: (item, outcome, pd) => emit(item.acc, outcome, pd),
      sleep, concurrency: PER_WORKER_CONCURRENCY,
      aborted: () => aborted,
    }, { rounds: SLOW_ROUNDS, delayMs: SLOW_MS });
  }
}
```

- [ ] **Step 3:** Verify `node --check lib/checker/bulkWorker.js`.

- [ ] **Step 4:** Commit `lib/checker/bulkWorker.js` —
`feat(bulk): child-worker BYO never-skip slow-lane (mirror in-process)`.

---

## Self-review (coverage vs spec §Phase 3)

- Transient (network/retry) deferred, not terminal-recorded on first exhaustion → Tasks 2 & 3. ✓
- Bounded slow-lane rounds + backoff, fresh proxy seed per round → all. ✓
- Terminal error only after the budget, still RECORDED (never silently skipped) → neverSkip. ✓
- Both BYO paths (in-process + child) covered → Tasks 2 & 3. ✓
- Abort/cancel respected (stops drain + recording) → `aborted()` everywhere. ✓
