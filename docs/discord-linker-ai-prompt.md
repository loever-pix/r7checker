# PROJECT: R6Checker Discord Auto-Linker (Premium Bot + r6checker.xyz API)

You are building a **new feature set** inside the existing **R6Checker** monorepo at the workspace root. This is NOT a greenfield project — extend existing patterns, reuse Ubisoft auth/profile code, and integrate with the live site **https://r6checker.xyz**.

## Executive summary

Build a **premium Discord bot experience** that lets licensed users submit:

1. Ubisoft credentials (`email:password`)
2. Console credentials for the platform they want to link (`xbox` or `psn`, `email:password`)

The system should attempt to **auto-link** the console account to the Ubisoft account and return one of:

- **Successfully linked**
- **Already linked** (no free slot on Ubisoft side — current link or ghost)
- **Failed** (with a specific reason code)

**Do NOT build a custom key/redemption system in Discord.** Licensing is handled by the client via **KeyAuth**, integrated on **r6checker.xyz**. The Discord bot only checks access through site APIs.

The desktop bulk checker (**R6Checker.exe**, `cli/`) remains separate — this project adds a **single-account linker** service.

---

## Repository context (read these first)

### Existing Ubisoft / checker logic (REUSE — do not rewrite)

- `lib/auth.js` — Ubisoft login, session tickets, 2FA detection, proxy rotation
- `lib/player.js` — profile fetch, `/v2/profiles`, `/v3/users/{id}/profiles`, `/v3/users/{id}/initialProfiles` (ghost detection)
- `lib/checker/resultFormat.js` — `linkableTagInner()` determines free XBX/PSN slots (includes ghosts)
- `lib/proxy/session.js` — provider-aware proxy session rotation (Flame, DataImpulse, Core, Nova)

### Existing website (`server.js` + `lib/store.js`)

- Express app at `server.js`
- User auth: `lib/siteAuth.js` (cookie `r6_sid`)
- Subscriptions: `store.subscriptionStatus()`, `bulk_subscriptions` table
- CLI licensing: `/api/cli/*` with license key + HWID + subscription gate
- Discord OAuth already exists: `/auth/discord`, `/auth/discord/callback`, `lib/discord.js`
- Users table already has: `discord_id`, `discord_username`, `cli_key`, `hwid`
- `discord_oauth` table stores OAuth tokens from verify flow

### Existing Discord bot (`bot.js` + `lib/bot/`)

- Entry: `bot.js` — registers guild slash commands from `lib/bot/commands/*`
- Config: `lib/bot/config.js` — `BOT_API_TOKEN`, `BOT_SERVER_URL` (localhost), `publicUrl` (r6checker.xyz)
- Pattern for bot → server calls: see `lib/bot/commands/recheck.js` (uses `cfg.botApiToken` + `cfg.serverUrl`)
- Bot HTTP inbound: `lib/bot/mpHttpServer.js` (auth via shared token)
- Theme: Ayanokoji / Classroom of the Elite — `lib/bot/config.js` theme colors, embed style in existing commands

---

## Architecture (mandatory)

```
Discord User
  → Discord Bot (UI only: slash commands, modals, embeds, DMs)
  → r6checker.xyz API (/api/linker/*)
  → KeyAuth validation (SERVER-SIDE ONLY — never in bot or client)
  → Job queue + linker workers
  → Ubisoft + Xbox/PSN auth + link + post-verify
```

**Rules:**

1. KeyAuth secrets live ONLY in server `.env` on r6checker.xyz
2. Discord bot NEVER calls KeyAuth directly
3. Discord bot NEVER stores license keys
4. Credentials (`email:password`) are processed in memory only — never logged, never persisted to DB
5. Match existing code style: CommonJS, minimal scope, reuse existing helpers

---

## Phase plan (implement in order)

### PHASE 1 — Site API + Discord shell + pre-check (ship this first)

#### A. Database (`lib/store.js`)

