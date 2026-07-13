# Bulk Account Checker + Crypto Balance System

**Date:** 2026-05-30
**Status:** Approved, in implementation

## Summary

Extend the existing single-account R6 checker with:
1. A site-level email/password signup + login (separate from the existing Discord OAuth).
2. A user balance (stored in cents) with crypto deposits via NOWPayments.
3. A bulk account checker that accepts paste OR `.txt` upload of `email:password` lines, processes 4 concurrently through the existing proxy pool, and charges $1.25 per *definitive* outcome (success or wrong-password). 2FA / anti-bot / network failures are free.
4. Per-job encrypted result files, auto-deleted after 24h, downloadable as plain `.txt` in the format:
   `email:pass | username | level | total_items | credits/renown | Profile: URL`.

## Confirmed decisions

| Topic | Decision |
|---|---|
| Site auth | Email + password (new). Coexists with existing Discord OAuth — they don't replace each other. |
| Crypto provider | NOWPayments |
| Billing | Charge on success AND on wrong-password. Refund (i.e. don't charge) on 2FA / anti-bot / network. |
| Concurrency | 4 workers in parallel through existing proxy pool, live progress to UI. |
| Input | `email:password` per line, both paste and `.txt` upload. 500-line cap per job. |
| Result storage | Per-user job, 24h retention, AES-256-GCM at rest, plain `.txt` download. |
| Min deposit | $10 USD |
| Storage | better-sqlite3, single `data.db`. Money stored as integer cents. |

## Architecture

```
public/
  account/
    signup.html              new email+pass signup
    login.html               new site login
    index.html               balance, deposit, history
  bulk.html                  paste/upload + live job view + download
lib/
  store.js                   NEW better-sqlite3 wrapper
  siteAuth.js                NEW signup/login/sessions (scrypt + cookie)
  payments/
    nowpayments.js           NEW invoice creation, IPN webhook verify, idempotent credit
  checker/
    bulkRunner.js            NEW queue + 4-worker pool, billing decision, AES result encryption
    resultFormat.js          NEW line formatter, encrypt/decrypt helpers
server.js                    mounts the new routes
```

Three new request paths, all isolated from existing routes:

1. **Site auth.** `POST /api/auth/signup|login|logout`, `GET /api/auth/me`. Session cookie `r6_sid` (distinct from existing `r6locker_discord_session`). 30-day sliding expiry. Captcha reused from existing Turnstile config.
2. **Deposit.** `POST /api/deposit { amountUsd }` → calls NOWPayments `POST /v1/invoice`, returns hosted invoice URL. Webhook at `POST /webhook/nowpayments` HMAC-verified with IPN secret, credits balance idempotently. 60s polling fallback for missed webhooks.
3. **Bulk check.** `POST /api/bulk/start { accounts: [...] }` creates a job, returns `jobId`. Background runner processes 4 at a time; per-account billing is atomic SQLite transaction. `GET /api/bulk/:jobId` returns progress; `/download` streams decrypted `.txt`.

## Data model (SQLite)

```sql
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL COLLATE NOCASE,
  password_hash TEXT NOT NULL,            -- scrypt: salt_hex$hash_hex
  balance_cents INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_login_at INTEGER
);

CREATE TABLE sessions (
  token TEXT PRIMARY KEY,                  -- 32-byte hex
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

CREATE TABLE transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL,                      -- 'deposit'|'charge'|'refund'|'adjust'
  amount_cents INTEGER NOT NULL,           -- signed
  balance_after INTEGER NOT NULL,
  ref TEXT,                                -- invoice id OR job id
  meta TEXT,                               -- JSON
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_txn_user ON transactions(user_id, created_at DESC);

CREATE TABLE deposits (
  invoice_id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  amount_usd REAL NOT NULL,
  pay_currency TEXT,
  pay_address TEXT,
  status TEXT NOT NULL,                    -- 'waiting'|'confirming'|'finished'|'failed'|'expired'
  credited INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE bulk_jobs (
  id TEXT PRIMARY KEY,                     -- 16-byte hex
  user_id INTEGER NOT NULL REFERENCES users(id),
  total INTEGER NOT NULL,
  done INTEGER NOT NULL DEFAULT 0,
  charged_cents INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,                    -- 'running'|'done'|'cancelled'
  results_path TEXT,                       -- .cache/jobs/<id>.enc
  created_at INTEGER NOT NULL,
  finished_at INTEGER,
  expires_at INTEGER NOT NULL              -- created_at + 24h
);
```

## Billing decision table

| Outcome | Billable? | Output line |
|---|---|---|
| 200 + ticket + playerData fetched | $1.25 | `email:pass \| username \| level \| total_items \| credits/renown \| Profile: URL` |
| 401 Wrong email or password | $1.25 | `email:pass \| INVALID` |
| 2FA required (definitive) | free | `email:pass \| 2FA_REQUIRED` |
| 502 anti-bot retries exhausted | free | `email:pass \| ERROR_RETRY` |
| Network / proxy timeout | free | `email:pass \| ERROR_NETWORK` |
| Login succeeded, getPlayerData failed | $1.25 | `email:pass \| <username> \| PARTIAL` |

Implemented as a single `decideBillable(err, ticket)` helper so the rule lives in one place.

## Atomic charging

```js
db.transaction(() => {
  const row = SELECT balance_cents WHERE id=?;
  if (row.balance_cents < cents) throw InsufficientFundsError;
  UPDATE users SET balance_cents = balance_cents - cents WHERE id=?;
  INSERT INTO transactions (kind='charge', amount_cents=-cents, balance_after=..., ref=jobId);
  UPDATE bulk_jobs SET charged_cents = charged_cents + cents WHERE id=?;
})();
```

Mid-run InsufficientFunds aborts the job cleanly (status='done', partial results downloadable).

## Result encryption

Per-job results joined with `\n`, AES-256-GCM encrypted with `RESULTS_ENC_KEY` from `.env` (auto-generated on first server start). On-disk layout: `iv(12) || tag(16) || ciphertext`. In-memory results dropped once written.

## Sweeper

`setInterval(60_000)`:
- Delete `bulk_jobs` (+ their `.enc` files) where `expires_at < now`
- Mark stale `deposits` (waiting > 24h) as expired
- Delete expired `sessions`

## Error handling highlights

- Auth: generic 401 for bad creds (no email enumeration); constant-time scrypt even for unknown emails.
- Deposit: validates `MIN_DEPOSIT_USD ≤ amount ≤ 1000`; NOWPayments 5xx → 503 to user, nothing written.
- Webhook: HMAC fail → 401 logged; unknown invoice → 404; already-credited → 200 OK (idempotent).
- Bulk: empty/oversized inputs → 400; insufficient balance pre-flight → 402; mid-run insufficient → graceful stop.
- Server crash mid-job: startup sweeper marks `running` jobs `cancelled`. Partial in-memory results lost (memory-only), but `charged_cents` is correct in DB.

## Rollout

One env flag: `ENABLE_BILLING=1`. When unset:
- Auth pages still work (local testing)
- `/api/deposit` and `/api/bulk/start` return 503
- Webhook returns 404

Deploy steps: land DB + auth + UI behind flag → configure NOWPayments IPN URL → add `NOWPAYMENTS_IPN_SECRET` → flip flag → test real $10 deposit.

## Env vars

```
NOWPAYMENTS_API_KEY=<set>
NOWPAYMENTS_PUBLIC_KEY=<set>
NOWPAYMENTS_IPN_SECRET=<pending from NOWPayments dashboard>
SITE_SESSION_SECRET=<auto-generated>
RESULTS_ENC_KEY=<auto-generated, 64 hex chars>
PRICE_PER_CHECK_USD=1.25
MIN_DEPOSIT_USD=10
BULK_CONCURRENCY=4
ENABLE_BILLING=0
```

## Out of scope

- Withdrawals (balance is one-way).
- Refund UI (only automatic per billing table).
- Admin dashboard / multi-user moderation.
- Account export / GDPR deletion.
- Promo codes / volume discounts.

## Testing

Focused on financial correctness:
1. Store unit tests: `chargeUser` exact deduction, idempotent `creditDeposit`, serialized concurrent charges.
2. NOWPayments webhook: HMAC verify, replay protection.
3. Bulk runner: mocked checkOne, charge counts match billing table outcomes.
4. Manual e2e: signup → deposit (sandbox) → small bulk job → download.
