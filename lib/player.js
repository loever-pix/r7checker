const fs    = require('fs');
const path  = require('path');
const axios = require('axios');
const { BASE_HEADERS, getR6Session, getRankSession } = require('./auth');
const { ubiRequest } = require('./api');
const { proxiedRequest, isProxyEnabled, isAnyRotationEnabled } = require('./proxyClient');
const marketplace = require('./marketplace'); // itemId -> official skin image (cached catalog)
const { YEAR_SEASON_TO_NUM, SEASON_CHAMPION, SEASON_EMERALD, SEASON_NAMES } = require('./rankedSeasons');
// All external (non-Ubisoft) HTTP calls go through this � uses proxy if enabled
const http = (config) => isAnyRotationEnabled() ? proxiedRequest(config) : axios(config);

// r6data.com � third-party API for historical season ranks and item names
const R6DATA_KEY  = process.env.R6DATA_KEY || '';  // REDACTED for public distribution — see .env.example
const R6DATA_BASE = 'https://api.r6data.com/api';

// Reverse: season name �  number (for r6data responses that use season names)
const SEASON_NAME_TO_NUM = /** @type {Record<string,number>} */ ({});
// Populated below once SEASON_NAMES is defined

const CACHE_DIR = process.env.CACHE_DIR || path.join(__dirname, '..', '.cache');
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// Verbose per-account inventory/charm/currency dumps. OFF by default: at bulk
// scale (100k+ checks) these per-item log lines ballooned server.log to multiple
// GB (a real disk-fill + I/O drag on every check). Flip R6_DEBUG_INVENTORY=1
// (or R6_DEBUG=1) to restore them for a single interactive investigation.
const DEBUG_INV = process.env.R6_DEBUG_INVENTORY === '1' || process.env.R6_DEBUG === '1';
const dbg = (...a) => { if (DEBUG_INV) console.log(...a); };

function getCachePath(userId) {
  return path.join(CACHE_DIR, `${userId}.json`);
}

// Strip ghost-tagged season ranks from cached data. Caches written before the
// ghost-skip fix still hold xbl/psn ranks marked {ghost:true} that we must NOT
// display — they belong to a previously-linked-but-unlinked console. Mutates
// in place; safe to call on any data shape.
function stripGhostsInPlace(data) {
  if (data && Array.isArray(data.seasonRanks)) data.seasonRanks = data.seasonRanks.filter(r => !r.ghost);
  if (data && data.linkedSeasons && typeof data.linkedSeasons === 'object') {
    for (const k of Object.keys(data.linkedSeasons)) {
      const arr = data.linkedSeasons[k];
      if (Array.isArray(arr)) data.linkedSeasons[k] = arr.filter(r => !r.ghost);
    }
  }
  return data;
}

function readCache(userId) {
  try {
    const p = getCachePath(userId);
    if (!fs.existsSync(p)) return null;
    const { ts, data } = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (Date.now() - ts > CACHE_TTL_MS) return null;
    console.log(`Cache hit for ${userId} (expires in ${Math.round((CACHE_TTL_MS - (Date.now() - ts)) / 3600000)}h)`);
    return stripGhostsInPlace(data);
  } catch { return null; }
}

function writeCache(userId, data) {
  try {
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(getCachePath(userId), JSON.stringify({ ts: Date.now(), data }));
  } catch (e) { console.warn('Cache write failed:', e.message); }
}

// Prune profile-cache entries not refreshed in the last 2 days. A file's mtime
// is bumped every time the account is (re)checked, so mtime == last-checked.
// Anything older is deleted → the public /profile page goes 404 for accounts
// not seen in 2 days, and disk stays lean. Runs on boot + every 6h.
const PROFILE_PRUNE_MS = Number(process.env.PROFILE_PRUNE_MS) || 2 * 24 * 60 * 60 * 1000;
function pruneProfileCache() {
  try {
    const now = Date.now();
    let removed = 0;
    for (const f of fs.readdirSync(CACHE_DIR)) {
      if (!/^[0-9a-f-]{36}\.json$/i.test(f)) continue;   // only {uuid}.json profile caches
      const fp = path.join(CACHE_DIR, f);
      try { if (now - fs.statSync(fp).mtimeMs > PROFILE_PRUNE_MS) { fs.unlinkSync(fp); removed++; } } catch {}
    }
    if (removed) console.log(`[player] pruned ${removed} profile-cache entries older than ${Math.round(PROFILE_PRUNE_MS / 3600000)}h`);
  } catch (e) { console.warn('[player] profile-cache prune failed:', e.message); }
}
setTimeout(pruneProfileCache, 30_000).unref();
setInterval(pruneProfileCache, 6 * 60 * 60 * 1000).unref();

// Read the cached data IGNORING TTL — used only to preserve previously-known
// data when a fresh fetch came back degraded (see preserveFromCache).
function readCacheRaw(userId) {
  try {
    const p = getCachePath(userId);
    if (!fs.existsSync(p)) return null;
    return stripGhostsInPlace(JSON.parse(fs.readFileSync(p, 'utf8'))?.data ?? null);
  } catch { return null; }
}

// Union season ranks by season number; the FRESH entry wins for a season it
// actually returned, while seasons only present in the old cache are kept (so
// history is never lost). Sorted newest-season-first.
function mergeSeasonRanks(oldArr, newArr) {
  const bySeason = new Map();
  for (const e of (oldArr || [])) if (e && e.season != null) bySeason.set(e.season, e);
  for (const e of (newArr || [])) if (e && e.season != null) bySeason.set(e.season, e);
  const merged = [...bySeason.values()];
  for (const e of (newArr || [])) if (e && e.season == null) merged.push(e);
  merged.sort((a, b) => (b.season ?? 0) - (a.season ?? 0));
  return merged;
}

// NEVER WIPE: a degraded re-fetch (e.g. proxy/tracker outage) must not blank
// out data we already had. Mutates `data` in place, restoring/merging any
// field that came back empty from the previous good cache for this user.
function preserveFromCache(userId, data) {
  const prev = readCacheRaw(userId);
  if (!prev) return data;
  // Season ranks: merge so fresh seasons update, old seasons survive, and an
  // empty fetch keeps the full prior history (the reported "rank wipe").
  // CRITICAL: drop any ghost-tagged entries from the cached prev data before
  // merging — caches written BEFORE the ghost-skip fix contain ghost ranks
  // tagged {ghost:true} that would otherwise leak right back into the fresh
  // result (the trashgang799 Diamond/Emerald regression).
  if (Array.isArray(prev.seasonRanks) && prev.seasonRanks.length) {
    const prevClean = prev.seasonRanks.filter(r => !r.ghost);
    data.seasonRanks = (data.seasonRanks && data.seasonRanks.length)
      ? mergeSeasonRanks(prevClean, data.seasonRanks)
      : prevClean;
  }
  // Inventory sections: only restore when the fresh fetch returned NONE (a
  // failed inventory pull) — a real fetch with items wins.
  if (Array.isArray(prev.sections) && prev.sections.length && !(data.sections && data.sections.length)) {
    data.sections = prev.sections;
  }
  // Enrichment that's expensive/flaky to fetch — keep prior when newly missing.
  if (prev.trackerStats && !data.trackerStats) data.trackerStats = prev.trackerStats;
  if (Array.isArray(prev.linkedConsoles) && prev.linkedConsoles.length && !(data.linkedConsoles && data.linkedConsoles.length)) {
    data.linkedConsoles = prev.linkedConsoles;
  }
  return data;
}

const PC_SPACE_ID   = '5172a557-50b5-4665-b7db-e3f2e8c5041d';
const PC_SANDBOX_ID = 'OSBOR_PC_LNCH_A';
const GENOME_ID     = '85c31714-0941-4876-a18d-2c7e9dce8d40';

// Static item catalog: id �  { name, category }
// Sourced from github.com/simpsonresearch/Siege_Skin_Checker
let ITEM_CATALOG = null;
function getItemCatalog() {
  if (ITEM_CATALOG) return ITEM_CATALOG;
  try {
    const raw = require('./r6-catalog.json');
    ITEM_CATALOG = {};
    for (const item of raw.items) ITEM_CATALOG[item.id] = item;
  } catch { ITEM_CATALOG = {}; }
  return ITEM_CATALOG;
}

// Extract the App ID that the token was issued to from its JWE header segment.
// Ubisoft returns 404 (not 401) when Ubi-AppId doesn't match the token's aid field.
function extractAppIdFromToken(ticket) {
  try {
    const header = ticket.split('.')[0];
    // JWE headers are base64url encoded � pad and decode
    const padded = header + '='.repeat((4 - header.length % 4) % 4);
    const json = Buffer.from(padded, 'base64').toString('utf8');
    return JSON.parse(json).aid || '';
  } catch { return ''; }
}

function authHeaders(ticket, sessionId, appId) {
  const resolvedAppId = appId || extractAppIdFromToken(ticket) || BASE_HEADERS['Ubi-AppId'];
  return {
    ...BASE_HEADERS,
    'Ubi-AppId': resolvedAppId,
    Authorization: `Ubi_v1 t=${ticket}`,
    'Ubi-SessionId': sessionId,
  };
}

function inventoryHeaders(ticket, sessionId, appId) {
  return {
    ...authHeaders(ticket, sessionId, appId),
    'GenomeId': GENOME_ID,
    'Ubi-LocaleCode': 'en-US',
    'Ubi-RequestedPlatformType': 'uplay',  // required � Siege_Skin_Checker sends this
  };
}

// V6 rank table (Solar Raid / Season 28 onwards)
// Switching to PNG assets � same slugs as SVGs except champion uses "champions" (not "champions_1")
const RANK_ICON_CDN = 'https://cdn.jsdelivr.net/gh/danielwerg/r6data@master/src/assets/ranks/v3/pngs/';

// r6data.com rank image CDN � webp images for each rank
const R6DATA_RANK_IMG = 'https://r6data.com/assets/img/r6_ranks_img/';

// Ranked 3.0 badge art (the current redesign) — same source the rank cards use
// via tracker.gg metadata. Keyed by our r6slug (e.g. 'platinum-5', 'champion').
const RANK_ICON_3_0 = 'https://trackercdn.com/cdn/r6.tracker.network/ranks/3.0/medium/';

const RANKS_V6 = [
  { id:  0, name: 'Unranked',   tier: 'unranked',  slug: 'unranked',       r6slug: 'unranked'   },
  { id:  1, name: 'Copper 5',   tier: 'copper',    slug: 'copper_5',       r6slug: 'copper-5'   },
  { id:  2, name: 'Copper 4',   tier: 'copper',    slug: 'copper_4',       r6slug: 'copper-4'   },
  { id:  3, name: 'Copper 3',   tier: 'copper',    slug: 'copper_3',       r6slug: 'copper-3'   },
  { id:  4, name: 'Copper 2',   tier: 'copper',    slug: 'copper_2',       r6slug: 'copper-2'   },
  { id:  5, name: 'Copper 1',   tier: 'copper',    slug: 'copper_1',       r6slug: 'copper-1'   },
  { id:  6, name: 'Bronze 5',   tier: 'bronze',    slug: 'bronze_5',       r6slug: 'bronze-5'   },
  { id:  7, name: 'Bronze 4',   tier: 'bronze',    slug: 'bronze_4',       r6slug: 'bronze-4'   },
  { id:  8, name: 'Bronze 3',   tier: 'bronze',    slug: 'bronze_3',       r6slug: 'bronze-3'   },
  { id:  9, name: 'Bronze 2',   tier: 'bronze',    slug: 'bronze_2',       r6slug: 'bronze-2'   },
  { id: 10, name: 'Bronze 1',   tier: 'bronze',    slug: 'bronze_1',       r6slug: 'bronze-1'   },
  { id: 11, name: 'Silver 5',   tier: 'silver',    slug: 'silver_5',       r6slug: 'silver-5'   },
  { id: 12, name: 'Silver 4',   tier: 'silver',    slug: 'silver_4',       r6slug: 'silver-4'   },
  { id: 13, name: 'Silver 3',   tier: 'silver',    slug: 'silver_3',       r6slug: 'silver-3'   },
  { id: 14, name: 'Silver 2',   tier: 'silver',    slug: 'silver_2',       r6slug: 'silver-2'   },
  { id: 15, name: 'Silver 1',   tier: 'silver',    slug: 'silver_1',       r6slug: 'silver-1'   },
  { id: 16, name: 'Gold 5',     tier: 'gold',      slug: 'gold_5',         r6slug: 'gold-5'     },
  { id: 17, name: 'Gold 4',     tier: 'gold',      slug: 'gold_4',         r6slug: 'gold-4'     },
  { id: 18, name: 'Gold 3',     tier: 'gold',      slug: 'gold_3',         r6slug: 'gold-3'     },
  { id: 19, name: 'Gold 2',     tier: 'gold',      slug: 'gold_2',         r6slug: 'gold-2'     },
  { id: 20, name: 'Gold 1',     tier: 'gold',      slug: 'gold_1',         r6slug: 'gold-1'     },
  { id: 21, name: 'Platinum 5', tier: 'platinum',  slug: 'platinum_5_v2',  r6slug: 'platinum-5' },
  { id: 22, name: 'Platinum 4', tier: 'platinum',  slug: 'platinum_4_v2',  r6slug: 'platinum-4' },
  { id: 23, name: 'Platinum 3', tier: 'platinum',  slug: 'platinum_3_v2',  r6slug: 'platinum-3' },
  { id: 24, name: 'Platinum 2', tier: 'platinum',  slug: 'platinum_2_v2',  r6slug: 'platinum-2' },
  { id: 25, name: 'Platinum 1', tier: 'platinum',  slug: 'platinum_1_v2',  r6slug: 'platinum-1' },
  { id: 26, name: 'Emerald 5',  tier: 'emerald',   slug: 'emerald_5',      r6slug: 'emerald-5'  },
  { id: 27, name: 'Emerald 4',  tier: 'emerald',   slug: 'emerald_4',      r6slug: 'emerald-4'  },
  { id: 28, name: 'Emerald 3',  tier: 'emerald',   slug: 'emerald_3',      r6slug: 'emerald-3'  },
  { id: 29, name: 'Emerald 2',  tier: 'emerald',   slug: 'emerald_2',      r6slug: 'emerald-2'  },
  { id: 30, name: 'Emerald 1',  tier: 'emerald',   slug: 'emerald_1',      r6slug: 'emerald-1'  },
  { id: 31, name: 'Diamond 5',  tier: 'diamond',   slug: 'diamond_5_v2',   r6slug: 'diamond-5'  },
  { id: 32, name: 'Diamond 4',  tier: 'diamond',   slug: 'diamond_4_v2',   r6slug: 'diamond-4'  },
  { id: 33, name: 'Diamond 3',  tier: 'diamond',   slug: 'diamond_3_v2',   r6slug: 'diamond-3'  },
  { id: 34, name: 'Diamond 2',  tier: 'diamond',   slug: 'diamond_2_v2',   r6slug: 'diamond-2'  },
  { id: 35, name: 'Diamond 1',  tier: 'diamond',   slug: 'diamond_1_v2',   r6slug: 'diamond-1'  },
  { id: 36, name: 'Champion',   tier: 'champion',  slug: 'champions',      r6slug: 'champion'   },
];

function getRankV6(rankId) {
  return RANKS_V6[rankId] ?? RANKS_V6[0];
}

// Ranked 2.0 RP thresholds (Y10S1+ / season 37+)
// Each entry: [minRP, rankId]  � sorted ascending so we can binary-scan.
// Ranked 2.0 RP thresholds � sourced from r6data.com /api/ranks?version=v6
const RP_THRESHOLDS = [
  [    0,  0], // Unranked (0-999)
  [ 1000,  1], // Copper 5
  [ 1100,  2], // Copper 4
  [ 1200,  3], // Copper 3
  [ 1300,  4], // Copper 2
  [ 1400,  5], // Copper 1
  [ 1500,  6], // Bronze 5
  [ 1600,  7], // Bronze 4
  [ 1700,  8], // Bronze 3
  [ 1800,  9], // Bronze 2
  [ 1900, 10], // Bronze 1
  [ 2000, 11], // Silver 5
  [ 2100, 12], // Silver 4
  [ 2200, 13], // Silver 3
  [ 2300, 14], // Silver 2
  [ 2400, 15], // Silver 1
  [ 2500, 16], // Gold 5
  [ 2600, 17], // Gold 4
  [ 2700, 18], // Gold 3
  [ 2800, 19], // Gold 2
  [ 2900, 20], // Gold 1
  [ 3000, 21], // Platinum 5
  [ 3100, 22], // Platinum 4
  [ 3200, 23], // Platinum 3
  [ 3300, 24], // Platinum 2
  [ 3400, 25], // Platinum 1
  [ 3500, 26], // Emerald 5
  [ 3600, 27], // Emerald 4
  [ 3700, 28], // Emerald 3
  [ 3800, 29], // Emerald 2
  [ 3900, 30], // Emerald 1
  [ 4000, 31], // Diamond 5
  [ 4100, 32], // Diamond 4
  [ 4200, 33], // Diamond 3
  [ 4300, 34], // Diamond 2
  [ 4400, 35], // Diamond 1
  [ 4500, 36], // Champion
];

function rpToRankId(rp) {
  if (!rp || rp <= 0) return 0;
  let rankId = 0;
  for (const [threshold, id] of RP_THRESHOLDS) {
    if (rp >= threshold) rankId = id;
    else break;
  }
  return rankId;
}

// ── Season-aware rank brackets ──────────────────────────────────────────────
// R6 added tiers mid-history AND reworked the brackets several times. Using one
// current-era table for every season wrongly showed Emerald/Champion in seasons
// that predate them:
//   • Champion arrived Y4S3 (season 15) — none before that (top tier = Diamond).
//   • Emerald  arrived Y7S4 (season 28) — none before that.
// RP_THRESHOLDS above already encodes the modern (Solar Raid+, season 28+) RP
// table, so it stays the source of truth for season >= 28. For older seasons we
// re-derive the tier from that season's MMR using the era-correct table below.
// Tables are ascending [minPoints, name, tier]; scan upward, last match wins.
// Set A — Ranked 1.0 pre-Champion (seasons 1–14): top tier Diamond 4500+.
const ERA_1_PRECHAMP = [
  [1,'Copper 5','copper'],[1300,'Copper 4','copper'],[1400,'Copper 3','copper'],[1500,'Copper 2','copper'],[1600,'Copper 1','copper'],
  [1700,'Bronze 4','bronze'],[1800,'Bronze 3','bronze'],[1900,'Bronze 2','bronze'],[2000,'Bronze 1','bronze'],
  [2100,'Silver 4','silver'],[2200,'Silver 3','silver'],[2300,'Silver 2','silver'],[2400,'Silver 1','silver'],
  [2500,'Gold 4','gold'],[2700,'Gold 3','gold'],[2900,'Gold 2','gold'],[3100,'Gold 1','gold'],
  [3300,'Platinum 3','platinum'],[3700,'Platinum 2','platinum'],[4100,'Platinum 1','platinum'],
  [4500,'Diamond','diamond'],
];
// Set B — Champion era, pre-Emerald (seasons 15–27): Champion 5000+, Diamond 4400+.
const ERA_CHAMP_NOEMERALD = [
  [1,'Copper 5','copper'],[1200,'Copper 4','copper'],[1300,'Copper 3','copper'],[1400,'Copper 2','copper'],[1500,'Copper 1','copper'],
  [1600,'Bronze 5','bronze'],[1700,'Bronze 4','bronze'],[1800,'Bronze 3','bronze'],[1900,'Bronze 2','bronze'],[2000,'Bronze 1','bronze'],
  [2100,'Silver 5','silver'],[2200,'Silver 4','silver'],[2300,'Silver 3','silver'],[2400,'Silver 2','silver'],[2500,'Silver 1','silver'],
  [2600,'Gold 3','gold'],[2800,'Gold 2','gold'],[3000,'Gold 1','gold'],
  [3200,'Platinum 3','platinum'],[3600,'Platinum 2','platinum'],[4000,'Platinum 1','platinum'],
  [4400,'Diamond','diamond'],[5000,'Champion','champion'],
];

function eraRankFromPoints(table, pts) {
  let out = table[0];
  for (const row of table) { if (pts >= row[0]) out = row; else break; }
  return { name: out[1], tier: out[2] };
}

// Resolve a {name,tier} back to a RANKS_V6-shaped entry so slug/icon URLs work.
function v6FromNameTier(name, tier) {
  return RANKS_V6.find(r => r.name === name) || RANKS_V6.find(r => r.tier === tier) || RANKS_V6[0];
}

// Era-correct a derived rank for its season. `def` is the current-era info we
// computed; returns a RANKS_V6-shaped entry that reflects the tiers that existed
// in that season. Modern seasons (>= 28) pass through unchanged.
function eraCorrectRank(season, points, def) {
  const s = Number(season);
  if (!s || s >= SEASON_EMERALD) return def;
  const pts = Number(points) || 0;
  const table = s >= SEASON_CHAMPION ? ERA_CHAMP_NOEMERALD : ERA_1_PRECHAMP;
  if (pts > 0) { const e = eraRankFromPoints(table, pts); return v6FromNameTier(e.name, e.tier); }
  // No usable points — just demote tiers that didn't exist yet in this season.
  let { name, tier } = def;
  if (tier === 'emerald') { name = 'Diamond'; tier = 'diamond'; }
  if (s < SEASON_CHAMPION && tier === 'champion') { name = 'Diamond'; tier = 'diamond'; }
  return v6FromNameTier(name, tier);
}

// Legacy table for old seasons still returned by some endpoints
const RANK_NAMES_LEGACY = [
  'Unranked',
  'Copper V','Copper IV','Copper III','Copper II','Copper I',
  'Bronze V','Bronze IV','Bronze III','Bronze II','Bronze I',
  'Silver V','Silver IV','Silver III','Silver II','Silver I',
  'Gold V','Gold IV','Gold III','Gold II','Gold I',
  'Platinum V','Platinum IV','Platinum III','Platinum II','Platinum I',
  'Emerald V','Emerald IV','Emerald III','Emerald II','Emerald I',
  'Diamond V','Diamond IV','Diamond III','Diamond II','Diamond I',
  'Champion',
];

function getRankTier(rankName) {
  if (!rankName || rankName === 'Unranked') return 'unranked';
  const lower = rankName.toLowerCase();
  if (lower.startsWith('champion')) return 'champion';
  if (lower.startsWith('diamond'))  return 'diamond';
  if (lower.startsWith('emerald'))  return 'emerald';
  if (lower.startsWith('platinum')) return 'platinum';
  if (lower.startsWith('gold'))     return 'gold';
  if (lower.startsWith('silver'))   return 'silver';
  if (lower.startsWith('bronze'))   return 'bronze';
  if (lower.startsWith('copper'))   return 'copper';
  return 'unranked';
}

// Populate the reverse map now that SEASON_NAMES is defined
for (const [num, name] of Object.entries(SEASON_NAMES)) {
  SEASON_NAME_TO_NUM[name.toLowerCase()] = Number(num);
}

// New crossplay space ID used by the skill/full_profiles endpoint (Y8+)
const CROSSPLAY_SPACE_ID = '0d2ae42d-4c27-4cb7-af6c-2099062302bb';

