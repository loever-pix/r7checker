# R6Checker — Full-Stack Source Bundle

One codebase runs three things:

| Component | Entry point | What it does |
|---|---|---|
| **Website** | `server.js` (Node/Express) | r6checker.xyz — account lookup, bulk-check UI, storefront, admin, Whop billing |
| **Discord bot** | `bot.js` (discord.js) | SellAuth stock management + `/checkall`, `/restock`, `/replace`, `/recheck`, sales feed |
| **Desktop checker** | `cli/checker.js` (Node SEA build) | R6Checker.exe / UbisoftVM.exe — CLI bulk-check tool, HWID-locked, offline-capable |

## Top-level layout

```
server.js                 # website (Express + SQLite via better-sqlite3)
bot.js                    # Discord bot
package.json              # site + bot deps
package-lock.json

lib/                      # shared logic (used by ALL three components)
  auth.js                 # Ubi login — DataDome bypass, fingerprint + IP rotation, session teardown
  player.js               # profile + inventory + rank assembly, era correction, charm corroboration
  api.js                  # Ubi HTTP client with global concurrency + token bucket
  proxyClient.js          # rotating residential gateway (per-request session tokens)
  rankSources.js          # tracker.gg (primary) + r6data + tabstats + r6tab + stats.cc (fallbacks)
  trackerGGCache.js       # 1h cache with sha1-hashed keys
  r6dataCache.js          # cooldown-aware cache
  rankedSeasons.js        # season name/number tables, era-boundary constants
  linkedHistory.js        # ghost tracking for previously-linked console handles
  marketplace.js          # itemId → official skin image
  dnsCache.js             # TTL-cached DNS for the proxy gateway
  r6-catalog.json         # static item catalog (skinCheck reads this)
  store.js                # SQLite users/jobs/deposits/subscriptions
  siteAuth.js             # session cookies, password hashing, owner check
  desktopActivation.js    # HWID + license validation for the desktop app
  pricingStore.js         # JSON overrides for live pricing (hot-reload)
  bot/                    # bot-specific: SellAuth, VWI push, resort, sales feed, etc.
  checker/                # bulk pipeline: bulkRunner, bulkWorker (forked), rateGovernor, resultFormat
  payments/               # Whop provider adapter

cli/                      # desktop-app source (Node SEA)
  checker.js              # main CLI
  build.js / build-local.js / build-sea.js
                          # SEA build scripts (produces R6Checker.exe or UbisoftVM.exe)
  sea-config.json / sea-config-local.json
  local/                  # desktop runtime
    main.js, menu.js, runner.js, pool.js, check-worker.js
    circuit-breaker.js, retry.js, queue.js, multiproc.js
    control-plane.js      # activation / license
    updater.js            # auto-update
    brand.js              # R6_BRAND switch (r6checker vs ubivm)
    metrics.js, logger.js, writer.js, version.js, config.js
  package.json            # cli-scoped deps

public/                   # website static + client JS
  index.html, account.html, bulk.html, download.html, admin.html, locker.html, marketplace*.html
  app.js, style.css, discord-popup.js, server-login.js, oauth-callback.html
  img/                    # public images
  js/                     # UMD modules — vwiBuckets.js (VWI sorter classifier)

scripts/                  # unit tests + dev helpers
  test-*.js               # (see "Testing" below)
  make-preview.js         # helper for preview generation

tools/
  ubi-email-checker/      # companion tool (separate SEA build, email-only validator)

docs/
  DEPLOY-UPCLOUD.md       # VPS deploy notes
  superpowers/plans/      # implementation plans (design history)
  superpowers/specs/      # design specs

data/
  item-images.json        # catalog data
  ranked-charm-images.json

.env.example              # environment template — copy to .env and fill in
README.md                 # this file
```

## Redactions in this distribution

For safe public sharing, the following have been scrubbed:

- **`lib/proxyClient.js`** — hardcoded fallback proxy user/pass/host/port removed (reads from `.env`).
- **`lib/player.js`** — r6data.com API key removed (still works without it; falls through to tracker.gg + Ubi-native).
- **`lib/bot/config.js` + `lib/bot/commands/checkall.js`** — Discord owner user-ID default replaced with `000000000000000000`.
- **`lib/bot/salesFeed.js`, `lib/siteAuth.js`, `server.js`, `cli/local/main.js`** — hardcoded owner email fallback replaced with `owner@example.com`.
- **`scripts/test-desktop-activation.js`** — HTML-fixture email replaced.
- **`scripts/test-vwi-phone-gate.js` + `scripts/test-level-ranks-gate.js`** — real bug-repro credentials and personal names replaced with synthetic ones.
- **`cli/checker.js`** — one email in a comment anonymized.
- **`docs/DEPLOY-UPCLOUD.md`** — VPS username/IP/paths replaced with `<deploy-user>` / `<vps-ip>` placeholders.