Add tables (with migrations like existing patterns):

- `linker_subscriptions` OR extend existing subscription model with a `linker` plan type
- `linker_credits` (user_id, credits_remaining, credits_used, period_start, period_end)
- `linker_jobs` (id, user_id, discord_id, platform, status, result, reason_code, created_at, finished_at)
  - Store masked emails only if needed for history — NEVER passwords

#### B. KeyAuth integration (`lib/keyauth.js` — new)

- Server-side module wrapping KeyAuth API
- Env vars: `KEYAUTH_NAME`, `KEYAUTH_OWNERID`, `KEYAUTH_SECRET`, `KEYAUTH_VERSION`
- Functions:
  - `validateLicense(key, hwid?)` — for site/dashboard use
  - `checkUserAccess(userId)` — map site user → KeyAuth subscription active
- Client will configure KeyAuth; build abstraction so it works even if KeyAuth is stubbed in dev (`KEYAUTH_DEV_BYPASS=1`)

#### C. Discord account binding

- Extend existing Discord OAuth flow OR add `/link-discord` page
- Bind `users.discord_id` to site account (column already exists)
- Endpoint: `GET /api/linker/access` — called by bot with:
  - Header: `Authorization: Bearer ${BOT_API_TOKEN}`
  - Header: `X-Discord-User-Id: <snowflake>`
  - Returns: `{ allowed, linked, plan, expiresAt, creditsLeft, queuePriority, renewUrl }`

#### D. Linker API routes in `server.js`

Namespace: `/api/linker/*`

| Route | Auth | Purpose |
|---|---|---|
| `GET /api/linker/access` | Bot token + Discord ID | License gate |
| `POST /api/linker/jobs` | Bot token + Discord ID | Create job |
| `GET /api/linker/jobs/:id` | Bot token + Discord ID | Job status |
| `GET /api/linker/history` | Bot token + Discord ID | Last N jobs (masked) |

`POST /api/linker/jobs` body:

```json
{
  "platform": "xbox" | "psn",
  "ubisoftEmail": "...",
  "ubisoftPassword": "...",
  "consoleEmail": "...",
  "consolePassword": "..."
}
```

Flow:

1. Validate Discord user is linked to site user with active linker access (KeyAuth/subscription)
2. Create job record → return `{ jobId }` immediately
3. Worker picks up job asynchronously

**Phase 1 worker behavior (pre-check only):**

1. Login Ubisoft via `lib/auth.js` (use proxy from env `LINKER_PROXY` or operator-configured proxy list)
2. Fetch player data via `lib/player.js`
3. Run `linkableTagInner(playerData)` from `lib/checker/resultFormat.js`
4. If requested platform slot not free → `already_linked`
5. If Ubisoft login fails → `failed` + `UBI_INVALID` / `UBI_2FA`
6. If slot IS free → return `precheck_ok` (Phase 1 stops here; do NOT charge credit yet in Phase 1, or charge only on full link in Phase 2)

#### E. Discord bot commands (`lib/bot/commands/`)

Add to `bot.js` commands registry:

| Command | Behavior |
|---|---|
| `/start` | Onboarding embed + button link to `https://r6checker.xyz/link-discord` (or existing verify flow) |
| `/account` | Calls `/api/linker/access`, shows plan/expiry/credits in branded embed |
| `/link` | Premium guided flow (see UX below) |
| `/status [job_id]` | Poll job status |
| `/history` | Recent jobs from API |
| `/help` | FAQ + failure reason glossary |

**Do NOT add `/redeem`.**

#### F. Premium Discord UX (mandatory quality bar)

`/link` flow:

1. Gate: call `/api/linker/access` — if not linked/expired → ephemeral error + `[Connect Account]` + `[Renew]` buttons to r6checker.xyz
2. Modal 1: Ubisoft email + password (ephemeral)
3. String select: Xbox or PSN
4. Modal 2: Console email + password (ephemeral)
5. Confirm embed with **masked** emails (`u***@gmail.com`) + platform + `[Confirm]` / `[Cancel]` buttons
6. On confirm → POST job → ephemeral "Job queued #XXXX"
7. **DM user** progress updates (not public channel spam):
   - Queued → Logging into Ubisoft → Checking link slot → (Phase 2+) Linking → Verifying → Done