async function getProfile(userId, ticket, sessionId, appId) {
  const headers = authHeaders(ticket, sessionId, appId);

  // Sequential to respect the global rate limiter in api.js
  const profileRes = await ubiRequest({ method: 'get', url: `https://public-ubiservices.ubi.com/v2/profiles?userId=${userId}`, headers });

  // Level: fetched later in fetchAndCache via statscard endpoint (requires rank session token)
  const level = 0;

  const linksRes = await ubiRequest({ method: 'get', url: `https://public-ubiservices.ubi.com/v3/users/${userId}/profiles`, headers });

  // initialProfiles keeps the ORIGINAL console links (psn/xbl) even after a
  // platform is unlinked — /v2 and /v3 both drop them, so this is the only
  // endpoint that still reveals a previously-linked PSN/Xbox. Best-effort.
  let initialProfilesList = [];
  try {
    const initRes = await ubiRequest({ method: 'get', url: `https://public-ubiservices.ubi.com/v3/users/${userId}/initialProfiles`, headers, validateStatus: () => true });
    if (initRes?.status === 200) initialProfilesList = initRes.data?.profiles ?? [];
  } catch { /* best-effort — never block the profile on this */ }

  const allProfiles     = profileRes.data.profiles ?? [];
  const linkedProfiles  = linksRes.data.profiles ?? [];
  const linkedPlatforms = linkedProfiles.map(p => p.platformType);
  // Per-platform username + profileId so the UI can build tracker.network
  // deep-links (e.g. https://r6.tracker.network/r6/profile/xbl/Gamertag).
  const mapAccount = (p, ghost) => ({
    platform:  p.platformType,                 // uplay | steam | xbl | psn
    username:  p.nameOnPlatform || '',
    profileId: p.profileId || '',
    idOnPlatform: p.idOnPlatform || '',         // steamId / xuid / etc.
    ghost,
  });
  const linkedAccounts  = linkedProfiles.map(p => mapAccount(p, false));

  // ── Ubisoft-driven Ghost detection ────────────────────────────────────
  // CURRENTLY linked = /v3/users/{id}/profiles. A platform that appears in
  // /v2 (all associations on file) OR in initialProfiles (original console
  // links) but NOT in /v3 was linked once and later unlinked → a "Ghost".
  // initialProfiles is essential: Ubisoft eventually purges a fully-unlinked
  // PSN from /v2 too, but it stays in initialProfiles.
  const linkedTypes = new Set(linkedProfiles.map(p => p.platformType));
  const ghostSeen = new Set();
  const ghostAccounts = [];
  for (const p of [...allProfiles, ...initialProfilesList]) {
    if (!p.platformType || linkedTypes.has(p.platformType)) continue;
    const key = `${p.platformType}:${p.profileId || p.idOnPlatform || p.nameOnPlatform || ''}`;
    if (ghostSeen.has(key)) continue;
    ghostSeen.add(key);
    ghostAccounts.push(mapAccount(p, true));
  }
  for (const g of ghostAccounts) {
    console.log(`[profile] Ghost (was-linked) ${g.platform}: ${g.username}`);
    linkedAccounts.push(g);
  }

  // Prefer the uplay (PC) profile � inventory and game endpoints use its profileId
  const uplayProfile = allProfiles.find(p => p.platformType === 'uplay')
    ?? linkedProfiles.find(p => p.platformType === 'uplay')
    ?? allProfiles[0]
    ?? {};

  const profileId = uplayProfile.profileId ?? userId;
  console.log(`Profile: userId=${userId} uplayProfileId=${profileId} username=${uplayProfile.nameOnPlatform ?? '?'}`);

  // Cache-bust avatar once per day � Ubisoft updates these and we'd serve stale otherwise
  const avatarBust = Math.floor(Date.now() / (60 * 60 * 1000)); // hourly
  const avatarRaw = `https://ubisoft-avatars.akamaized.net/${userId}/default_146_146.png?v=${avatarBust}`;
  return {
    userId,
    profileId,
    username: uplayProfile.nameOnPlatform ?? '',
    avatar: proxyImage(avatarRaw) ?? avatarRaw,
    level,
    renown: 0,
    credits: 0,
    linkedPlatforms,
    linkedAccounts,
  };
}

// Parse one skill/full_profiles API response into rank entries.
// seasonIdHint is used as a fallback if p.season_id is missing.
// Captures BOTH peak (max_rank_points) AND current (rank_points) separately.
function parseRankResponse(data, seasonIdHint) {
  const entries = [];
  const platformFamilies = data?.platform_families_full_profiles ?? [];
  for (const pf of platformFamilies) {
    for (const board of pf.board_ids_full_profiles ?? []) {
      if (board.board_id !== 'ranked') continue;
      for (const entry of board.full_profiles ?? []) {
        const p = entry.profile;
        if (!p) continue;

        // PEAK � what they reached at their highest
        const peakMmr  = p.max_rank_points ?? p.rank_points ?? 0;
        // Derive from RP when Ubisoft omits the rank id but reports RP (Ranked
        // 3.0 reset) so a ranked player is never dropped as "no rank".
        const peakRankId = (p.max_rank && p.max_rank > 0) ? p.max_rank
                         : (p.rank && p.rank > 0) ? p.rank
                         : rpToRankId(peakMmr);
        if (!peakRankId) continue;
        const _season = p.season_id ?? seasonIdHint;
        // Era-correct: remap to the tiers that actually existed this season (no
        // Emerald before S28, no Champion before S15) from the season's own MMR.
        const peakInfo = eraCorrectRank(_season, peakMmr, getRankV6(peakRankId));

        // CURRENT � where they sit right now (may differ from peak)
        const curRP   = p.rank_points ?? peakMmr;
        const curRankIdFromAPI = p.rank ?? 0;
        // Prefer the rank ID Ubisoft computed; fall back to deriving from RP
        const curRankId = curRankIdFromAPI > 0 ? curRankIdFromAPI : rpToRankId(curRP);
        const curInfo = eraCorrectRank(_season, curRP, curRankId > 0 ? getRankV6(curRankId) : peakInfo);

        const rawChampPos = p.top_rank_position ?? p.topRankPosition ??
                            p.global_ranking ?? p.globalRanking ??
                            p.champion_rank ?? p.championRank ??
                            p.rank_position ?? p.rankPosition ??
                            p.position ?? null;
        const champPosition = (rawChampPos && rawChampPos > 0) ? rawChampPos : null;

        const peakIconUrl = proxyImage(`${R6DATA_RANK_IMG}${peakInfo.r6slug}.webp`)
                          ?? `${RANK_ICON_CDN}${peakInfo.slug}.png`;
        const curIconUrl  = curRankId > 0
          ? (proxyImage(`${R6DATA_RANK_IMG}${curInfo.r6slug}.webp`)
             ?? `${RANK_ICON_CDN}${curInfo.slug}.png`)
          : peakIconUrl;

        entries.push({
          season:     p.season_id ?? seasonIdHint,
          seasonName: SEASON_NAMES[p.season_id ?? seasonIdHint] ?? `Season ${p.season_id ?? seasonIdHint}`,
          // Peak goes into the standard fields (for all-time list)
          rank:       peakRankId,
          rankName:   peakInfo.name,
          rankTier:   peakInfo.tier,
          mmr:        peakMmr,
          iconUrl:    peakIconUrl,
          // Current goes into separate fields (for "Current Rank" card)
          currentRank:     curRankId,
          currentRankName: curInfo.name,
          currentRankTier: curInfo.tier,
          currentMmr:      curRP,
          currentIconUrl:  curIconUrl,
          champPosition,
        });
      }
    }
  }
  return entries;
}

// Parse the history_profiles endpoint response format into the same rank-entry shape.
// Structure differs slightly: history_profiles nests seasons inside full_profiles differently.
function parseHistoryResponse(data) {
  const entries = [];
  // history_profiles may use a different structure � try both known layouts.
  // Layout A: same as full_profiles (platform_families_full_profiles)
  if (data?.platform_families_full_profiles) {
    return parseRankResponse(data, null);
  }
  // Layout B: { history: [ { season_id, platform_family, board_id, profile: {...} } ] }
  const history = data?.history ?? data?.profiles ?? data?.seasons ?? [];
  if (Array.isArray(history)) {
    for (const h of history) {
      const p = h.profile ?? h;
      if (!p || !p.season_id) continue;
      const peakRankId = (p.max_rank && p.max_rank > 0) ? p.max_rank : (p.rank ?? 0);
      if (!peakRankId) continue;
      const peakRankInfo = eraCorrectRank(p.season_id, p.max_rank_points ?? p.rank_points ?? 0, getRankV6(peakRankId));
      const rawChampPos = p.top_rank_position ?? p.topRankPosition ?? p.global_ranking ?? null;
      const champPosition = (rawChampPos && rawChampPos > 0) ? rawChampPos : null;
      const rawIconUrl = `${RANK_ICON_CDN}${peakRankInfo.slug}.png`;
      entries.push({
        season:       p.season_id,
        seasonName:   SEASON_NAMES[p.season_id] ?? `Season ${p.season_id}`,
        rank:         peakRankId,
        rankName:     peakRankInfo.name,
        rankTier:     peakRankInfo.tier,
        mmr:          p.max_rank_points ?? p.rank_points ?? 0,
        iconUrl:      proxyImage(rawIconUrl) ?? rawIconUrl,
        champPosition,
      });
    }
  }
  return entries;
}

// Parse the r6karma legacy endpoint response.
// Response: { players: { [profileId]: { board_id, season, region, rank, max_rank, max_rank_points, ... } } }
// OR when season_id=-1: { players: { [profileId]: { seasons: { [N]: {...} } } } }
function parseKarmaResponse(data, profileId) {
  const entries = [];
  const playerData = data?.players?.[profileId];
  if (!playerData) return entries;

  function pushSeason(sd) {
    const peakRankId = (sd.max_rank && sd.max_rank > 0) ? sd.max_rank : (sd.rank ?? 0);
    if (!peakRankId) return;
    const peakRankInfo = eraCorrectRank(sd.season ?? sd.season_id, sd.max_rank_points ?? sd.rank_points ?? 0, getRankV6(peakRankId));
    const champPosition = (sd.top_rank_position && sd.top_rank_position > 0) ? sd.top_rank_position : null;
    const rawIconUrl = `${RANK_ICON_CDN}${peakRankInfo.slug}.png`;
    entries.push({
      season:     sd.season ?? sd.season_id,
      seasonName: SEASON_NAMES[sd.season ?? sd.season_id] ?? `Season ${sd.season ?? sd.season_id}`,
      rank:       peakRankId,
      rankName:   peakRankInfo.name,
      rankTier:   peakRankInfo.tier,
      mmr:        sd.max_rank_points ?? sd.rank_points ?? 0,
      iconUrl:    proxyImage(rawIconUrl) ?? rawIconUrl,
      champPosition,
    });
  }

  // season_id=-1 returns { seasons: { "N": {...} } }
  if (playerData.seasons && typeof playerData.seasons === 'object') {
    for (const [, sd] of Object.entries(playerData.seasons)) {
      pushSeason(sd);
    }
  } else if (playerData.season != null) {
    // Single season entry
    pushSeason(playerData);
  }
  return entries;
}

// ���� r6data.com: resolve a userId to an in-game display name ����
// The leaderboard uses in-game names (e.g. "sakayanagi") not platform names ("Brand0n.R6").
async function resolveDisplayName(username, userId) {
  const names = new Set();
  if (username) names.add(username.toLowerCase());

  // Try resolving via r6data accountInfo
  const idsToTry = [userId, username].filter(Boolean);
  for (const id of idsToTry) {
    try {
      const res = await http({
        method: 'get', url: `${R6DATA_BASE}/stats`,
        params: { type: 'accountInfo', nameOnPlatform: id, platformType: 'uplay' },
        headers: { 'api-key': R6DATA_KEY },
        timeout: 8000,
      });
      const profiles = res.data?.profiles ?? [];
      for (const p of profiles) {
        const name = p.nameOnPlatform;
        if (name && name !== id) names.add(name.toLowerCase());
      }
    } catch { /* ignore */ }
  }
  return [...names];
}

// ���� r6data.com: look up a player's champion position on the current-season leaderboard ����
// Searches leaderboard pages until the player is found or we run out of champions.
// Returns the position number or null if not found.
async function lookupChampionPosition(username, userId) {
  if (!username && !userId) return null;

  // Resolve all possible display names (platform name, in-game name)
  const namesToMatch = await resolveDisplayName(username, userId);
  if (namesToMatch.length === 0) return null;
  console.log(`[r6data] Looking up champion position for names: [${namesToMatch.join(', ')}]`);

  try {
    for (let page = 1; page <= 100; page++) {
      const res = await http({
        method: 'get', url: `${R6DATA_BASE}/stats`,
        params: { type: 'leaderboards', page, platform: 'pc' },
        headers: { 'api-key': R6DATA_KEY },
        timeout: 10000,
      });
      const entries = res.data;
      if (!Array.isArray(entries) || entries.length === 0) break;
      for (const entry of entries) {
        const id = (entry.id ?? '').toLowerCase();
        if (namesToMatch.includes(id)) {
          console.log(`[r6data] Found champion position: #${entry.position} (${entry.id}, ${entry.rankPoints} RP)`);
          return entry.position;
        }
      }
      // If the last entry's RP is below champion threshold (4500), stop searching
      const lastRP = entries[entries.length - 1]?.rankPoints ?? 0;
      if (lastRP < 4500) break;
    }
  } catch (e) {
    console.warn('[r6data] Leaderboard lookup failed:', e.message);
  }
  return null;
}

// ���� r6data.com: fetch ALL historical season ranks for a player ��������������������������
// Uses the third-party r6data.com API which has its own historical database.
// Returns the same rank-entry shape our UI expects.
async function getR6DataSeasonRanks(username, userId) {
  if (!username && !userId) return [];

  function parseR6DataResponse(raw, currentSeason) {
    const entries = [];

    // ���� New format (2025+): { data: { metadata: {...}, segments: [...] } } ����
    const segments = raw?.data?.segments ?? [];
    const metaCurrentSeason = raw?.data?.metadata?.currentSeason ?? currentSeason ?? null;
    if (segments.length > 0) {
      for (const seg of segments) {
        // Only process ranked mode segments that have maxRankPoints
        if (seg.attributes?.sessionType !== 'ranked') continue;
        const maxRP = seg.stats?.maxRankPoints?.value ?? 0;
        if (!maxRP || maxRP <= 0) continue;

        const seasonNum = seg.attributes?.season ?? null;
        if (seasonNum == null) continue;

        // PEAK � highest RP achieved during the season
        const peakRankId = rpToRankId(maxRP);
        if (peakRankId === 0) continue;
        const peakInfo = getRankV6(peakRankId);
        const peakIconUrl = proxyImage(`${R6DATA_RANK_IMG}${peakInfo.r6slug}.webp`)
                         ?? `${RANK_ICON_CDN}${peakInfo.slug}.png`;

        // CURRENT � where the player sits RIGHT NOW (may have de-ranked from peak)
        const curRP = seg.stats?.rankPoints?.value ?? maxRP;
        const curRankId = rpToRankId(curRP);
        const curInfo = curRankId > 0 ? getRankV6(curRankId) : peakInfo;
        const curIconUrl = curRankId > 0
          ? (proxyImage(`${R6DATA_RANK_IMG}${curInfo.r6slug}.webp`) ?? `${RANK_ICON_CDN}${curInfo.slug}.png`)
          : peakIconUrl;

        const seasonName = (seasonNum != null ? SEASON_NAMES[seasonNum] : null)
                         ?? seg.metadata?.seasonName ?? `Season ${seasonNum}`;

        entries.push({
          season: seasonNum, seasonName,
          // Peak is the canonical season rank shown in the all-time list
          rank: peakRankId, rankName: peakInfo.name, rankTier: peakInfo.tier,
          mmr: maxRP, iconUrl: peakIconUrl,
          // Current � actual right-now rank (may differ from peak)
          currentRank: curRankId, currentRankName: curInfo.name, currentRankTier: curInfo.tier,
          currentMmr: curRP, currentIconUrl: curIconUrl,
          champPosition: null,
          _isCurrentSeason: seasonNum === metaCurrentSeason,
        });
      }
      if (entries.length > 0) return entries;
    }

    // ���� Legacy format: flat array or { seasons: [...] } ����
    let seasons = [];
    if (Array.isArray(raw)) {
      seasons = raw;
    } else if (raw && typeof raw === 'object') {
      if (Array.isArray(raw.seasons))      seasons = raw.seasons;
      else if (Array.isArray(raw.data))    seasons = raw.data;
      else if (Array.isArray(raw.results)) seasons = raw.results;
      else {
        for (const [key, val] of Object.entries(raw)) {
          if (val && typeof val === 'object') seasons.push({ _code: key, ...val });
        }
      }
    }

    for (const s of seasons) {
      const code      = (s.season ?? s.seasonCode ?? s.code ?? s._code ?? '').toString();
      const codeUpper = code.toUpperCase();
      let seasonNum   = YEAR_SEASON_TO_NUM[codeUpper]
                     ?? (Number.isInteger(Number(code)) && Number(code) > 0 ? Number(code) : null)
                     ?? SEASON_NAME_TO_NUM[(s.seasonName ?? s.season_name ?? s.name ?? '').toLowerCase()]
                     ?? null;

      const rankRaw     = s.maxRank ?? s.max_rank ?? s.rank ?? s.currentRank ?? null;
      const rankNameRaw = s.maxRankName ?? s.max_rank_name ?? s.rankName ?? s.rank_name ?? null;
      let rankId        = typeof rankRaw === 'number' ? rankRaw : null;
      let rankName      = typeof rankNameRaw === 'string' ? rankNameRaw
                        : typeof rankRaw     === 'string' ? rankRaw : null;

      if (!rankId && rankName) {
        const found = RANKS_V6.find(r => r.name.toLowerCase() === rankName.toLowerCase());
        if (found) rankId = found.id;
      }
      if (rankId == null || rankId === 0) continue;

      const rankInfo = getRankV6(rankId);
      const rawPos   = s.champPosition ?? s.champRank ?? s.topRankPosition ??
                       s.top_rank_position ?? s.championPosition ??
                       s.globalRanking ?? s.global_ranking ?? null;
      const champPosition = (rawPos && rawPos > 0) ? rawPos : null;
      const mmr       = s.maxMmr ?? s.max_mmr ?? s.mmr ?? s.rankPoints ?? s.rank_points ?? 0;
      const rawIconUrl = `${RANK_ICON_CDN}${rankInfo.slug}.png`;
      const seasonName = (seasonNum != null ? SEASON_NAMES[seasonNum] : null)
                       ?? s.seasonName ?? s.season_name ?? s.name
                       ?? (seasonNum != null ? `Season ${seasonNum}` : code || 'Unknown');

      entries.push({ season: seasonNum, seasonName, rank: rankId, rankName: rankInfo.name,
                     rankTier: rankInfo.tier, mmr, iconUrl: proxyImage(rawIconUrl) ?? rawIconUrl,
                     champPosition });
    }
    return entries;
  }

  // Try userId first (more reliable � in-game name can differ from platform name),
  // then fall back to platform username.  Both are accepted by r6data's nameOnPlatform param.
  const namesToTry = [userId, username].filter(Boolean);
  // Try both documented type names � docs list both variants
  const r6cache = require('./r6dataCache');
  for (const nameVal of namesToTry) {
    // Cache check — skip r6data entirely if we have a fresh response (1h TTL)
    const cachedKey = 'seasonsStats:' + nameVal;
    const cached = r6cache.get('seasonsStats', nameVal);
    if (cached) {
      console.log('[r6data] cache hit for ' + nameVal.slice(0, 8));
      const entries = parseR6DataResponse(cached);
      if (entries.length > 0) {
        for (const e of entries) delete e._isCurrentSeason;
        return entries;
      }
    }

    // Cooldown gate — r6data uses a sliding-window rate limit. If we just got
    // a 429, every retry resets the window. Refuse until cooldown expires.
    if (r6cache.isCoolingDown()) {
      console.log(`[r6data] cooldown active (${Math.ceil(r6cache.cooldownRemainingMs()/1000)}s left) — skipping`);
      continue;
    }

    for (const type of ['seasonsStats', 'seasonalStats']) {
      try {
        const res = await http({
          method: 'get', url: `${R6DATA_BASE}/stats`,
          params: { type, nameOnPlatform: nameVal, platformType: 'uplay' },
          headers: { 'api-key': R6DATA_KEY },
          timeout: 15000,
          validateStatus: () => true,
        });
        // Detect 429 and trip cooldown for retryAfter ms
        if (res.status === 429) {
          const retryAfter = res.data?.retryAfter || 30_000;
          r6cache.trip(retryAfter);
          break; // skip seasonalStats fallback too — same rate limit
        }
        const raw = res.data;
        if (raw) r6cache.set('seasonsStats', nameVal, raw); // cache for 1h
        console.log(`[r6data] type=${type} name=${nameVal} keys:`, Object.keys(raw ?? {}).join(', '));
        console.log(`[r6data] response:`, JSON.stringify(raw).slice(0, 1500));
        const entries = parseR6DataResponse(raw);
        if (entries.length > 0) {
          // Look up champion position for current-season champion entries
          const champEntry = entries.find(e => e._isCurrentSeason && e.rank === 36);
          if (champEntry) {
            console.log('[r6data] Current season is Champion � looking up leaderboard position...');
            const pos = await lookupChampionPosition(username, userId);
            if (pos) champEntry.champPosition = pos;
          }
          // Clean up internal flags
          for (const e of entries) delete e._isCurrentSeason;

          console.log(`[r6data] parsed ${entries.length} season(s): [${entries.map(e => `${e.seasonName}=${e.rankName}(${e.mmr}RP)${e.champPosition ? '#' + e.champPosition : ''}`).join(', ')}]`);
          return entries;
        }
      } catch (e) {
        const status   = e.response?.status;
        const body     = e.response?.data ? JSON.stringify(e.response.data).slice(0, 200) : e.message;
        console.warn(`[r6data] type=${type} name=${nameVal} failed (${status ?? 'network'}): ${body}`);
      }
    }
  }
  return [];
}

// ���� tabstats.com: public tracker API with historical season data ��������������������������
// No API key required. Falls back gracefully on any error.
async function getTabstatsSeasonRanks(userId) {
  if (!userId) return [];
  try {
    const res = await axios.get(`https://api2.tabstats.com/siege/player/`, {
      params: { ubisoft_id: userId, platform: 'uplay' },
      timeout: 10000,
      headers: { 'User-Agent': 'R6Locker/1.0' },
    });
    const raw = res.data;
    console.log('[tabstats] response keys:', Object.keys(raw ?? {}).join(', '));
    console.log('[tabstats] raw sample:', JSON.stringify(raw).slice(0, 2000));
    return parseTrackerSeasons('[tabstats]', raw);
  } catch (e) {
    console.warn(`[tabstats] failed (${e.response?.status ?? e.message})`);
    return [];
  }
}

// ���� r6tab.com: another public tracker with historical season data ��������������������������
async function getR6TabSeasonRanks(username) {
  if (!username) return [];
  try {
    const res = await axios.get(`https://r6tab.com/api/player.php`, {
      params: { platform: 'uplay', players: username },
      timeout: 10000,
      headers: { 'User-Agent': 'R6Locker/1.0' },
    });
    const raw = res.data;
    console.log('[r6tab] response keys:', Object.keys(raw ?? {}).join(', '));
    console.log('[r6tab] raw sample:', JSON.stringify(raw).slice(0, 2000));
    return parseTrackerSeasons('[r6tab]', raw);
  } catch (e) {
    console.warn(`[r6tab] failed (${e.response?.status ?? e.message})`);
    return [];
  }
}

