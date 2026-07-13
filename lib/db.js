// Simple JSON-file database for profile-check history.
// Append-only log of every successful /api/login → playerData fetch.
// Storage: .cache/checks.json — single file, atomic writes, no native deps.

const fs   = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', '.cache', 'checks.json');
try { fs.mkdirSync(path.dirname(DB_PATH), { recursive: true }); } catch {}

let cache = null;
let writeQueued = false;

function load() {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    if (!Array.isArray(cache.checks)) cache.checks = [];
    if (typeof cache.totalChecks !== 'number') cache.totalChecks = cache.checks.length;
  } catch {
    cache = { totalChecks: 0, checks: [] };
  }
  return cache;
}

function persistSoon() {
  if (writeQueued) return;
  writeQueued = true;
  setImmediate(() => {
    writeQueued = false;
    try {
      const tmp = DB_PATH + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(cache));
      fs.renameSync(tmp, DB_PATH);
    } catch (e) {
      console.warn('[db] persist failed:', e.message);
    }
  });
}

// Record a profile check. Idempotent per userId (latest data wins).
function recordCheck({ userId, username, avatar, level, currentRank, currentMmr, checkedBy, sectionsCount, itemsCount }) {
  if (!userId) return;
  const db = load();
  const now = Date.now();

  // De-dupe by userId — keep latest entry, increment its checkCount
  const idx = db.checks.findIndex(c => c.userId === userId);
  if (idx >= 0) {
    const prev = db.checks[idx];
    db.checks[idx] = {
      ...prev,
      username: username || prev.username,
      avatar:   avatar   || prev.avatar,
      level:    level    ?? prev.level,
      currentRank: currentRank ?? prev.currentRank,
      currentMmr:  currentMmr  ?? prev.currentMmr,
      sectionsCount: sectionsCount ?? prev.sectionsCount,
      itemsCount:    itemsCount    ?? prev.itemsCount,
      lastCheckedAt: now,
      checkCount: (prev.checkCount || 1) + 1,
      // Attach the latest "checked by" Discord user (overwrites previous)
      checkedBy: checkedBy || prev.checkedBy || null,
    };
  } else {
    db.checks.unshift({
      userId, username, avatar, level, currentRank, currentMmr,
      sectionsCount, itemsCount,
      firstCheckedAt: now, lastCheckedAt: now, checkCount: 1,
      checkedBy: checkedBy || null,
    });
  }
  db.totalChecks++;          // total includes re-checks
  if (db.checks.length > 1000) db.checks.length = 1000;  // cap stored history
  persistSoon();
}

// Comma-separated list of userIds OR usernames to hide from public "recent" list.
const HIDE_FROM_RECENT = (process.env.HIDE_FROM_RECENT || '')
  .split(',')
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);

function recentChecks(limit = 20) {
  const db = load();
  return db.checks
    .filter(c => !HIDE_FROM_RECENT.includes((c.userId || '').toLowerCase())
              && !HIDE_FROM_RECENT.includes((c.username || '').toLowerCase()))
    .sort((a, b) => b.lastCheckedAt - a.lastCheckedAt)
    .slice(0, limit)
    .map(c => ({
      userId: c.userId,
      username: c.username,
      avatar: c.avatar,
      level: c.level,
      currentRank: c.currentRank,
      currentMmr: c.currentMmr,
      itemsCount: c.itemsCount,
      checkCount: c.checkCount,
      lastCheckedAt: c.lastCheckedAt,
      checkedBy: c.checkedBy ? {
        username: c.checkedBy.username,
        avatar:   c.checkedBy.avatar,
        id:       c.checkedBy.id,
      } : null,
    }));
}

function stats() {
  const db = load();
  const visible = db.checks.filter(c =>
    !HIDE_FROM_RECENT.includes((c.userId || '').toLowerCase())
    && !HIDE_FROM_RECENT.includes((c.username || '').toLowerCase())
  );
  const uniqueAccounts = visible.length;
  const totalChecks    = visible.reduce((sum, c) => sum + (c.checkCount || 1), 0);
  const last24h = visible.filter(c => Date.now() - c.lastCheckedAt < 86400_000).length;
  const last7d  = visible.filter(c => Date.now() - c.lastCheckedAt < 7 * 86400_000).length;
  return { uniqueAccounts, totalChecks, last24h, last7d };
}

function getCheck(userId) {
  if (!userId) return null;
  const db = load();
  const c = db.checks.find(x => x.userId === userId);
  if (!c) return null;
  return {
    userId: c.userId, username: c.username, avatar: c.avatar,
    level: c.level, currentRank: c.currentRank, currentMmr: c.currentMmr,
    itemsCount: c.itemsCount, checkCount: c.checkCount,
    lastCheckedAt: c.lastCheckedAt,
    checkedBy: c.checkedBy ? { username: c.checkedBy.username, avatar: c.checkedBy.avatar, id: c.checkedBy.id } : null,
  };
}

module.exports = { recordCheck, recentChecks, stats, getCheck };
