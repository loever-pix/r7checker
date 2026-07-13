'use strict';
// Adaptive worker_threads pool. Owns the full worker lifecycle: spawn, assign
// jobs, monitor health (replace hung/crashed workers), and dynamically scale the
// number of active workers based on CPU, memory, failure rate, and latency.

const os = require('os');
const { Worker } = require('worker_threads');
const { EventEmitter } = require('events');
const { config } = require('./config');
const log = require('./logger');

// One managed worker thread. Each runs MANY concurrent async checks; `inFlight`
// maps a jobId → { job, startedAt } for result routing + per-check hang
// detection.
class Slot {
  constructor(id, worker) {
    this.id = id;
    this.worker = worker;
    this.inFlight = new Map();   // jobId → { job, startedAt }
    this.respawns = 0;
    this.alive = true;
  }
  get load() { return this.inFlight.size; }
}

class WorkerPool extends EventEmitter {
  // workerSpec: { file } OR { source } (eval bundle). workerData passed to each.
  constructor({ workerSpec, workerData, proxies, queue, breaker, metrics, governor, name, maxConcurrency: capOverride, startConcurrency: startOverride }) {
    super();
    this.workerSpec = workerSpec;
    this.workerData = workerData || {};
    this.proxies = proxies && proxies.length ? proxies : [null];
    this.queue = queue;
    this.breaker = breaker;
    this.metrics = metrics;
    this.governor = governor || null;
    this.name = name || 'pool';
    this._govHeld = new Map();

    this.slots = new Map();
    this.nextSlotId = 0;
    this.threadCount = config.pool.threads;
    this.maxConcurrency = Math.min(
      capOverride != null ? capOverride : config.pool.maxConcurrency,
      this.queue.capacity || config.pool.maxConcurrency,
    );
    this.target = Math.min(
      startOverride != null ? startOverride : config.pool.startConcurrency,
      this.maxConcurrency,
    );
    this.draining = false;        // graceful shutdown: stop dispatching new jobs
    this.stopped = false;
    this._proxyCursor = 0;
    this._adaptTimer = null;
    this._healthTimer = null;
    this._scheduleTimer = null;
    this._idleResolve = null;
    this._donePromise = new Promise((res) => { this._idleResolve = res; });
  }

  _inFlight() { let n = 0; for (const s of this.slots.values()) n += s.inFlight.size; return n; }

  // Live thread with the fewest in-flight checks (spreads load evenly).
  _leastLoaded() {
    let best = null;
    for (const s of this.slots.values()) {
      if (!s.alive) continue;
      if (!best || s.load < best.load) best = s;
    }
    return best;
  }

  _spawn() {
    const id = this.nextSlotId++;
    let worker;
    const opts = { workerData: this.workerData };
    if (this.workerSpec.source) worker = new Worker(this.workerSpec.source, { ...opts, eval: true });
    else worker = new Worker(this.workerSpec.file, opts);

    const slot = new Slot(id, worker);
    this.slots.set(id, slot);

    worker.on('message', (msg) => this._onMessage(slot, msg));
    worker.on('error', (err) => this._onWorkerError(slot, err));
    worker.on('exit', (code) => this._onWorkerExit(slot, code));
    return slot;
  }

  _onMessage(slot, msg) {
    if (!msg) return;
    if (msg.type === 'ready') { this._tick(); return; }
    if (msg.type === 'result') {
      const jid = msg.jobId != null ? msg.jobId : msg.id;
      const entry = slot.inFlight.get(jid);
      if (entry) { slot.inFlight.delete(jid); this._handleResult(entry.job, msg); }
      this._tick();
    }
  }

  _onWorkerError(slot, err) {
    log.warn(`worker ${slot.id} error: ${err.message}`);
    this._requeueSlotJobs(slot);
    this._replaceSlot(slot, 'error');
  }

  _onWorkerExit(slot, code) {
    if (!slot.alive) return; // intentional termination
    if (code !== 0) {
      log.warn(`worker ${slot.id} exited (code ${code})`);
      this._requeueSlotJobs(slot);
      this._replaceSlot(slot, 'exit');
    }
  }