// Generic parser: handles the various season-data shapes trackers use.
// Supports:
//   - Array of season objects (each with season/code/name + rank fields)
//   - Object keyed by Y-code ("Y11S1": { rank: 36, mmr: 4643 })
//   - Nested under data/player/stats wrapper
function parseTrackerSeasons(label, raw) {
  const entries = [];

  // Unwrap one level of nesting (data / player / stats wrappers)
  const unwrapped = raw?.data ?? raw?.player ?? raw?.stats ?? raw;

  // Find the seasonal list: try both array and keyed-object shapes
  let seasonsList = unwrapped?.previous_seasons
    ?? unwrapped?.seasons ?? unwrapped?.season_stats
    ?? unwrapped?.ranked_seasons ?? unwrapped?.history ?? null;

  // No seasons key found at top level � log and bail
  if (!seasonsList) {
    console.log(`${label} no seasons field found � response shape not understood`);
    return [];
  }

  // Decide whether it's an array or a keyed object
  let pairs; // [{code?, data}]
  if (Array.isArray(seasonsList)) {
    pairs = seasonsList.map(s => ({ code: null, data: s }));
  } else if (typeof seasonsList === 'object') {
    // Object keyed by year-season code e.g. { Y11S1: { rank:36, mmr:4643 }, ... }
    pairs = Object.entries(seasonsList).map(([k, v]) => ({ code: k, data: v }));
  } else {
    return [];
  }

  for (const { code: keyCode, data: s } of pairs) {
    if (!s || typeof s !== 'object') continue;

    // Resolve season number
    const nameRaw   = (s?.season ?? s?.season_name ?? s?.name ?? s?.code ?? keyCode ?? '').toString();
    const codeUpper = nameRaw.toUpperCase();
    const keyUpper  = (keyCode ?? '').toUpperCase();
    let seasonNum   = YEAR_SEASON_TO_NUM[keyUpper]
                   ?? YEAR_SEASON_TO_NUM[codeUpper]
                   ?? SEASON_NAME_TO_NUM[nameRaw.toLowerCase()]
                   ?? (Number.isInteger(Number(nameRaw)) && Number(nameRaw) > 0 ? Number(nameRaw) : null);

    // Resolve rank ID: support int rank ID, string name, or nested object
    const rawRank  = s?.max_rank ?? s?.maxRank ?? s?.best_rank ?? s?.rank ?? null;
    const rawName  = s?.max_rank_name ?? s?.maxRankName ?? s?.rank_name ?? s?.rankName ?? null;
    const rawMmr   = s?.max_mmr ?? s?.maxMmr ?? s?.mmr ?? s?.rank_points ?? s?.rankPoints ?? 0;

    let rankId = null;
    if (typeof rawRank === 'number' && rawRank >= 0 && rawRank <= 36) {
      rankId = rawRank;
    } else if (typeof rawRank === 'number') {
      // Might be a legacy rank integer > 36 � skip
    } else if (typeof rawName === 'string' && rawName) {
      // Match by name ("Champions", "Diamond 1", "Gold 3", etc.)
      const nameLower = rawName.toLowerCase().replace(/\s+/g, ' ');
      const found = RANKS_V6.find(r => r.name.toLowerCase() === nameLower)
                 ?? RANKS_V6.slice().reverse().find(r => nameLower.includes(r.tier)); // highest tier first
      if (found) rankId = found.id;
    }
    if (rankId == null || rankId === 0) continue;

    const rankInfo   = getRankV6(rankId);
    const rawIconUrl = `${RANK_ICON_CDN}${rankInfo.slug}.png`;
    const rawChampPos = s?.top_rank_position ?? s?.topRankPosition ?? s?.champion_rank
                     ?? s?.champPosition ?? s?.global_ranking ?? null;
    const champPosition = (rawChampPos && rawChampPos > 0) ? rawChampPos : null;

    entries.push({
      season:     seasonNum,
      seasonName: (seasonNum != null ? SEASON_NAMES[seasonNum] : null) ?? (nameRaw || `Season ?`),
      rank:       rankId,
      rankName:   rankInfo.name,
      rankTier:   rankInfo.tier,
      mmr:        rawMmr,
      iconUrl:    proxyImage(rawIconUrl) ?? rawIconUrl,
      champPosition,
    });
  }

  console.log(`${label} parsed ${entries.length} season(s): [${entries.map(e => `${e.seasonName}=${e.rankName}${e.champPosition ? '#' + e.champPosition : ''}`).join(', ')}]`);
  return entries;
}

// Fetch the player's ranked data.
// Strategy (Ubisoft no longer exposes past-season data on their public API,
// so we MUST rely on third-party trackers that maintain their own history):
//   1. tracker.gg /uplay/{ubiId}  -> primary: full history, current+peak
//   2. r6data.com                 -> fallback: historical, rate-limited
//   3. tabstats.com / r6tab.com   -> tertiary fallbacks
//   4. Ubisoft /full_profiles     -> current-season override (real-time)
async function getSeasonRanks(profileId, username, ticket, sessionId, appId, opts = {}) {
  // nativeOnly: skip every third-party tracker (tracker.gg → camoufox, r6data,
  // tabstats, and the secondary-source enrichment pass) and use ONLY Ubisoft's
  // own skill/full_profiles endpoint. This is what bulk uses — it still returns
  // current + past seasons, but makes zero browser launches, so it scales to
  // hundreds of concurrent checks without stalling.
  const nativeOnly = !!opts.nativeOnly;
  // trackerOnly (bulk): ONLY the api.tracker.gg lookup, no browser escalation
  // and no slow secondary sources (r6data/tabstats/native loop/enrichment).
  // This is the lightweight path that scales to bulk concurrency.
  const trackerOnly = !!opts.trackerOnly;
  const headers = authHeaders(ticket, sessionId, appId);
  const seenSeasons = new Set();
  const ranks = [];

  function addEntries(entries) {
    let added = 0;
    for (const r of entries) {
      const key = r.season ?? r.seasonName ?? JSON.stringify(r);
      if (!seenSeasons.has(key)) {
        seenSeasons.add(key);
        ranks.push(r);
        added++;
      }
    }
    return added;
  }

  // -- Attempt 1: tracker.gg (PRIMARY - full historical season data) --
  // Tracker.gg has TWO endpoints: /ubi/{username} (preferred, public, served
  // from CF cache) and /uplay/{userId} (fallback). fetchTrackerGG tries both.
  if (!nativeOnly) try {
    const { fetchTrackerGG } = require('./rankSources');
    const tgEntries = await fetchTrackerGG(profileId, { username, userId: profileId, noBrowser: trackerOnly });
    if (tgEntries.length) {
      addEntries(tgEntries);
      console.log('[ranks] tracker.gg returned ' + tgEntries.length + ' seasons');
    }
  } catch (e) {
    console.warn('[ranks] tracker.gg failed:', e.message);
  }

  // -- Attempt 2: r6data.com (fallback - has historical when not rate-limited) --
  if (!nativeOnly && !trackerOnly && ranks.length < 3) {
    const r6dataEntries = await getR6DataSeasonRanks(username, profileId);
    if (r6dataEntries.length) {
      addEntries(r6dataEntries);
      console.log('[ranks] r6data added ' + r6dataEntries.length + ' seasons');
    }
  }

  // -- Attempt 3: tabstats.com (tertiary public tracker) --
  if (!nativeOnly && !trackerOnly && ranks.length === 0) {
    const tabstatsEntries = await getTabstatsSeasonRanks(profileId);
    if (tabstatsEntries.length) {
      addEntries(tabstatsEntries);
      console.log('[ranks] tabstats returned ' + tabstatsEntries.length + ' seasons');
    }
  }

  // -- Attempt 4: r6tab.com (another public tracker) --
  if (!nativeOnly && ranks.length === 0) {
    const r6tabEntries = await getR6TabSeasonRanks(username);
    if (r6tabEntries.length) {
      addEntries(r6tabEntries);
      console.log('[ranks] r6tab returned ' + r6tabEntries.length + ' seasons');
    }
  }

  // ���� Attempt 2: legacy r6karma (deprecated � skip, confirmed 404 for all regions) ������
  // Keeping the dead code commented in case Ubisoft ever restores it.
  // if (ranks.length === 0) { /* r6karma is 404 */ }

  // ���� Attempt 3: Ubisoft official endpoints � try several variants ������������������
  // These return current-season rank with current_rank_points (live, not peak).
  const UBI_RANK_ENDPOINTS = [
    // v2 full_profiles � current season, current AND peak rank
    `https://public-ubiservices.ubi.com/v2/spaces/${CROSSPLAY_SPACE_ID}/title/r6s/skill/full_profiles?profile_ids=${profileId}&platform_families=pc,console`,
    // Same but ALL platforms (some accounts only appear under PC)
    `https://public-ubiservices.ubi.com/v2/spaces/${PC_SPACE_ID}/title/r6s/skill/full_profiles?profile_ids=${profileId}&platform_families=pc`,
    // pastSeasons=true variant � Ubisoft sometimes returns history
    `https://public-ubiservices.ubi.com/v2/spaces/${CROSSPLAY_SPACE_ID}/title/r6s/skill/full_profiles?profile_ids=${profileId}&platform_families=pc,console&pastSeasons=true`,
    // Older v1 endpoint � still works for some accounts
    `https://public-ubiservices.ubi.com/v1/spaces/${PC_SPACE_ID}/title/r6s/rankedv2/players?profile_ids=${profileId}`,
  ];
  for (const url of (trackerOnly ? [] : UBI_RANK_ENDPOINTS)) {
    try {
      const res = await ubiRequest({ method: 'get', url, headers });
      const entries = parseRankResponse(res.data, null);
      const added = addEntries(entries);
      if (added) {
        console.log(`[ranks] Ubisoft endpoint added ${added} entries: ${url.split('?')[0].split('/').slice(-2).join('/')}`);
        // Stop trying further endpoints once we have data
        if (ranks.some(r => r.currentMmr && r.currentMmr !== r.mmr)) break;
      }
    } catch (e) {
      const code = e.response?.status;
      if (code !== 404 && code !== 403) {
        console.warn(`[ranks] Ubisoft endpoint failed (${code ?? e.message}): ${url.split('?')[0].split('/').slice(-2).join('/')}`);
      }
    }
  }

  // ���� Attempt 4: per-season Ubisoft history loop ������������������������������������������������������
  // If we have <3 seasons, try fetching individual past seasons from Ubisoft.
  // Some seasons need to be queried explicitly with ?season_id=N.
  if (nativeOnly) try {
    const { fetchStatsCcProfile, parseStatsCcSeasonRanks } = require('./rankSources');
    const sc = await fetchStatsCcProfile(profileId, { bulk: true, timeout: 10000 });
    if (sc?.seasons) {
      const added = addEntries(parseStatsCcSeasonRanks(sc.seasons));
      if (added) console.log(`[ranks] stats.cc added ${added} season(s)`);
    }
  } catch (e) {
    console.warn('[ranks] stats.cc rank fetch failed:', e.message);
  }

  if (!trackerOnly && ranks.length < 5) {
    const currentSeasonGuess = 42; // Y11S2 System Override (live 2026-06-02); update each season
    const seasonsToTry = [];
    for (let s = currentSeasonGuess; s >= Math.max(currentSeasonGuess - 6, 28); s--) {
      if (!seenSeasons.has(s)) seasonsToTry.push(s);
    }
    for (const sid of seasonsToTry.slice(0, 6)) {
      try {
        const url = `https://public-ubiservices.ubi.com/v2/spaces/${CROSSPLAY_SPACE_ID}/title/r6s/skill/full_profiles?profile_ids=${profileId}&platform_families=pc,console&season_id=${sid}`;
        const res = await ubiRequest({ method: 'get', url, headers });
        const entries = parseRankResponse(res.data, sid);
        addEntries(entries);
      } catch { /* per-season is best-effort */ }
    }
  }

  // ���� Enrichment pass: query extra free APIs in parallel and merge ��������������������
  // These can fill in missing currentMmr/currentRank for the current season
  // when r6data was rate-limited and we fell back to peak-only sources.
  if (!nativeOnly && !trackerOnly) try {
    const { fetchAllExtraSources } = require('./rankSources');
    const extras = await fetchAllExtraSources(username, profileId);
    if (extras.length > 0) {
      console.log(`[ranks] enrichment: ${extras.length} extra entries from secondary sources`);
      // Build index by season number for fast merge
      const bySeason = new Map();
      for (const r of ranks) if (r.season != null) bySeason.set(r.season, r);
      for (const x of extras) {
        const target = x.season != null && bySeason.get(x.season);
        if (!target) continue;
        // Prefer current data from secondary sources (they often have it when r6data didn't)
        if (x._currentRP && (!target.currentMmr || target.currentMmr === target.mmr)) {
          const curRP = x._currentRP;
          const curRankId = rpToRankId(curRP);
          if (curRankId > 0) {
            const curInfo = getRankV6(curRankId);
            target.currentMmr      = curRP;
            target.currentRank     = curRankId;
            target.currentRankName = curInfo.name;
            target.currentRankTier = curInfo.tier;
            target.currentIconUrl  = proxyImage(`${R6DATA_RANK_IMG}${curInfo.r6slug}.webp`)
                                  ?? `${RANK_ICON_CDN}${curInfo.slug}.png`;
            console.log(`[ranks] S${x.season} current updated to ${curInfo.name} (${curRP} RP) from ${x._source}`);
          }
        }
      }
    }
  } catch (e) {
    console.warn('[ranks] enrichment failed:', e.message);
  }

  ranks.sort((a, b) => (b.season ?? 0) - (a.season ?? 0));

  // Stale-cache fallback: when every live source fails / is rate-limited,
  // we'd rather return yesterday's ranks than nothing at all. Rank data
  // within a season is mostly static — stale-by-a-day is still useful.
  if (ranks.length === 0) {
    const r6cache = require('./r6dataCache');
    const candidates = [username, profileId].filter(Boolean);
    for (const id of candidates) {
      const stale = r6cache.getStale('seasonsStats', id);
      if (stale?.data) {
        try {
          // Re-parse with the same parser used for fresh data
          const { data: raw, ageMs } = stale;
          // Lazy inline parse (mirrors the parseR6DataResponse path) — only
          // hit on total-failure so we don't care about minor duplication.
          const segments = raw?.data?.segments ?? [];
          for (const seg of segments) {
            if (seg.attributes?.sessionType !== 'ranked') continue;
            const maxRP = seg.stats?.maxRankPoints?.value ?? 0;
            if (!maxRP) continue;
            const seasonNum = seg.attributes?.season;
            if (seasonNum == null) continue;
            const peakRankId = rpToRankId(maxRP);
            if (peakRankId === 0) continue;
            const peakInfo = getRankV6(peakRankId);
            ranks.push({
              season: seasonNum,
              seasonName: SEASON_NAMES[seasonNum] ?? `Season ${seasonNum}`,
              rank: peakRankId, rankName: peakInfo.name, rankTier: peakInfo.tier,
              mmr: maxRP,
              iconUrl: proxyImage(`${R6DATA_RANK_IMG}${peakInfo.r6slug}.webp`) ?? `${RANK_ICON_CDN}${peakInfo.slug}.png`,
              champPosition: null,
              _stale: true,
            });
          }
          if (ranks.length) {
            console.log(`[ranks] STALE fallback hit (${Math.round(ageMs/3600000)}h old) — ${ranks.length} season(s) recovered`);
            ranks.sort((a, b) => (b.season ?? 0) - (a.season ?? 0));
            break;
          }
        } catch (e) {
          console.warn('[ranks] stale parse failed:', e.message);
        }
      }
    }
  }

  console.log(`Season ranks: ${ranks.length} season(s): [${ranks.map(r => `S${r.season}=${r.rankName}${r.currentMmr && r.currentMmr !== r.mmr ? `[cur=${r.currentRankName}]` : ''}${r.champPosition ? '#' + r.champPosition : ''}`).join(', ')}]`);
  return ranks;
}

// Public-facing wrapper: NEVER throws. The pipeline's bulk path and the locker
// page both rely on this — a thrown error here would tank an entire bulk row
// (or the whole locker render) for what is decorative data.
async function getSeasonRanksSafe(profileId, username, ticket, sessionId, appId, opts = {}) {
  try {
    return await getSeasonRanks(profileId, username, ticket, sessionId, appId, opts);
  } catch (e) {
    console.warn('[ranks] getSeasonRanks threw unexpectedly:', e.message);
    return [];
  }
}

function extractRarity(tags) {
  for (const t of tags) {
    if (typeof t !== 'string') continue;
    const lower = t.toLowerCase();
    if (lower.includes('legendary')) return 'Legendary';
    if (lower.includes('epic'))      return 'Epic';
    if (lower.includes('rare'))      return 'Rare';
    if (lower.includes('uncommon'))  return 'Uncommon';
    if (lower.includes('common'))    return 'Common';
  }
  return 'Standard';
}

function extractType(tags, apiType) {
  // Real API type names (from 2024+ Ubisoft endpoints):
  if (apiType) {
    if (apiType === 'Charm' || apiType === 'CharmAttachment') return 'Charm';
    if (apiType === 'WeaponSkin')             return 'Weapon Skin';
    if (apiType === 'CharacterHeadgear')      return 'Headgear';
    if (apiType === 'CharacterUniform')       return 'Uniform';
    if (apiType === 'GadgetSkin')             return 'Gadget Skin';
    if (apiType === 'DroneSkin')              return 'Drone Skin';
    if (apiType === 'WeaponAttachmentSkin' ||
        apiType === 'WeaponAttachmentSkinSet') return 'Attachment Skin';
    if (apiType === 'OperatorCardBadge')      return 'Card Badge';
    if (apiType === 'OperatorCardPortrait')   return 'Card Portrait';
    if (apiType === 'OperatorCardBackground') return 'Card Background';
    if (apiType === 'MVPAnimation')           return 'MVP Animation';
  }
  // Tags fallback (tags use `type_characteruniform` format)
  for (const t of tags) {
    if (typeof t !== 'string') continue;
    const tl = t.toLowerCase();
    if (tl.includes('charm'))         return 'Charm';
    if (tl.includes('weaponskin'))    return 'Weapon Skin';
    if (tl.includes('headgear'))      return 'Headgear';
    if (tl.includes('uniform'))       return 'Uniform';
  }
  return 'Item';
}

