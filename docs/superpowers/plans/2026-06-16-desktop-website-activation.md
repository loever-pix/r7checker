# Desktop Website Activation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the desktop checker prefer the signed-in website account at `https://r6checker.xyz`, bind that account email to the desktop HWID, and block desktop use when access expires.

**Architecture:** The website remains the source of truth. A signed-in website session can mint the existing per-user CLI key through a new session-authenticated endpoint that receives the desktop HWID and redirects the key back to a localhost callback. The desktop stores the key and keeps using `/api/cli/me`, so subscription expiry and HWID checks stay enforced by the existing backend path.

**Tech Stack:** Node.js, Express, SQLite store helpers, Windows Node SEA desktop build.

## Global Constraints

- Control-plane base URL must default to `https://r6checker.xyz`.
- Desktop access must require an active website access pass unless the account is an owner.
- The first successful activation binds `users.hwid`; later mismatched HWIDs are rejected.
- No browser cookies or website passwords are stored by the desktop app.
- The browser activation callback must only allow localhost loopback URLs.
- Existing email/password activation remains as fallback.

---

### Task 1: Backend Activation Endpoint

**Files:**
- Modify: `server.js`
- Test: `scripts/test-desktop-activation.js`

**Interfaces:**
- Consumes: `req.siteUser`, `siteAuth.requireUser`, `store.setUserHwid(userId, hwid)`, `store.getOrCreateCliKey(userId)`, `store.subscriptionStatus(userId)`, `siteAuth.isOwner(user)`
- Produces: `GET /api/cli/activate?hwid=<id>&callback=http://127.0.0.1:<port>/callback`

- [ ] Write a failing test script that asserts expired users are rejected, first HWID binds, mismatched HWID is rejected, and non-localhost callbacks are rejected.
- [ ] Run `node scripts/test-desktop-activation.js` and confirm it fails because the activation helper/endpoint does not exist.
- [ ] Add a small backend activation helper and route near the existing `/api/cli/login` route.
- [ ] Run `node scripts/test-desktop-activation.js` and confirm it passes.

### Task 2: Desktop Browser Activation

**Files:**
- Modify: `cli/local/control-plane.js`
- Modify: `cli/local/main.js`
- Test: `scripts/test-desktop-activation.js`

**Interfaces:**
- Consumes: `cp.hwid()`, `cp.verifyLicense(key)`, `config.controlPlane.baseUrl`
- Produces: `cp.activateWithWebsite()` returning `{ ok: true, key, account }` or `{ ok: false, reason }`

- [ ] Extend the failing test script to assert the desktop builds the activation URL using `https://r6checker.xyz`, includes `hwid`, and uses a loopback callback.
- [ ] Run the test and confirm it fails because `activateWithWebsite` does not exist.
- [ ] Add a local HTTP callback server, browser opener, activation URL creation, and key capture to `cli/local/control-plane.js`.
- [ ] Update `ensureKey` in `cli/local/main.js` to try website activation first, then fall back to email/password.
- [ ] Run `node scripts/test-desktop-activation.js` and confirm it passes.

### Task 3: Build Verification

**Files:**
- Modify: `cli/dist/R6Checker.exe`

- [ ] Run `node scripts/test-desktop-activation.js`.
- [ ] Run `npm run build` from `cli`.
- [ ] Confirm `cli/dist/R6Checker.exe` is rebuilt successfully.