  // Recycling a thread loses ALL of its in-flight checks — requeue every one so
  // none are dropped (they retry on another thread).
  _requeueSlotJobs(slot) {
    for (const { job } of slot.inFlight.values()) {
      if (this.governor && this._govHeld.has(job.item.id)) {
        this.governor.release();
        this._govHeld.delete(job.item.id);
      }
      this.queue.requeue(job.item, job.attempt, 0);
    }
    slot.inFlight.clear();
  }

  _replaceSlot(slot, reason) {
    slot.alive = false;
    try { slot.worker.terminate(); } catch {}
    this.slots.delete(slot.id);
    if (this.stopped || this.draining) { this._maybeDone(); return; }
    if (slot.respawns >= config.pool.maxRespawns) {
      log.error(`worker slot exceeded ${config.pool.maxRespawns} respawns — not replacing (reason: ${reason})`);
      this._maybeDone();
      return;
    }
    const fresh = this._spawn();
    fresh.respawns = slot.respawns + 1;
  }

  // Round-robin over proxies, skipping any that are currently cooling down
  // from a 429 storm. Falls back to the next one in rotation rather than
  // returning null — we want SOME proxy to be used so the pool never stalls.
  _nextProxy() {
    const N = this.proxies.length;
    if (N <= 1) { this._proxyCursor++; return this.proxies[0]; }
    const map = this._proxyHits;
    const now = Date.now();
    for (let tries = 0; tries < N; tries++) {
      const p = this.proxies[this._proxyCursor++ % N];
      const entry = map && map.get(p);
      if (!entry || entry.cooldownUntil <= now) return p;
    }
    // All proxies cooling down — return one anyway so dispatch continues; the
    // worker will likely 429 again and contribute to backoff measurements.
    return this.proxies[this._proxyCursor++ % N];
  }

  _handleResult(job, msg) {
    if (this.governor && this._govHeld.has(job.item.id)) {
      this.governor.release();
      this._govHeld.delete(job.item.id);
    }

    // Pipeline sweep hit — defer write until enrich lane completes full capture.
    if (msg.needsEnrich) {
      this.queue.complete();
      this.emit('needsEnrich', { job, msg });
      this._maybeDone();
      this._tick();
      return;
    }

    const { classifyResult, classifyError, backoffDelay } = require('./retry');
    // Track per-proxy 429s for cooldown decisions before we forget the proxy
    // assignment. msg.error/code surface upstream rate-limit signals.
    if (msg.status === 'error') this._notePossible429(job, msg);

    // Decide retry vs terminal.
    let kind;
    if (msg.status === 'error') {
      kind = classifyError({ code: msg.code, message: msg.error });
      this.breaker.recordFailure();
    } else {
      kind = classifyResult(msg);
      this.breaker.recordSuccess();
    }

    // Fast lane — exponential backoff with jitter.
    if (kind === 'transient' && job.attempt < config.retry.maxAttempts) {
      this.metrics.markRetry();
      const delay = backoffDelay(job.attempt + 1);
      this.queue.requeue(job.item, job.attempt + 1, delay);
      return;
    }

    // Slow lane — after fast retries exhaust we DO NOT mark the line ERROR.
    // The user's directive is "never skip a line and make sure its finished
    // if error do it later". So we keep requeueing on a long delay
    // (slowLaneMs) until slowLaneMax additional attempts also exhaust.
    const slowMax = config.retry.maxAttempts + (config.retry.slowLaneMax || 0);
    if (kind === 'transient' && job.attempt < slowMax) {
      this.metrics.markRetry();
      this.queue.requeue(job.item, job.attempt + 1, config.retry.slowLaneMs);
      return;
    }

    // Terminal — only after BOTH lanes exhaust. Record metric + emit for the
    // writer (which will write to errors.txt so the user can re-process).
    this.metrics.markResult(msg.status === 'error' && kind !== 'transient' ? 'error'
      : (msg.status === 'error' ? 'error' : msg.status), msg.latencyMs);
    this.queue.complete();
    this.emit('result', { job, msg });
    this._maybeDone();
  }

