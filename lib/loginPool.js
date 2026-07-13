// Login concurrency, dedup, and result caching for high-throughput.
//
// Goals at 100s of concurrent users:
//   • Cap concurrent browser contexts (memory ceiling)
//   • Dedupe parallel logins for the same email (1 browser, N waiters)
//   • Cache fresh sessions/playerData so refreshes don't hit Ubisoft
//
// All exports are pure functions over in-memory maps — no external deps.

const fs = require('fs');
const path = require('path');

// ── Tunables (env-overridable) ─────────────────────────────────────────
const MAX_CONCURRENT_BROWSERS = parseInt(process.env.MAX_BROWSERS || '10', 10);
const SESSION_CACHE_TTL_MS    = parseInt(process.env.SESSION_TTL_MS || String(30 * 60 * 1000), 10); // 30 min
const PLAYER_CACHE_TTL_MS     = parseInt(process.env.PLAYER_TTL_MS  || String(5 * 60 * 1000), 10);  // 5 min

// ── Semaphore: caps concurrent browser-based logins ─────────────────────
let activeBrowsers = 0;
const browserQueue = [];

function acquireBrowserSlot() {
  if (activeBrowsers < MAX_CONCURRENT_BROWSERS) {
    activeBrowsers++;
    return Promise.resolve();
  }
  return new Promise(resolve => browserQueue.push(resolve));
}

function releaseBrowserSlot() {
  activeBrowsers = Math.max(0, activeBrowsers - 1);
  const next = browserQueue.shift();
  if (next) {
    activeBrowsers++;
    next();
  }
}

function browserPoolStats() {
  return { active: activeBrowsers, waiting: browserQueue.length, max: MAX_CONCURRENT_BROWSERS };
}

// ── Per-email login dedup ───────────────────────────────────────────────
// If user A clicks "Login" 3 times in 2 seconds, we run ONE login and
// fan out the result to all 3 callers.
const inflightLogins = new Map(); // email -> Promise<sessionResult>

async function dedupedLogin(email, runLogin) {
  const key = email.toLowerCase();
  const existing = inflightLogins.get(key);
  if (existing) {
    console.log(`[pool] Deduping login for ${key} — ${inflightLogins.size} inflight`);
    return existing;
  }
  const promise = (async () => {
    try { return await runLogin(); }
    finally { inflightLogins.delete(key); }
  })();
  inflightLogins.set(key, promise);
  return promise;
}

// ── Session cache: ticket+sessionId+userId per user ────────────────────
// Survives within a single process. Lets repeat fetches skip re-login entirely.
const sessionCache = new Map(); // email -> { session, expiresAt }
const sessionByUserId = new Map(); // userId -> email (reverse lookup for refresh)

function cacheSession(email, session) {
  if (!email || !session?.ticket) return;
  sessionCache.set(email.toLowerCase(), {
    session,
    expiresAt: Date.now() + SESSION_CACHE_TTL_MS,
  });
  // Reverse index by Ubisoft userId so refresh-by-profile-URL can find creds
  if (session.userId) sessionByUserId.set(session.userId, email.toLowerCase());
}

function getCachedSession(email) {
  if (!email) return null;
  const entry = sessionCache.get(email.toLowerCase());
  if (!entry) return null;
  if (Date.now() >= entry.expiresAt) {
    sessionCache.delete(email.toLowerCase());
    return null;
  }
  return entry.session;
}

// Lookup a cached Ubisoft session by the player's userId (used by /api/refresh)
function getCachedSessionByUserId(userId) {
  if (!userId) return null;
  const email = sessionByUserId.get(userId);
  if (!email) return null;
  return getCachedSession(email);
}

function invalidateSession(email) {
  if (email) {
    const entry = sessionCache.get(email.toLowerCase());
    if (entry?.session?.userId) sessionByUserId.delete(entry.session.userId);
    sessionCache.delete(email.toLowerCase());
  }
}

// ── Player data cache: full /api/player response per userId ────────────
// Same UI refresh within TTL serves from memory — zero Ubisoft calls.
const playerCache = new Map(); // userId -> { data, expiresAt }

function cachePlayerData(userId, data) {
  if (!userId || !data) return;
  playerCache.set(userId, {
    data,
    expiresAt: Date.now() + PLAYER_CACHE_TTL_MS,
  });
}

function getCachedPlayerData(userId) {
  if (!userId) return null;
  const entry = playerCache.get(userId);
  if (!entry) return null;
  if (Date.now() >= entry.expiresAt) {
    playerCache.delete(userId);
    return null;
  }
  return entry.data;
}

function invalidatePlayerData(userId) {
  if (userId) playerCache.delete(userId);
}

// ── Periodic eviction ──────────────────────────────────────────────────
setInterval(() => {
  const now = Date.now();
  let evicted = 0;
  for (const [k, v] of sessionCache) if (v.expiresAt < now) { sessionCache.delete(k); evicted++; }
  for (const [k, v] of playerCache)  if (v.expiresAt < now) { playerCache.delete(k);  evicted++; }
  if (evicted > 0) console.log(`[pool] Evicted ${evicted} expired cache entries`);
}, 60 * 1000).unref();

module.exports = {
  acquireBrowserSlot,
  releaseBrowserSlot,
  browserPoolStats,
  dedupedLogin,
  cacheSession,
  getCachedSession,
  getCachedSessionByUserId,
  invalidateSession,
  cachePlayerData,
  getCachedPlayerData,
  invalidatePlayerData,
  MAX_CONCURRENT_BROWSERS,
  SESSION_CACHE_TTL_MS,
  PLAYER_CACHE_TTL_MS,
};
