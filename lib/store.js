// SQLite-backed store for users, balances, transactions, deposits, bulk jobs.
//
// All money is integer cents — never floats. Every balance mutation goes
// through a transaction so we can't crash mid-write and leave money missing.
//
// On first run, generates a SITE_SESSION_SECRET and RESULTS_ENC_KEY into .env
// if they're empty, so the operator doesn't have to remember to.

const fs    = require('fs');
const path  = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DATA_DB_PATH || path.join(__dirname, '..', '.cache', 'data.db');
try { fs.mkdirSync(path.dirname(DB_PATH), { recursive: true }); } catch {}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('synchronous = NORMAL');
// Wait up to 5s for a held write lock instead of throwing SQLITE_BUSY. Matters
// when a maintenance/migration process touches the DB alongside the running
// server, and under heavy bulk write load.
db.pragma('busy_timeout = 5000');

// ── Schema migration ─────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    email           TEXT UNIQUE NOT NULL COLLATE NOCASE,
    password_hash   TEXT NOT NULL,
    balance_cents   INTEGER NOT NULL DEFAULT 0,
    created_at      INTEGER NOT NULL,
    last_login_at   INTEGER
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token       TEXT PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at  INTEGER NOT NULL,
    created_at  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

  CREATE TABLE IF NOT EXISTS transactions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id         INTEGER NOT NULL REFERENCES users(id),
    kind            TEXT NOT NULL,
    amount_cents    INTEGER NOT NULL,
    balance_after   INTEGER NOT NULL,
    ref             TEXT,
    meta            TEXT,
    created_at      INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_txn_user ON transactions(user_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS deposits (
    invoice_id      TEXT PRIMARY KEY,
    user_id         INTEGER NOT NULL REFERENCES users(id),
    amount_usd      REAL NOT NULL,
    pay_currency    TEXT,
    pay_address     TEXT,
    status          TEXT NOT NULL,
    credited        INTEGER NOT NULL DEFAULT 0,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_deposits_user ON deposits(user_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS password_resets (
    token       TEXT PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at  INTEGER NOT NULL,
    used_at     INTEGER,
    created_at  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_resets_user ON password_resets(user_id);

  CREATE TABLE IF NOT EXISTS bulk_jobs (
    id              TEXT PRIMARY KEY,
    user_id         INTEGER NOT NULL REFERENCES users(id),
    total           INTEGER NOT NULL,
    done            INTEGER NOT NULL DEFAULT 0,
    charged_cents   INTEGER NOT NULL DEFAULT 0,
    status          TEXT NOT NULL,
    results_path    TEXT,
    created_at      INTEGER NOT NULL,
    finished_at     INTEGER,
    expires_at      INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_jobs_user ON bulk_jobs(user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_jobs_expires ON bulk_jobs(expires_at);

  -- BYO-proxy access: time-based subscription per user. While expires_at is in
  -- the future, the user may run bulk checks through their OWN proxies for free
  -- (no per-check billing). One row per user.
  CREATE TABLE IF NOT EXISTS bulk_subscriptions (
    user_id     INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    plan        TEXT NOT NULL,
    expires_at  INTEGER NOT NULL,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );

  -- NOWPayments invoices for subscription purchases. Mirrors deposits so the
  -- webhook can extend a subscription idempotently (credited flag).
  CREATE TABLE IF NOT EXISTS subscription_invoices (
    invoice_id  TEXT PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id),
    plan        TEXT NOT NULL,
    days        INTEGER NOT NULL,
    amount_usd  REAL NOT NULL,
    status      TEXT NOT NULL,
    credited    INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_subinv_user ON subscription_invoices(user_id, created_at DESC);

  -- User-supplied proxies (one newline-separated blob per user) used for
  -- BYO-proxy bulk jobs.
  CREATE TABLE IF NOT EXISTS user_proxies (
    user_id     INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    proxies     TEXT NOT NULL DEFAULT '',
    updated_at  INTEGER NOT NULL
  );
`);

// ── Migration: add users.unlimited (bypass billing) if missing ───────────
try {
  const cols = db.prepare(`PRAGMA table_info(users)`).all();
  if (!cols.some(c => c.name === 'unlimited')) {
    db.exec(`ALTER TABLE users ADD COLUMN unlimited INTEGER NOT NULL DEFAULT 0`);
    console.log('[store] migrated: added users.unlimited');
  }
} catch (e) { console.warn('[store] unlimited migration failed:', e.message); }

// ── Migration: add users.cli_key (license key for the desktop CLI checker) ──
try {
  const cols = db.prepare(`PRAGMA table_info(users)`).all();
  if (!cols.some(c => c.name === 'cli_key')) {
    db.exec(`ALTER TABLE users ADD COLUMN cli_key TEXT`);
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_cli_key ON users(cli_key) WHERE cli_key IS NOT NULL`);
    console.log('[store] migrated: added users.cli_key');
  }
} catch (e) { console.warn('[store] cli_key migration failed:', e.message); }

// ── Migration: add users.hwid (binds the CLI key to one device) ─────────────
try {
  const cols = db.prepare(`PRAGMA table_info(users)`).all();
  if (!cols.some(c => c.name === 'hwid')) {
    db.exec(`ALTER TABLE users ADD COLUMN hwid TEXT`);
    console.log('[store] migrated: added users.hwid');
  }
} catch (e) { console.warn('[store] hwid migration failed:', e.message); }

// ── Migration: marketplace columns + tables ────────────────────────────────
// discord_id      → user's Discord snowflake (linked via OAuth)
// discord_username→ shown next to listings
// discord_in_guild_at → last time we verified they're in the configured guild
// is_trusted      → owner-granted green-badge flag for sellers
try {
  const cols = db.prepare(`PRAGMA table_info(users)`).all();
  const has = (n) => cols.some(c => c.name === n);
  if (!has('discord_id'))        db.exec(`ALTER TABLE users ADD COLUMN discord_id TEXT`);
  if (!has('discord_username'))  db.exec(`ALTER TABLE users ADD COLUMN discord_username TEXT`);
  if (!has('discord_in_guild_at')) db.exec(`ALTER TABLE users ADD COLUMN discord_in_guild_at INTEGER`);
  if (!has('is_trusted'))        db.exec(`ALTER TABLE users ADD COLUMN is_trusted INTEGER NOT NULL DEFAULT 0`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_users_discord_id ON users(discord_id) WHERE discord_id IS NOT NULL`);
  console.log('[store] migrated: marketplace columns on users');
} catch (e) { console.warn('[store] marketplace user-cols migration failed:', e.message); }

// Persistent OAuth tokens captured at /verify so the bot can re-add the user
// to ANY guild later (refresh access_token → guilds.join). Keyed by Discord id.
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS discord_oauth (
      discord_id              TEXT PRIMARY KEY,
      username                TEXT,
      email                   TEXT,
      refresh_token           TEXT,
      access_token            TEXT,
      access_token_expires_at INTEGER,
      scope                   TEXT,
      updated_at              INTEGER NOT NULL,
      last_invited_at         INTEGER,
      last_invite_guild       TEXT,
      last_invite_status      TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_oauth_updated ON discord_oauth(updated_at DESC);
  `);
} catch (e) { console.warn('[store] discord_oauth migration failed:', e.message); }

// Track which SITE user has checked which Ubisoft profile. Used by the
// marketplace to gate listing creation to "accounts you've checked here".
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_profile_checks (
      user_id INTEGER NOT NULL,
      profile_user_id TEXT NOT NULL,
      first_checked_at INTEGER NOT NULL,
      last_checked_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, profile_user_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_upc_user ON user_profile_checks(user_id);
    CREATE INDEX IF NOT EXISTS idx_upc_profile ON user_profile_checks(profile_user_id);
  `);
} catch (e) { console.warn('[store] user_profile_checks migration failed:', e.message); }

// Marketplace listings. Discord channel id stored once a purchase creates one.
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS marketplace_listings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      seller_user_id INTEGER NOT NULL,
      profile_user_id TEXT NOT NULL,
      access_type TEXT NOT NULL,            -- 'fa' or 'nfa'
      price_cents INTEGER NOT NULL,
      title TEXT,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'active', -- active | pending | sold | cancelled
      created_at INTEGER NOT NULL,
      sold_at INTEGER,
      buyer_user_id INTEGER,
      discord_channel_id TEXT,
      FOREIGN KEY (seller_user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_mp_status_created ON marketplace_listings(status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_mp_seller ON marketplace_listings(seller_user_id);
    CREATE INDEX IF NOT EXISTS idx_mp_buyer  ON marketplace_listings(buyer_user_id);
  `);
} catch (e) { console.warn('[store] marketplace_listings migration failed:', e.message); }

// On boot, mark stale 'running' jobs as cancelled (server restarted mid-job).
db.prepare(`UPDATE bulk_jobs SET status='cancelled', finished_at=? WHERE status='running'`)
  .run(Date.now());

// ── Self-generating secrets ──────────────────────────────────────────────
// If SITE_SESSION_SECRET / RESULTS_ENC_KEY are blank in .env, generate one
// and append it. Avoids the "I forgot to set the secret" footgun.
//
// CRITICAL: process.env may be EMPTY even when .env contains the secret
// (e.g., a script loaded this module with the wrong CWD so dotenv was a
// no-op). In that case the secret is on disk but invisible to us. We MUST
// check the .env file content directly before assuming generation is
// needed — otherwise we'd silently rotate the production secret and
// invalidate every session + encrypted result on the next restart.
function ensureEnvSecret(key, bytes) {
  if (process.env[key] && process.env[key].length >= bytes * 2) return;

  const envPath = path.join(__dirname, '..', '.env');

  // Step 1: if the secret already exists in the .env file, load it instead
  // of generating a new one.
  if (fs.existsSync(envPath)) {
    try {
      const cur = fs.readFileSync(envPath, 'utf8');
      const m = cur.match(new RegExp(`^${key}=(.+)$`, 'm'));
      if (m && m[1].trim().length >= bytes * 2) {
        process.env[key] = m[1].trim();
        console.log(`[store] loaded ${key} from .env (process.env was empty)`);
        return;
      }
    } catch { /* fall through to generation */ }
  }

  // Step 2: genuinely empty on disk too — generate and persist.
  const generated = crypto.randomBytes(bytes).toString('hex');
  process.env[key] = generated;
  try {
    if (fs.existsSync(envPath)) {
      const cur = fs.readFileSync(envPath, 'utf8');
      const re = new RegExp(`^${key}=.*$`, 'm');
      const updated = re.test(cur) ? cur.replace(re, `${key}=${generated}`) : cur + `\n${key}=${generated}\n`;
      fs.writeFileSync(envPath, updated);
      console.log(`[store] generated ${key} and wrote to .env`);
    }
  } catch (e) {
    console.warn(`[store] could not persist ${key} to .env: ${e.message}`);
  }
}
ensureEnvSecret('SITE_SESSION_SECRET', 32);
ensureEnvSecret('RESULTS_ENC_KEY', 32);

// ── Users ────────────────────────────────────────────────────────────────
const _insertUser = db.prepare(`INSERT INTO users (email, password_hash, created_at) VALUES (?, ?, ?)`);
const _getUserByEmail = db.prepare(`SELECT * FROM users WHERE email = ? COLLATE NOCASE`);
const _getUserById = db.prepare(`SELECT * FROM users WHERE id = ?`);
const _touchLogin = db.prepare(`UPDATE users SET last_login_at = ? WHERE id = ?`);

function createUser(email, passwordHash) {
  const info = _insertUser.run(email, passwordHash, Date.now());
  return getUserById(info.lastInsertRowid);
}
function getUserByEmail(email) { return _getUserByEmail.get(email) || null; }
function getUserById(id)       { return _getUserById.get(id) || null; }
function touchLogin(id)        { _touchLogin.run(Date.now(), id); }
const _setUnlimited = db.prepare(`UPDATE users SET unlimited = ? WHERE id = ?`);
function setUnlimited(id, on)  { return _setUnlimited.run(on ? 1 : 0, id).changes; }

// ── Sessions ─────────────────────────────────────────────────────────────
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

const _insertSession   = db.prepare(`INSERT INTO sessions (token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)`);
const _getSession      = db.prepare(`SELECT * FROM sessions WHERE token = ?`);
const _renewSession    = db.prepare(`UPDATE sessions SET expires_at = ? WHERE token = ?`);
const _deleteSession   = db.prepare(`DELETE FROM sessions WHERE token = ?`);
const _sweepSessions   = db.prepare(`DELETE FROM sessions WHERE expires_at < ?`);

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  _insertSession.run(token, userId, now + SESSION_TTL_MS, now);
  return token;
}
// Invalidate every session for a user. Called on password reset so a stolen
// session can't outlive a password change.
const _deleteAllUserSessions = db.prepare(`DELETE FROM sessions WHERE user_id = ?`);
function deleteAllUserSessions(userId) { return _deleteAllUserSessions.run(userId).changes; }
function getSession(token) {
  if (!token) return null;
  const row = _getSession.get(token);
  if (!row) return null;
  if (row.expires_at < Date.now()) { _deleteSession.run(token); return null; }
  return row;
}
function renewSession(token) { _renewSession.run(Date.now() + SESSION_TTL_MS, token); }
function deleteSession(token) { _deleteSession.run(token); }

// ── Transactions / balances ──────────────────────────────────────────────
const _selectBalance = db.prepare(`SELECT balance_cents FROM users WHERE id = ?`);
const _decBalance    = db.prepare(`UPDATE users SET balance_cents = balance_cents - ? WHERE id = ?`);
const _incBalance    = db.prepare(`UPDATE users SET balance_cents = balance_cents + ? WHERE id = ?`);
const _insertTxn     = db.prepare(`INSERT INTO transactions (user_id, kind, amount_cents, balance_after, ref, meta, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`);
// id DESC as the tiebreaker — without it, concurrent inserts that share
// created_at come back in arbitrary order, which breaks any reconstruction
// of balance history.
const _listTxns      = db.prepare(`SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`);

class InsufficientFundsError extends Error {
  constructor(have, need) { super('Insufficient balance'); this.name = 'InsufficientFundsError'; this.have = have; this.need = need; }
}

// Charges `cents` from user. Throws InsufficientFundsError if balance < cents.
// Atomic: deduction, transaction row, and (optional) bulk_jobs counter all in
// one DB transaction so a crash mid-write can't desync them.
const chargeUser = db.transaction((userId, cents, jobId, accountEmail) => {
  if (!Number.isInteger(cents) || cents <= 0) throw new Error(`chargeUser: invalid cents=${cents}`);
  const row = _selectBalance.get(userId);
  if (!row) throw new Error(`User ${userId} not found`);
  if (row.balance_cents < cents) throw new InsufficientFundsError(row.balance_cents, cents);
  _decBalance.run(cents, userId);
  const balanceAfter = row.balance_cents - cents;
  _insertTxn.run(userId, 'charge', -cents, balanceAfter, jobId, JSON.stringify({ account: accountEmail }), Date.now());
  if (jobId) {
    db.prepare(`UPDATE bulk_jobs SET charged_cents = charged_cents + ? WHERE id = ?`).run(cents, jobId);
  }
  return balanceAfter;
});

// Credits user with `cents`. Idempotent guard belongs to the caller (deposits flow).
const creditBalance = db.transaction((userId, cents, kind, ref, meta) => {
  if (!Number.isInteger(cents) || cents <= 0) throw new Error(`creditBalance: invalid cents=${cents}`);
  const row = _selectBalance.get(userId);
  if (!row) throw new Error(`User ${userId} not found`);
  _incBalance.run(cents, userId);
  const balanceAfter = row.balance_cents + cents;
  _insertTxn.run(userId, kind, cents, balanceAfter, ref || null, meta ? JSON.stringify(meta) : null, Date.now());
  return balanceAfter;
});

function listTransactions(userId, limit = 50) {
  return _listTxns.all(userId, Math.min(200, limit | 0 || 50));
}

// ── Owner analytics ──────────────────────────────────────────────────────
// All aggregates in one read-only call. Revenue = money charged for checks
// (kind='charge'); deposits = money users put in; outstanding = unspent
// balance liability.
function adminStats() {
  const now = Date.now();
  const m = new Date(); m.setDate(1); m.setHours(0, 0, 0, 0);
  const monthStart = m.getTime();
  const day1  = now - 24 * 60 * 60 * 1000;
  const day30 = now - 30 * 24 * 60 * 60 * 1000;
  const get = (sql, ...a) => db.prepare(sql).get(...a);

  const users        = get(`SELECT COUNT(*) c FROM users`).c;
  const newUsersMonth= get(`SELECT COUNT(*) c FROM users WHERE created_at >= ?`, monthStart).c;
  const chAll        = get(`SELECT COUNT(*) c, COALESCE(SUM(-amount_cents),0) rev FROM transactions WHERE kind='charge'`);
  const chMonth      = get(`SELECT COUNT(*) c, COALESCE(SUM(-amount_cents),0) rev FROM transactions WHERE kind='charge' AND created_at >= ?`, monthStart);
  const ch24h        = get(`SELECT COUNT(*) c, COALESCE(SUM(-amount_cents),0) rev FROM transactions WHERE kind='charge' AND created_at >= ?`, day1);
  const activeMonth  = get(`SELECT COUNT(DISTINCT user_id) c FROM transactions WHERE kind='charge' AND created_at >= ?`, day30).c;
  const depAll       = get(`SELECT COUNT(*) c, COALESCE(SUM(amount_cents),0) s FROM transactions WHERE kind='deposit'`);
  const depMonth     = get(`SELECT COALESCE(SUM(amount_cents),0) s FROM transactions WHERE kind='deposit' AND created_at >= ?`, monthStart).s;
  const outstanding  = get(`SELECT COALESCE(SUM(balance_cents),0) s FROM users`).s;
  const jobsAll      = get(`SELECT COUNT(*) c, COALESCE(SUM(total),0) acc FROM bulk_jobs`);
  const jobsMonth    = get(`SELECT COUNT(*) c, COALESCE(SUM(total),0) acc FROM bulk_jobs WHERE created_at >= ?`, monthStart);

  // Last 14 days revenue, grouped by UTC day.
  const dayMs = 24 * 60 * 60 * 1000;
  const rows = db.prepare(
    `SELECT CAST(created_at / ${dayMs} AS INTEGER) d, COALESCE(SUM(-amount_cents),0) rev, COUNT(*) c
     FROM transactions WHERE kind='charge' AND created_at >= ? GROUP BY d ORDER BY d`
  ).all(now - 14 * dayMs);
  const daily = rows.map(r => ({ day: r.d * dayMs, revenueCents: r.rev, checks: r.c }));

  return {
    generatedAt: now,
    users, newUsersMonth, activeUsersMonth: activeMonth,
    checks:   { allTime: chAll.c, month: chMonth.c, last24h: ch24h.c },
    revenueCents: { allTime: chAll.rev, month: chMonth.rev, last24h: ch24h.rev },
    deposits: { count: depAll.c, allTimeCents: depAll.s, monthCents: depMonth },
    outstandingBalanceCents: outstanding,
    bulkJobs: { allTime: jobsAll.c, month: jobsMonth.c, accountsAllTime: jobsAll.acc, accountsMonth: jobsMonth.acc },
    daily,
  };
}

// ── Deposits ─────────────────────────────────────────────────────────────
const _insertDeposit = db.prepare(`INSERT INTO deposits (invoice_id, user_id, amount_usd, pay_currency, pay_address, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
const _getDeposit    = db.prepare(`SELECT * FROM deposits WHERE invoice_id = ?`);
// Refuse to transition AWAY from a terminal state. Once a deposit is
// refunded/failed/expired, no late webhook may overwrite that. Otherwise
// a NOWPayments retry of an earlier 'finished' webhook could re-credit
// a previously-refunded user.
const _updateDeposit = db.prepare(`UPDATE deposits SET status = ?, pay_currency = COALESCE(?, pay_currency), pay_address = COALESCE(?, pay_address), updated_at = ? WHERE invoice_id = ? AND status NOT IN ('refunded', 'failed', 'expired')`);
// Same protection in the credit step: even if updateDepositStatus somehow
// flipped status back, the actual money-mover refuses to credit a deposit
// whose status row is terminal. Belt and suspenders.
const _markCredited  = db.prepare(`UPDATE deposits SET credited = 1, status = 'finished', updated_at = ? WHERE invoice_id = ? AND credited = 0 AND status NOT IN ('refunded', 'failed', 'expired')`);
const _listDeposits  = db.prepare(`SELECT * FROM deposits WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`);
const _pendingDeposits = db.prepare(`SELECT * FROM deposits WHERE status IN ('waiting','confirming') AND created_at > ?`);

function recordDeposit({ invoiceId, userId, amountUsd, payCurrency, payAddress, status }) {
  const now = Date.now();
  _insertDeposit.run(invoiceId, userId, amountUsd, payCurrency || null, payAddress || null, status, now, now);
  return getDeposit(invoiceId);
}
function getDeposit(invoiceId) { return _getDeposit.get(invoiceId) || null; }
function updateDepositStatus(invoiceId, status, payCurrency, payAddress) {
  _updateDeposit.run(status, payCurrency || null, payAddress || null, Date.now(), invoiceId);
}
function listDeposits(userId, limit = 50) {
  return _listDeposits.all(userId, Math.min(200, limit | 0 || 50));
}
function listPendingDeposits(sinceMs) {
  return _pendingDeposits.all(sinceMs);
}

// Credit a deposit. Idempotent: returns false if already credited.
// One transaction marks the deposit credited AND bumps the balance + writes
// the txn row, so the two never disagree.
const creditDeposit = db.transaction((invoiceId, userId, amountCents, meta) => {
  const result = _markCredited.run(Date.now(), invoiceId);
  if (result.changes === 0) return { credited: false }; // already done
  const balanceAfter = creditBalance(userId, amountCents, 'deposit', invoiceId, meta);
  return { credited: true, balanceAfter };
});

// Reverse a previously-credited deposit. Called when NOWPayments reports a
// 'refunded' or 'failed' status AFTER we already credited the user (which
// would otherwise leave them with both the balance AND their crypto back).
//
// Idempotent: only reverses ONCE. The `credited=1` flag is flipped back to 0
// so a future webhook can't double-reverse. The amount actually debited is
// clamped to whatever balance is still on the account (we won't let the
// user go negative — that loss falls on us as the operator, matching the
// economic reality that the user might have already spent some of it).
const _markRefunded = db.prepare(`UPDATE deposits SET credited = 0, status = 'refunded', updated_at = ? WHERE invoice_id = ? AND credited = 1`);
const refundDeposit = db.transaction((invoiceId, meta) => {
  const dep = _getDeposit.get(invoiceId);
  if (!dep || !dep.credited) return { reversed: false, reason: 'not-credited' };
  const flipped = _markRefunded.run(Date.now(), invoiceId).changes;
  if (flipped === 0) return { reversed: false, reason: 'race' };
  const amountCents = Math.floor(dep.amount_usd * 100);
  const userRow = _selectBalance.get(dep.user_id);
  if (!userRow) return { reversed: false, reason: 'no-user' };
  const debit = Math.min(amountCents, userRow.balance_cents);
  if (debit > 0) {
    db.prepare(`UPDATE users SET balance_cents = balance_cents - ? WHERE id = ?`).run(debit, dep.user_id);
    const balanceAfter = userRow.balance_cents - debit;
    _insertTxn.run(dep.user_id, 'refund', -debit, balanceAfter, invoiceId, JSON.stringify({ ...(meta || {}), originalAmountCents: amountCents }), Date.now());
    return { reversed: true, debited: debit, originalAmount: amountCents, balanceAfter };
  }
  // Balance was already zero — flip credited but don't write a $0 txn row.
  _insertTxn.run(dep.user_id, 'refund', 0, 0, invoiceId, JSON.stringify({ ...(meta || {}), originalAmountCents: amountCents, note: 'balance-already-zero' }), Date.now());
  return { reversed: true, debited: 0, originalAmount: amountCents, balanceAfter: 0 };
});

// Explicit operator-controlled top-up. Same effect as a deposit credit but
// uses kind='adjust' in the txn log so audits can tell apart real payments
// from manual adjustments. Only callable from admin scripts OR the
// owner-gated POST /api/admin/grant-balance route (requireOwner, OWNER_EMAILS).
// Never wire this to any non-owner-gated route.
const adminAdjust = db.transaction((userId, cents, reason) => {
  if (typeof reason !== 'string' || reason.length < 3) {
    throw new Error('adminAdjust: must supply a human-readable reason (>=3 chars) for the audit log');
  }
  return creditBalance(userId, cents, 'adjust', null, { reason, by: 'admin', at: Date.now() });
});

// ── Password resets ──────────────────────────────────────────────────────
const RESET_TTL_MS = 60 * 60 * 1000; // 1 hour

const _insertReset       = db.prepare(`INSERT INTO password_resets (token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)`);
const _getReset          = db.prepare(`SELECT * FROM password_resets WHERE token = ?`);
const _markResetUsed     = db.prepare(`UPDATE password_resets SET used_at = ? WHERE token = ? AND used_at IS NULL`);
const _sweepResets       = db.prepare(`DELETE FROM password_resets WHERE expires_at < ?`);
const _updatePasswordHash = db.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`);

function createResetToken(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  _insertReset.run(token, userId, now + RESET_TTL_MS, now);
  return token;
}

// Returns the unused reset row (or null). Does NOT consume it.
function getResetToken(token) {
  if (!token) return null;
  const row = _getReset.get(token);
  if (!row) return null;
  if (row.used_at) return null;                 // already consumed
  if (row.expires_at < Date.now()) return null; // expired
  return row;
}

// Atomic password-change flow:
//   1. mark token consumed (single-use; concurrent attempts lose)
//   2. update password hash
//   3. invalidate every session for that user
// All in one DB transaction so a partial reset is impossible.
const consumeResetToken = db.transaction((token, newPasswordHash) => {
  const row = _getReset.get(token);
  if (!row || row.used_at || row.expires_at < Date.now()) {
    return { ok: false, reason: 'invalid_or_expired' };
  }
  const claimed = _markResetUsed.run(Date.now(), token).changes;
  if (claimed === 0) return { ok: false, reason: 'race_lost' };
  _updatePasswordHash.run(newPasswordHash, row.user_id);
  const sessionsKilled = _deleteAllUserSessions.run(row.user_id).changes;
  return { ok: true, userId: row.user_id, sessionsKilled };
});

// ── Bulk jobs ────────────────────────────────────────────────────────────
const _insertJob     = db.prepare(`INSERT INTO bulk_jobs (id, user_id, total, status, created_at, expires_at) VALUES (?, ?, ?, 'running', ?, ?)`);
const _getJob        = db.prepare(`SELECT * FROM bulk_jobs WHERE id = ?`);
const _bumpJobDone   = db.prepare(`UPDATE bulk_jobs SET done = done + 1 WHERE id = ?`);
const _finishJob     = db.prepare(`UPDATE bulk_jobs SET status = ?, results_path = ?, finished_at = ? WHERE id = ?`);
const _cancelJob     = db.prepare(`UPDATE bulk_jobs SET status = 'cancelled', finished_at = ? WHERE id = ? AND status = 'running'`);
// One-shot finalize for an UPLOADED job (results computed off-server by the
// desktop checker): set the real total/done + attach the encrypted results.
const _finalizeUpload = db.prepare(`UPDATE bulk_jobs SET total = ?, done = ?, status = 'done', results_path = ?, finished_at = ? WHERE id = ?`);
const _listJobs      = db.prepare(`SELECT * FROM bulk_jobs WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`);
const _expiredJobs   = db.prepare(`SELECT * FROM bulk_jobs WHERE expires_at < ?`);
const _deleteJob     = db.prepare(`DELETE FROM bulk_jobs WHERE id = ?`);

// How long bulk result files are retained for re-download. Default 30 days
// (was 24h). Override with BULK_RETENTION_DAYS. Result files hold encrypted
// credentials, so this is a security-vs-convenience tradeoff.
const JOB_TTL_MS = Math.max(1, Number(process.env.BULK_RETENTION_DAYS) || 30) * 24 * 60 * 60 * 1000;

function createJob(userId, total) {
  const id = crypto.randomBytes(16).toString('hex');
  const now = Date.now();
  _insertJob.run(id, userId, total, now, now + JOB_TTL_MS);
  return getJob(id);
}
function getJob(id) { return _getJob.get(id) || null; }
function bumpJobDone(id) { _bumpJobDone.run(id); }
function finishJob(id, resultsPath) { _finishJob.run('done', resultsPath || null, Date.now(), id); }
function finalizeUploadedJob(id, total, done, resultsPath) { _finalizeUpload.run(total | 0, done | 0, resultsPath || null, Date.now(), id); }
function cancelJob(id) { _cancelJob.run(Date.now(), id); }
function listJobs(userId, limit = 50) { return _listJobs.all(userId, Math.min(200, limit | 0 || 50)); }
function listExpiredJobs(nowMs) { return _expiredJobs.all(nowMs); }
function deleteJob(id) { _deleteJob.run(id); }

// ── Sweeper ──────────────────────────────────────────────────────────────
// Single periodic cleaner for stale sessions, expired deposits, expired jobs.
function startSweeper() {
  setInterval(() => {
    const now = Date.now();
    try {
      _sweepSessions.run(now);

      // Expire stale waiting deposits (>24h old & still not finished)
      const stale = listPendingDeposits(now - 24 * 60 * 60 * 1000);
      for (const d of stale) {
        // Anything older than 24h in waiting/confirming → mark expired
        if (now - d.created_at > 24 * 60 * 60 * 1000) {
          updateDepositStatus(d.invoice_id, 'expired');
        }
      }

      // Expire bulk jobs + their files. Delete DB row FIRST so a failed
      // unlink doesn't orphan the row and re-attempt forever.
      const expired = listExpiredJobs(now);
      for (const j of expired) {
        const filePath = j.results_path;
        deleteJob(j.id);
        if (filePath) {
          try { fs.unlinkSync(filePath); } catch {}
        }
      }

      // Sweep expired (used or past TTL) reset tokens
      _sweepResets.run(now);
    } catch (e) {
      console.warn('[store] sweeper error:', e.message);
    }
  }, 60_000).unref();
}

// ── BYO-proxy subscriptions ────────────────────────────────────────────────
// Plans: id → { days, usd }. Weekly/monthly are deals vs the daily rate.
// Override with SUBSCRIPTION_PLANS (JSON) if desired.
const DEFAULT_PLANS = {
  daily:   { days: 1,  usd: 5 },
  weekly:  { days: 7,  usd: 20 },   // vs 7×$5=$35
  monthly: { days: 30, usd: 50 },   // vs ~4×$20=$80
};
function loadPlans() {
  try { const p = JSON.parse(process.env.SUBSCRIPTION_PLANS || ''); if (p && typeof p === 'object') return p; } catch {}
  return DEFAULT_PLANS;
}
const SUBSCRIPTION_PLANS = loadPlans();
function getPlan(id) { return SUBSCRIPTION_PLANS[id] || null; }

const _getSub = db.prepare(`SELECT * FROM bulk_subscriptions WHERE user_id = ?`);
const _upsertSub = db.prepare(`
  INSERT INTO bulk_subscriptions (user_id, plan, expires_at, created_at, updated_at)
  VALUES (@user_id, @plan, @expires_at, @now, @now)
  ON CONFLICT(user_id) DO UPDATE SET plan=@plan, expires_at=@expires_at, updated_at=@now
`);

function getSubscription(userId) { return _getSub.get(userId) || null; }
function isSubscriptionActive(userId) {
  const s = _getSub.get(userId);
  return !!(s && s.expires_at > Date.now());
}
function subscriptionStatus(userId) {
  const s = _getSub.get(userId);
  const now = Date.now();
  const active = !!(s && s.expires_at > now);
  return {
    active,
    plan: s ? s.plan : null,
    expiresAt: s ? s.expires_at : null,
    msLeft: active ? s.expires_at - now : 0,
  };
}
// Add `days` to the subscription, stacking onto remaining time if still active.
const extendSubscription = db.transaction((userId, days, plan) => {
  const now = Date.now();
  const cur = _getSub.get(userId);
  const base = (cur && cur.expires_at > now) ? cur.expires_at : now;
  const expires_at = base + days * 24 * 60 * 60 * 1000;
  _upsertSub.run({ user_id: userId, plan, expires_at, now });
  return expires_at;
});

// ── Subscription invoices (NOWPayments) ────────────────────────────────────
const _insSubInv = db.prepare(`INSERT INTO subscription_invoices (invoice_id, user_id, plan, days, amount_usd, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
const _getSubInv = db.prepare(`SELECT * FROM subscription_invoices WHERE invoice_id = ?`);
const _updSubInv = db.prepare(`UPDATE subscription_invoices SET status = ?, updated_at = ? WHERE invoice_id = ? AND status NOT IN ('finished','refunded','failed','expired')`);
const _markSubInvCredited = db.prepare(`UPDATE subscription_invoices SET credited = 1, status = 'finished', updated_at = ? WHERE invoice_id = ? AND credited = 0`);
const _pendingSubInv = db.prepare(`SELECT * FROM subscription_invoices WHERE status IN ('waiting','confirming') AND created_at > ?`);

function recordSubscriptionInvoice({ invoiceId, userId, plan, days, amountUsd, status }) {
  const now = Date.now();
  _insSubInv.run(invoiceId, userId, plan, days, amountUsd, status, now, now);
  return _getSubInv.get(invoiceId);
}
function getSubscriptionInvoice(invoiceId) { return _getSubInv.get(invoiceId) || null; }
function updateSubscriptionInvoiceStatus(invoiceId, status) { _updSubInv.run(status, Date.now(), invoiceId); }
function listPendingSubscriptionInvoices(sinceMs) { return _pendingSubInv.all(sinceMs); }
// Idempotent: extend the subscription exactly once per paid invoice.
const creditSubscriptionInvoice = db.transaction((invoiceId) => {
  const inv = _getSubInv.get(invoiceId);
  if (!inv) return { credited: false, reason: 'unknown' };
  const claimed = _markSubInvCredited.run(Date.now(), invoiceId).changes;
  if (claimed === 0) return { credited: false, reason: 'already' };
  const expiresAt = extendSubscription(inv.user_id, inv.days, inv.plan);
  return { credited: true, expiresAt, userId: inv.user_id, plan: inv.plan };
});

// ── User-supplied proxies ──────────────────────────────────────────────────
const _getUserProxies = db.prepare(`SELECT proxies FROM user_proxies WHERE user_id = ?`);
const _setUserProxies = db.prepare(`
  INSERT INTO user_proxies (user_id, proxies, updated_at) VALUES (?, ?, ?)
  ON CONFLICT(user_id) DO UPDATE SET proxies = excluded.proxies, updated_at = excluded.updated_at
`);
function getUserProxies(userId) {
  const row = _getUserProxies.get(userId);
  if (!row || !row.proxies) return [];
  return row.proxies.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
}
function setUserProxies(userId, text) {
  const clean = String(text || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean).join('\n');
  _setUserProxies.run(userId, clean, Date.now());
  return clean ? clean.split('\n').length : 0;
}

// ── Desktop CLI license key ────────────────────────────────────────────────
// One persistent key per user (format R6-XXXX-XXXX-XXXX). It only WORKS while
// the user's BYO-proxy subscription is active (enforced at the API layer), so
// the key is the license and the subscription expiry is the gate.
function genCliKey() {
  return 'R6-' + crypto.randomBytes(9).toString('hex').toUpperCase().match(/.{1,6}/g).join('-');
}
const _setCliKey = db.prepare(`UPDATE users SET cli_key = ? WHERE id = ?`);
const _getUserByCliKey = db.prepare(`SELECT * FROM users WHERE cli_key = ?`);
function getOrCreateCliKey(userId) {
  const u = getUserById(userId);
  if (!u) return null;
  if (u.cli_key) return u.cli_key;
  let key, tries = 0;
  do { key = genCliKey(); tries++; } while (_getUserByCliKey.get(key) && tries < 6);
  _setCliKey.run(key, userId);
  return key;
}
function getUserByCliKey(key) {
  if (!key) return null;
  return _getUserByCliKey.get(String(key).trim()) || null;
}
const _setHwid = db.prepare(`UPDATE users SET hwid = ? WHERE id = ?`);
function setUserHwid(userId, hwid) { return _setHwid.run(hwid || null, userId).changes; }
function clearUserHwidByEmail(email) {
  const u = getUserByEmail(email);
  if (!u) return false;
  _setHwid.run(null, u.id);
  return true;
}

// ── Marketplace helpers ────────────────────────────────────────────────────
const _linkDiscord = db.prepare(`
  UPDATE users SET discord_id = ?, discord_username = ?, discord_in_guild_at = ? WHERE id = ?
`);
function linkUserDiscord(userId, { discordId, discordUsername, inGuildAt }) {
  return _linkDiscord.run(discordId || null, discordUsername || null, inGuildAt || null, userId).changes;
}
const _setTrusted = db.prepare(`UPDATE users SET is_trusted = ? WHERE id = ?`);
function setUserTrusted(userId, trusted) { return _setTrusted.run(trusted ? 1 : 0, userId).changes; }

const _upsertCheck = db.prepare(`
  INSERT INTO user_profile_checks (user_id, profile_user_id, first_checked_at, last_checked_at)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(user_id, profile_user_id) DO UPDATE SET last_checked_at = excluded.last_checked_at
`);
function recordUserProfileCheck(userId, profileUserId) {
  if (!userId || !profileUserId) return 0;
  const now = Date.now();
  return _upsertCheck.run(userId, profileUserId, now, now).changes;
}
const _userHasChecked = db.prepare(`SELECT 1 FROM user_profile_checks WHERE user_id = ? AND profile_user_id = ?`);
function userHasCheckedProfile(userId, profileUserId) {
  return !!_userHasChecked.get(userId, profileUserId);
}
const _listUserChecks = db.prepare(`
  SELECT profile_user_id, last_checked_at FROM user_profile_checks WHERE user_id = ? ORDER BY last_checked_at DESC LIMIT 100
`);
function listUserChecks(userId) { return _listUserChecks.all(userId); }

const _createListing = db.prepare(`
  INSERT INTO marketplace_listings (seller_user_id, profile_user_id, access_type, price_cents, title, description, status, created_at)
  VALUES (?, ?, ?, ?, ?, ?, 'active', ?)
`);
function createListing({ sellerUserId, profileUserId, accessType, priceCents, title, description }) {
  const now = Date.now();
  const info = _createListing.run(sellerUserId, profileUserId, accessType, priceCents, title || null, description || null, now);
  return Number(info.lastInsertRowid);
}
const _getListing = db.prepare(`SELECT * FROM marketplace_listings WHERE id = ?`);
function getListing(id) { return _getListing.get(id) || null; }

// Active listings with seller info (Discord name + trust + email obscured to id only).
const _listActive = db.prepare(`
  SELECT l.id, l.profile_user_id, l.access_type, l.price_cents, l.title, l.description, l.created_at,
         u.id as seller_id, u.discord_id as seller_discord_id, u.discord_username as seller_discord_username,
         u.is_trusted as seller_trusted
  FROM marketplace_listings l JOIN users u ON u.id = l.seller_user_id
  WHERE l.status = 'active'
  ORDER BY l.created_at DESC LIMIT 200
`);
function listActiveListings() { return _listActive.all(); }

const _listMyListings = db.prepare(`
  SELECT * FROM marketplace_listings WHERE seller_user_id = ? ORDER BY created_at DESC LIMIT 100
`);
function listMyListings(userId) { return _listMyListings.all(userId); }

const _markListingPending = db.prepare(`
  UPDATE marketplace_listings SET status = 'pending', buyer_user_id = ? WHERE id = ? AND status = 'active'
`);
function markListingPending(listingId, buyerUserId) {
  return _markListingPending.run(buyerUserId, listingId).changes;
}
const _markListingSold = db.prepare(`
  UPDATE marketplace_listings SET status = 'sold', sold_at = ?, discord_channel_id = ? WHERE id = ?
`);
function markListingSold(listingId, channelId) {
  return _markListingSold.run(Date.now(), channelId, listingId).changes;
}
// Attach the Discord channel to a pending listing WITHOUT marking it sold — the
// listing stays reserved (hidden) until the deal is confirmed finished/cancelled.
const _setListingChannel = db.prepare(`
  UPDATE marketplace_listings SET discord_channel_id = ? WHERE id = ?
`);
function setListingChannel(listingId, channelId) { return _setListingChannel.run(channelId, listingId).changes; }
// Deal confirmed done → sold (removed from the marketplace for good).
const _completeListing = db.prepare(`
  UPDATE marketplace_listings SET status = 'sold', sold_at = ? WHERE id = ? AND status = 'pending'
`);
function completeListing(listingId) { return _completeListing.run(Date.now(), listingId).changes; }
// Deal cancelled → back on the marketplace (un-reserve, clear buyer + channel).
const _reopenListing = db.prepare(`
  UPDATE marketplace_listings SET status = 'active', buyer_user_id = NULL, discord_channel_id = NULL WHERE id = ?
`);
function reopenListing(listingId) { return _reopenListing.run(listingId).changes; }
const _getListingByChannel = db.prepare(`SELECT * FROM marketplace_listings WHERE discord_channel_id = ?`);
function getListingByChannel(channelId) { return _getListingByChannel.get(channelId) || null; }
const _cancelListing = db.prepare(`
  UPDATE marketplace_listings SET status = 'cancelled' WHERE id = ? AND status = 'active' AND seller_user_id = ?
`);
function cancelListing(listingId, sellerUserId) {
  return _cancelListing.run(listingId, sellerUserId).changes;
}

// ── Discord OAuth tokens ─────────────────────────────────────────────────────
const _upsertOauth = db.prepare(`
  INSERT INTO discord_oauth (discord_id, username, email, refresh_token, access_token, access_token_expires_at, scope, updated_at)
  VALUES (@discord_id, @username, @email, @refresh_token, @access_token, @access_token_expires_at, @scope, @updated_at)
  ON CONFLICT(discord_id) DO UPDATE SET
    username = excluded.username,
    email    = excluded.email,
    refresh_token = excluded.refresh_token,
    access_token  = excluded.access_token,
    access_token_expires_at = excluded.access_token_expires_at,
    scope    = excluded.scope,
    updated_at = excluded.updated_at
`);
function upsertDiscordOauth(rec) {
  if (!rec || !rec.discordId) return;
  _upsertOauth.run({
    discord_id: rec.discordId,
    username:   rec.username || null,
    email:      rec.email || null,
    refresh_token: rec.refreshToken || null,
    access_token:  rec.accessToken || null,
    access_token_expires_at: rec.expiresIn ? Date.now() + (Number(rec.expiresIn) - 30) * 1000 : null,
    scope:      rec.scope || null,
    updated_at: Date.now(),
  });
}
const _getOauth = db.prepare(`SELECT * FROM discord_oauth WHERE discord_id = ?`);
function getDiscordOauth(discordId) { return _getOauth.get(discordId) || null; }
const _listOauth = db.prepare(`SELECT discord_id, username, email, refresh_token, access_token, access_token_expires_at, scope, updated_at, last_invited_at, last_invite_guild, last_invite_status FROM discord_oauth ORDER BY updated_at DESC`);
function listDiscordOauths() { return _listOauth.all(); }
const _countOauth = db.prepare(`SELECT COUNT(*) AS n FROM discord_oauth`);
function countDiscordOauths() { return _countOauth.get().n; }
const _markInvited = db.prepare(`UPDATE discord_oauth SET last_invited_at = ?, last_invite_guild = ?, last_invite_status = ? WHERE discord_id = ?`);
function markDiscordInvited(discordId, guildId, status) { _markInvited.run(Date.now(), guildId, status, discordId); }

module.exports = {
  db,
  InsufficientFundsError,
  // discord oauth tokens
  upsertDiscordOauth, getDiscordOauth, listDiscordOauths, countDiscordOauths, markDiscordInvited,
  // desktop CLI key + HWID lock
  getOrCreateCliKey, getUserByCliKey, setUserHwid, clearUserHwidByEmail,
  // marketplace
  linkUserDiscord, setUserTrusted,
  recordUserProfileCheck, userHasCheckedProfile, listUserChecks,
  createListing, getListing, listActiveListings, listMyListings,
  markListingPending, markListingSold, cancelListing,
  setListingChannel, completeListing, reopenListing, getListingByChannel,
  // BYO-proxy subscriptions
  SUBSCRIPTION_PLANS, getPlan,
  getSubscription, isSubscriptionActive, subscriptionStatus, extendSubscription,
  recordSubscriptionInvoice, getSubscriptionInvoice, updateSubscriptionInvoiceStatus,
  listPendingSubscriptionInvoices, creditSubscriptionInvoice,
  getUserProxies, setUserProxies,
  // users
  createUser, getUserByEmail, getUserById, touchLogin, setUnlimited,
  // sessions
  createSession, getSession, renewSession, deleteSession, deleteAllUserSessions,
  // password resets
  createResetToken, getResetToken, consumeResetToken,
  // money
  chargeUser, creditBalance, listTransactions,
  // owner analytics
  adminStats,
  // deposits
  recordDeposit, getDeposit, updateDepositStatus, listDeposits, listPendingDeposits, creditDeposit, refundDeposit,
  // admin
  adminAdjust,
  // jobs
  createJob, getJob, bumpJobDone, finishJob, finalizeUploadedJob, cancelJob, listJobs, listExpiredJobs, deleteJob,
  // sweeper
  startSweeper,
};