// Format the internal nameId into something human-readable.
// Three naming conventions exist in the wild:
//   Dot-format:        "uniforms.Y5S3.Fuze.SeasonalCamo_Y5S3.SHADOW_LEGACY"
//   Underscore-format: "OPCARDBADGE_RAM_Y8S3_ELITE_RAM"
//   Space-format:      "Op Card Badge Ram Elite Ram 0x634cd502a5"   (older items � nameId IS the raw display name)
function formatNameId(nameId) {
  if (!nameId || typeof nameId !== 'string') return null;

  // Strip ALL hex hashes anywhere (e.g. " 0x634cd502a5" or " 0x000000104697e915")
  let s = nameId.replace(/\s*0x[0-9a-fA-F]+/gi, '').trim();
  if (!s) return null;

  // Title-case helper that also uppercases the first letter after hyphens
  function toTitle(str) {
    return str.toLowerCase().replace(/(?:^|[\s-])\S/g, c => c.toUpperCase()).replace(/\s{2,}/g, ' ').trim();
  }

  // Segment cleaner for dot/underscore tokens
  function cleanSegment(seg) {
    return seg
      .replace(/_/g, ' ')
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/\bY\d+[Ss]\d+\b/gi, '')
      .replace(/\b(?:GO|Development|BP|Battlepass|Membership|ThemedContent|Outsourcing|Seasonal|SeasonalCamo)\b/gi, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  // ���� Dot-format ��������������������������������������������������������������������������������������������������������������������������
  if (s.includes('.')) {
    const parts = s.split('.');
    // Skip type prefix (first segment) and season codes
    const meaningful = parts
      .filter(p => !/^(?:y\d+s\d+|Charm|weapon_charms_universal|CharacterHeadgear|CharacterUniform|WeaponSkin|GadgetSkin|DroneSkin|OperatorCardPortrait|OperatorCardBackground|OperatorCardBadge|MVPAnimation|WeaponAttachmentSkin)$/i.test(p) && p.trim());
    // Take the last 2 meaningful segments
    const tail = meaningful.slice(-2).map(cleanSegment).filter(Boolean);
    let result = tail.join(' ').replace(/\s{2,}/g, ' ').trim();
    // Post-process: clean up Black Ice / Instance Of / verbose patterns
    result = cleanItemName(result) || result;
    return result ? toTitle(result) : null;
  }

  // ���� Underscore-format ��������������������������������������������������������������������������������������������������������������
  if (s.includes('_') && !/ /.test(s)) {
    s = s.replace(/^(WPNATT|WPNALL|WPN|OPCARDBADGE|OPCARDPORTRAIT|OPCARDBACKGROUND|OPCARD|HEADGEAR|UNIFORM|CHARM|BADGE|BANNER|ATTACH|OP|GO|DEVELOPMENT)_/i, '');
    const tokens = s.split('_').filter(t =>
      !/^y\d+s\d+$/i.test(t) &&
      !/^(?:GO|BP|Development|Battlepass|ThemedContent|Outsourcing|Seasonal|SeasonalCamo)$/i.test(t) &&
      t.trim()
    );
    const result = tokens.join(' ').replace(/\s{2,}/g, ' ').trim();
    return result ? toTitle(result) : null;
  }

  // ���� Space-format ������������������������������������������������������������������������������������������������������������������������
  // Apply cleanItemName which handles all the same patterns
  s = cleanItemName(s);
  if (s && s.length > 1) return s;
  return null;
}

// Clean the API-provided ItemName field (runs before formatNameId, so must be thorough).
// Returns null if the result is too short � caller then falls back to formatNameId(nameId).
function cleanItemName(raw) {
  if (!raw || typeof raw !== 'string') return null;
  let s = raw
    // Strip ALL hex hashes (0x followed by hex digits) anywhere in the string
    .replace(/\s*0x[0-9a-fA-F]+/gi, '')
    // Development/GO_ debug prefixes
    .replace(/^(?:Development|GO)\s+/i, '')
    // "Instance Of " / "Instance Of-" / "Instanceof-" (may appear multiple times)
    .replace(/Instance\s*Of[\s-]+/gi, '')
    .replace(/Instanceof[\s-]*/gi, '')
    // Black Ice texture patterns: "Black Ice Texture-WeaponName Black Ice" �  "WeaponName"
    .replace(/Black\s+Ice\s+Texture[\s-]+/gi, '')
    .replace(/Black\s+Texture[\s-]+/gi, '')
    // "Black " prefix when followed by "Texture" was already caught, but catch standalone "-black "
    .replace(/-black\s+/gi, ' ')
    .replace(/^black\s+/gi, '')
    // Strip trailing " Black Ice" suffix (the section title says "Black Ices")
    .replace(/\s+Black\s+Ice$/i, '')
    // Strip "R6unique-Black Ice" / "R6unique" patterns
    .replace(/[\s-]*R6unique[\s-]*Black\s+Ice/gi, '')
    .replace(/[\s-]*R6unique/gi, '')
    // Strip lone "Ice" that remains after other Black Ice cleanup
    .replace(/\s+Ice$/i, '')
    .replace(/^Ice\s+/i, '')
    // Strip "-Fbi-" / "-Fbi" and similar faction codes
    .replace(/[\s-]+Fbi(?:[\s-]+|$)/gi, ' ')
    // Strip trailing "-" after cleanup
    .replace(/[\s-]+$/g, '')
    // Purple/Pink prefix before weapon names (color variants)
    .replace(/^(?:Purple|Pink)\s+/i, '')
    // Type prefixes: "Character Uniform", "Character Headgear", "Characteruniform", etc.
    .replace(/^Character\s*(?:Headgear|Uniform|headgear|uniform)\s+/i, '')
    // Weapon prefix: "Weapon Skin", "WeaponSkin"
    .replace(/^Weapon\s*Skin\s+/i, '')
    // "Weapon Attachment Skin Set" / "Weapon Attachment Skin"
    .replace(/^Weapon\s+Attachment\s+Skin(?:\s+Set)?\s+/i, '')
    // Season prefixes: "Y7s1event ", "Y8s4seasonal ", "Y10S2seasonal Camo", etc.
    // NOTE: "seasonal" must appear before "season" so the longer match wins
    .replace(/^Y\d+[Ss]\d+\s*(?:event|battlepass|seasonal|season|elite|lootcrate|r6cup|pro|alternative|business|community|pro\s*team|proleague|ranked?|membership|bp)?\s*/i, '')
    // "Seasonal Camo" sub-type prefixes (Hg=headgear, Bdu=uniform)
    .replace(/^Seasonal\s+Camo\s+(?:Hg|Bdu|Uniform)\s+/i, '')
    // Strip "Seasonal Camo" anywhere � the section title already says "Seasonals"
    .replace(/\bSeasonal\s+Camo\b\s*/gi, '')
    // Proleague region prefixes: "Proleague NA ", "ProL EU "
    .replace(/^Pro\s*l(?:eague?)?\s+[A-Za-z]{1,4}\s+/i, '')
    // Strip verbose proleague/esport prefixes
    .replace(/^(?:E-Sports?\s+)?(?:Proleague|Pro\s*League)\s+Set\s+/i, '')
    .replace(/^Dlc\s+(?:E-Sports?\s+)?(?:Proleague|Pro\s*League)\s+Set\s+/i, '')
    // Operator card prefixes
    .replace(/^(?:Operator\s+Card|Op\s+Card)\s+(?:Portrait|Badge|Background|Video\s+Card)\s+/i, '')
    // Other type prefixes
    .replace(/^(?:Victory\s+Dance|Legacy|Gadget\s*Skin|Drone\s*Skin|Attachment\s*Skin|MVP\s*Animation)\s+/i, '')
    // "Battlepass"/"Battle Pass" prefix when followed by real content
    .replace(/^(?:Battle\s*pass)\s+(?=\S)/i, '')
    // "Event Collection" prefix � "Event Collection Rainbow Is Magic Ws 1 Texture-" �  cleaner
    .replace(/^Event\s+Collection\s+/i, '')
    // Strip "Ws N Texture-" / "Ws N Texture " patterns (weapon skin texture refs)
    .replace(/\bWs\s+\d+\s+Texture[\s-]*/gi, '')
    // Strip "Texture-" or "Texture " prefix/suffix
    .replace(/\bTexture[\s-]+/gi, '')
    .replace(/[\s-]+Texture\b/gi, '')
    // "Bundle NN SomeDescription" �  "SomeDescription" (strip bundle + number prefix)
    .replace(/^Bundle\s+\d+\s+/i, '')
    // "Vc-W Smg ..." / "Vc-W Ar ..." weapon code prefixes
    .replace(/^Vc-W\s+(?:Smg|Ar|Lmg|Dmr|Sr|Sg|Pistol|Mp|Rifle)\s+/i, '')
    // "Wass" / "Was" prefix (weapon attachment skin set) � strip and cleanup
    .replace(/^(?:Wass|Was)\s+/i, '')
    // "Headgear Gign" / "Headgear Slot" prefixes
    .replace(/^Headgear\s+(?:Gign|Slot\d*)\s*/i, '')
    // "Slot02 Tier1 01" / "SlotXX TierX" raw patterns
    .replace(/^Slot\d+\s+Tier\d+\s+\d+/i, '')
    // Trailing numbers that are just variant IDs (e.g., "Shield 02" �  "Shield")
    .replace(/\s+\d{2,}$/g, '')
    // Strip "Camo " when it's a lone prefix
    .replace(/^Camo\s+/i, '')
    // Strip "Esports Chibi" / "Esport Chibi" suffixes
    .replace(/\s+Esports?\s+Chibi$/i, '')
    .trim();

  // Second pass: re-strip season codes that survived (e.g. mid-string "Y6S4")
  s = s.replace(/\bY\d+[Ss]\d+\b\s*/gi, '').trim();

  // Remove duplicate operator name: "Kaid Kaid Neon Dawn" �  "Kaid Neon Dawn"
  const dupWords = s.split(/\s+/);
  if (dupWords.length >= 2 && dupWords[0].toLowerCase() === dupWords[1].toLowerCase()) {
    s = dupWords.slice(1).join(' ');
  }
  // Remove trailing word that duplicates the first: "Ram Elite Ram" �  "Ram Elite"
  if (dupWords.length >= 3 && dupWords[0].toLowerCase() === dupWords[dupWords.length - 1].toLowerCase()) {
    s = dupWords.slice(0, -1).join(' ');
  }

  // If empty or a lone meaningless word/abbreviation, tell caller to use nameId fallback.
  const loneWords = /^(?:Battlepass|Membership|Lootcrate|Bundle|Border|Clh|Dd|Wint|Seasonal\s*Camo|Camo|Development|GO|Seasonal|Texture|Wass|Was|Weapon Attachment Skin Set|Black Ice|Shield|Tier\d*|Slot\d*|Pattern|Set|Standard|Default|Outsourcing|Instance|Of|Type|Collection|Event|Firefighter|Uniform|Headgear|Hg|Skin|Charm|Gadget|Drone|Mvp|Card|Portrait|Badge|Background|Panache|Spetznaz|Gorodskoy)$/i;
  if (s.length <= 1 || loneWords.test(s)) return null;
  return s;
}

// ���� Universal final-pass name scrubber ��������������������������������������������������������������������
// Runs LAST, after every other naming step, on every item before it enters
// the UI. Guarantees no UUIDs, no raw internal tokens, no empty strings.
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const HEX_HASH_RE = /\b0x[0-9a-f]{6,}\b/gi;
const LONG_HEX_RE = /\b[a-f0-9]{12,}\b/gi;

// Title-case a word, preserving leading punctuation (parens, brackets, etc.)
// and keeping short ALL-CAPS codes intact (M4, AK12, R6, EBR).
function titleCaseWord(w) {
  if (!w) return w;
  // Split into leading punctuation + body + trailing punctuation
  const m = w.match(/^([(\[\{"'`]*)(.*?)([)\]\}"'`,.!?:;]*)$/);
  if (!m) return w;
  const [, lead, body, tail] = m;
  if (!body) return w;
  if (/^[A-Z0-9]{1,6}$/.test(body)) return lead + body + tail; // ALL-CAPS code
  if (/^\d+$/.test(body)) return lead + body + tail;            // pure number
  return lead + body.charAt(0).toUpperCase() + body.slice(1).toLowerCase() + tail;
}

// Tokens that are leaked internal categorization labels � strip wherever they appear.
const INTERNAL_JUNK_TOKENS = /\b(Instanceof|InstanceOf|Instance Of|Weaponskin|WeaponSkin|Weapon\s+Skin|WeaponSkins|Characterheadgear|CharacterHeadgear|Characteruniform|CharacterUniform|WeaponAttachmentSkinSet|WeaponAttachmentSkin|Charactermesh|Operatorcardportrait|Operatorcardbackground|Operatorcardbadge|Operatorcardvideo|Operatorcardvideoreward)\b/gi;
// Internal collection / build / pipeline prefixes that snuck into display names.
const INTERNAL_PREFIX_TOKENS = /\b(Licensing|Collection|Loadout\s*\d*|Org\s+Charm|Org|Fw|Hg|Bp|Bdu|Battlepass|Membership|Lootcrate|Bundle|Development|Outsourcing|Texture|Texturex|Textur|Unlockable|Visual|Pattern|Slot\d+|Tier\d+|Wass|Was|Pol|Rgb|Modern\s+Camo|Modern|Camo|Signature\s+Event\s+Pattern|Signature\s+Event|Themed\s+Content|Themedcontent|Color|Universal\s+Visual|Universal|Default|Standard|Ws|Memento|Variation|Border|Clh|Dd|Wint|Firefighter|Panache|Specialty|Eliteskin)\b/gi;
// Faction / squad codes that often leak in (kept as suffix is fine, but as prefix it's noisy).
const FACTION_TOKEN = /\b(Spetznaz|Spetsnaz|Sas|Fbi|Gign|Gsg9|Bope|Navyseal|Jtf2|Sat|Sek|Sek2|Sdu|Cbrn|Ctu|Jfo|Nighthaven|Wolfguard|Osa|Fenrir|Deimos|Warden|Gigr|Gorodskoy|Urban)\b/gi;

// Common typo / spelling corrections from Ubisoft's internal data
const SPELLING_FIXES = [
  [/\bSpetznaz\b/gi, 'Spetsnaz'],
  [/\bE[-\s]?sport\s+/gi, 'Esports '],
  [/\bE[-\s]?sports?\b/gi, 'Esports'],
  [/\bAk[-\s]?(\d+)\b/gi, 'AK$1'],     // Ak 12 �  AK12
  [/\bMp[-\s]?(\d+)\b/gi, 'MP$1'],     // Mp 7 �  MP7
  [/\bUmp[-\s]?(\d+)\b/gi, 'UMP$1'],
  [/\bT[-\s]?5\s+Smg\b/gi, 'T-5 SMG'],
  [/\bMk[-\s]?14[-\s]?Ebr\b/gi, 'MK-14 EBR'],
];

function finalNameClean(name, sectionTitle) {
  let n = (name ?? '').toString();

  // Strip any leaked UUIDs / hex blobs / raw IDs
  n = n.replace(UUID_RE, '').replace(HEX_HASH_RE, '').replace(LONG_HEX_RE, '');

  // Strip internal tokens (run twice � once for each pass; some tokens are nested)
  for (let i = 0; i < 2; i++) {
    n = n.replace(INTERNAL_JUNK_TOKENS, '')
         .replace(INTERNAL_PREFIX_TOKENS, '')
         .replace(/\b(Y\d+S\d+(?:battlepass|membership|lootcrate|bundle|event)?)\b/gi, '');
  }

  // Normalize whitespace and separators (don't break parens though)
  n = n.replace(/[_]+/g, ' ').replace(/-{2,}/g, ' ').replace(/\s{2,}/g, ' ').trim();

  // De-dupe adjacent identical words: "Fuze Fuze" �  "Fuze"
  const words = n.split(/\s+/).filter(Boolean);
  const deduped = [];
  for (const w of words) {
    if (!deduped.length || deduped[deduped.length - 1].toLowerCase() !== w.toLowerCase()) {
      deduped.push(w);
    }
  }

  // Title-case every word (preserves parens and short ALL-CAPS codes)
  n = deduped.map(titleCaseWord).join(' ').trim();

  // Apply spelling fixes
  for (const [re, repl] of SPELLING_FIXES) n = n.replace(re, repl);

  // Fix " ( " / " ) " spacing artifacts
  n = n.replace(/\(\s+/g, '(').replace(/\s+\)/g, ')');

  // Strip leading punctuation that survives from internal nameIds (e.g. "-uzk50gi" → "UZK50Gi")
  n = n.replace(/^[-_,.:;]+\s*/, '');

  // UPPERCASE weapon-code-looking tokens at the start (e.g. "uzk50gi" → "UZK50GI", "sc3000k" → "SC3000K")
  // Weapon names are 2-8 chars mixing letters+digits; if it looks like one, capitalize
  n = n.replace(/^([a-z]+\d+[a-z]*)\b/i, m => m.toUpperCase());

  // If after all cleanup the name is JUST a type ("Uniform", "Headgear", "Card", etc.) and we have
  // a section title, prefer "Uniform" stays as "Uniform" (dedup pass will append discriminator)
  // but for empty/too-short names, fall back to the section title's singular form.
  if (!n || n.length < 2) {
    n = sectionTitle ? sectionTitle.replace(/s$/, '') : 'Item';
  }

  return n;
}

// Wrap a CDN image URL through our local proxy so the browser never hits auth-gated CDN directly.
function proxyImage(url, fallback) {
  if (!url || typeof url !== 'string' || !url.trim()) return null;
  const trimmed = url.trim();
  if (!trimmed.startsWith('http')) return null;
  const fb = (fallback && typeof fallback === 'string' && fallback.trim().startsWith('http'))
    ? `&fallback=${encodeURIComponent(fallback.trim())}` : '';
  return `/api/img?url=${encodeURIComponent(trimmed)}${fb}`;
}

// ���� Elite skin artwork from Ubisoft's official staticctf CDN ��������������������������
// These are the actual elite skin images (not generic operator figures).
// Sourced from each operator's page on ubisoft.com/game/rainbow-six/siege/game-info/operators/
const ELITE_SKIN_IMAGES = {
  thermite: 'https://staticctf.ubisoft.com/J3yJr34U2pZ2Ieem48Dwy9uqj5PNUQTn/2ILhbxn12rNUwM42Mj75BQ/d9558dfbb8916d73b8e843882cd2f98f/R6-operator-thermite-elite.png',
  jackal:   'https://staticctf.ubisoft.com/J3yJr34U2pZ2Ieem48Dwy9uqj5PNUQTn/7A9mgAuqElnDkRC9N3HlSY/4185698a57f17d7cf846dbc60f7ef69b/r6s-operator-jackal-elite.png',
  smoke:    'https://staticctf.ubisoft.com/J3yJr34U2pZ2Ieem48Dwy9uqj5PNUQTn/5RZXXtb3jB8cDaekXKjHBK/7c26e157abf709708386b80e7f82a5a2/R6-operator-smoke_V2.png',
  mira:     'https://staticctf.ubisoft.com/J3yJr34U2pZ2Ieem48Dwy9uqj5PNUQTn/3utncRlZEff2EoZKSglUJX/8a721d93e0d1fbe2a5fbc61b49a759e4/R6-operator-mira-elite.png',
  glaz:     'https://staticctf.ubisoft.com/J3yJr34U2pZ2Ieem48Dwy9uqj5PNUQTn/5AMXQ4gegJlSg0PByxBNEK/262e9d1615f6a256afc5c4f7e5d62d82/R6-operator-glaz-elite.png',
  jager:    'https://staticctf.ubisoft.com/J3yJr34U2pZ2Ieem48Dwy9uqj5PNUQTn/4wTCCby4i1HLQr6AH0zGhl/a9eae6e4ffe2d833f191b21fe6c431a0/R6-operator-jager-elite.png',
  lion:     'https://staticctf.ubisoft.com/J3yJr34U2pZ2Ieem48Dwy9uqj5PNUQTn/6AlCVTmyO0AHtYheyAK4kW/11195c6e0c4fb9f7f9d0477348e5686d/r6s-operator-lion-elite.png',
  buck:     'https://staticctf.ubisoft.com/J3yJr34U2pZ2Ieem48Dwy9uqj5PNUQTn/1G1Bt1APEBlRWFpfGvK6vA/d3fd78e9da98a9100aab5ca2bf788295/r6s-operator-buck-elite.png',
  hibana:   'https://staticctf.ubisoft.com/J3yJr34U2pZ2Ieem48Dwy9uqj5PNUQTn/5qYxU2qr7IeRDycHrcil16/5e72cbd649ea0a2bd9276a1ce2a5dead/R6-operator-hibana-elite.png',
  ash:      'https://staticctf.ubisoft.com/J3yJr34U2pZ2Ieem48Dwy9uqj5PNUQTn/sgz265gFy93WYOOUPEIRj/d8dd7e11b0cb071d2dfd1e7e7242cd2d/r6s-operator-ash-elite.png',
};

// Get the official elite skin artwork for an operator
function getEliteSkinImage(operatorName) {
  if (!operatorName) return null;
  const safe = OPERATOR_SAFENAMES[operatorName.toLowerCase().trim()];
  if (!safe) return null;
  return ELITE_SKIN_IMAGES[safe] ?? null;
}

// ���� Operator figure images from danielwerg/r6data CDN ������������������������������������������
// Used as fallback for headgears, uniforms, operator cards when Ubisoft API returns nothing.
const OPERATOR_FIGURE_CDN = 'https://cdn.jsdelivr.net/gh/danielwerg/r6data@master/src/assets/operators/figures/';
const OPERATOR_ICON_CDN   = 'https://cdn.jsdelivr.net/gh/danielwerg/r6data@master/src/assets/operators/icons/svgs/';

// Map display name variants �  safename used in the CDN URL
const OPERATOR_SAFENAMES = {
  ace:'ace', alibi:'alibi', amaru:'amaru', aruni:'aruni', ash:'ash', azami:'azami',
  bandit:'bandit', blackbeard:'blackbeard', blitz:'blitz', brava:'brava', buck:'buck',
  capitao:'capitao', capitão:'capitao', castle:'castle', caveira:'caveira', clash:'clash',
  deimos:'deimos', doc:'doc', dokkaebi:'dokkaebi', echo:'echo', ela:'ela',
  fenrir:'fenrir', finka:'finka', flores:'flores', frost:'frost', fuze:'fuze',
  glaz:'glaz', goyo:'goyo', gridlock:'gridlock', grim:'grim',
  hibana:'hibana', iana:'iana', iq:'iq',
  jackal:'jackal', jager:'jager', jäger:'jager',
  kaid:'kaid', kali:'kali', kapkan:'kapkan',
  lesion:'lesion', lion:'lion',
  maestro:'maestro', maverick:'maverick', melusi:'melusi', mira:'mira',
  montagne:'montagne', mozzie:'mozzie', mute:'mute',
  nokk:'nokk', nøkk:'nokk', nomad:'nomad',
  oryx:'oryx', osa:'osa',
  pulse:'pulse', ram:'ram', recruit:'recruit', rook:'rook',
  sens:'sens', sledge:'sledge', smoke:'smoke', solis:'solis',
  tachanka:'tachanka', thatcher:'thatcher', thermite:'thermite', thorn:'thorn',
  thunderbird:'thunderbird', tubarao:'tubarao', twitch:'twitch',
  valkyrie:'valkyrie', vigil:'vigil',
  wamai:'wamai', warden:'warden',
  ying:'ying', zero:'zero', zofia:'zofia',
  // Common alternate spellings
  'jäger':'jager', 'nøkk':'nokk', 'capitão':'capitao',
};

// Get the figure image URL for an operator (used for elite skins, headgears, uniforms)
function getOperatorFigureUrl(operatorName) {
  if (!operatorName) return null;
  const safe = OPERATOR_SAFENAMES[operatorName.toLowerCase().trim()];
  if (!safe) return null;
  // Most are .webp, a few newer ones are .png
  const pngOps = new Set(['brava','deimos','fenrir','ram','recruit','tubarao']);
  const ext = pngOps.has(safe) ? 'png' : 'webp';
  return `${OPERATOR_FIGURE_CDN}${safe}.${ext}`;
}

// Get the icon URL for an operator (smaller, used as last-resort fallback)
function getOperatorIconUrl(operatorName) {
  if (!operatorName) return null;
  const safe = OPERATOR_SAFENAMES[operatorName.toLowerCase().trim()];
  if (!safe) return null;
  return `${OPERATOR_ICON_CDN}${safe}.svg`;
}

// Extract operator name from item name like "Thermite Elite" �  "Thermite"
function extractOperatorFromName(name) {
  if (!name) return null;
  // Remove common suffixes
  const cleaned = name
    .replace(/\s*\(.*\)\s*$/, '')  // "(Tombraider)"
    .replace(/\s+Elite\s*$/i, '')
    .replace(/\s+Black\s+Ice\s*$/i, '')
    .trim();
  if (cleaned && OPERATOR_SAFENAMES[cleaned.toLowerCase()]) return cleaned;
  // Try first word
  const first = cleaned.split(/\s+/)[0];
  if (first && OPERATOR_SAFENAMES[first.toLowerCase()]) return first;
  return null;
}

// Extract operator name from API tags like "Character.Legacy.FUZE", "Character.GRIM"
function extractOperatorFromItemTags(tags) {
  if (!tags || !Array.isArray(tags)) return null;
  for (const t of tags) {
    if (typeof t !== 'string') continue;
    const m = t.match(/^Character\.(?:Legacy\.)?([A-Z][A-Z0-9_]+)$/i);
    if (m) {
      const raw = m[1].replace(/_/g, ' ').toLowerCase();
      // Title-case
      return raw.split(/\s+/).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    }
  }
  return null;
}

// Inline SVG icons for each category � guaranteed to render, no network round-trip.
// Each is a simple monochrome glyph on a transparent background sized 64�64.
function svgTile(inner) {
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">' +
    '<rect width="64" height="64" rx="8" fill="#0c1424" stroke="#1a2540"/>' +
    '<g fill="none" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">' + inner + '</g>' +
    '</svg>'
  );
}
// Clean, encoding-safe vector category icons (no emoji/text that can mojibake).
const GENERIC_ICONS = {
  weapon:     svgTile('<path d="M32 14C40 27 45 33 45 40a13 13 0 1 1-26 0c0-7 5-13 13-26Z" fill="#9b6cff" stroke="#b18cff"/>'),
  seasonal:   svgTile('<path d="M32 14C40 27 45 33 45 40a13 13 0 1 1-26 0c0-7 5-13 13-26Z" fill="#5aa3ff" stroke="#7fbcff"/>'),
  blackice:   svgTile('<g stroke="#8fd8ff"><path d="M32 14v36M16 23l32 18M48 23 16 41"/><path d="M27 18l5 4 5-4M27 46l5-4 5 4"/></g>'),
  glacier:    svgTile('<g stroke="#bdecff"><path d="M32 14v36M16 23l32 18M48 23 16 41"/></g>'),
  headgear:   svgTile('<g stroke="#e8a53a"><path d="M15 41a17 17 0 0 1 34 0"/><path d="M13 41h38"/></g>'),
  uniform:    svgTile('<path d="M25 16l7 5 7-5 9 6-4 9-5-2v21H25V29l-5 2-4-9z" stroke="#3aff8d"/>'),
  charm:      svgTile('<g stroke="#ff8a8a"><circle cx="32" cy="42" r="9"/><path d="M32 33v-7a6 6 0 0 1 12 0"/></g>'),
  attachment: svgTile('<g stroke="#5aa3ff"><circle cx="32" cy="32" r="12"/><path d="M32 15v7M32 42v7M15 32h7M42 32h7"/></g>'),
  card:       svgTile('<g stroke="#e8a53a"><rect x="15" y="19" width="34" height="26" rx="3"/><circle cx="26" cy="30" r="4"/><path d="M34 28h11M34 34h11M19 40h26"/></g>'),
  drone:      svgTile('<g stroke="#5aa3ff"><circle cx="32" cy="34" r="8"/><circle cx="19" cy="24" r="4"/><circle cx="45" cy="24" r="4"/><path d="M22 27l6 4M42 27l-6 4"/></g>'),
  gadget:     svgTile('<g stroke="#e8a53a"><circle cx="32" cy="32" r="7"/><path d="M32 17v6M32 41v6M17 32h6M41 32h6M21 21l4 4M39 39l4 4M43 21l-4 4M25 39l-4 4"/></g>'),
  elite:      svgTile('<path d="M32 15l5 11 12 2-9 8 2 12-10-6-10 6 2-12-9-8 12-2z" fill="#ffd24d" stroke="#ffd24d"/>'),
};
// Final fallback - used only if a category-specific icon isn't picked.
const PLACEHOLDER_SVG = svgTile('<g stroke="#7d8aa3"><circle cx="32" cy="32" r="15"/><path d="M32 23v11M32 41h.01"/></g>');

// Map a section title (or apiType) to a generic icon URL.
function genericIconFor(category, apiType) {
  const cat = (category || '').toLowerCase();
  const at  = (apiType  || '').toLowerCase();

  if (/black\s*ice/.test(cat)) return GENERIC_ICONS.blackice;
  if (/glacier/.test(cat))     return GENERIC_ICONS.glacier;
  if (/elite/.test(cat))       return GENERIC_ICONS.elite;
  if (/charm/.test(cat) || /charm/.test(at))           return GENERIC_ICONS.charm;
  if (/headgear/.test(cat) || at === 'characterheadgear') return GENERIC_ICONS.headgear;
  if (/uniform/.test(cat)  || at === 'characteruniform')  return GENERIC_ICONS.uniform;
  if (/attachment/.test(cat) || /attachment/.test(at))    return GENERIC_ICONS.attachment;
  if (/operator card|operatorcard|mvp/.test(cat) || /operatorcard|mvp/.test(at)) return GENERIC_ICONS.card;
  if (/drone/.test(cat) || at === 'droneskin')   return GENERIC_ICONS.drone;
  if (/gadget/.test(cat) || at === 'gadgetskin') return GENERIC_ICONS.gadget;
  if (/seasonal/.test(cat)) return GENERIC_ICONS.seasonal;
  return GENERIC_ICONS.weapon;
}

// Construct an item-image URL from Ubisoft's asset ID if the API didn't give us a URL.
// Pattern: {ubiCdn}/{spaceId}/MtxAssetsDeployer/{assetId-with-underscores}.png
const MTX_SPACES = [
  '0d2ae42d-4c27-4cb7-af6c-2099062302bb', // crossplay (most items)
  '5172a557-50b5-4665-b7db-e3f2e8c5041d', // PC
  '631d8095-c443-4e21-b301-4af1a0929c27', // PS
  '98a601e5-ca91-4440-b1c5-753f601a2c90', // Xbox
];
function constructAssetUrl(assetId, preferredSpace) {
  if (!assetId) return null;
  const id = assetId.replace(/-/g, '_');
  const space = preferredSpace || MTX_SPACES[0];
  return `https://ubiservices.cdn.ubi.com/${space}/MtxAssetsDeployer/${id}.png`;
}

// ── Manual item-id → image-URL curation ──────────────────────────────────
// For items where Ubisoft's API has no visualAssetId at all (~16% of inventory).
// Hot-reloads on file change so you can add entries without restarting.
let CURATION_CACHE = { mtime: 0, map: {} };
function getCuratedImage(itemId) {
  if (!itemId) return null;
  try {
    const fp = require('path').join(__dirname, '..', 'data', 'item-images.json');
    const stat = require('fs').statSync(fp);
    if (stat.mtimeMs !== CURATION_CACHE.mtime) {
      const data = JSON.parse(require('fs').readFileSync(fp, 'utf8'));
      CURATION_CACHE = { mtime: stat.mtimeMs, map: data.items || {} };
    }
    return CURATION_CACHE.map[itemId] || null;
  } catch { return null; }
}

// Extract operator name from any string by scanning for known operator names.
// Works on nameIds like "weapon_skins.Y7S2.Y7S2_Elite_Castle_Texture-M1014.POINT_BLANK_JUSTICE"
function extractOperatorFromAnyString(s) {
  if (!s) return null;
  const lower = s.toLowerCase().replace(/[-_.]/g, ' ');
  for (const opName of Object.keys(OPERATOR_SAFENAMES)) {
    const re = new RegExp(`(^|\\s)${opName}(\\s|$)`, 'i');
    if (re.test(lower)) return opName;
  }
  return null;
}

// Get a fallback image for items missing visualAssetUrl.
// GUARANTEE: never returns null — always at least a generic icon or placeholder.
function getFallbackImage(item, itemName, category) {
  const tags    = item.Tags ?? item.tags ?? [];
  const apiType = item.type ?? item.Type ?? '';
  const nameId  = item.nameId ?? '';
  const itemId  = item.ItemId ?? item.itemId ?? item.id ?? '';

  // 0. MANUAL CURATION — hand-picked URL for items missing data
  const curated = getCuratedImage(itemId);
  if (curated) return proxyImage(curated);

  // 0.5. MARKETPLACE CATALOG — official skin image keyed by item UUID. Covers
  //      most items Ubisoft's inventory details omit. Built (once, globally) by
  //      scripts/build-marketplace.js → data/marketplace-images.json.
  const mp = marketplace.getImage(itemId);
  if (mp) return proxyImage(mp);

  // 1. Asset-ID-derived URL: construct from visualAssetId if URL is missing
  const assetId = item.assets?.visualAssetId;
  if (assetId) {
    const url = constructAssetUrl(assetId, item.spaceId);
    if (url) return proxyImage(url);
  }

  // 2. Extract operator from item name OR nameId OR tags — most thorough
  const op = extractOperatorFromName(itemName)
          ?? extractOperatorFromItemTags(tags)
          ?? extractOperatorFromAnyString(itemName)
          ?? extractOperatorFromAnyString(nameId);

  // 3. Elite skin artwork (Ubisoft staticctf CDN) when we have an operator
  if (op && (category === 'Elites' || /elite/i.test(itemName) || /elite/i.test(nameId))) {
    const eliteUrl = getEliteSkinImage(op);
    if (eliteUrl) return proxyImage(eliteUrl);
  }

  // 4. Operator figure for ANY operator-themed item (headgear, uniform,
  //    weapon skin with operator name, charm tied to an operator, etc.)
  if (op) {
    const figUrl = getOperatorFigureUrl(op);
    if (figUrl) return proxyImage(figUrl);
  }

  // 5. Operator card / MVP — use small operator icon (or generic recruit if no op)
  if (/OperatorCard|MVPAnimation/i.test(apiType)) {
    const url = getOperatorIconUrl(op || 'recruit');
    if (url) return proxyImage(url);
  }

  // 6. Generic category SVG — never null
  return genericIconFor(category, apiType) || PLACEHOLDER_SVG;
}

// localizedNames: optional map of itemId �  localized display name from the localization API
function normalizeItem(i, localizedNames = {}) {
  const tags    = i.Tags ?? i.tags ?? [];
  const apiType = i.type ?? i.Type ?? null;
  const itemId  = i.ItemId ?? i.itemId ?? i.id ?? '';

  // Manual curation overrides EVERYTHING (so you can fix wrong/ugly Ubisoft images too)
  let image = proxyImage(getCuratedImage(itemId));

  // Fall back to Ubisoft API URL if no curation entry
  if (!image) {
    const rawImage = i.assets?.visualAssetUrl ?? null;
    image = proxyImage(rawImage);
  }

  // Name resolution priority:
  //   1. Localization API result (real display name, e.g. "M4 Black Ice")
  //   2. Cleaned API ItemName field (has hex hashes / noisy prefixes stripped)
  //   3. Formatted internal nameId (best-effort readable version of the slug)
  //   4. Raw item ID as last resort
  const localName = localizedNames[itemId] ?? null;
  const apiName   = cleanItemName(i.ItemName ?? i.itemName ?? null);
  const nameIdFmt = formatNameId(i.nameId);
  const resolvedName = localName ?? apiName ?? nameIdFmt ?? itemId ?? 'Unknown';

  // If Ubisoft API didn't return an image, try operator-based fallback
  if (!image) {
    image = getFallbackImage(i, resolvedName, null);
  }

  return {
    id:     itemId,
    name:   resolvedName,
    image,
    rarity: extractRarity(tags),
    type:   extractType(tags, apiType),
  };
}

// Scan charm items from the inventory to find ranked charms.
// Ranked charms have season-coded tags (e.g. "Y11S1") and rank info in their nameId
// (e.g. "CHARM_RANKED_Y11S1_CHAMPION" or "charm.ranked.y11s1.champion").
// Returns [{season, seasonName, rankTier, iconUrl}] sorted newest-first.
function detectSeasonRanksFromCharms(allDetails) {
  const SEASON_CODES = Object.keys(YEAR_SEASON_TO_NUM); // ['Y1S1','Y1S2',...]
  const TIER_ORDER   = ['champion','diamond','emerald','platinum','gold','silver','bronze','copper'];

  const bestByseason = new Map(); // seasonNum �  { rankTier, priority }

  for (const item of allDetails) {
    const apiType = item.type ?? item.Type ?? '';
    if (apiType !== 'Charm' && apiType !== 'CharmAttachment') continue;

    const tags   = item.Tags ?? item.tags ?? [];
    const nameId = (item.nameId ?? '').toLowerCase();

    // Ranked charms always have "ranked" somewhere in their nameId or tags
    const hasRankedHint =
      nameId.includes('ranked') || nameId.includes('rank') ||
      tags.some(t => typeof t === 'string' && t.toLowerCase().includes('ranked'));
    if (!hasRankedHint) continue;

    // Season: scan tags for known codes (Y11S1, Y10S4, ⬦)
    let seasonNum = null;
    for (const tag of tags) {
      if (typeof tag !== 'string') continue;
      const tagUp = tag.toUpperCase().trim();
      if (YEAR_SEASON_TO_NUM[tagUp] != null) { seasonNum = YEAR_SEASON_TO_NUM[tagUp]; break; }
    }
    // Also scan nameId itself for codes
    if (seasonNum == null) {
      for (const code of SEASON_CODES) {
        if (nameId.includes(code.toLowerCase())) { seasonNum = YEAR_SEASON_TO_NUM[code]; break; }
      }
    }
    if (seasonNum == null) continue;

    // Tier: check nameId first, then fall back to rarity
    let rankTier = null;
    for (const tier of TIER_ORDER) {
      if (nameId.includes(tier)) { rankTier = tier; break; }
    }
    if (!rankTier) {
      const rar = extractRarity(tags);
      rankTier = rar === 'Legendary' ? 'champion'
               : rar === 'Epic'      ? 'diamond'
               : rar === 'Rare'      ? 'emerald'
               : rar === 'Uncommon'  ? 'platinum'
               : null; // 'Common' is too broad (gold/silver/bronze/copper)
    }
    if (!rankTier) continue;

    const priority = TIER_ORDER.indexOf(rankTier);
    const current  = bestByseason.get(seasonNum);
    // Keep the highest rank (lowest index) seen for this season
    if (!current || priority < current.priority) {
      bestByseason.set(seasonNum, { rankTier, priority, nameId: item.nameId });
    }
  }

  const results = [];
  for (const [seasonNum, info] of bestByseason.entries()) {
    const rankEntry  = RANKS_V6.find(r => r.tier === info.rankTier) ?? RANKS_V6[0];
    const rawIconUrl = `${RANK_ICON_CDN}${rankEntry.slug}.png`;
    results.push({
      season:     seasonNum,
      seasonName: SEASON_NAMES[seasonNum] ?? `Season ${seasonNum}`,
      rank:       rankEntry.id,
      rankName:   rankEntry.name,
      rankTier:   info.rankTier,
      mmr:        0,           // inventory doesn't tell us MMR
      iconUrl:    proxyImage(rawIconUrl) ?? rawIconUrl,
      champPosition: null,     // will be patched by live API if available
      source:     'inventory', // tag so we know where this came from
    });
  }

  results.sort((a, b) => b.season - a.season);
  if (results.length) {
    console.log(`[ranked-detect] ${results.length} season(s) from inventory charms: [${results.map(r => `S${r.season}=${r.rankTier}`).join(', ')}]`);
  }
  return results;
}

// Global item-DETAIL cache. The /v1/spaces/items?itemIds= endpoint returns the
// SAME data for every player (itemId → name/type/asset is global game data), so
// we fetch each itemId at most ONCE process-wide instead of re-fetching it for
// every account. After warmup this eliminates ~all of inventory "step 2" — the
// single biggest per-valid-account network cost — and frees the UBI_RPS budget
// for the calls that must happen. Only POSITIVE results are cached (a transient
// miss is retried next time, never poisoned). Capped so it can't grow unbounded.
const _itemDetailCache = new Map();
// In-flight map: itemId → Promise<detail>. Prevents the cold-cache stampede
// where N concurrent workers all miss the same itemId and each fires a redundant
// batch fetch for it. When a worker wants an itemId already in flight, it just
// awaits the existing promise. Cleared on settle (success OR failure).
const _itemDetailPending = new Map();
const ITEM_CACHE_MAX = Number(process.env.ITEM_CACHE_MAX) || 60000;
function _itemId(d) { return d && (d.ItemId ?? d.itemId ?? d.id ?? d.ItemID); }
function _cacheItemDetail(id, detail) {
  if (!id || !detail) return;
  if (_itemDetailCache.size >= ITEM_CACHE_MAX && !_itemDetailCache.has(id)) {
    let n = Math.ceil(ITEM_CACHE_MAX * 0.1);           // evict oldest ~10%
    for (const k of _itemDetailCache.keys()) { _itemDetailCache.delete(k); if (--n <= 0) break; }
  }
  _itemDetailCache.set(id, detail);
}

async function getInventory(profileId, ticket, sessionId, appId) {
  const headers = inventoryHeaders(ticket, sessionId, appId);
  const empty   = { seasonals: [], universals: [], blackIces: [], rankedCharms: [], attachmentSkins: [] };

  // ���� Step 1: fetch owned item IDs ������������������������������������������������������������������������������������
  // Try crossplay space first (0d2ae42d-...) then PC-specific space as fallback
  let ownedItems = [];
  const step1Urls = [
    `https://public-ubiservices.ubi.com/v1/profiles/${profileId}/inventory?spaceId=${CROSSPLAY_SPACE_ID}`,
    `https://public-ubiservices.ubi.com/v1/profiles/${profileId}/inventory?spaceId=${PC_SPACE_ID}`,
    `https://public-ubiservices.ubi.com/v2/profiles/${profileId}/inventory?spaceId=${CROSSPLAY_SPACE_ID}`,
    `https://public-ubiservices.ubi.com/v2/profiles/${profileId}/inventory?spaceId=${PC_SPACE_ID}`,
  ];

  for (const url of step1Urls) {
    try {
      const res = await ubiRequest({ method: 'get', url, headers });
      dbg(`Inventory step 1 response from ${url}:`, JSON.stringify(res.data).slice(0, 300));
      const raw = res.data.Inventory ?? res.data.inventory ?? res.data.ItemInstances ?? res.data.items ?? null;
      if (raw && raw.length) {
        ownedItems = raw;
        dbg(`Inventory step 1 OK: ${url} (${raw.length} items)`);
        break;
      } else {
        dbg(`Inventory step 1 returned no items from ${url}`);
      }
    } catch (e) {
      console.warn('Inventory step 1 failed:', url, e.response?.status ?? e.message);
    }
  }

  if (!ownedItems.length) {
    console.warn('No inventory items found, returning empty');
    return empty;
  }

  // ���� Step 2: fetch item details in batches of 50 ������������������������������������������������������
  // URL confirmed by Siege_Skin_Checker: spaceId is a query param, NOT a path segment
  const BATCH = 50;
  const ids = ownedItems
    .map(i => i.ItemId ?? i.itemId ?? i.id ?? i.ItemID)
    .filter(Boolean);

  // Three buckets per item: CACHED (free) | PENDING (another worker is already
  // fetching it — await their result) | TO-FETCH (genuinely first to ask). The
  // PENDING bucket is the cold-cache stampede fix: 100 workers hitting the same
  // uncached itemId at once now share ONE batch fetch instead of firing 100.
  const cachedDetails = [];
  const pendingPromises = [];
  const toFetch = [];
  const seen = new Set();
  for (const id of ids) {
    if (seen.has(id)) continue; seen.add(id);
    const hit = _itemDetailCache.get(id);
    if (hit !== undefined) { cachedDetails.push(hit); continue; }
    const pending = _itemDetailPending.get(id);
    if (pending) { pendingPromises.push(pending); continue; }
    toFetch.push(id);
  }
  // For TO-FETCH items, batch in 50s. BEFORE firing the network call, register a
  // per-id promise so concurrent workers race-resolve through the PENDING path
  // instead of duplicating work.
  const batchPromises = [];
  for (let i = 0; i < toFetch.length; i += BATCH) {
    const batchIdx = Math.floor(i / BATCH) + 1;
    const batchIds = toFetch.slice(i, i + BATCH);
    const batchPromise = ubiRequest({
      method: 'get',
      url: `https://public-ubiservices.ubi.com/v1/spaces/items?spaceId=${CROSSPLAY_SPACE_ID}&itemIds=${batchIds.join(',')}`,
      headers,
    })
    .then(res => res.data.Items ?? res.data.items ?? [])
    .catch(e => {
      console.warn(`Item details batch ${batchIdx} failed:`, e.response?.status ?? e.message);
      return [];
    });
    // Register a per-id promise so concurrent fetchers find this in PENDING.
    // Each per-id promise pulls its own item out of the batch result by id and
    // self-cleans the PENDING map regardless of success — never leaks a slot.
    for (const id of batchIds) {
      const perId = batchPromise.then(items => {
        const hit = items.find(it => _itemId(it) === id) || null;
        if (hit) _cacheItemDetail(id, hit);
        return hit;
      }).finally(() => { if (_itemDetailPending.get(id) === perId) _itemDetailPending.delete(id); });
      _itemDetailPending.set(id, perId);
    }
    batchPromises.push(batchPromise);
  }
  const [fetchedDetails, pendingDetails] = await Promise.all([
    Promise.all(batchPromises).then(arr => arr.flat()),
    Promise.all(pendingPromises).then(arr => arr.filter(Boolean)),
  ]);
  const allDetails = cachedDetails.concat(pendingDetails, fetchedDetails);

  dbg(`Inventory step 2: ${allDetails.length}/${ids.length} item details (${cachedDetails.length} cached, ${pendingDetails.length} dedup'd, ${toFetch.length} fetched in ${batchPromises.length} batches)`);
  // Log type distribution so we can see what categories exist (debug-gated —
  // the whole scan is skipped unless R6_DEBUG_INVENTORY is set).
  if (DEBUG_INV && allDetails.length > 0) {
    const typeDist = {};
    for (const d of allDetails) {
      const t = d.type ?? d.Type ?? 'unknown';
      typeDist[t] = (typeDist[t] || 0) + 1;
    }
    console.log('[debug] item type distribution:', JSON.stringify(typeDist));
    // Log one sample cosmetic item (skip ChallengeProgression)
    const sampleCosmetic = allDetails.find(d => d.type && d.type !== 'ChallengeProgression');
    if (sampleCosmetic) console.log('[debug] sample cosmetic item:', JSON.stringify(sampleCosmetic));
  }

  // ���� Step 2a-log: dump all charm nameIds so we can identify ranked-charm patterns ����
  if (DEBUG_INV) {
    const charms = allDetails.filter(d => { const t = d.type ?? d.Type ?? ''; return t === 'Charm' || t === 'CharmAttachment'; });
    if (charms.length) {
      console.log(`[charm-debug] ${charms.length} charm(s) found. nameIds:`);
      charms.forEach(c => console.log(`  charm nameId="${c.nameId}" tags=${JSON.stringify((c.Tags ?? c.tags ?? []).slice(0,6))}`));
    }
  }

  // ���� Step 2b: parse virtual_currency items for renown / R6 credits ������������������
  // Build itemId �  quantity map from the raw inventory (step 1 data has quantities)
  const itemQuantities = new Map();
  for (const oi of ownedItems) {
    const id = oi.ItemId ?? oi.itemId ?? oi.id ?? oi.ItemID ?? '';
    if (id) itemQuantities.set(id, oi.quantity ?? 1);
  }
  let renown = 0, credits = 0;
  for (const d of allDetails) {
    if ((d.type ?? d.Type) !== 'virtual_currency') continue;
    const nid = (d.nameId ?? '').toLowerCase();
    const qty = itemQuantities.get(d.ItemId ?? d.itemId ?? d.id ?? '') ?? 0;
    dbg(`[currency] nameId=${d.nameId} qty=${qty}`);
    if (nid.includes('renown'))    renown  = qty;
    else if (nid.includes('credit')) credits = qty; // catches rb_credits, r6credits, etc.
  }
  if (renown || credits) dbg(`[currency] renown=${renown} credits=${credits}`);

  // ���� Step 2c: localized display names ��������������������������������������������������������������������������
  // Ubisoft's /v1/localizations endpoint returns 404 � it has been removed.
  // Name resolution falls back to cleanItemName() + formatNameId() from the nameId field.
  // Localized display names via the CURRENT Ubisoft endpoint
  //   GET /v1/spaces/:spaceId/localizations/strings?localizedStringIds=...
  // (the old /v1/localizations 404s). lib/ubisoftItems.js wraps it together
  // with /v1/spaces/:spaceId/items/all to build a global itemId->name catalog,
  // refreshed here with THIS check's fresh ticket. This is what produces
  // clean names instead of operator-name guesses (e.g. an attachment wrongly
  // labelled "Vigil"). SAFE: if the response shape doesn't match our parser,
  // the catalog stays empty and naming falls back to the old path — no
  // regression, just no upgrade.
  const localizedNames = {};
  try {
    const ubisoftItems = require('./ubisoftItems');
    // Refresh items/all (24h TTL) + resolve display names for THIS account's
    // owned items (≤20 ids/req, so ~3 calls for a typical inventory).
    await ubisoftItems.ensureForItems(ids, ticket, sessionId, appId);
    let hits = 0;
    for (const id of ids) {
      const meta = ubisoftItems.lookupItem(id);
      if (meta?.name) { localizedNames[id] = meta.name; hits++; }
    }
    dbg(`[inventory] localized ${hits}/${ids.length} names from Ubisoft items/all catalog`);
  } catch (e) {
    console.warn('[inventory] localization catalog unavailable:', e.message);
  }

  // ���� Step 2d: ranked charm detection skipped ������������������������������������������������������������������
  // We no longer try to detect ranks from inventory charms.  Instead, ranked
  // charms are generated from the season-rank API data (buildRankedCharms).
  const inventoryRankedSeasons = [];

  // Harvest the REAL charm image for any ranked charm the account OWNS, keyed
  // "season|tier". buildRankedCharms uses these only when generated/catalog
  // charm art is missing, so the scraped ranked charm map stays authoritative.
  const ownedRankedCharmImages = {};
  {
    const T_ORDER = ['champion','diamond','emerald','platinum','gold','silver','bronze','copper'];
    const S_CODES = Object.keys(YEAR_SEASON_TO_NUM);
    for (const item of allDetails) {
      const apiType = item.type ?? item.Type ?? '';
      if (apiType !== 'Charm' && apiType !== 'CharmAttachment') continue;
      const tags   = item.Tags ?? item.tags ?? [];
      const nameId = (item.nameId ?? '').toLowerCase();
      const ranked = nameId.includes('rank') || tags.some(t => typeof t === 'string' && t.toLowerCase().includes('ranked'));
      if (!ranked) continue;
      let seasonNum = null;
      for (const tag of tags) { const u = String(tag).toUpperCase().trim(); if (YEAR_SEASON_TO_NUM[u] != null) { seasonNum = YEAR_SEASON_TO_NUM[u]; break; } }
      if (seasonNum == null) for (const code of S_CODES) { if (nameId.includes(code.toLowerCase())) { seasonNum = YEAR_SEASON_TO_NUM[code]; break; } }
      if (seasonNum == null) continue;
      let tier = T_ORDER.find(t => nameId.includes(t)) || null;
      if (!tier) {
        const rar = extractRarity(tags);
        tier = rar === 'Legendary' ? 'champion' : rar === 'Epic' ? 'diamond' : rar === 'Rare' ? 'emerald' : rar === 'Uncommon' ? 'platinum' : null;
      }
      if (!tier) continue;
      const raw = item.assets?.visualAssetUrl ?? item.assets?.VisualAssetUrl ?? null;
      const img = proxyImage(getCuratedImage(item.ItemId ?? item.itemId ?? item.id)) || proxyImage(raw);
      if (img) ownedRankedCharmImages[`${seasonNum}|${tier}`] = img;
    }
  }

  // ���� Step 3: categorise by catalog lookup first, fall back to type/tags ��������
  const catalog = getItemCatalog();

  // Build a fast id �  detail lookup
  const detailById = new Map();
  for (const d of allDetails) {
    const id = d.ItemId ?? d.itemId ?? d.id ?? '';
    if (id) detailById.set(id, d);
  }

  // Map owned item IDs �  catalog entries (fast lookup)
  const catalogHits = { Seasonals: [], 'Black Ice': [], 'Dust Line': [], Racer: [],
    'Pro Leagues': [], Elites: [], Charms: [], 'Gold Dusts': [], Specialty: [],
    Boosters: [], 'Attachment Skins': [] };
  const catalogMissIds = new Set();

  for (const id of ids) {
    const entry = catalog[id];
    if (entry) {
      const cat = entry.category;
      if (!catalogHits[cat]) catalogHits[cat] = [];
      // Merge catalog name with any API-provided image (proxied)
      const apiDetail = detailById.get(id) ?? {};
      let catImage = proxyImage(apiDetail.assets?.visualAssetUrl ?? null);
      // Fallback: use operator figure/icon when Ubisoft doesn't provide an image
      if (!catImage) {
        catImage = getFallbackImage(apiDetail, entry.name, cat);
      }
      // Guarantee an image � fall back to category icon if both API & elite lookups fail
      if (!catImage) catImage = getFallbackImage(apiDetail, entry.name, cat);
      catalogHits[cat].push({
        id,
        // Ubisoft localization name wins when available (cleanest), else the
        // local catalog name.
        name:   localizedNames[id] ?? entry.name,
        image:  catImage,
        rarity: extractRarity(apiDetail.Tags ?? apiDetail.tags ?? []) || 'Standard',
        type:   extractType(apiDetail.Tags ?? apiDetail.tags ?? [], apiDetail.type ?? apiDetail.Type) || cat,
      });
    } else {
      catalogMissIds.add(id);
    }
  }
  dbg(`Catalog hits: ${ids.length - catalogMissIds.size}/${ids.length}, misses: ${catalogMissIds.size}`);

  // Non-cosmetic types to skip entirely
  const NON_COSMETIC_TYPES = new Set([
    'ChallengeProgression', 'ProgressionReward', 'ProfileProgression',
    'BattlePassV2Node', 'BattlePassV2PremiumNode', 'BattlePassV2Point',
    'BattlePassV2Token', 'BattlePassV2Premium',
    'Booster', 'FlatDiscount', 'CurrencyToken', 'virtual_currency',
    'ItemsPoolsRewardClaimToken', 'lootcrate',
    'MigrationStep', 'Paragon', 'bundles',
    'Character', 'CharacterSet',
  ]);

  // ���� Dynamic categorisation of ALL cosmetic items ��������������������������������������������������
  // Categorise every item (catalog + non-catalog) by nameId / tags patterns.
  // This replaces the old catalog-only approach.
  const categoryBuckets = new Map(); // categoryTitle �  [normalizedItem]

  function addToBucket(title, item, raw) {
    // Final safety net: every item exits the pipeline with an image + non-garbage name
    if (!item.image) item.image = PLACEHOLDER_SVG;
    item.name = finalNameClean(item.name, title);

    // Skip "ghost" items — Ubisoft has them in inventory but NO image (any data: URI)
    // AND no useful name (just a bare type). These are leftover seasonal-camo records,
    // Y10S4 placeholder battlepass items, etc. Showing them as "Uniform #7" with a
    // question mark is worse UX than hiding them.
    const hasOnlyDataUriImage = (item.image || '').startsWith('data:');
    const hasBareTypeName = /^(Uniform|Headgear|Card|Skin|Charm|Drone|Gadget|Attachment|Background|Portrait|Badge|Item)(\s|$)/i.test(item.name);
    if (hasOnlyDataUriImage && hasBareTypeName) return;

    // Stash raw item for the dedup pass (stripped before final response)
    if (raw) Object.defineProperty(item, '__raw', { value: raw, enumerable: false });
    if (!categoryBuckets.has(title)) categoryBuckets.set(title, []);
    categoryBuckets.get(title).push(item);
  }

  // nameId pattern �  category title (checked in order, first match wins)
  // NOTE: Black Ices and Glaciers are weapon-skin-only collections.
  //       The WeaponSkin gate is enforced in classifyItem() below.
  const COLLECTION_PATTERNS = [
    [/black_?ice/i,                                'Black Ices'],
    [/glacier/i,                                    'Glaciers'],
    [/elite_?set|eliteskin/i,                       'Elites'],
    [/seasonal_?camo|seasonalcamo/i,               'Seasonals'],
    // universal matched separately below � needs apiType check
    [/proleague|pro_league|pro\.league/i,          'Pro Leagues'],
    [/esport/i,                                     'Esport Packs'],
    [/dust_?line|dustline/i,                       'Dust Line'],
    [/racer/i,                                      'Racer'],
    [/gold_?dust|golddust/i,                       'Gold Dusts'],
    [/mute_?protocol|muteprotocol/i,               'M.U.T.E Protocol'],
    [/rengoku/i,                                    'Rengoku'],
    [/doktor|doctor.*curse/i,                       'Doktors Curse'],
    [/rainbow.*magic/i,                             'Rainbow Is Magic'],
    [/showdown/i,                                   'Showdown'],
    [/apocalypse/i,                                 'Apocalypse'],
    [/containment/i,                                'Containment'],
    [/snow_?brawl|snowbrawl/i,                     'Snow Brawl'],
    [/sugar_?fright|sugarfright/i,                 'Sugar Fright'],
    [/grand_?larceny|grandlarceny/i,               'Grand Larceny'],
    [/stadium/i,                                    'Stadium'],
    [/r6_?cup|r6cup/i,                             'R6 Cup Rewards'],
    [/invitational/i,                               'Invitational'],
    [/arcana/i,                                     'Arcana'],
    [/sunsplash/i,                                  'Sunsplash'],
    [/wind_?bastion|windbastion/i,                 'Wind Bastion'],
    [/ember_?rise|emberrise/i,                     'Ember Rise'],
    [/influencer/i,                                 'Influencers'],
    [/redhammer/i,                                  'Redhammer'],
    [/gadget_?skin|gadgetskin/i,                   'Gadget Skins'],
    [/drone_?skin|droneskin/i,                     'Drone Skins'],
    [/attachment_?skin|attachmentskin/i,            'Attachment Skins'],
  ];

  // Tag-based patterns (checked if nameId patterns don't match)
  const TAG_PATTERNS = [
    ['esport',          'Esport Packs'],
    ['pilot_program',   'Pilot Programs'],
    ['proleague',       'Pro Leagues'],
  ];

  function classifyItem(item) {
    const nid   = (item.nameId ?? '').toLowerCase();
    const apiType = item.type ?? item.Type ?? '';
    const tags  = (item.Tags ?? item.tags ?? []).map(t => typeof t === 'string' ? t.toLowerCase() : '');

    // Sections that are STRICTLY weapon skins. Charms / headgear / uniforms /
    // attachments that happen to share the collection name go elsewhere.
    const WEAPON_SKIN_ONLY_CATS = new Set(['Black Ices', 'Glaciers']);
    const isWeaponSkinType = apiType === 'WeaponSkin'
      || apiType === 'WeaponAttachmentSkinSet'
      || apiType === 'WeaponAttachmentSkin';
    // Charms attached to a Black Ice / Glacier weapon are still charms.
    const isCharmType = apiType === 'Charm';

    // 1. Check nameId against collection patterns
    for (const [re, cat] of COLLECTION_PATTERNS) {
      if (re.test(nid)) {
        if (WEAPON_SKIN_ONLY_CATS.has(cat)) {
          if (!isWeaponSkinType || isCharmType) {
            // Skip � let the matcher fall through so the item lands in
            // Charms / Headgears / Attachment Skins where it belongs.
            continue;
          }
          // Filter out attachment-only entries too � Black Ice / Glacier
          // sections show full weapon skins, not just sights or grips.
          if (apiType !== 'WeaponSkin') continue;
        }
        return cat;
      }
    }

    // 1b. Universal � only for weapon skins/attachment skins, not charms/headgears/etc.
    if (/universal/i.test(nid)) {
      if (apiType === 'WeaponSkin' || apiType === 'WeaponAttachmentSkinSet' || apiType === 'WeaponAttachmentSkin') {
        return 'Universals';
      }
      // For non-weapon types, fall through to other classification
    }

    // 2. Pilot Programs � detect year from nameId or tags
    if (/pilot_?program|pilotprogram/i.test(nid)) {
      const ym = nid.match(/y(\d+)/i) || tags.join(' ').match(/y(\d+)/i);
      return ym ? `Y${ym[1]} Pilot Programs` : 'Pilot Programs';
    }

    // 3. Check tags
    for (const [tagKey, cat] of TAG_PATTERNS) {
      if (tags.some(t => t.includes(tagKey))) return cat;
    }

    // 4. Fall back to API type grouping
    switch (apiType) {
      case 'WeaponSkin': {
        // Split weapon skins by rarity to match reference site
        const rarity = extractRarity(item.Tags ?? item.tags ?? []);
        if (rarity === 'Legendary') return 'Legendary Weapon Skins';
        if (rarity === 'Epic')      return 'Epic Weapon Skins';
        if (rarity === 'Rare')      return 'Rare Weapon Skins';
        if (rarity === 'Uncommon')  return 'Uncommon Weapon Skins';
        return 'Weapon Skins'; // Common/Standard fallback
      }
      case 'CharacterHeadgear':        return 'Headgears';
      case 'CharacterUniform':         return 'Uniforms';
      case 'Charm':                    return 'Charms';
      case 'OperatorCardPortrait':     return 'Operator Cards';
      case 'OperatorCardBackground':   return 'Operator Cards';
      case 'OperatorCardBadge':        return 'Operator Cards';
      case 'GadgetSkin':               return 'Gadget Skins';
      case 'DroneSkin':                return 'Drone Skins';
      case 'MVPAnimation':             return 'MVP Animations';
      case 'WeaponAttachmentSkinSet':  return 'Attachment Skins';
      case 'WeaponAttachmentSkin':     return 'Attachment Skins';
      case 'OperatorVideoCard':        return 'Operator Cards';
      default:                         return null; // skip unknown
    }
  }

  const processedIds = new Set();

  // Build reverse map: Y6S4 �  season name for seasonal camo naming
  const CODE_TO_SEASON_NAME = {};
  for (const [code, num] of Object.entries(YEAR_SEASON_TO_NUM)) {
    if (SEASON_NAMES[num]) CODE_TO_SEASON_NAME[code.toLowerCase()] = SEASON_NAMES[num];
  }

  // Build a set of all season names for detecting season-name-only items
  const SEASON_NAME_SET = new Set(Object.values(SEASON_NAMES).map(n => n.toLowerCase()));

  // Categories that need name improvement (season names, "Camo", battle pass codes)
  const IMPROVE_NAME_CATEGORIES = new Set([
    'Seasonals', 'Black Ices', 'Glaciers', 'Headgears', 'Uniforms', 'Charms',
    'Weapon Skins', 'Legendary Weapon Skins', 'Epic Weapon Skins',
    'Rare Weapon Skins', 'Uncommon Weapon Skins',
    'Gadget Skins', 'Drone Skins', 'MVP Animations', 'Operator Cards',
    'Attachment Skins', 'Esport Packs', 'Elites',
    'Rainbow Is Magic', 'Showdown', 'Arcana', 'Containment',
  ]);

  // Process catalog-matched items first (they have curated names)
  // Map catalog categories to our section titles.
  const CATALOG_CAT_REMAP = {
    'Black Ice': 'Black Ices',
    'Specialty': 'Universals',
  };
  // Catalog says "Glacier" the item (Seasonals). We want it in its own section
  // when it's actually a weapon skin in the user's inventory.
  for (const [cat, items] of Object.entries(catalogHits)) {
    for (const item of items) {
      processedIds.add(item.id);
      const apiDetail = detailById.get(item.id) ?? {};
      const apiType   = apiDetail.type ?? apiDetail.Type ?? '';
      // Run dynamic classification � it knows about WeaponSkin gating.
      let category = classifyItem(apiDetail) ?? CATALOG_CAT_REMAP[cat] ?? cat;
      if (category === 'Boosters') continue; // skip non-cosmetic

      // Override: catalog item named "Glacier" that's actually a weapon skin
      // goes into the Glaciers section.
      if (/^glacier/i.test(item.name) && apiType === 'WeaponSkin') {
        category = 'Glaciers';
      }

      const processed = postProcessName(category, item, apiDetail);
      addToBucket(category, processed, apiDetail);
    }
  }

  // Extract operator name from tags like "Character.Legacy.FUZE", "Character.GRIM", etc.
  function extractOperatorFromTags(tags) {
    for (const t of tags) {
      if (typeof t !== 'string') continue;
      const m = t.match(/^Character\.(?:Legacy\.)?([A-Z][A-Z0-9_]+)$/i);
      if (m) {
        const raw = m[1].replace(/_/g, ' ').toLowerCase();
        // Title-case each word
        return raw.split(/\s+/).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
      }
    }
    return null;
  }

  // Check if a name contains a season name and extract it + operator part
  function splitSeasonFromName(name) {
    if (!name) return null;
    const lower = name.toLowerCase();
    // Check exact match first
    if (SEASON_NAME_SET.has(lower)) return { operator: null, season: name };
    // Check if name ends with a season name (e.g., "Kaid Neon Dawn" �  operator="Kaid", season="Neon Dawn")
    for (const [, sname] of Object.entries(SEASON_NAMES)) {
      const sl = sname.toLowerCase();
      if (lower.endsWith(' ' + sl)) {
        const op = name.slice(0, name.length - sname.length - 1).trim();
        return { operator: op || null, season: sname };
      }
    }
    // Check if name starts with a season name
    for (const [, sname] of Object.entries(SEASON_NAMES)) {
      const sl = sname.toLowerCase();
      if (lower.startsWith(sl + ' ')) {
        const op = name.slice(sname.length + 1).trim();
        return { operator: op || null, season: sname };
      }
    }
    return null;
  }

  // Improve names for items in specific categories where raw API names are poor
  function improveSeasonalName(item, normalized) {
    const nid = (item.nameId ?? '').toLowerCase();
    const tags = item.Tags ?? item.tags ?? [];
    let name = normalized.name;

    // Step 1: Check if name contains a season name mixed with operator (e.g., "Kaid Neon Dawn")
    const splitResult = splitSeasonFromName(name);
    if (splitResult && splitResult.operator && splitResult.season) {
      normalized.name = `${splitResult.operator} (${splitResult.season})`;
      return normalized;
    }

    // Step 2: Check if name IS a season name, or is otherwise bad
    const isSeasonName = name && SEASON_NAME_SET.has(name.toLowerCase());
    const isCamo = name && (/^camo$/i.test(name) || /\bcamo\b/i.test(name));
    const isBattlePass = name && /^y\d+s\d+battlepass$/i.test(name);
    const isHgPrefix = name && /^hg\s/i.test(name);
    const isBadName = !name || name.length <= 3 || isCamo || isSeasonName || isBattlePass || isHgPrefix
                    || /^(dd|border|firefighter|panache|spetznaz|outsourcing)$/i.test(name)
                    || /^(uniform|headgear|hg)\s/i.test(name);
    // If name is already good, keep it
    if (name && !isBadName) return normalized;

    // Step 3: Extract season code from nameId
    const seasonMatch = nid.match(/y(\d+)s(\d+)/i);
    let seasonName = null;
    if (seasonMatch) {
      const code = `y${seasonMatch[1]}s${seasonMatch[2]}`;
      seasonName = CODE_TO_SEASON_NAME[code];
    }

    // Step 4: Extract operator from tags (most reliable source)
    let operatorFromTag = extractOperatorFromTags(tags);

    // Step 5: Extract operator from nameId segments as fallback
    const segments = nid.replace(/\./g, '_').split('_').filter(Boolean);
    const noiseTokens = new Set(['development','go','seasonal','seasonalcamo','camo','hg','bdu',
      'uniform','uniforms','headgear','headgears','weaponskin','weapon','skin','skins',
      'characterheadgear','characteruniform','charactheadgear','charactuniform',
      'character','set','default','standard','texture','outsourcing','themedcontent',
      'bp','battlepass','membership','attachment','attachments','bundle',
      'wass','was','instance','of','type','common','rare','epic','legendary','uncommon',
      'portrait','badge','background','videocard','card','operator','opcard',
      'gadgetskin','gadget','drone','droneskin','mvp','animation','mvpanimation',
      'victory','dance','victorydance','legacy','proleague','pro',
      'charm','charms','weaponcharms','universal','3d','2d',
      'event','collection','ws','lootcrate','r6cup','invitational',
      'alternative','business','community','team','dlc','esport','esports',
      'elite','eliteset','eliteskin','ranked','rank',
      'blackice','black','ice','shield','pattern',
      'visual','unlockable','modern','pol','rgb','white','arctic',
      'vc','smg','ar','lmg','dmr','sr','sg','pistol','mp','rifle',
      'signature','firefighter','border','dd','clh','wint']);
    const seasonWords = seasonName ? seasonName.toLowerCase().split(/\s+/) : [];
    const meaningful = segments.filter(seg => {
      if (noiseTokens.has(seg)) return false;
      if (/^y\d+s\d+/i.test(seg)) return false;
      if (/^0x[0-9a-f]+$/i.test(seg)) return false;
      if (/^[a-f0-9]{8,}$/i.test(seg)) return false;
      if (seg.length <= 1) return false;
      if (seasonWords.includes(seg)) return false;
      return true;
    });

    let operatorFromNameId = meaningful.length > 0
      ? meaningful.map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ')
      : null;

    // Remove duplicate words: "Fuze Fuze" �  "Fuze"
    if (operatorFromNameId) {
      const words = operatorFromNameId.split(/\s+/);
      if (words.length >= 2 && words[0].toLowerCase() === words[1].toLowerCase()) {
        operatorFromNameId = words.slice(1).join(' ');
      }
    }

    // Prefer tag-extracted operator, then nameId-extracted
    const operator = operatorFromTag ?? operatorFromNameId;

    if (operator && seasonName) {
      normalized.name = `${operator} (${seasonName})`;
    } else if (operator) {
      normalized.name = operator;
    } else if (seasonName) {
      // No operator found � use item type as prefix: "Uniform (Tenfold Pursuit)"
      const apiType = item.type ?? item.Type ?? '';
      const typeLabel = { CharacterUniform: 'Uniform', CharacterHeadgear: 'Headgear',
        WeaponSkin: 'Weapon Skin', Charm: 'Charm', GadgetSkin: 'Gadget Skin',
        DroneSkin: 'Drone Skin', MVPAnimation: 'MVP', OperatorCardPortrait: 'Portrait',
        OperatorCardBadge: 'Badge', OperatorCardBackground: 'Card BG',
        WeaponAttachmentSkin: 'Attachment', WeaponAttachmentSkinSet: 'Attachment Set',
      }[apiType] ?? '';
      normalized.name = typeLabel ? `${typeLabel} (${seasonName})` : seasonName;
    }
    return normalized;
  }

  // ���� Category-specific post-processing for names ����������������������������������������������������
  // Applied AFTER normalizeItem + improveSeasonalName to fix category-specific issues.
  function postProcessName(category, normalized, item) {
    let name = normalized.name;
    const nid = (item.nameId ?? '').toLowerCase();

    // ���� Black Ices: extract weapon name and ensure "Black Ice" suffix ����
    if (category === 'Black Ices') {
      // For Black Ices, we always try to extract the weapon name from nameId
      // because the API name is often garbage (WEAPON_SKINS, DEVELOPMENT, Instanceof, etc.)
      // Split nameId on dots, underscores, AND hyphens to extract weapon codes
      const biNidParts = nid.replace(/\./g, '-').replace(/_/g, '-').split('-').filter(p =>
        p.length > 1 &&
        !/^(weaponskins?|weapon|skins?|blackice|black|ice|r6unique|texture|instanceof|instance|of|seasonal|seasonalcamo|development|go|legacy|purple|pink|shield|headgear|headgears|gign|slot\d*|tier\d*|pattern|set|default|standard|outsourcing|character|uniform|bdu|hg|camo|visual|unlockable|y\d+s\d+.*|0x[0-9a-f]+|[a-f0-9]{8,})$/i.test(p)
      );

      // Check if current name is garbage (contains internal patterns)
      const isBadBI = /WEAPON_SKINS/i.test(name) || /DEVELOPMENT/i.test(name) ||
                      /Instanceof/i.test(name) || /Instance\s*Of/i.test(name) ||
                      /^Headgears?\b/i.test(name) || /Texture/i.test(name) ||
                      /Legacy\s+Black\s+Ice/i.test(name) || /INSTANCEOF/i.test(name);

      if (isBadBI && biNidParts.length > 0) {
        // Build weapon name from meaningful nameId parts
        // Filter out faction codes and keep weapon identifiers
        const weaponParts = biNidParts.filter(p =>
          !/^(gsg9|sas|fbi|gign|spetsnaz|navyseal|bope|jtf2|gigr|ctu|jfo|sek|sat|cbrn|nighthaven|wolfguard|osa|fenrir|deimos|warden)$/i.test(p)
        );
        if (weaponParts.length > 0) {
          name = weaponParts.map(p => p.toUpperCase()).join(' ');
        }
      } else {
        // Clean remaining patterns from otherwise ok names
        name = name
          .replace(/Instanceof-?black\s*Texture-?/gi, '')
          .replace(/Instanceof-?black\s*/gi, '')
          .replace(/Instance\s*of-?black\s*/gi, '')
          .trim();
        // Remove parenthetical season info
        name = name.replace(/\s*\([^)]*\)\s*$/, '').trim();
      }
      // Strip "Black Ice" prefix/suffix before re-adding (normalize)
      name = name.replace(/^Black\s+Ice\s+/i, '').replace(/\s+Black\s+Ice$/i, '').trim();
      // Clean slot/tier patterns
      name = name.replace(/\s*Slot\d+\s*Tier\d+\s*\d*/i, '').trim();
      name = name.replace(/\s+Gign\s*/i, ' ').trim();
      // Strip trailing numbers
      name = name.replace(/\s+\d{2,}$/g, '').trim();
      // Append "Black Ice"
      if (name && name.length > 0) {
        name = `${name} Black Ice`;
      }
      normalized.name = name;
    }

    // ���� Glaciers: same treatment as Black Ices ����
    if (category === 'Glaciers') {
      const glacNidParts = nid.replace(/\./g, '-').replace(/_/g, '-').split('-').filter(p =>
        p.length > 1 &&
        !/^(weaponskins?|weapon|skins?|glacier|r6unique|texture|instanceof|instance|of|seasonal|seasonalcamo|development|go|legacy|shield|headgear|headgears|slot\d*|tier\d*|pattern|set|default|standard|outsourcing|character|uniform|bdu|hg|camo|visual|unlockable|y\d+s\d+.*|0x[0-9a-f]+|[a-f0-9]{8,})$/i.test(p)
      );

      const isBadGlac = /WEAPON_SKINS/i.test(name) || /DEVELOPMENT/i.test(name)
        || /Instanceof/i.test(name) || /Instance\s*Of/i.test(name)
        || /^Headgears?\b/i.test(name) || /Texture/i.test(name)
        || /^Seasonals?\b/i.test(name) || /INSTANCEOF/i.test(name)
        || /^Glacier$/i.test(name); // bare "Glacier" � need the weapon name

      if (isBadGlac && glacNidParts.length > 0) {
        const weaponParts = glacNidParts.filter(p =>
          !/^(gsg9|sas|fbi|gign|spetsnaz|navyseal|bope|jtf2|gigr|ctu|jfo|sek|sat|cbrn|nighthaven|wolfguard|osa|fenrir|deimos|warden)$/i.test(p)
        );
        if (weaponParts.length > 0) {
          name = weaponParts.map(p => p.toUpperCase()).join(' ');
        }
      } else {
        name = name
          .replace(/Instanceof-?(?:black\s*)?Texture-?/gi, '')
          .replace(/Instanceof-?/gi, '')
          .replace(/Instance\s*of-?/gi, '')
          .replace(/\s*\([^)]*\)\s*$/, '')
          .trim();
      }
      name = name.replace(/^Glacier\s+/i, '').replace(/\s+Glacier$/i, '').trim();
      name = name.replace(/\s*Slot\d+\s*Tier\d+\s*\d*/i, '').trim();
      name = name.replace(/\s+\d{2,}$/g, '').trim();
      if (name && name.length > 0) {
        name = `${name} Glacier`;
      } else {
        name = 'Glacier'; // bare fallback � at least labelled
      }
      normalized.name = name;
    }

    // ���� Universals: aggressive cleanup of internal codes ����
    if (category === 'Universals') {
      // Strip verbose prefixes and internal code patterns
      name = name
        .replace(/^Skins?\s+Weaponuniversal.*/i, '')
        .replace(/^Weaponuniversal.*/i, '')
        .replace(/^Weapon\s+Universal\s+Visual\s+Unlockable[-\s]*/i, '')
        .replace(/^Weapon\s+Universal\s+/i, '')
        .replace(/^Universal\s+/i, '')
        .replace(/^Skins?\s+/i, '')
        .replace(/Modern\s+Camo[-\s]*[A-Z]?\s*/i, '')
        .replace(/\bPoland\s+Modern\s+Pol\s+/i, '')
        .replace(/\bModern\s+Pol\s+/i, '')
        .replace(/\bSignature\s+Event\s+Pattern\s+/i, '')
        .replace(/\bCollection\s+S\d+\s+/i, '')
        .replace(/\bRgb\s+White\s+/i, '')
        .replace(/\bVisual\s+Unlockable[-\s]*/i, '')
        .replace(/[-\s]+Camo[-\s]*[A-Za-z]?\s*$/i, '') // trailing "Camo-b" etc.
        .trim();
      // If result is too short or just "Camo", try extracting from nameId
      if (name.length <= 4 || /^Camo$/i.test(name)) {
        const uniParts = nid.replace(/\./g, '_').split('_').filter(p =>
          p.length > 2 &&
          !/^(weapon|universal|visual|unlockable|modern|camo|pattern|signature|event|collection|rgb|white|arctic|pol|poland|ws|texture|y\d+s\d+|0x[0-9a-f]+|[a-f0-9]{8,}|weaponskin|development|go)$/i.test(p)
        );
        if (uniParts.length > 0) {
          name = uniParts.map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
        }
      }
      // If still garbage or too short, use a generic label
      if (name.length <= 2 || /weaponuniversal/i.test(name)) name = 'Universal Camo';
      normalized.name = name;
    }

    // ���� R6 Cup: clean "Y9s3r6cup" patterns ����
    if (category === 'R6 Cup Rewards') {
      const cupMatch = name.match(/^Y(\d+)[Ss](\d+)\s*r6cup$/i);
      if (cupMatch) {
        const code = `y${cupMatch[1]}s${cupMatch[2]}`;
        const sn = CODE_TO_SEASON_NAME[code];
        name = sn ? `R6 Cup ${sn}` : `R6 Cup Y${cupMatch[1]}S${cupMatch[2]}`;
        normalized.name = name;
      }
    }

    // ���� Rainbow Is Magic: clean up and differentiate items ����
    if (category === 'Rainbow Is Magic') {
      // First, aggressively clean the name
      name = name
        .replace(/\bInstanceof[-\s]*y\d+s\d+\s*/gi, '')  // "Instanceof-y11s1"
        .replace(/\bInstanceof[-\s]*/gi, '')               // "Instanceof-"
        .replace(/\bTexture[-\s]*/gi, '')                   // "Texture-"
        .replace(/\bTextur\b/gi, '')                        // truncated "Textur"
        .replace(/\bEvent\s+Collection\s*/gi, '')           // "Event Collection"
        .replace(/\bI\s+Rainbowismagic\s+/gi, 'Rainbow Is Magic ')
        .replace(/\bRainbowismagic\s+/gi, 'Rainbow Is Magic ')
        .replace(/\s+/g, ' ')
        .trim();

      // Clean up leaked type names
      name = name
        .replace(/\bWeapon\s*attachment\s*skin\s*set\s*(?:Wass)?\b/gi, '')
        .replace(/\bWeaponattachmentskinset\b/gi, '')
        .replace(/\bDroneskin\s+Droneskin\b/gi, '')
        .replace(/\bDroneskin\b/gi, '')
        .replace(/\bMemento\s+3d[-\s]*/gi, '')
        .replace(/\bMk[-\s]*14[-\s]*Ebr\s+Variation\b/gi, 'Mk-14 EBR')
        .replace(/\bMk[-\s]*14[-\s]*Ebr\b/gi, 'Mk-14 EBR')
        .replace(/\s+/g, ' ').trim();

      // If it's still just "Rainbow Is Magic" with nothing distinguishing, try nameId
      if (/^Rainbow\s+Is\s+Magic\s*$/i.test(name)) {
        const rimParts = nid.replace(/\./g, '_').replace(/-/g, '_').split('_').filter(p =>
          p.length > 1 &&
          !/^(rainbow|is|magic|rainbowismagic|event|collection|ws|texture|textur|pattern|development|go|seasonal|instanceof|instance|of|y\d+s\d+|0x[0-9a-f]+|[a-f0-9]{8,}|weaponskin|weapon|charm|headgear|uniform|characterheadgear|characteruniform|signature|visual|unlockable|bp|battlepass|3d|2d|memento|variation|1|01|02|03|wass|was|attachment|attachmentskinset|droneskin|drone|skin|skins)$/i.test(p)
        );
        if (rimParts.length > 0) {
          const extracted = rimParts
            .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
            .join(' ');
          name = `Rainbow Is Magic ${extracted}`;
        }
      }
      normalized.name = name;
    }

    // ���� Attachment Skins: clean verbose names ����
    if (category === 'Attachment Skins') {
      name = name
        .replace(/^Wass\s+Was$/i, 'Default')
        .replace(/^Color\s+(Arctic)\s+\1$/i, '$1')  // "Color Arctic Arctic" �  "Arctic"
        .replace(/^Color\s+/i, '')                    // "Color Azurite" �  "Azurite"
        .replace(/^Pattern\s+Welcome\s+Pack\s+All$/i, 'Welcome Pack')
        .replace(/^Pattern\s+\d+\s+/i, '')            // "Pattern 03 Sinister Infusion" �  "Sinister Infusion"
        .replace(/^Event\s+Collection\s+/i, '')
        .trim();
      normalized.name = name;
    }

    // ���� General: clean any remaining "Textur" (truncated "Texture") suffix ����
    if (/\s+Textur$/i.test(normalized.name)) {
      normalized.name = normalized.name.replace(/\s+Textur$/i, '').trim();
    }

    return normalized;
  }

  // Process ALL non-catalog cosmetic items
  for (const item of allDetails) {
    const id = item.ItemId ?? item.itemId ?? item.id ?? '';
    if (processedIds.has(id)) continue;
    processedIds.add(id);

    const apiType = item.type ?? item.Type ?? '';
    if (!apiType || NON_COSMETIC_TYPES.has(apiType)) continue;

    const category = classifyItem(item);
    if (!category) continue;

    let normalized = normalizeItem(item, localizedNames);
    if (IMPROVE_NAME_CATEGORIES.has(category)) {
      normalized = improveSeasonalName(item, normalized);
    }
    normalized = postProcessName(category, normalized, item);
    // Apply fallback image if still missing after normalization
    if (!normalized.image) {
      normalized.image = getFallbackImage(item, normalized.name, category);
    }
    addToBucket(category, normalized, item);
  }

  // ���� Dedup distinguisher: when multiple items share a display name in the
  //   same section, append a distinguishing suffix (operator, type, etc.) so
  //   the UI doesn't show 12� "Headgear" or 19� "Rainbow Is Magic".
  function tagsOf(raw) { return raw?.Tags ?? raw?.tags ?? []; }
  function operatorFromRaw(raw) {
    return extractOperatorFromItemTags(tagsOf(raw)) ?? null;
  }
  function typeLabelFor(raw) {
    const t = raw?.type ?? raw?.Type ?? '';
    return ({
      CharacterHeadgear: 'Headgear',
      CharacterUniform:  'Uniform',
      Charm:             'Charm',
      WeaponSkin:        'Skin',
      WeaponAttachmentSkinSet: 'Attachment',
      WeaponAttachmentSkin:    'Attachment',
      GadgetSkin:        'Gadget',
      DroneSkin:         'Drone',
      MVPAnimation:      'MVP',
      OperatorCardPortrait:   'Portrait',
      OperatorCardBackground: 'Background',
      OperatorCardBadge:      'Badge',
      OperatorVideoCard:      'Video Card',
    })[t] || null;
  }

  for (const [, items] of categoryBuckets) {
    // Group by name
    const byName = new Map();
    for (const it of items) {
      const k = it.name;
      if (!byName.has(k)) byName.set(k, []);
      byName.get(k).push(it);
    }
    // For each group of size > 1, try to differentiate
    for (const group of byName.values()) {
      if (group.length < 2) continue;
      const usedSuffixes = new Set();
      group.forEach((it, idx) => {
        const raw = it.__raw;
        const op = operatorFromRaw(raw);
        const tp = typeLabelFor(raw);
        // Try operator first, then type, then index � pick the first that's unique
        const candidates = [];
        if (op) candidates.push(op);
        if (tp && tp !== it.name) candidates.push(tp);
        if (op && tp) candidates.push(`${op} ${tp}`);
        candidates.push(`#${idx + 1}`);

        let pick = null;
        for (const c of candidates) {
          if (!usedSuffixes.has(c)) { pick = c; break; }
        }
        if (!pick) pick = `#${idx + 1}`;
        usedSuffixes.add(pick);
        // Only append if it's not already in the name
        if (!it.name.toLowerCase().includes(pick.toLowerCase())) {
          it.name = `${it.name} � ${pick}`;
        }
      });
    }
  }

  // Strip the stashed raw items now that dedup is done (they're non-enumerable
  // so they wouldn't serialize anyway � explicit delete keeps intent clear).
  for (const [, items] of categoryBuckets) {
    for (const it of items) { delete it.__raw; }
  }

  // Define section display order (sections not listed here appear at the end)
  const SECTION_ORDER = [
    'Seasonals', 'Universals', 'Black Ices', 'Glaciers', 'Ranked Charms',
    'Attachment Skins',
    'Pro Leagues', 'R6 Cup Rewards',
    'Y5 Pilot Programs', 'Y6 Pilot Programs', 'Y7 Pilot Programs',
    'Y8 Pilot Programs', 'Y9 Pilot Programs', 'Pilot Programs',
    'Esport Packs', 'Elites',
    'M.U.T.E Protocol', 'Rengoku', 'Doktors Curse',
    'Redhammer', 'Sunsplash', 'Wind Bastion', 'Ember Rise',
    'Rainbow Is Magic', 'Showdown', 'Apocalypse', 'Containment',
    'Snow Brawl', 'Sugar Fright', 'Grand Larceny', 'Stadium', 'Arcana',
    'Influencers', 'Invitational', 'Dust Line', 'Racer', 'Gold Dusts',
    'Legendary Weapon Skins', 'Epic Weapon Skins',
    'Rare Weapon Skins', 'Uncommon Weapon Skins', 'Weapon Skins',
    'Headgears', 'Uniforms', 'Charms',
    'Gadget Skins', 'Drone Skins', 'MVP Animations', 'Operator Cards',
  ];

  // ���� Group "Seasonals" items into per-season sub-buckets ����������������������������
  // The UI will render each season as one expandable card containing
  // the operator's uniform, headgear, charm, weapon skin, etc.
  // Known season names (lowercased) for fast lookup
  const SEASON_NAME_LOOKUP = new Set(Object.values(SEASON_NAMES).map(n => n.toLowerCase()));

  function extractSeasonName(item) {
    // Pattern 1: Any "(Season Name)" anywhere in the name (dedup may have added suffixes)
    const m = item.name.match(/\(([^)]+)\)/);
    if (m && SEASON_NAME_LOOKUP.has(m[1].toLowerCase())) return m[1].trim();
    // Pattern 2: Name IS a season name, e.g. "Crimson Heist"
    if (SEASON_NAME_LOOKUP.has(item.name.toLowerCase())) return item.name;
    // Pattern 3: Name ends with / starts with / contains a known season name
    const lower = item.name.toLowerCase();
    for (const [, sname] of Object.entries(SEASON_NAMES)) {
      const sl = sname.toLowerCase();
      // Match season name as a word boundary anywhere in the string
      if (new RegExp(`(?:^|\\s|-|\\()${sl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$|\\s|-|\\))`, 'i').test(lower)) {
        return sname;
      }
    }
    return null;
  }

  const seasonalsBucket = categoryBuckets.get('Seasonals');
  if (seasonalsBucket && seasonalsBucket.length > 0) {
    // Re-attach __raw so we can re-classify (already deleted by dedup pass � too late)
    // We need to extract season info from the name only at this point.
    const seasonGroups = new Map(); // seasonName �  [items]
    const unmatched = [];
    for (const item of seasonalsBucket) {
      const sn = extractSeasonName(item);
      if (sn) {
        // Strip the season info from display name since it's the group title now
        const snEscaped = sn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        item.name = item.name
          .replace(new RegExp(`\\s*\\(${snEscaped}\\)\\s*`, 'i'), ' ')
          .replace(new RegExp(`(?:^|\\s)${snEscaped}(?:\\s|$)`, 'i'), ' ')
          .replace(/\s{2,}/g, ' ')
          .trim();
        if (!item.name || item.name === '�' || /^�\s*#?\d*$/.test(item.name)) item.name = 'Item';
        if (!seasonGroups.has(sn)) seasonGroups.set(sn, []);
        seasonGroups.get(sn).push(item);
      } else {
        unmatched.push(item);
      }
    }
    // Replace the flat Seasonals bucket with a grouped structure on the bucket
    categoryBuckets.set('Seasonals', { __grouped: true, groups: seasonGroups, ungrouped: unmatched });
  }

  const sections = [];
  const added = new Set();
  function pushSection(title, bucket) {
    const key = title.toLowerCase().replace(/[\s.]+/g, '');
    if (bucket && bucket.__grouped) {
      // Convert Map �  array of { title, items } sub-sections
      const groups = [...bucket.groups.entries()]
        .sort((a, b) => b[1].length - a[1].length) // most items first
        .map(([gTitle, items]) => ({
          title: gTitle,
          key: gTitle.toLowerCase().replace(/[\s.]+/g, ''),
          items,
        }));
      sections.push({
        title,
        key,
        grouped: true,
        groups,
        items: bucket.ungrouped || [], // misc items that didn't get a season match
      });
    } else if (bucket && bucket.length) {
      sections.push({ title, key, items: bucket });
    }
  }

  for (const title of SECTION_ORDER) {
    const bucket = categoryBuckets.get(title);
    if (bucket) {
      pushSection(title, bucket);
      added.add(title);
    }
  }
  // Any remaining categories not in SECTION_ORDER
  for (const [title, items] of categoryBuckets) {
    if (!added.has(title) && items.length) {
      sections.push({ title, key: title.toLowerCase().replace(/[\s.]+/g, ''), items });
    }
  }

  const totalItems = sections.reduce((sum, s) => sum + s.items.length, 0);
  dbg(`[sections] ${sections.length} sections, ${totalItems} total items: [${sections.map(s => `${s.title}(${s.items.length})`).join(', ')}]`);

  return { renown, credits, inventoryRankedSeasons, sections, ownedRankedCharmImages };
}

// Build the ranked charms list from season rank history.
// If a player hit Champion in a season, they earned EVERY tier charm for that
// season (Champion, Diamond, Emerald, Platinum, Gold, Silver, Bronze, Copper).
// Hitting Diamond earns Diamond + all below, etc.
// Index of REAL ranked-charm art from the skins catalog, keyed "tier|season"
// (e.g. "diamond|dust line" → siegeskins charm image). Built once. Lets us show
// the actual charm a player earned rather than the generic rank badge. Seasons
// not in the catalog (very newest) fall back to the rank badge.
function normalizeRankedCharmKey(tier, seasonName) {
  if (!tier || !seasonName) return null;
  return `${String(tier).toLowerCase().replace(/s$/, '').trim()}|${String(seasonName).toLowerCase().trim()}`;
}

function loadGeneratedRankedCharmArt() {
  const idx = {};
  try {
    const generated = require('../data/ranked-charm-images.json');
    const items = generated && generated.items && typeof generated.items === 'object'
      ? generated.items
      : {};
    for (const [key, value] of Object.entries(items)) {
      const image = typeof value === 'string' ? value : value && value.image;
      if (typeof image === 'string' && image.trim().startsWith('http')) {
        idx[key.toLowerCase().trim()] = image.trim();
      }
    }
  } catch {}
  return idx;
}

const _generatedRankedCharmArt = loadGeneratedRankedCharmArt();

const _rankedCharmArt = (() => {
  const idx = {};
  try {
    const cache = require('./skins_cache.json');
    for (const v of Object.values(cache)) {
      if (v.category !== 'Ranked Charms' || !v.image) continue;
      const m = (v.name || '').match(/^(\w+)\s*\((.+)\)$/);
      if (!m) continue;
      const key = normalizeRankedCharmKey(m[1], m[2]);
      if (key) idx[key] = v.image;
    }
  } catch {}
  return idx;
})();
function rankedCharmImage(tier, seasonName) {
  const key = normalizeRankedCharmKey(tier, seasonName);
  if (!key) return null;
  return _generatedRankedCharmArt[key] || _rankedCharmArt[key] || null;
}

function buildRankedCharms(seasonRanks, ownedCharmImages = {}) {
  const TIER_ORDER = ['champion','diamond','emerald','platinum','gold','silver','bronze','copper'];
  const TIER_LABEL = {
    champion: 'Champion', diamond: 'Diamond', emerald: 'Emerald',
    platinum: 'Platinum', gold: 'Gold',       silver: 'Silver',
    bronze: 'Bronze',     copper: 'Copper',
  };
  const TIER_RARITY = {
    champion: 'Legendary', diamond: 'Epic',    emerald: 'Rare',
    platinum: 'Uncommon',  gold: 'Common',     silver: 'Common',
    bronze: 'Common',      copper: 'Common',
  };

  const charms = [];
  for (const r of seasonRanks) {
    if (!r.rankTier || r.rankTier === 'unranked') continue;
    const achievedIdx = TIER_ORDER.indexOf(r.rankTier);
    if (achievedIdx < 0) continue;

    // Generate charms for the achieved tier and every tier below it
    for (let i = achievedIdx; i < TIER_ORDER.length; i++) {
      const tier = TIER_ORDER[i];
      const rankInfo = RANKS_V6.find(rv => rv.tier === tier) ?? RANKS_V6[0];
      // Image priority: generated/catalog charm art → the account's own charm
      // image for seasons not in the generated map → the rank badge.
      const owned     = ownedCharmImages[`${r.season}|${tier}`];
      const realCharm = rankedCharmImage(tier, r.seasonName);
      const new30Url   = `${RANK_ICON_3_0}${rankInfo.r6slug}.png`;
      const fallbackUrl = `${R6DATA_RANK_IMG}${rankInfo.r6slug}.webp`;
      const image = realCharm
        ? (proxyImage(realCharm, new30Url) ?? realCharm)
        : owned
          ? owned
          : (proxyImage(new30Url, fallbackUrl) ?? new30Url);
      charms.push({
        id:       `rc_s${r.season}_${tier}`,
        name:     `${TIER_LABEL[tier]} (${r.seasonName})`,
        image,
        rarity:   TIER_RARITY[tier] ?? 'Common',
        type:     'Ranked Charm',
        rankTier: tier,
      });
    }
  }
  return charms;
}

// Deduplication map: userId -> Promise
// If two users log in with the same account simultaneously,
// only one fetch runs � the second awaits the first's result.
const inflight = new Map();

async function fetchAndCache(userId, ticket, sessionId, appId, opts = {}) {
  const bulk = !!opts.bulk; // skip all third-party (tracker.gg/r6data/camoufox)
  // `fast` (interactive single check): keep inventory/skins/bans but use the
  // lightweight trackerOnly rank path (one api.tracker.gg call, NO camoufox
  // browser escalation and no slow secondary sources) and skip combat stats —
  // brings an uncached check from ~10-60s down to a few seconds.
  const fast = !!opts.fast;
  const liteRanks = bulk || fast;
  const startTs = Date.now();
  console.log(`Fetching fresh data for ${userId}... (appId: ${appId || 'default'})`);

  // PARALLEL: profile + both session exchanges fire at the same time.
  // Was 3 sequential awaits (~2-3s). Now overlapped (~1s).
  const [profile, invSession, rankSession] = await Promise.all([
    getProfile(userId, ticket, sessionId, appId),
    getR6Session(ticket, sessionId).catch(() => null),
    getRankSession(ticket, sessionId).catch(() => null),
  ]);
  const profileId = profile.profileId ?? userId;

  const invTicket    = invSession?.ticket    ?? ticket;
  const invSessionId = invSession?.sessionId ?? sessionId;
  const invAppId     = invSession?.appId     ?? appId;
  if (invSession) {
    console.log(`[player] Inventory session: appId=${invAppId} profileId=${invSession.profileId ?? '?'}`);
  } else {
    console.warn('[player] No inventory session exchange succeeded; inventory may be empty');
  }

  const rankTicket    = rankSession?.ticket    ?? ticket;
  const rankSessionId = rankSession?.sessionId ?? sessionId;
  const rankAppId     = rankSession?.appId     ?? appId;
  if (rankSession) {
    console.log(`[player] Rank session: appId=${rankAppId}`);
  } else {
    console.warn('[player] No rank session exchange succeeded; ranks may be empty');
  }

  // Season ranks. Bulk uses the lightweight trackerOnly path: api.tracker.gg
  // via the rotating proxy with NO browser escalation and no slow secondary
  // sources, so it scales to bulk concurrency while still returning real ranks.
  // bulk → trackerOnly (one api.tracker.gg call, scales to concurrency).
  // fast → nativeOnly (Ubisoft's own rank endpoints, DIRECT — no tracker.gg,
  // no camoufox, no slow secondary sources; inventory charms still fill season
  // history). full (default) → everything incl. browser escalation.
  // R6_NO_TRACKER=1 (set by the desktop SEA worker, which can't ship cycletls)
  // forces the native-Ubisoft rank path even in bulk mode — otherwise the bulk
  // path would call tracker.gg, return [], and the result line would be blank ranks.
  const noTracker = process.env.R6_NO_TRACKER === '1';
  const rankOpts = bulk ? (noTracker ? { nativeOnly: true } : { trackerOnly: true }) : (fast ? { nativeOnly: true } : {});
  const [seasonRanksRaw, inventory] = await Promise.all([
    getSeasonRanksSafe(profileId, profile.username, rankTicket, rankSessionId, rankAppId, rankOpts),
    getInventory(profileId, invTicket, invSessionId, invAppId),
  ]);

  // tracker.gg combat stats — parsed from the cache getSeasonRanks just warmed,
  // so this is normally a zero-network-cost read. Best-effort: never blocks data.
  let trackerStats = null;
  if (!liteRanks) try {
    const { fetchTrackerGGStats } = require('./rankSources');
    trackerStats = await fetchTrackerGGStats(profileId, { username: profile.username, userId: profileId });
    if (trackerStats) {
      console.log(`[player] tracker.gg stats: KD ${trackerStats.overview?.kdRatio?.display ?? '?'}, Win ${trackerStats.overview?.winPct?.display ?? '?'}, ${trackerStats.gamemodes?.length ?? 0} modes`);
    }
  } catch (e) {
    console.warn('[player] tracker.gg stats failed:', e.message);
  }

  // Merge: API season ranks take priority; inventory charm detections fill gaps
  const apiSeasons = new Set(seasonRanksRaw.map(r => r.season));
  const merged = [...seasonRanksRaw];
  for (const inv of (inventory.inventoryRankedSeasons ?? [])) {
    if (!apiSeasons.has(inv.season)) {
      merged.push(inv);
      console.log(`[merge] Added S${inv.season}=${inv.rankTier} from inventory charms (not in API data)`);
    } else {
      // Patch champion position if live API gave us one but inventory has the tier right
      const existing = merged.find(r => r.season === inv.season);
      if (existing && existing.rankTier !== inv.rankTier && inv.rankTier !== null) {
        // inventory says different tier � trust the API, just log the discrepancy
        console.log(`[merge] S${inv.season}: API says ${existing.rankTier}, inventory charm says ${inv.rankTier}`);
      }
    }
  }
  merged.sort((a, b) => (b.season ?? 0) - (a.season ?? 0));

  // ── Linked-account (Xbox / PSN) season stats ──────────────────────────
  // Siege rank is cross-progression: a season can have been played on PC, Xbox
  // AND PSN. For each season we keep the HIGHEST rank across all platforms
  // (and that platform's full stats). We also track "Ghost" accounts: consoles
  // Ubisoft used to report linked but no longer does — we still surface them
  // (and their ranks) flagged as Ghost. Best-effort, never blocks.
  const linkedSeasons = {};
  let linkedConsoles = [];   // [{ platform, handle, ghost }] for the UI
  try {
    const { fetchTrackerGGForPlatform, pickHighestPerSeason } = require('./rankSources');
    const linkedHistory = require('./linkedHistory');
    const PLATFORM_SLUG = { xbl: 'xbl', xbox: 'xbl', psn: 'psn' };

    // Consoles from Ubisoft. linkedAccounts now carries a `ghost` flag set by
    // getProfile (present in /v2/profiles but not /v3 = was-linked-but-unlinked).
    // Prefer a currently-linked entry over a ghost one for the same platform.
    const consoleMap = new Map(); // slug -> { slug, handle, ghost }
    for (const a of (profile.linkedAccounts ?? [])) {
      const slug = PLATFORM_SLUG[a.platform];
      const handle = a.username || a.idOnPlatform;
      if (!slug || !handle) continue;
      const prev = consoleMap.get(slug);
      if (!prev || (prev.ghost && !a.ghost)) consoleMap.set(slug, { slug, handle, ghost: !!a.ghost });
    }
    // Record currently-linked consoles to history, and fold in any history-only
    // ghosts (consoles Ubisoft has since dropped from BOTH endpoints).
    const currentConsoles = [...consoleMap.values()].filter(c => !c.ghost).map(c => ({ slug: c.slug, handle: c.handle }));
    for (const h of linkedHistory.recordAndList(profileId, currentConsoles)) {
      if (!consoleMap.has(h.slug)) consoleMap.set(h.slug, { slug: h.slug, handle: h.handle, ghost: h.ghost });
    }
    const known = [...consoleMap.values()];

    // PC entries are already in `merged` (tagged platform 'pc' by tracker.gg).
    const all = merged.slice();
    // GHOSTS (previously-linked-but-unlinked consoles) — we still surface that
    // they existed in linkedConsoles for transparency, but we do NOT pull their
    // ranks/data: a ghost handle no longer belongs to this Ubisoft account, so
    // its ranks aren't this account's value. Only CURRENT linked consoles
    // contribute to seasonRanks / VWI bucketing.
    for (const acc of known.filter(a => a.ghost)) {
      linkedConsoles.push({ platform: acc.slug, handle: acc.handle, ghost: true, seasons: 0 });
      console.log(`[merge] ${acc.slug} (${acc.handle}) [GHOST]: skipped (no data pulled)`);
    }
    const liveAccounts = known.filter(a => !a.ghost);
    // Fetch every CURRENT console IN PARALLEL so total time ≈ the slowest
    // single lookup, not the sum — important under the bulk per-check timeout.
    // Bulk passes fewer retries for the same reason. In BULK we skip the
    // console fetches entirely: the checker's Ranks: column is Ubi-account
    // ONLY (per operator spec — a Lvl-13 PC account must not show a linked
    // Xbox's Diamond), so pulling console ranks in bulk is wasted work.
    // The full/interactive path still fetches them because the profile page
    // renders `linkedSeasons` as an informational per-console section.
    const fetchOpts = bulk ? { retries: 2 } : {};
    const results = bulk
      ? []
      : await Promise.all(liveAccounts.map(acc =>
          fetchTrackerGGForPlatform(acc.slug, acc.handle, fetchOpts)
            .then(entries => ({ acc, entries }))
            .catch(() => ({ acc, entries: [] }))
        ));
    // Record the console entries in `linkedSeasons` (informational for the
    // profile page) but do NOT merge them into `all`. The bulk result line's
    // "Ranks:" field must reflect ONLY the Ubi/PC account being checked — a
    // linked Xbox Diamond is not this account's rank per operator spec.
    for (const { acc, entries } of results) {
      const tagged = entries.map(e => ({ ...e, platform: acc.slug, ghost: false }));
      if (tagged.length) linkedSeasons[acc.slug] = tagged;
      linkedConsoles.push({ platform: acc.slug, handle: acc.handle, ghost: false, seasons: tagged.length });
      console.log(`[merge] ${acc.slug} (${acc.handle}): ${tagged.length} seasons (NOT merged into Ubi ranks)`);
    }
    // Also record CURRENT-linked consoles we didn't fetch (bulk skip) so the
    // profile page still knows they exist.
    if (bulk) for (const acc of liveAccounts) linkedConsoles.push({ platform: acc.slug, handle: acc.handle, ghost: false, seasons: 0 });
    // Collapse to one entry per season using ONLY the Ubi/PC ranks in `merged`.
    const highest = pickHighestPerSeason(all);
    merged.length = 0;
    merged.push(...highest);
  } catch (e) {
    console.warn('[player] linked-account seasons failed:', e.message);
  }

  const seasonRanks  = merged;
  const rankedCharms = buildRankedCharms(seasonRanks, inventory.ownedRankedCharmImages || {});

  // Insert ranked charms into the sections array (after Black Ices if present)
  const { inventoryRankedSeasons: _, sections: invSections, ownedRankedCharmImages: _ownedCharms, ...inventoryClean } = inventory;
  const sections = [...(invSections ?? [])];
  if (rankedCharms.length) {
    const blackIceIdx = sections.findIndex(s => s.key === 'blackices');
    const insertAt = blackIceIdx >= 0 ? blackIceIdx + 1 : sections.length;
    sections.splice(insertAt, 0, { title: 'Ranked Charms', key: 'rankedcharms', items: rankedCharms });
  }

  // ���� Clearance Level ��������������������������������������������������������������������������������������������
  // Primary: statscard endpoint on crossplay space using the rank session token
  // (AppId e3d5ea9e-... + crossplay spaceId = returns PClearanceLevel with real value)
  let level = profile.level;
  if (!level) {
    try {
      const statscardHeaders = {
        ...BASE_HEADERS,
        'Ubi-AppId': rankAppId || 'e3d5ea9e-50bd-43b7-88bf-39794f4e3d40',
        Authorization: `Ubi_v1 t=${rankTicket}`,
        'Ubi-SessionId': rankSessionId,
        'Ubi-LocaleCode': 'en-US',
      };
      const statscardRes = await ubiRequest({
        method: 'get',
        url: `https://public-ubiservices.ubi.com/v1/profiles/${profileId}/statscard?spaceId=${CROSSPLAY_SPACE_ID}`,
        headers: statscardHeaders,
      });
      const cards = statscardRes.data?.Statscards ?? [];
      const levelCard = cards.find(c => c.statName === 'PClearanceLevel');
      if (levelCard?.value) {
        level = parseInt(levelCard.value, 10) || 0;
        if (level) console.log(`[statscard] Clearance Level: ${level}`);
      }
    } catch (e) {
      console.warn(`[statscard] Level fetch failed: ${e.response?.status ?? e.message}`);
    }
  }
  // Fallback: r6data accountInfo
  if (!level && profile.username) {
    try {
      const r6InfoRes = await http({
        method: 'get', url: `${R6DATA_BASE}/stats`,
        params: { type: 'accountInfo', nameOnPlatform: profile.username, platformType: 'uplay' },
        headers: { 'api-key': R6DATA_KEY },
        timeout: 8000,
      });
      const r6Info = r6InfoRes.data;
      level = r6Info?.level ?? r6Info?.clearanceLevel ?? r6Info?.accountLevel ?? 0;
      if (level) console.log(`[r6data] accountInfo level: ${level}`);
    } catch (e) {
      console.warn(`[r6data] accountInfo failed: ${e.response?.status ?? e.message}`);
    }
  }

  // Final guard: strip any ghost-tagged season that slipped through (a stale
  // cache entry, an inventory-charm tag, anything downstream). Ranks from a
  // previously-linked-but-unlinked console DO NOT belong to this account.
  const cleanedSeasonRanks = (seasonRanks ?? []).filter(r => !r.ghost);
  // ── Corroborate wanted-tier ranks against OWNED ranked charms ────────────
  // Every player who finishes a season at rank R gets a per-season charm for R
  // AND every tier below (e.g. a S41 Diamond gets Diamond + Emerald + Platinum
  // + Gold + Silver + Bronze + Copper charms). Charms are inventory items
  // scoped to the Ubisoft PC account — they can't be gifted or transferred —
  // so the presence of "S41 Platinum charm" is proof this account earned at
  // least Platinum in S41. Their ABSENCE, when inventory otherwise loaded fine,
  // is strong evidence the API-reported rank came from cross-progression leak.
  //
  // Signal: build a map of season → highest-owned-tier from ownedRankedCharmImages.
  // A wanted-tier rank (Plat/Emerald/Diamond/Champion) is kept iff a charm exists
  // for that season at that tier OR higher.
  // Safety: only apply the filter when inventory clearly loaded (has any items).
  // If total items is 0 the fetch likely broke — trust API to avoid false-blanks.
  const CHARM_TIER_ORDER = { copper: 1, bronze: 2, silver: 3, gold: 4, platinum: 5, emerald: 6, diamond: 7, champion: 8 };
  const CHARM_WANTED_TIERS = new Set(['platinum', 'emerald', 'diamond', 'champion']);
  const ownedCharms = inventory.ownedRankedCharmImages || {};
  const charmSeasonPeaks = {};   // season → highest owned tier (numeric)
  for (const key of Object.keys(ownedCharms)) {
    const [sStr, tier] = String(key).split('|');
    const s = Number(sStr);
    const r = CHARM_TIER_ORDER[String(tier).toLowerCase()] || 0;
    if (!s || !r) continue;
    if (!charmSeasonPeaks[s] || charmSeasonPeaks[s] < r) charmSeasonPeaks[s] = r;
  }
  const hasInventoryItems = Array.isArray(inventory.sections) &&
    inventory.sections.some(sec =>
      (Array.isArray(sec.items) && sec.items.length > 0) ||
      (Array.isArray(sec.groups) && sec.groups.some(g => Array.isArray(g.items) && g.items.length > 0))
    );
  const applyCharmFilter = hasInventoryItems;
  const corroboratedRanks = applyCharmFilter
    ? cleanedSeasonRanks.filter(r => {
        const tier = String(r.rankTier || '').toLowerCase();
        if (!CHARM_WANTED_TIERS.has(tier)) return true;  // Copper–Gold: not sold as VWI, always keep
        const claimed = CHARM_TIER_ORDER[tier] || 0;
        const peak = charmSeasonPeaks[r.season] || 0;
        const corroborated = peak >= claimed;
        if (!corroborated) console.log(`[merge] S${r.season}=${r.rankName} DROPPED — no matching ranked charm in PC inventory (leaked?)`);
        return corroborated;
      })
    : cleanedSeasonRanks;

  // Era-correct EVERY source. The Ubi-native parsers (parseRankResponse etc.)
  // already run eraCorrectRank internally, but tracker.gg's buildRankEntry +
  // the secondary sources (tabstats, r6tab, r6data) return raw modern-scale
  // entries that include tiers that DIDN'T EXIST in old seasons:
  //   • Champion — introduced Y4S3 Ember Rise (S15); a S1–S14 "Champion" is bogus
  //   • Emerald  — introduced Y7S4 Solar Raid  (S28); a S1–S27 "Emerald"  is bogus
  // eraCorrectRank remaps each pre-era entry to the tier that ACTUALLY existed
  // that season (using the era's own MMR table if points are present, otherwise
  // demoting the tier only). Modern seasons pass through unchanged.
  const eraCorrectedRanks = corroboratedRanks.map(r => {
    const s = Number(r.season);
    if (!s || s >= SEASON_EMERALD) return r;               // modern era → no change
    const peakDef = v6FromNameTier(r.rankName || '', r.rankTier || '');
    const peak    = eraCorrectRank(s, r.mmr, peakDef);
    const curDef  = v6FromNameTier(r.currentRankName || r.rankName || '', r.currentRankTier || r.rankTier || '');
    const cur     = eraCorrectRank(s, r.currentMmr ?? r.mmr, curDef);
    // If nothing changed, keep the original object (avoid churn on the cache).
    if (peak.id === (r.rank || 0) && cur.id === (r.currentRank || r.rank || 0)) return r;
    return {
      ...r,
      rank: peak.id, rankName: peak.name, rankTier: peak.tier,
      currentRank: cur.id, currentRankName: cur.name, currentRankTier: cur.tier,
      // Icons update alongside — otherwise the badge art wouldn't match the tier.
      iconUrl:        proxyImage(`${R6DATA_RANK_IMG}${peak.r6slug}.webp`) ?? `${RANK_ICON_CDN}${peak.slug}.png`,
      currentIconUrl: proxyImage(`${R6DATA_RANK_IMG}${cur.r6slug}.webp`)  ?? `${RANK_ICON_CDN}${cur.slug}.png`,
    };
  });
  // Normalize season ranks: trackers (tabstats, r6tab) don't return current-vs-peak,
  // so fill in current* from peak so the UI always has values to display.
  const normalizedRanks = eraCorrectedRanks.map(r => ({
    ...r,
    currentRank:      r.currentRank      ?? r.rank,
    currentRankName:  r.currentRankName  ?? r.rankName,
    currentRankTier:  r.currentRankTier  ?? r.rankTier,
    currentMmr:       r.currentMmr       ?? r.mmr,
    currentIconUrl:   r.currentIconUrl   ?? r.iconUrl,
  }));

  // Ban + last-played enrichment — all three sources run CONCURRENTLY (was three
  // sequential round-trips). `checked` distinguishes a confirmed-clean account
  // from one we couldn't verify, so the line shows "?" instead of a false "N".
  //   1. Ubisoft sanctions    → current/active bans (uses our ticket).
  //   2. tracker.gg banAlerts → PRIOR/cheating bans (cycletls + FlameProxies),
  //      usually a free cache read from the rank fetch. PRIMARY for cheating.
  //   3. stats.cc             → last-played + linked devices + ban backstop.
  let banStatus = { banned: false, reason: null, checked: false };
  let lastPlayedAt = null, lastPlayedDevices = [];
  let emailVerified = null, phoneVerified = null, hasPhone = false;
  {
    const { fetchBanStatus, fetchStatsCcProfile } = require('./rankSources');
    const sanctionsUrl = `https://public-ubiservices.ubi.com/v1/profiles/${encodeURIComponent(profileId)}/sanctions?spaceId=${CROSSPLAY_SPACE_ID}`;
    // /v3/users/{id} → account-level status (email/phone verification, lock, etc.)
    const acctUrl = `https://public-ubiservices.ubi.com/v3/users/${encodeURIComponent(profileId)}`;
    // Hard per-source cap so a slow upstream can never hang the check. 6s gives
    // the ban sources (tracker.gg via cycletls ~2-4s, stats.cc ~1-3s, run in
    // parallel) enough time to actually RETURN — a tighter cap was silently
    // cutting the ban check and producing false "not banned" results. Ban
    // accuracy matters more to a reseller than shaving 2s off a valid hit.
    const SRC_CAP_MS = Number(process.env.ENRICH_SRC_CAP_MS) || 6000;
    const bounded = (p) => Promise.race([p, new Promise(r => setTimeout(() => r(null), SRC_CAP_MS))]);
    const tgEnabled = process.env.TRACKER_BAN_CHECK !== '0';
    const scEnabled = process.env.STATSCC_CHECK !== '0';
    // Reusable CHEATING-source fetchers (the false-"N" culprits when they time
    // out) so the auto-recheck below can re-run just these without re-logging in.
    const fetchTg = () => tgEnabled ? bounded(fetchBanStatus(profileId, { username: profile.username, userId: profileId, noBrowser: true }).catch(() => null)) : Promise.resolve(null);
    const fetchSc = () => scEnabled ? bounded(fetchStatsCcProfile(profileId, { timeout: SRC_CAP_MS, bulk }).catch(() => null)) : Promise.resolve(null);
    let [sanc, acct, tg, sc] = await Promise.all([
      bounded(ubiRequest({ method: 'get', url: sanctionsUrl, headers: authHeaders(ticket, sessionId, appId), validateStatus: () => true }).catch(() => null)),
      bounded(ubiRequest({ method: 'get', url: acctUrl, headers: authHeaders(ticket, sessionId, appId), validateStatus: () => true }).catch(() => null)),
      fetchTg(),
      fetchSc(),
    ]);
    // AUTO-RECHECK: if NEITHER cheating source returned, retry just those a bounded
    // number of times (no re-login) so an unverifiable ban resolves to a real Y/N
    // instead of "?". We accept "?" only after the budget is spent — this never
    // turns a valid login into an error. Tune with BULK_BAN_RECHECKS (default 2).
    const BAN_RECHECKS = Math.max(0, Number(process.env.BULK_BAN_RECHECKS)
      || (process.env.R6_NO_TRACKER === '1' ? 4 : 2));
    for (let r = 0; r < BAN_RECHECKS && !tg && !sc && (tgEnabled || scEnabled); r++) {
      await new Promise(res => setTimeout(res, 600 + r * 400));
      [tg, sc] = await Promise.all([fetchTg(), fetchSc()]);
    }
    // Account verification flags from /v3/users/{id}.status:
    //   email verified  = account activated + email not flagged invalid
    //   phone verified  = a phone is set + phoneActivated + not flagged invalid
    // null = couldn't fetch (line shows "?" instead of a false "N").
    const acctD = (acct && acct.status >= 200 && acct.status < 300) ? acct.data : null;
    if (acctD && acctD.status) {
      const st = acctD.status;
      emailVerified = (st.generalStatus === 'activated' && st.invalidEmail === false && st.changeEmailPending !== true);
      hasPhone = !!(acctD.phone && acctD.phone.number);
      phoneVerified = hasPhone && st.phoneActivated === true && st.invalidPhone === false;
    }
    // Track which sources actually RETURNED. A ban from any source is definitive;
    // but a confident CLEAN ("Banned: N") must NOT rest on Ubisoft sanctions alone
    // — that endpoint misses cheating/BattlEye bans, so trusting it solo produced
    // false "not banned" results when the cheating sources timed out.
    let sancOk = false, tgOk = false, scOk = false;
    const sancList = sanc?.data?.currentSanctions ?? sanc?.data?.sanctions;
    if (sanc && sanc.status >= 200 && sanc.status < 300 && Array.isArray(sancList)) {
      sancOk = true;
      if (sancList.length) {
        const s0 = sancList[0] || {};
        banStatus.banned = true;
        banStatus.reason = s0.reason || s0.sanctionsCategoryName || s0.type || 'sanctioned';
      }
    }
    if (tg) {
      tgOk = true;
      if (tg.banned) { banStatus.banned = true; banStatus.reason = tg.reason || banStatus.reason || 'Cheating'; }
    }
    if (sc) {
      scOk = true;
      lastPlayedAt = sc.lastPlayedAt || null;
      lastPlayedDevices = sc.platforms || [];
      if (sc.banned) { banStatus.banned = true; banStatus.reason = banStatus.reason || 'Cheating'; }
    }
    // "checked" = we can stand behind the verdict. A detected ban is always
    // definitive. A clean verdict is only trustworthy if a CHEATING-capable source
    // (tracker.gg PRIMARY, stats.cc backstop) actually returned. If both cheating
    // sources are intentionally disabled, fall back to trusting Ubisoft sanctions.
    const cheatingSourcesDisabled = !tgEnabled && !scEnabled;
    // Desktop (no tracker): a clean "Banned: N" MUST come from stats.cc — Ubi
    // sanctions alone miss BattlEye/cheating bans.
    const requireScForClean = process.env.R6_NO_TRACKER === '1' && scEnabled && !tgEnabled;
    if (!banStatus.banned && requireScForClean && !scOk) {
      banStatus.checked = false;
    } else {
      banStatus.checked = banStatus.banned || tgOk || scOk || (cheatingSourcesDisabled && sancOk);
    }
    if (banStatus.banned) console.log(`[player] ban for ${profileId}: ${banStatus.reason}`);
    else if (!banStatus.checked) console.log(`[player] ban UNVERIFIED for ${profileId} (cheating sources didn't return) → "?"`);
  }

  const data = { ...profile, level: level || profile.level, seasonRanks: normalizedRanks, linkedSeasons, linkedConsoles, trackerStats, banned: banStatus.banned, banReason: banStatus.reason, banChecked: banStatus.checked, lastPlayedAt, lastPlayedDevices, emailVerified, phoneVerified, hasPhone, ...inventoryClean, sections };

  // Override item names/categories with the operator-curated skins_cache
  // (Layer 1) + live Ubisoft localization catalog (Layer 2) so the
  // playerData carries the cleanest available name + image for every item.
  try {
    const { enhanceItemNames } = require('./checker/skinCheck');
    enhanceItemNames(data);
  } catch (e) {
    console.warn('[player] skin-cache name enhancement failed:', e.message);
  }

  // Fire-and-forget background refresh of the Ubisoft items catalog. The
  // catalog is global (same items for every player) with a 24h TTL, so
  // the first successful real check populates it for everyone else and
  // subsequent checks are no-ops.
  try {
    const ubisoftItems = require('./ubisoftItems');
    // Use the inventory-flavour ticket (the one that succeeded for getInventory).
    ubisoftItems.maybeRefreshInBackground(invTicket, invSessionId, invAppId);
  } catch (e) {
    console.warn('[player] ubisoft catalog refresh kick-off failed:', e.message);
  }
  // Only persist a meaningful result � empty fetches happen on rate-limits
  // and we don't want them to overwrite a good prior cache.
  // NEVER WIPE: merge back any previously-known data this fetch lacked (a
  // degraded proxy/tracker run would otherwise blank a good profile). Also
  // upgrades the returned object so the live response shows the kept data.
  preserveFromCache(userId, data);

  const looksUsable = (data.seasonRanks?.length ?? 0) > 0
                  || (data.sections?.length ?? 0) > 0;
  if (looksUsable) writeCache(userId, data);
  return data;
}

async function getPlayerData(userId, ticket, sessionId, appId, opts = {}) {
  // Bulk mode: lightweight native-Ubisoft-only fetch (no tracker.gg / r6data /
  // tabstats / camoufox enrichment). Those third-party calls are fine for a
  // single locker view, but at hundreds of concurrent bulk checks they spawn
  // headless browsers and stall every worker. See fetchAndCache(opts.bulk).
  const bulk = !!opts.bulk;
  // forceRefresh: every CREDENTIALED check (single login, token/session paste,
  // bulk) sets this so it ALWAYS re-fetches live data (bans, rank, linkable…)
  // instead of serving a stale ≤24h cache. The public /profile page leaves it
  // off and keeps using the cache, since it has no credentials to re-fetch.
  const forceRefresh = !!opts.forceRefresh;
  // Tier 1: in-memory TTL cache (5min by default) � sub-ms hit
  const pool = require('./loginPool');
  const memCached = forceRefresh ? null : pool.getCachedPlayerData(userId);
  if (memCached) {
    console.log(`[player] �a� memory cache hit for ${userId}`);
    return memCached;
  }

  // Tier 2: disk cache (longer-lived) � fast file read
  const cached = forceRefresh ? null : readCache(userId);
  if (cached) {
    pool.cachePlayerData(userId, cached); // promote to memory
    return cached;
  }

  // Tier 3: dedup inflight fetches � multiple callers share one upstream call
  if (inflight.has(userId)) {
    console.log(`[dedup] awaiting in-flight fetch for ${userId}`);
    return inflight.get(userId);
  }

  const promise = fetchAndCache(userId, ticket, sessionId, appId, { bulk, fast: !!opts.fast })
    .then(data => {
      // Only memoize results that look real � keeps rate-limit failures
      // from poisoning the cache for 5 minutes.
      const usable = (data?.seasonRanks?.length ?? 0) > 0
                  || (data?.sections?.length ?? 0) > 0;
      if (usable) pool.cachePlayerData(userId, data);
      return data;
    })
    .finally(() => inflight.delete(userId));
  inflight.set(userId, promise);
  return promise;
}

module.exports = { getPlayerData, _test: { mergeSeasonRanks, preserveFromCache, readCacheRaw, writeCache, eraCorrectRank, getRankV6, v6FromNameTier, rpToRankId, buildRankedCharms, rankedCharmImage, normalizeRankedCharmKey, loadGeneratedRankedCharmArt, SEASON_NAMES, SEASON_CHAMPION, SEASON_EMERALD } };