8. Final result embed with consistent template:

Colors:

- Brand/in-progress: `0x5865F2` or theme from `cfg.theme`
- Success: `0x57F287`
- Already linked: `0xFEE75C`
- Failed: `0xED4245`

Footer on every embed: `R6Checker · r6checker.xyz · Job #ID`

Use `MessageFlags.Ephemeral` for anything with credentials. Never echo passwords in embeds/logs.

---

### PHASE 2 — Xbox auto-link

Add `lib/linker/` module:

```
lib/linker/
  precheck.js      — Ubisoft login + linkable check (reuse resultFormat)
  verify.js        — post-link profile re-read
  xboxAuth.js      — Microsoft/Xbox login from email:password
  xboxLink.js      — complete Ubisoft↔Xbox association
  worker.js        — job processor
  reasons.js       — standardized reason codes
```

Worker pipeline for `platform: xbox`:

1. Pre-check (already built)
2. If slot free → login Xbox/Microsoft with console creds
3. Execute link flow (browser automation with Playwright OR reverse-engineered OAuth — document which approach you chose and why)
4. Post-verify: re-fetch `/v3/users/{id}/profiles` — confirm `xbl` present
5. Return result

**Credit rule:** Only deduct credit AFTER pre-check passes (slot is free). Invalid Ubisoft creds = no credit burned.

Reason codes (`lib/linker/reasons.js`):

- `SUCCESS`
- `ALREADY_LINKED`
- `UBI_INVALID`, `UBI_2FA`
- `CONSOLE_INVALID`, `CONSOLE_2FA`
- `CONSOLE_TAKEN` (console already linked to different Ubisoft account)
- `LINK_REJECTED`, `TIMEOUT`, `PROXY_ERROR`, `UNKNOWN`

---

### PHASE 3 — PSN auto-link

Mirror Phase 2 for PlayStation:

- `lib/linker/psnAuth.js`
- `lib/linker/psnLink.js`

Same job pipeline, same result format.

---

## Environment variables (document in `.env.example`)

```env
# Linker
KEYAUTH_NAME=
KEYAUTH_OWNERID=
KEYAUTH_SECRET=
KEYAUTH_VERSION=
KEYAUTH_DEV_BYPASS=0

LINKER_PROXY=http://user:pass@host:port
LINKER_MAX_CONCURRENT=3
LINKER_JOB_TIMEOUT_MS=300000
LINKER_CREDITS_DAY_PASS=5
LINKER_CREDITS_MONTHLY=50

# Already exist — reuse
BOT_API_TOKEN=
BOT_SERVER_URL=http://127.0.0.1:3000
SITE_URL=https://r6checker.xyz
DISCORD_BOT_TOKEN=
DISCORD_GUILD_ID=
```

---

## Implementation constraints

1. **Minimize diff** — extend existing files where natural; new code in `lib/linker/` and `lib/bot/commands/link*.js`
2. **Match conventions** — CommonJS, same error handling style as `lib/auth.js` and `server.js`
3. **No commits** unless user asks
4. **Security**
   - Redact passwords in all logs: `[REDACTED]`
   - Rate limit `/api/linker/jobs` per Discord user (e.g. 10/hour)
   - Bot inbound auth: same pattern as `mpHttpServer.js` / `BOT_API_TOKEN`
5. **Proxies** — linker jobs MUST support HTTP proxy (reuse `lib/proxy/session.js` patterns)
6. **2FA** — Phase 1/2: fail with clear `UBI_2FA` / `CONSOLE_2FA` message; do not silently hang
7. **Job queue** — start simple: in-process queue with concurrency limit; design so Redis/Bull can replace later without API changes
8. **Tests** — add `scripts/test-linker-precheck.js` for pre-check logic with mocked auth; test reason code mapping