  // Per-proxy 429 / rate-limit accounting. A proxy URL that throws 429-ish
  // errors many times in the rolling window gets a short cooldown — the
  // dispatcher skips it for that window so the rest of the pool keeps
  // flowing instead of stalling on a single hot proxy.
  _notePossible429(job, msg) {
    if (!job || !job.proxy) return;
    const m = String(msg.error || '').toLowerCase();
    const c = String(msg.code || '').toUpperCase();
    const is429 = /429|rate.?limit|too.?many|ERATELIMIT/i.test(m + ' ' + c);
    if (!is429) return;
    const map = this._proxyHits || (this._proxyHits = new Map());
    const now = Date.now();
    const entry = map.get(job.proxy) || { hits: [], cooldownUntil: 0 };
    entry.hits = entry.hits.filter(t => now - t < 30_000);
    entry.hits.push(now);
    if (entry.hits.length >= 8) {
      entry.cooldownUntil = now + 15_000;   // 15s skip; cheap and self-healing
      entry.hits.length = 0;
    }
    map.set(job.proxy, entry);
  }

  // Keep `target` checks in flight, spread across the threads. Each dispatch
  // goes to the least-loaded live thread so concurrency stays balanced.
  _govCap() {
    if (!this.governor) return this.target;
    try { return Math.min(this.target, this.governor.concurrency()); } catch { return this.target; }
  }

  _dispatchJob(slot) {
    const job = this.queue.next();
    if (!job) return false;
    const proxy = this._nextProxy();
    job.proxy = proxy;
    slot.inFlight.set(job.item.id, { job, startedAt: Date.now() });
    slot.worker.postMessage({ type: 'job', item: job.item, proxy });
    return true;
  }

  _tryDispatch() {
    const cap = this._govCap();
    let inFlight = this._inFlight();
    while (inFlight < cap) {
      if (this.stopped || this.draining) break;
      const slot = this._leastLoaded();
      if (!slot) break;
      if (!this._dispatchJob(slot)) break;
      inFlight++;
    }
    return inFlight;
  }

  // Wait for a governor slot without parking the event loop forever. On stop/
  // drain, abandon the pending acquire (release if it later grants).
  async _acquireGovSlot() {
    if (!this.governor) return true;
    let granted = false;
    const pending = this.governor.acquire().then(() => { granted = true; });
    while (!granted && !this.stopped && !this.draining) {
      await Promise.race([
        pending,
        new Promise((resolve) => setTimeout(resolve, 200)),
      ]);
    }
    if (!granted) {
      pending.then(() => { try { this.governor.release(); } catch { /* ignore */ } }).catch(() => {});
      return false;
    }
    if (this.stopped || this.draining) {
      try { this.governor.release(); } catch { /* ignore */ }
      return false;
    }
    return true;
  }

  async _dispatchWithGov() {
    if (this.stopped || this.draining) return;
    if (this.breaker && !this.breaker.canRequest()) {
      this.metrics.circuit = this.breaker.snapshot().state;
      this._reschedule(Math.min(800, this.breaker.retryAfter() || 400));
      return;
    }
    this.metrics.circuit = this.breaker ? this.breaker.snapshot().state : 'closed';

    const cap = this._govCap();
    let inFlight = this._inFlight();
    while (inFlight < cap) {
      if (this.stopped || this.draining) break;
      const slot = this._leastLoaded();
      if (!slot) break;
      if (this.governor) {
        const ok = await this._acquireGovSlot();
        if (!ok) break;
      }
      const job = this.queue.next();
      if (!job) {
        if (this.governor) { try { this.governor.release(); } catch { /* ignore */ } }
        break;
      }
      if (this.governor) this._govHeld.set(job.item.id, true);
      const proxy = this._nextProxy();
      job.proxy = proxy;
      slot.inFlight.set(job.item.id, { job, startedAt: Date.now() });
      slot.worker.postMessage({ type: 'job', item: job.item, proxy });
      inFlight++;
    }

    this.metrics.activeWorkers = inFlight;
    this.metrics.targetWorkers = cap;
    this.metrics.queueDepth = this.queue.depth;

    if (inFlight === 0) {
      const wait = this.queue.nextReadyInMs();
      if (wait === Infinity) this._maybeDone();
      else this._reschedule(Math.min(wait, 400));
    }
  }