## Not included (excluded from the bundle)

- `.env`, `.env.*` (real)
- `.git/`, `node_modules/`, `.cache/`, `.claude/`, `.worktrees/`, `_brandwork/`
- `accounts_created.txt`, `accounts.txt` (any location), `proxies.txt` (any location), `appids.txt`
- `public/downloads/` (real user data + previous zips)
- `cli/dist/`, `cli/output/`, `cli/checker.obf.js` (opaque compiled build — regen from `checker.js` via `node build.js`)
- `test-params.js`, `test-proxy.js`, `test.js` at repo root (dev scripts with hardcoded credentials)
- `scripts/test-skin-detector.js`, `scripts/test-small-bulk.js` (dev scripts with real user data / hardcoded owner)
- `server-output.log` (contains real usernames + profileIds)

## Build & run

### 0. Prereqs
- Node.js 20+
- SQLite 3 (via `better-sqlite3` — auto-installed by npm)
- Windows/macOS/Linux

### 1. Install
```
npm install                  # root deps (site + bot)
cd cli && npm install && cd ..
cd tools/ubi-email-checker && npm install && cd ../..
```

### 2. Configure
```
cp .env.example .env
$EDITOR .env
```
Fill in at minimum: `PROXY_*`, `SITE_SESSION_SECRET`, `RESULTS_ENC_KEY`, `OWNER_EMAILS`, `DISCORD_TOKEN` (if running the bot).

### 3. Run

**Website only** (localhost:3000):
```
node server.js
```

**Bot only**:
```
node bot.js
```

**Desktop checker** (build the EXE first):
```
cd cli
node build.js               # produces dist/R6Checker.exe or dist/UbisoftVM.exe
# For a lite build (email-only validator branded UbisoftVM.exe):
R6_BRAND=ubivm node build.js
```

The exe reads `accounts.txt` and `proxies.txt` from the folder next to itself, and writes `results.txt` / `valid.txt` / `vwi.txt` (AES-256-GCM encrypted with `RESULTS_ENC_KEY`).

### 4. Testing
Every test is pure JS with no external services required (or fakes them):
```
node scripts/test-rate-governor.js
node scripts/test-never-skip.js
node scripts/test-tracker-identity.js
node scripts/test-era-correction.js
node scripts/test-level-ranks-gate.js
node scripts/test-charm-corroboration.js
node scripts/test-vwi-phone-gate.js
node scripts/test-vwi-resort.js
node scripts/test-vwi-buckets.js
node scripts/test-vwi-pricing.js
node scripts/test-vwi-push-plan.js
node scripts/test-whop.js
node scripts/test-refund.js
node scripts/test-xss-escape.js
node scripts/test-desktop-activation.js
```

## Notable design notes

**Rate governor** (`lib/checker/rateGovernor.js`) — TCP-style AIMD adaptive concurrency:
- Slow start (200 concurrent initial, not the ceiling — probes upward gently)
- Additive increase: +16 slots per 500ms of clean successes (time-gated, NOT per-call)
- Multiplicative decrease: halve on data-path 429/503 (hard), trim one step on login-layer 429 (soft — rotation recovers it)
- Circuit breaker: pauses the whole pool if the hard-throttle rate in a 15s rolling window crosses 70%
- Retry-After header honored exactly

**Ubi rate-limit strategy** — Ubisoft throttles per `(fingerprint × source IP)`:
- Fingerprint pool: 32 combos of (UA + Accept-Language + AppId)
- IP rotation: FlameProxies `-session-<rand>` / DataImpulse `__sid-<rand>` injected per request
- Session teardown: `DELETE /v3/profiles/sessions/{id}` after every check — this alone bumped the valid rate from 0% → 20% on live traffic

**Checker output rules** (see `lib/checker/resultFormat.js` + `public/js/vwiBuckets.js`):
- Ranks are era-corrected (Champion introduced S15 Ember Rise; Emerald introduced S28 Solar Raid) before display
- Ranks suppressed when PC clearance level < 20 (ranked play unlocks at level 20)
- Ranks corroborated against `ownedRankedCharmImages` — a claim without a matching S+tier charm is dropped
- `Ranks:` field shows the season NAME (`Plat (S41 Silent Hunt)`), not just the number
- VWI classification requires `PhoneVerified: Y` (recovery-vulnerable otherwise)

**Multi-process forking** (`lib/checker/bulkRunner.js`):
- 4 forked child processes (`BULK_WORKERS=4`), each with its own libuv pool
- 200 coroutines per child (`BULK_WORKER_CONCURRENCY=200`) gated by the governor
- Results stream over IPC → parent bills/writes/counts

## Support

Open an issue on your fork or ping whoever handed you this bundle.