---

## Acceptance criteria

### Phase 1

- [ ] Unlicensed Discord user gets clear "connect account / renew" message
- [ ] Linked + licensed user can run `/link` and receive pre-check result
- [ ] `already_linked` correctly detected using `linkableTagInner` + ghosts from `initialProfiles`
- [ ] No passwords in DB, logs, or Discord messages after submit
- [ ] `/account` shows plan, expiry, credits from site API
- [ ] Job progress DMs update at least 3 states

### Phase 2

- [ ] Xbox link success confirmed by post-verify profile read
- [ ] Credits only deducted when pre-check passes
- [ ] All reason codes return user-friendly Discord messages

### Phase 3

- [ ] PSN link works with same UX and result format as Xbox

---

## Out of scope (do NOT build)

- Custom key redemption in Discord (`/redeem`)
- Bulk combo checking in Discord (that's `cli/` / R6Checker.exe)
- Unlinking or swapping console accounts
- Storing user credentials beyond job execution
- KeyAuth secret in bot process or frontend JS
- HWID lock for Discord linker (Discord ID binding is sufficient)

---

## Suggested file checklist

**New files:**

- `lib/keyauth.js`
- `lib/linker/precheck.js`
- `lib/linker/verify.js`
- `lib/linker/worker.js`
- `lib/linker/reasons.js`
- `lib/linker/xboxAuth.js` (Phase 2)
- `lib/linker/xboxLink.js` (Phase 2)
- `lib/linker/psnAuth.js` (Phase 3)
- `lib/linker/psnLink.js` (Phase 3)
- `lib/bot/commands/start.js`
- `lib/bot/commands/account.js`
- `lib/bot/commands/link.js`
- `lib/bot/commands/linkerStatus.js`
- `lib/bot/commands/linkerHistory.js`
- `lib/bot/commands/linkerHelp.js`
- `lib/bot/linkerApi.js` (bot-side fetch wrapper for `/api/linker/*`)
- `scripts/test-linker-precheck.js`

**Modify:**

- `server.js` — add `/api/linker/*` routes
- `lib/store.js` — linker tables + helpers
- `bot.js` — register new commands
- `lib/bot/config.js` — linker-related config if needed
- `.env.example` — document new vars

---

## Working style

1. Read existing patterns before writing (`recheck.js`, `/api/cli/*`, `linkableTagInner`, `mpHttpServer.js`)
2. Implement **Phase 1 completely** and verify pre-check works before starting Phase 2
3. After each phase, list what was built, what's stubbed, and how to test locally:
   - `node server.js`
   - `node bot.js`
   - Test `/link` in Discord dev guild
4. Prefer working Phase 1 end-to-end over partial Phase 2/3

Begin by exploring the repo, then implement Phase 1.

---

## How to use this prompt

### Cursor

New Agent chat → paste this entire document → ensure workspace is `r6-byo-checker-share`.

### Claude Code

Use this document as the task spec. Ask for **Phase 1 only** first if you want tighter control.

### Local dev without KeyAuth

Set `KEYAUTH_DEV_BYPASS=1` until the client provides KeyAuth credentials.

### Branding note

Match embed styling to existing bot commands (`recheck.js`, `setupserver.js`) and theme in `lib/bot/config.js`.

---

## Follow-up prompts (after Phase 1)

### Phase 2

> Implement Phase 2 Xbox auto-link in `lib/linker/`. Reuse Phase 1 pre-check and post-verify. Add Playwright or documented OAuth flow. Do not break Phase 1.

### Phase 3

> Implement Phase 3 PSN auto-link mirroring Xbox. Same job API and Discord UX.

### Polish

> Add rate limiting, maintenance mode embed, and admin endpoint `GET /api/admin/linker/stats` for job success/failure breakdown.