  _tick() {
    if (this.stopped) return;
    if (this.draining) { this._maybeDone(); return; }

    if (this.governor) {
      if (this._tickRunning) return;
      this._tickRunning = true;
      this._dispatchWithGov()
        .catch((e) => log.warn(`${this.name} dispatch: ${e.message}`))
        .finally(() => { this._tickRunning = false; });
      return;
    }

    if (this.breaker && !this.breaker.canRequest()) {
      this.metrics.circuit = this.breaker.snapshot().state;
      this._reschedule(Math.min(800, this.breaker.retryAfter() || 400));
      return;
    }
    this.metrics.circuit = this.breaker ? this.breaker.snapshot().state : 'closed';

    const inFlight = this._tryDispatch();

    this.metrics.activeWorkers = inFlight;
    this.metrics.targetWorkers = this.target;
    this.metrics.queueDepth = this.queue.depth;

    if (inFlight === 0) {
      const wait = this.queue.nextReadyInMs();
      if (wait === Infinity) this._maybeDone();
      else this._reschedule(Math.min(wait, 400));
    }
  }

  _reschedule(ms) {
    if (this._scheduleTimer) return;
    this._scheduleTimer = setTimeout(() => { this._scheduleTimer = null; this._tick(); }, ms);
    if (this._scheduleTimer.unref) this._scheduleTimer.unref();
  }

  _maybeDone() {
    if (this.stopped) return;
    const anyInFlight = this._inFlight() > 0;
    if ((this.queue.done && !anyInFlight) || (this.draining && !anyInFlight)) {
      this.stopped = true;
      this._idleResolve && this._idleResolve();
    }
  }

  // ── Health monitor: recycle a thread with ANY check stuck past the timeout ─
  _startHealth() {
    this._healthTimer = setInterval(() => {
      const now = Date.now();
      for (const slot of [...this.slots.values()]) {
        let oldest = 0;
        for (const { startedAt } of slot.inFlight.values()) oldest = Math.max(oldest, now - startedAt);
        if (oldest > config.pool.workerTimeoutMs) {
          log.warn(`worker ${slot.id} hung (${slot.inFlight.size} in-flight, oldest ${Math.round(oldest / 1000)}s) — recycling`);
          this.breaker.recordFailure();
          this._requeueSlotJobs(slot);
          this._replaceSlot(slot, 'hang');
        }
      }
    }, Math.max(2000, Math.floor(config.pool.workerTimeoutMs / 3)));
    if (this._healthTimer.unref) this._healthTimer.unref();
  }

  // ── Adaptive concurrency controller — THROUGHPUT PEAK-HUNTER ──────────────
  // We hunt the throughput PEAK by stepping concurrency up/down and reversing
  // when the rolling success rate drops. KEY FIXES from the previous version:
  //   1. We use VALID+definitive-COMPLETION rate, not raw `done`. The old
  //      controller ignored slow-lane requeues (which now hold transient lines
  //      back for minutes), so a flood of fake-INVALIDs from a broken proxy
  //      used to LOOK like good throughput. Definitive (valid+invalid+twofa+
  //      banned) excludes errors entirely.
  //   2. We watch the RETRY RATE (per-second) as a leading distress signal.
  //      With slow-lane requeues, `metrics.counts.error` lags by many minutes;
  //      retries spike instantly when proxies start failing, so a sudden jump
  //      forces a hard concurrency cut BEFORE error % climbs.
  //   3. Memory floor + failure-rate ceiling still trigger emergency backoff.
  _startAdaptive() {
    if (!config.adaptive.enabled) return;
    const a = config.adaptive;
    const min = config.pool.minConcurrency;
    const sec = a.intervalMs / 1000;
    let prev = { done: this.metrics.counts.done, retried: this.metrics.counts.retried };
    let prevTput = -1;
    let dir = +1;          // probe UP first — slow-lane retry absorbs error spikes
    let prevRetryRate = 0;
    this._adaptTimer = setInterval(() => {
      if (this.stopped || this.draining) return;
      let min = config.pool.minConcurrency;
      if (this.governor) {
        try {
          const govMin = parseInt(process.env.BULK_GOV_MIN_CONCURRENCY || '0', 10) || 0;
          if (govMin > 0) min = Math.max(min, govMin);
        } catch {}
      }
      const max = this.maxConcurrency;
      const freeFrac = os.freemem() / os.totalmem();
      const fail = this.metrics.failureRate();

      const done = this.metrics.counts.done;
      const retried = this.metrics.counts.retried;
      const tput      = (done    - prev.done)    / sec;
      const retryRate = (retried - prev.retried) / sec;
      prev = { done, retried };

      if (done === 0) {
        prevTput = tput; prevRetryRate = retryRate;
        log.debug(`adaptive: WARMUP — holding at ${this.target} (no completions yet)`);
        return;
      }

      const step = Math.max(a.step, Math.round(this.target * 0.12));
      const retrySpike = retryRate > Math.max(5, prevRetryRate * 1.6);
      if (freeFrac < a.memFloorFree || fail > a.failHigh || retrySpike) {
        this.target = Math.max(min, Math.round(this.target * 0.6));
        prevTput = tput; prevRetryRate = retryRate;
        log.debug(`adaptive: BACKOFF → ${this.target} (free=${(freeFrac*100)|0}% fail=${(fail*100)|0}% retries=${retryRate|0}/s)`);
        return;
      }
      if (prevTput < 0) { prevTput = tput; prevRetryRate = retryRate; return; }

      if (tput < prevTput * 0.95) dir = -dir;
      this.target = Math.max(min, Math.min(max, this.target + dir * step));
      this._tick();
      log.debug(`adaptive: ${dir > 0 ? 'UP' : 'DOWN'} → ${this.target} (tput=${tput | 0}/s, retries=${retryRate|0}/s)`);
      prevTput = tput; prevRetryRate = retryRate;
    }, a.intervalMs);
    if (this._adaptTimer.unref) this._adaptTimer.unref();
  }

  start() {
    // Spawn the FIXED thread pool once; concurrency is scaled by feeding more
    // in-flight jobs to these threads, not by spawning more.
    for (let i = 0; i < this.threadCount; i++) this._spawn();
    this._startHealth();
    this._startAdaptive();
    // Kick once workers post 'ready'; also kick now in case of fast spawn.
    setTimeout(() => this._tick(), 50);
    return this._donePromise;
  }

  // Graceful: stop taking new jobs, let in-flight finish, then resolve.
  // Hard cap so Stop (S) doesn't hang for minutes on slow proxy logins.
  async drain({ maxMs } = {}) {
    this.draining = true;
    this._tick();
    const cap = maxMs ?? (process.env.R6_FAST_PASS === '1' ? 8000 : 20000);
    await Promise.race([
      this._donePromise,
      new Promise((resolve) => setTimeout(resolve, cap)),
    ]);
    if (!this.stopped) await this.abort();
  }

  async _terminateAll() {
    clearInterval(this._adaptTimer); clearInterval(this._healthTimer); clearTimeout(this._scheduleTimer);
    this._adaptTimer = this._healthTimer = this._scheduleTimer = null;
    await Promise.all([...this.slots.values()].map((s) => { s.alive = false; return s.worker.terminate().catch(() => {}); }));
    this.slots.clear();
  }

  // Hard stop — terminate workers immediately; in-flight jobs requeue on resume.
  async abort() {
    if (this.stopped) { await this._terminateAll(); return; }
    this.stopped = true;
    this.draining = true;
    for (const slot of this.slots.values()) this._requeueSlotJobs(slot);
    // Drop any gov holds so parked acquire loops can exit cleanly.
    if (this.governor && this._govHeld.size) {
      for (const id of [...this._govHeld.keys()]) {
        try { this.governor.release(); } catch { /* ignore */ }
        this._govHeld.delete(id);
      }
    }
    this._idleResolve && this._idleResolve();
    await this._terminateAll();
  }
}

module.exports = { WorkerPool };
