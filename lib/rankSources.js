// Multi-source rank fetcher. Public APIs that maintain their own historical
// season database — Ubisoft's official API no longer exposes past seasons.
//
// PRIMARY source: tracker.gg via /uplay/{ubiId} (NOT /ubi/{username} — that 403s).
// Returns FULL historical data — current + peak rank per season going back
// several years. Cached for 1 hour because Cloudflare aggressively rate-limits.
//
// Each entry has the same shape getSeasonRanks() produces:
//   { season, seasonName, rank, rankName, rankTier, mmr, iconUrl,
//     currentRank, currentRankName, currentRankTier, currentMmr, currentIconUrl,
//     champPosition, _source }

const axios = require('axios');
const crypto = require('crypto');
const { proxiedRequest, isProxyEnabled, isAnyRotationEnabled } = require('./proxyClient');
const tgCache = require('./trackerGGCache');
// cycletls spawns a Go subprocess and isn't packageable into a SEA exe — the
// desktop checker sets R6_NO_TRACKER=1 and skips every tracker.gg path, so the
// require is lazy to avoid loading the cycletls package at all in that env.
let cycletls = null;
function getCycletls() {
  if (cycletls) return cycletls;
  if (process.env.R6_NO_TRACKER === '1') return null;
  cycletls = require('./cycletlsClient');
  return cycletls;
}

// Use proxied client when proxy is enabled — rotating residential IPs are the
// only reliable way past tracker.gg's Cloudflare bot challenge (it gates by
// JA3/IP reputation, not by API key — even an authenticated request needs to
// look like it came from a real residential client).
const http = (config) => isAnyRotationEnabled() ? proxiedRequest(config) : axios(config);

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0';

// Build headers for tracker.gg API. With the official TRN-Api-Key the request
// bypasses Cloudflare rate-limit AND gets stable quotas; without it we mimic
// a browser hitting the public endpoint.
function trackerGGHeaders() {
  const base = {
    'User-Agent': USER_AGENT,
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    Referer: 'https://r6.tracker.network/',
    Origin:  'https://r6.tracker.network',
  };
  const key = process.env.TRACKER_GG_API_KEY;
  if (key) base['TRN-Api-Key'] = key;
  // The api.tracker.gg v2 endpoints accept a literal `Authorization: api.tracker.gg`
  // header — this is what lets the request through without the CF challenge that
  // was forcing camoufox escalation. (Confirmed working from a plain datacenter IP.)
  base['Authorization'] = 'api.tracker.gg';
  return base;
}

// ── Rank table (shared with player.js) ──────────────────────────────────
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
const RANK_ICON_CDN    = 'https://cdn.jsdelivr.net/gh/danielwerg/r6data@master/src/assets/ranks/v3/pngs/';
const R6DATA_RANK_IMG  = 'https://r6data.com/assets/img/r6_ranks_img/';
const getRankV6 = (id) => RANKS_V6[id] ?? RANKS_V6[0];
const proxyImage = (url) => url ? `/api/img?url=${encodeURIComponent(url)}` : null;

const SEASON_NAMES = {
  1:'Black Ice',2:'Dust Line',3:'Skull Rain',4:'Red Crow',
  5:'Velvet Shell',6:'Health',7:'Blood Orchid',8:'White Noise',
  9:'Chimera',10:'Para Bellum',11:'Grim Sky',12:'Wind Bastion',
  13:'Burnt Horizon',14:'Phantom Sight',15:'Ember Rise',16:'Shifting Tides',
  17:'Void Edge',18:'Steel Wave',19:'Shadow Legacy',20:'Neon Dawn',
  21:'Crimson Heist',22:'North Star',23:'Crystal Guard',24:'High Calibre',
  25:'Demon Veil',26:'Vector Glare',27:'Brutal Swarm',28:'Solar Raid',
  29:'Commanding Force',30:'Dread Factor',31:'Heavy Mettle',32:'Deep Freeze',
  33:'Deadly Omen',34:'New Blood',35:'Twin Shells',36:'Collision Point',
  37:'Prep Phase',38:'Daybreak',39:'High Stakes',40:'Tenfold Pursuit',
  41:'Silent Hunt',42:'System Override',
};

// Ranked RP → rank-id thresholds (Ranked 2.0 / 3.0). Mirrors player.js so the
// tracker.gg path can resolve a rank id from RP when the upstream omits one
// (common right after a season reset — e.g. ~2000 RP with no rank → Silver,
// NOT "Unranked"). Ascending; scan upward and keep the last threshold met.
const RP_THRESHOLDS = [
  [0,0],[1000,1],[1100,2],[1200,3],[1300,4],[1400,5],[1500,6],[1600,7],[1700,8],
  [1800,9],[1900,10],[2000,11],[2100,12],[2200,13],[2300,14],[2400,15],[2500,16],
  [2600,17],[2700,18],[2800,19],[2900,20],[3000,21],[3100,22],[3200,23],[3300,24],
  [3400,25],[3500,26],[3600,27],[3700,28],[3800,29],[3900,30],[4000,31],[4100,32],
  [4200,33],[4300,34],[4400,35],[4500,36],
];
function rpToRankId(rp) {
  if (!rp || rp <= 0) return 0;
  let id = 0;
  for (const [t, i] of RP_THRESHOLDS) { if (rp >= t) id = i; else break; }
  return id;
}

// Map a rank NAME to our rank id, for old MMR-era seasons that carry only a
// name + mmr value. tracker.gg uses ROMAN numerals ("SILVER II", "BRONZE I",
// "COPPER V") so we convert those to the 1–5 sub-rank. "CHAMPION" and
// "NO RANK"/"UNRANKED" are handled specially.
const ROMAN = { I: 1, II: 2, III: 3, IV: 4, V: 5 };
function rankIdFromName(name) {
  if (!name) return 0;
  const n = String(name).toUpperCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (n === 'NO RANK' || n === 'UNRANKED' || n === '') return 0;
  if (n === 'CHAMPION' || n.startsWith('CHAMPION')) return 36;

  const parts = n.split(' ');
  const tier = parts[0].toLowerCase();              // "silver"
  const numTok = parts[1] || '';                    // "II" or "2"
  const sub = ROMAN[numTok] || Number(numTok) || null; // 1..5

  // tier rows are ordered Copper5..Copper1, Bronze5..Bronze1, etc. — i.e. the
  // sub-rank counts DOWN. Find the tier block and index by sub.
  const tierRows = RANKS_V6.filter(r => r.tier === tier);
  if (!tierRows.length) return 0;
  if (sub == null) return tierRows[tierRows.length - 1].id; // tier-only → lowest
  // tierRows are [<tier> 5, <tier> 4, ... <tier> 1]; "<tier> N" name match:
  const match = tierRows.find(r => r.name.toUpperCase() === `${tier.toUpperCase()} ${sub}`);
  return match ? match.id : tierRows[tierRows.length - 1].id;
}

// Build a rank entry from raw tracker.gg stats. Handles BOTH the modern
// RP system (rankPoints / maxRankPoints / rank / maxRank) AND the older
// MMR system (Y5–Y7 seasons carry stats.mmr.{value, metadata.name} only).
// tracker.gg rank names arrive ALL-CAPS ("SILVER II", "NO RANK"). Title-case
// the tier word, keep roman numerals upper, and normalise "NO RANK"→"Unranked".
function prettyRank(name) {
  if (!name) return null;
  const n = String(name).trim().toUpperCase();
  if (n === 'NO RANK' || n === 'UNRANKED') return 'Unranked';
  const ROMANS = new Set(['I', 'II', 'III', 'IV', 'V']);
  return n.split(/\s+/).map(w =>
    ROMANS.has(w) ? w : w.charAt(0) + w.slice(1).toLowerCase()
  ).join(' ');
}

function buildRankEntry(season, seasonName, statsObj, platform = 'pc') {
  let curRP   = statsObj.rankPoints?.value ?? 0;
  let peakRP  = statsObj.maxRankPoints?.value ?? curRP;
  // tracker.gg gives the rank NAME + the NEW 3.0 badge image right in the stat
  // metadata (e.g. "EMERALD I" + ranks/3.0/medium/emerald-1.png). Prefer those
  // over our own id→CDN mapping so we always show the exact 3.0 ranked badge.
  let curMetaName  = statsObj.rankPoints?.metadata?.name ?? null;
  let peakMetaName = statsObj.maxRankPoints?.metadata?.name ?? null;
  let curMetaImg   = statsObj.rankPoints?.metadata?.imageUrl ?? null;
  let peakMetaImg  = statsObj.maxRankPoints?.metadata?.imageUrl ?? null;

  let curId   = statsObj.rank?.value || rankIdFromName(curMetaName);
  let peakId  = statsObj.maxRank?.value || rankIdFromName(peakMetaName) || curId;

  // Old MMR-era fallback (Y2–Y7): rank lives in stats.mmr (current) and
  // stats.maxMmr (peak), each with its own name + 3.0 badge. Use both so the
  // Latest-vs-Max columns differ like they do on tracker.gg.
  if (!peakId && !peakRP && !curId && !curRP && (statsObj.mmr || statsObj.maxMmr)) {
    const m  = statsObj.mmr    || {};
    const mx = statsObj.maxMmr || statsObj.mmr || {};
    curRP  = m.value  ?? 0;
    peakRP = mx.value ?? curRP;
    curMetaName  = m.metadata?.name     ?? null;
    peakMetaName = mx.metadata?.name    ?? curMetaName;
    curMetaImg   = m.metadata?.imageUrl  ?? null;
    peakMetaImg  = mx.metadata?.imageUrl ?? curMetaImg;
    curId  = rankIdFromName(curMetaName);
    peakId = rankIdFromName(peakMetaName) || curId;
  }

  // RP-derived fallback: if the upstream gave RP but no resolved rank id (very
  // common right after a Ranked 3.0 season reset), derive the rank from RP so
  // we never render a "ranked-with-RP" player as Unranked.
  if (!curId  && curRP  > 0) curId  = rpToRankId(curRP);
  if (!peakId && peakRP > 0) peakId = rpToRankId(peakRP) || curId;

  // No useful rank data — skip
  if (!peakId && !peakRP && !curId && !curRP) return null;

  const peakInfo = getRankV6(peakId || curId);
  const curInfo  = getRankV6(curId);
  // Image priority: tracker's 3.0 badge metadata → mmr badge → our CDN fallback.
  const rawPeakIcon = peakMetaImg || `${R6DATA_RANK_IMG}${peakInfo.r6slug}.webp`;
  const rawCurIcon  = curMetaImg  || `${R6DATA_RANK_IMG}${curInfo.r6slug}.webp`;
  const champPos    = (statsObj.topRankPosition?.value > 0 ? statsObj.topRankPosition.value : null)
                   ?? (statsObj.maxRankPoints?.metadata?.topRankPosition > 0 ? statsObj.maxRankPoints.metadata.topRankPosition : null);

  return {
    season,
    seasonName: SEASON_NAMES[season] ?? seasonName ?? `Season ${season}`,
    // Peak — what they reached at their highest
    rank:     peakId || curId,
    rankName: prettyRank(peakMetaName) || peakInfo.name,
    rankTier: peakInfo.tier,
    mmr:      peakRP || curRP,
    iconUrl:  proxyImage(rawPeakIcon),
    // Current — where they sit right now
    currentRank:     curId,
    currentRankName: prettyRank(curMetaName) || curInfo.name,
    currentRankTier: curInfo.tier,
    currentMmr:      curRP,
    currentIconUrl:  proxyImage(rawCurIcon),
    champPosition: champPos,
    platform,                 // 'pc' | 'xbl' | 'psn' — which platform this came from
    _source: 'tracker.gg',
  };
}

// ── tracker.gg — PRIMARY historical source ──────────────────────────────
// Returns full segments[] with one entry per (season, gamemode) pair.
// We filter to sessionType=ranked only.
//
// Endpoints (try in order — first 200 wins):
//   /profile/ubi/{username}   PREFERRED — public, served from CF cache, no key needed
//   /profile/uplay/{userId}   FALLBACK  — works when username has odd chars
// GET an api.tracker.gg URL with the Authorization header. Tries the rotating
// residential proxy FIRST (spreads load at bulk scale, honours the proxy
// requirement), then falls back to a DIRECT server-IP request when every proxy
// IP is Cloudflare-flagged — empirically the residential pool gets 403'd for
// api.tracker.gg while the clean server IP + Authorization header gets 200.
// A returned tracker.gg profile is only THIS account's if its Ubisoft id matches
// the id we looked up. The /ubi/{username} candidate resolves by DISPLAY NAME —
// and Siege names are reusable/non-unique, so a name can resolve to a completely
// different Ubisoft account (the "Level 0 with Champion ranks" contamination:
// a stranger who shares the handle). tracker echoes the resolved account id in
// data.platformInfo.platformUserId; if it's a real UUID that differs from the
// one we asked for, those seasons belong to someone else — discard them.
// Conservative: only reject on a POSITIVE UUID≠UUID mismatch. If tracker didn't
// echo a UUID (older shape, or an id we can't compare), accept as before so we
// never blank out ranks we currently show correctly.
const TG_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function trackerProfileMismatch(payload, userId) {
  if (!userId || !TG_UUID_RE.test(String(userId))) return false; // nothing to verify against
  const returnedId = payload?.data?.platformInfo?.platformUserId;
  if (!returnedId || !TG_UUID_RE.test(String(returnedId))) return false; // can't verify → don't reject
  return String(returnedId).toLowerCase() !== String(userId).toLowerCase();
}

// Wrong-platform guard. tracker.gg's /ubi/{uuid} endpoint silently RESOLVES the
// Ubisoft UUID to whichever platform tracker has data for — an audit of the live
// cache showed ~60% of PC-account lookups came back with platformInfo.platformSlug
// = 'xbl' (Xbox) or 'psn' (PlayStation), because those accounts had console play
// linked historically. Their segments then leaked in as if they were PC ranks (the
// "Lvl 13 with Diamond S16" case). We're checking the UBISOFT/PC account: reject
// any response that resolved to a CONSOLE platform. 'ubi' (cross-progression) and
// 'uplay' (PC-only) are the acceptable slugs. Unknown/missing slug is accepted so
// we never blank ranks we currently show correctly.
const TG_CONSOLE_SLUGS = new Set(['xbl', 'xbox', 'psn', 'playstation', 'switch']);
function trackerWrongPlatform(payload) {
  const slug = payload?.data?.platformInfo?.platformSlug;
  if (!slug) return false;                     // can't verify → don't reject
  return TG_CONSOLE_SLUGS.has(String(slug).toLowerCase());
}

async function trackerGet(url, headers, retries) {
  // Preferred: a dedicated tracker.gg proxy (e.g. FlameProxies US 'mode-fast')
  // set via TRACKER_PROXY_URL — cycletls (browser TLS) through it passes the
  // Cloudflare edge cleanly. Verified working.
  const flame = process.env.TRACKER_PROXY_URL;
  const cyc = getCycletls();
  if (!cyc) return { status: 0, body: '' };
  if (flame) {
    const res = await cyc.get(url, headers, { retries: retries ?? 4, proxyUrl: flame });
    if (res.status === 200) return res;
  }
  // Fallback: the configured residential pool, US-pinned (CF trusts US IPs).
  const country = process.env.TRACKER_PROXY_COUNTRY || 'us';
  const res = await cyc.get(url, headers, { retries: retries ?? 8, proxy: true, country });
  if (res.status === 200) return res;
  const direct = await cyc.get(url, headers, { retries: 2, proxy: false });
  return direct.status === 200 ? direct : res;
}

async function fetchTrackerGG(userIdOrUsername, opts = {}) {
  if (process.env.R6_NO_TRACKER === '1') return [];
  if (!userIdOrUsername) return [];
  const username = opts.username || (typeof userIdOrUsername === 'string' && !/^[0-9a-f-]{36}$/i.test(userIdOrUsername) ? userIdOrUsername : null);
  const userId   = opts.userId   || (typeof userIdOrUsername === 'string' && /^[0-9a-f-]{36}$/i.test(userIdOrUsername)  ? userIdOrUsername : null);

  // Cache key: prefer userId (stable across name changes), fall back to username
  const cacheKey = userId || username;
  const cached = tgCache.get(cacheKey);
  // Same guards on cache reads as on live fetches — pre-fix caches carry poisoned
  // xbl/psn payloads that would otherwise still leak console ranks onto a PC
  // check. A rejected cache read falls through to the live fetch below.
  if (cached && !trackerProfileMismatch(cached, userId) && !trackerWrongPlatform(cached)) {
    const entries = parseTrackerGGSegments(cached);
    if (entries.length > 0) {
      console.log(`[tracker.gg] cache hit for ${String(cacheKey).slice(0, 12)}: ${entries.length} seasons`);
      return entries;
    }
  }

  // Skip the cooldown when we have the official API key OR a dedicated tracker
  // proxy (TRACKER_PROXY_URL, e.g. FlameProxies) — both are independent of the
  // shared pool's rate limit that the cooldown was protecting. Without this, one
  // old 429 on the shared pool wrongly disabled tracker.gg (our PRIMARY ban
  // source) for 5 minutes even though the FlameProxies path is healthy.
  if (!process.env.TRACKER_GG_API_KEY && !process.env.TRACKER_PROXY_URL && tgCache.isCoolingDown()) {
    const stale = tgCache.getStale(cacheKey);
    const staleOk = stale && !trackerProfileMismatch(stale, userId) && !trackerWrongPlatform(stale);
    const staleEntries = staleOk ? parseTrackerGGSegments(stale) : [];
    if (staleEntries.length) {
      console.log(`[tracker.gg] cooldown active — serving ${staleEntries.length} stale seasons`);
      return staleEntries;
    }
    return [];
  }

  const candidates = [];
  // PRIMARY: /ubi/{profileId-UUID} — the most reliable lookup (the user's
  // verified method). The ubi endpoint accepts the Ubisoft profile UUID
  // directly and resolves the current handle server-side.
  if (userId)   candidates.push({ kind: 'ubi',   url: `https://api.tracker.gg/api/v2/r6siege/standard/profile/ubi/${encodeURIComponent(userId)}` });
  // /ubi/{username} keys on the mutable, NON-UNIQUE display name, so it can
  // resolve to a different Ubisoft account that shares the handle (the identity
  // guard below discards those). It only ever ADDS value when a name change
  // left the UUID lookup under-indexed — a rare, history-only edge case. Skip it
  // in bulk (opts.noBrowser): both UUID lookups are authoritative and
  // collision-proof, and dropping it cuts ~1/3 of tracker.gg requests per check
  // — the main 429 bottleneck at scale. Keep it for interactive/full checks
  // where completeness matters and volume is low.
  if (username && !opts.noBrowser) candidates.push({ kind: 'ubi', url: `https://api.tracker.gg/api/v2/r6siege/standard/profile/ubi/${encodeURIComponent(username)}` });
  if (userId)   candidates.push({ kind: 'uplay', url: `https://api.tracker.gg/api/v2/r6siege/standard/profile/uplay/${encodeURIComponent(userId)}` });

  // Try BOTH endpoints and keep whichever returns the MOST ranked seasons.
  // The /ubi/{username} and /uplay/{userId} lookups can resolve to slightly
  // different/sparser tracker profiles (name changes, partial indexing), so
  // returning on the first 200 sometimes under-reported (2 seasons when 7
  // existed). With proxy rotation the extra request is cheap.
  let sawAny403 = false;
  let best = [];
  let bestRaw = null;
  for (const c of candidates) {
    try {
      const res = await trackerGet(c.url, {
        Authorization: 'api.tracker.gg', // the only header needed — no TRN key, no cookies
      }, opts.noBrowser ? 2 : 8); // bulk: fewer proxy retries before the direct fallback
      if (res.status === 429) {
        tgCache.trip(5 * 60_000);
        console.warn(`[tracker.gg/${c.kind}] HTTP 429 — cooldown tripped`);
        break;
      }
      if (res.status === 403) { sawAny403 = true; console.warn(`[tracker.gg/${c.kind}] 403 after proxy retries`); continue; }
      if (res.status !== 200) { console.warn(`[tracker.gg/${c.kind}] HTTP ${res.status}`); continue; }

      // IDENTITY GUARD: reject a profile that resolved to a DIFFERENT Ubisoft
      // account (username-collision on the /ubi/{username} candidate). Without
      // this, a Level-0 account whose own UUID lookup is empty inherits a
      // stranger's Champion/Diamond ranks purely because they share a handle.
      if (trackerProfileMismatch(res.data, userId)) {
        const got = String(res.data?.data?.platformInfo?.platformUserId || '').slice(0, 8);
        console.warn(`[tracker.gg/${c.kind}] identity mismatch (returned ${got}… ≠ ${String(userId).slice(0, 8)}…) — discarding, wrong account`);
        continue;
      }
      // PLATFORM GUARD: reject a response that resolved to a CONSOLE (xbl/psn)
      // — we're checking the Ubi/PC account, not the linked console.
      if (trackerWrongPlatform(res.data)) {
        const slug = res.data?.data?.platformInfo?.platformSlug;
        console.warn(`[tracker.gg/${c.kind}] wrong platform (resolved to ${slug}) — discarding, PC/Ubi account only`);
        continue;
      }

      const entries = parseTrackerGGSegments(res.data);
      console.log(`[tracker.gg/${c.kind}] ${entries.length} ranked seasons for ${String(cacheKey).slice(0, 12)}`);
      if (entries.length > best.length) { best = entries; bestRaw = res.data; }
    } catch (e) {
      console.warn(`[tracker.gg/${c.kind}] failed: ${e.message}`);
    }
  }

  if (best.length) {
    tgCache.set(cacheKey, bestRaw);
    return best;
  }

  // cycletls blocked on every IP. Escalate to a REAL browser (camoufox) that
  // executes Cloudflare's JS challenge and returns the JSON. Slower (~5-10s)
  // but actually bypasses CF instead of dodging it. Runs through the rotating
  // proxy too. SKIPPED in bulk (opts.noBrowser): launching headless Firefox per
  // account doesn't scale to hundreds of concurrent checks. The Authorization
  // header makes plain cycletls succeed anyway, so the browser is rarely needed.
  if (!opts.noBrowser) try {
    const trackerBrowser = require('./trackerBrowser');
    for (const c of candidates) {
      const res = await trackerBrowser.fetchJson(c.url);
      if (res.status === 200 && res.data) {
        if (trackerProfileMismatch(res.data, userId)) {
          console.warn(`[tracker.gg/${c.kind}] camoufox identity mismatch — discarding, wrong account`);
          continue;
        }
        if (trackerWrongPlatform(res.data)) {
          console.warn(`[tracker.gg/${c.kind}] camoufox wrong platform (${res.data?.data?.platformInfo?.platformSlug}) — discarding, PC/Ubi account only`);
          continue;
        }
        const entries = parseTrackerGGSegments(res.data);
        if (entries.length) {
          tgCache.set(cacheKey, res.data);
          console.log(`[tracker.gg/${c.kind}] ${entries.length} seasons via camoufox bypass`);
          return entries;
        }
      }
    }
  } catch (e) {
    console.warn('[tracker.gg] camoufox bypass failed:', e.message);
  }

  // All live attempts failed (403 after proxy retries). Fall back to the
  // last-known-good cached response so seasons that were fetched before
  // keep showing instead of vanishing to an empty list. Same guards apply.
  const stale = tgCache.getStale(cacheKey);
  if (stale && !trackerProfileMismatch(stale, userId) && !trackerWrongPlatform(stale)) {
    const staleEntries = parseTrackerGGSegments(stale);
    if (staleEntries.length) {
      console.log(`[tracker.gg] live blocked — serving ${staleEntries.length} stale seasons for ${String(cacheKey).slice(0,12)}`);
      return staleEntries;
    }
  }
  if (sawAny403) {
    tgCache.trip(15_000);
    console.warn('[tracker.gg] 403 after retries, no stale cache — 15s cooldown');
  }
  return [];
}

// Fetch ranked seasons for a SPECIFIC platform handle (xbl / psn / steam).
// Used to pull linked-account season stats — Siege rank is cross-progression
// so a player's Xbox/PSN handle may surface seasons the PC lookup missed
// (or be a wholly separate legacy account). Returns the same entry shape as
// fetchTrackerGG, tagged with the platform.
//   slug:   tracker.gg platform slug — 'xbl' | 'psn' | 'steam'
//   handle: the gamertag / PSN id / steam id or vanity
async function fetchTrackerGGForPlatform(slug, handle, opts = {}) {
  if (!slug || !handle) return [];
  const cacheKey = `${slug}:${handle}`;
  const cached = tgCache.get(cacheKey);
  if (cached) {
    const e = parseTrackerGGSegments(cached, slug);
    if (e.length) return e.map(x => ({ ...x, _platform: slug }));
  }
  if (!process.env.TRACKER_GG_API_KEY && !process.env.TRACKER_PROXY_URL && tgCache.isCoolingDown()) return [];

  const url = `https://api.tracker.gg/api/v2/r6siege/standard/profile/${encodeURIComponent(slug)}/${encodeURIComponent(handle)}`;
  try {
    const hdrs = { Authorization: 'api.tracker.gg' }; // no TRN key, no cookies
    const res = await trackerGet(url, hdrs, opts.retries);
    if (res.status === 429) { tgCache.trip(5 * 60_000); return []; }
    if (res.status === 403) return []; // blocked even direct — give up on this handle
    if (res.status !== 200) return [];
    tgCache.set(cacheKey, res.data);
    const entries = parseTrackerGGSegments(res.data, slug).map(x => ({ ...x, _platform: slug }));
    console.log(`[tracker.gg/${slug}] ${entries.length} ranked seasons for ${handle}`);
    return entries;
  } catch (e) {
    console.warn(`[tracker.gg/${slug}] failed for ${handle}: ${e.message}`);
    return [];
  }
}

// Parse tracker.gg's segments[] into our standard rank-entry shape.
// Each segment has (season, gamemode). We only want sessionType=ranked.
function parseTrackerGGSegments(payload, platform = 'pc') {
  const segments = payload?.data?.segments ?? [];
  const entries = [];
  for (const seg of segments) {
    if (seg.type !== 'season') continue;
    // Only ranked playlist — skip event, quick-match, arcade, standard, etc.
    if (seg.attributes?.sessionType !== 'ranked') continue;

    const seasonNum = seg.attributes?.season;
    if (!seasonNum) continue;

    const seasonName = seg.metadata?.seasonName ?? seg.metadata?.name ?? null;
    const entry = buildRankEntry(seasonNum, seasonName, seg.stats || {}, platform);
    if (entry) entries.push(entry);
  }
  // Sort newest season first
  entries.sort((a, b) => (b.season ?? 0) - (a.season ?? 0));
  return entries;
}

// Comparable score for "which platform's rank was higher this season".
// Rank id dominates (champion=36 > diamond > … > copper); RP/MMR breaks ties.
function rankScore(e) {
  if (!e) return -1;
  return (Number(e.rank) || 0) * 1_000_000 + (Number(e.mmr) || 0);
}

// Merge season entries from multiple platforms, keeping the HIGHEST rank per
// season (and that platform's full stats for the season). Input is a flat list
// of entries (each tagged with .platform). Returns one entry per season.
function pickHighestPerSeason(allEntries) {
  const bySeason = new Map();
  for (const e of allEntries) {
    if (!e || e.season == null) continue;
    const cur = bySeason.get(e.season);
    if (!cur || rankScore(e) > rankScore(cur)) bySeason.set(e.season, e);
  }
  return [...bySeason.values()].sort((a, b) => (b.season ?? 0) - (a.season ?? 0));
}

// ── stats.cc HTML scrape — kept as enrichment fallback ──────────────────
async function fetchStatsCC(username, userId) {
  const tries = [];
  if (userId) tries.push(`https://stats.cc/siege/-/${encodeURIComponent(userId)}`);
  if (username) tries.push(`https://stats.cc/siege/search?q=${encodeURIComponent(username)}`);

  for (const url of tries) {
    try {
      const res = await http({
        method: 'get', url,
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'text/html,application/xhtml+xml',
          'Accept-Language': 'en-US,en;q=0.5',
        },
        timeout: 10000,
        maxRedirects: 3,
      });
      const html = res.data;
      let entries = [];
      const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
      if (m) {
        try {
          const parsed = JSON.parse(m[1]);
          const pp = parsed?.props?.pageProps ?? {};
          const profile = pp.profile ?? pp.userData ?? pp.user ?? pp.player ?? {};
          const seasons = profile.seasons || profile.rankedSeasons || profile.ranks
                       || pp.seasons || pp.ranks || [];
          for (const s of (Array.isArray(seasons) ? seasons : [])) {
            const cur  = s.current ?? s.now ?? s;
            const peak = s.max ?? s.peak ?? s.high ?? cur;
            const mmr     = cur?.mmr ?? cur?.rankPoints ?? cur?.rp ?? 0;
            const maxMmr  = peak?.mmr ?? peak?.rankPoints ?? peak?.rp ?? mmr;
            if (!mmr && !maxMmr) continue;
            entries.push({
              season: s.season ?? s.seasonId ?? s.id ?? null,
              seasonName: s.name ?? s.seasonName ?? null,
              _currentRP: mmr, _peakRP: maxMmr,
              _source: 'stats.cc',
            });
          }
        } catch {}
      }
      if (entries.length === 0) {
        const rpMatches = [...html.matchAll(/"season"\s*:\s*(\d+)[^}]*?"rankPoints"\s*:\s*(\d+)/g)];
        for (const m of rpMatches) {
          entries.push({ season: +m[1], _currentRP: +m[2], _source: 'stats.cc' });
        }
      }
      if (entries.length > 0) {
        console.log(`[stats.cc] returned ${entries.length} segments from ${url.slice(0, 60)}`);
        return entries;
      }
    } catch (e) {
      console.warn(`[stats.cc] ${url.slice(0, 60)} failed: ${e.response?.status ?? e.message}`);
    }
  }
  return [];
}

// ── tracker.gg combat stats + gamemode breakdown ────────────────────────
// Parsed from the SAME payload fetchTrackerGG already caches (overview +
// gamemode segments) — so this adds ZERO extra network requests in the common
// case. Operators/weapons are NOT in this payload (availableSegments is empty),
// so they'd need separate rate-limited calls; we deliberately skip them here.

// Pull one tracker.gg stat into a small {value, display} shape.
function pickStat(stats, key) {
  const s = stats?.[key];
  if (!s) return null;
  const value = s.value ?? null;
  const display = s.displayValue ?? (value != null ? String(value) : null);
  if (value == null && display == null) return null;
  return { value, display };
}

// Parse overview combat stats, per-gamemode breakdown, and hero art.
function parseTrackerGGStats(payload) {
  const data = payload?.data;
  if (!data) return null;
  const segments = data.segments ?? [];

  const overviewSeg = segments.find(s => s.type === 'overview');
  if (!overviewSeg) return null;
  const st = overviewSeg.stats ?? {};

  const overview = {
    kdRatio:       pickStat(st, 'kdRatio'),
    winPct:        pickStat(st, 'winPercentage'),
    headshotPct:   pickStat(st, 'headshotPercentage'),
    kills:         pickStat(st, 'kills'),
    deaths:        pickStat(st, 'deaths'),
    matchesPlayed: pickStat(st, 'matchesPlayed'),
    matchesWon:    pickStat(st, 'matchesWon'),
    matchesLost:   pickStat(st, 'matchesLost'),
    killsPerMatch: pickStat(st, 'killsPerMatch'),
    damageDealt:   pickStat(st, 'damageDealt'),
    assists:       pickStat(st, 'assists'),
    timePlayed:    pickStat(st, 'timePlayed'),
  };
  // Bail if the segment had no usable stats at all
  if (!Object.values(overview).some(Boolean)) return null;

  const gamemodes = segments
    .filter(s => s.type === 'gamemode')
    .map(s => ({
      key:     s.attributes?.gamemode ?? '',
      name:    s.metadata?.gamemodeName ?? s.attributes?.gamemode ?? 'Mode',
      kd:      pickStat(s.stats, 'kdRatio'),
      winPct:  pickStat(s.stats, 'winPercentage'),
      matches: pickStat(s.stats, 'matchesPlayed'),
    }))
    .filter(g => g.matches?.value);

  return {
    overview,
    gamemodes,
    heroUrl: proxyImage(data.userInfo?.customHeroUrl) ?? null,
    handle:  data.platformInfo?.platformUserHandle ?? null,
    _source: 'tracker.gg',
  };
}

// Return parsed tracker.gg stats. Reuses the 1h disk cache that fetchTrackerGG
// populates; only makes a network call if the cache is cold AND we're not in a
// cooldown window (so we never trip the rate limit that powers season ranks).
async function fetchTrackerGGStats(userIdOrUsername, opts = {}) {
  if (process.env.R6_NO_TRACKER === '1') return null;
  if (!userIdOrUsername) return null;
  const username = opts.username || (typeof userIdOrUsername === 'string' && !/^[0-9a-f-]{36}$/i.test(userIdOrUsername) ? userIdOrUsername : null);
  const userId   = opts.userId   || (typeof userIdOrUsername === 'string' && /^[0-9a-f-]{36}$/i.test(userIdOrUsername)  ? userIdOrUsername : null);
  const cacheKey = userId || username;

  let payload = tgCache.get(cacheKey);
  if (!payload) {
    // Share the network path with fetchTrackerGG so we keep ONE source of
    // truth for headers, /ubi-vs-/uplay fallback, cooldown handling, etc.
    // fetchTrackerGG populates the cache as a side effect.
    await fetchTrackerGG(userIdOrUsername, opts);
    payload = tgCache.get(cacheKey);
  }
  if (!payload) return null;
  try {
    return parseTrackerGGStats(payload);
  } catch {
    return null;
  }
}

// ── Ban detection ────────────────────────────────────────────────────────
// tracker.gg's `metadata.banAlerts` is the canonical field — null when clean,
// an array (or non-empty object) when sanctions exist. We also check a few
// related fields as a belt-and-suspenders fallback.
function parseBanStatus(payload) {
  if (!payload?.data) return { banned: false, reason: null };
  const d = payload.data;
  const alerts = d.metadata?.banAlerts;
  const flags  = d.metadata?.flags || d.userInfo?.flags || {};

  // Prefer the human label ("Cheating") over the numeric reason code.
  const labelOf = (a) => a?.reasonName || (a?.reason != null ? `reason ${a.reason}` : a?.type) || 'sanctioned';
  // A reversed ban (banReversed === true) is no longer in effect — ignore it.
  const active = (a) => a && a.banReversed !== true;

  let banned = false;
  let reason = null;

  if (Array.isArray(alerts)) {
    const live = alerts.filter(active);
    if (live.length) { banned = true; reason = labelOf(live[0]); }
  } else if (alerts && typeof alerts === 'object' && Object.keys(alerts).length > 0) {
    if (active(alerts)) { banned = true; reason = labelOf(alerts); }
  } else if (flags.banned || flags.isBanned || d.userInfo?.isBanned || d.platformInfo?.banned) {
    banned = true;
    reason = d.userInfo?.banReason || d.metadata?.banReason || null;
  }

  return { banned, reason };
}

// Returns { banned, reason } using the tracker.gg payload that fetchTrackerGG
// already cached. Zero extra network in the common case.
async function fetchBanStatus(userIdOrUsername, opts = {}) {
  if (process.env.R6_NO_TRACKER === '1') return { banned: false, reason: null };
  if (!userIdOrUsername) return { banned: false, reason: null };
  const username = opts.username || (typeof userIdOrUsername === 'string' && !/^[0-9a-f-]{36}$/i.test(userIdOrUsername) ? userIdOrUsername : null);
  const userId   = opts.userId   || (typeof userIdOrUsername === 'string' && /^[0-9a-f-]{36}$/i.test(userIdOrUsername)  ? userIdOrUsername : null);
  const cacheKey = userId || username;
  let payload = tgCache.get(cacheKey);
  if (!payload) {
    await fetchTrackerGG(userIdOrUsername, opts);
    payload = tgCache.get(cacheKey);
  }
  return parseBanStatus(payload || null);
}

// Parse stats.cc `ranked_season_records` (object or array) into rank entries
// matching getSeasonRanks()'s shape. Desktop uses this instead of tracker.gg.
function parseStatsCcSeasonRanks(raw) {
  if (!raw) return [];
  const list = Array.isArray(raw) ? raw : Object.values(raw);
  const entries = [];
  for (const rec of list) {
    if (!rec || typeof rec !== 'object') continue;
    const season = Number(rec.season ?? rec.season_id ?? rec.season_number ?? rec.id);
    if (!season) continue;
    const peakRP = Number(
      rec.max_rank_points ?? rec.max_mmr ?? rec.peak_rp ?? rec.max_rank_points ?? rec.rank_points ?? rec.mmr ?? 0,
    );
    const curRP = Number(rec.rank_points ?? rec.current_rank_points ?? rec.current_mmr ?? peakRP);
    const peakName = rec.max_rank_name ?? rec.peak_rank_name ?? rec.max_rank ?? rec.rank_name ?? '';
    const curName = rec.rank_name ?? rec.current_rank_name ?? peakName;
    let peakId = (Number(rec.max_rank) > 0 && Number(rec.max_rank) < 40) ? Number(rec.max_rank) : 0;
    let curId = (Number(rec.rank) > 0 && Number(rec.rank) < 40) ? Number(rec.rank) : 0;
    if (!peakId && peakName) peakId = rankIdFromName(String(peakName));
    if (!curId && curName) curId = rankIdFromName(String(curName));
    if (!peakId && peakRP > 0) peakId = rpToRankId(peakRP);
    if (!curId && curRP > 0) curId = rpToRankId(curRP);
    if (!peakId && !curId && !peakRP && !curRP) continue;
    const peakInfo = getRankV6(peakId || curId);
    const curInfo = getRankV6(curId || peakId);
    entries.push({
      season,
      seasonName: SEASON_NAMES[season] ?? `Season ${season}`,
      rank: peakId || curId,
      rankName: prettyRank(peakName) || peakInfo.name,
      rankTier: peakInfo.tier,
      mmr: peakRP || curRP,
      iconUrl: proxyImage(`${R6DATA_RANK_IMG}${peakInfo.r6slug}.webp`),
      currentRank: curId || peakId,
      currentRankName: prettyRank(curName) || curInfo.name,
      currentRankTier: curInfo.tier,
      currentMmr: curRP,
      currentIconUrl: proxyImage(`${R6DATA_RANK_IMG}${curInfo.r6slug}.webp`),
      _source: 'stats.cc',
    });
  }
  entries.sort((a, b) => (b.season ?? 0) - (a.season ?? 0));
  return entries;
}

// stats.cc (r6.stats.cc) JSON API — ONE direct call returns the cheating-ban
// flag, last-played timestamp, linked platform profiles (devices), and ranked
// season records. The x-api-key is a throwaway UUID (their own web client does
// the same), and the endpoint isn't behind tracker.gg's Cloudflare wall, so it
// works DIRECT — no browser, no rotating IP needed. Falls back to the proxy only
// if a direct call is ever blocked. Returns null on any failure.
async function fetchStatsCcProfile(profileId, opts = {}) {
  if (!profileId) return null;
  const url = `https://r6.stats.cc/v2/profiles/${encodeURIComponent(profileId)}?increment_views=false`;
  const headers = {
    'x-api-key': crypto.randomUUID(),
    'x-stats-cc-client': 'web-csr',
    'x-locale': 'en',
    'Accept': 'application/json',
    'Origin': 'https://stats.cc',
    'Referer': 'https://stats.cc/',
    'User-Agent': 'Mozilla/5.0',
  };
  const timeout = opts.timeout || 5000;
  const attempt = (extra) => axios({ method: 'get', url, headers, timeout, validateStatus: () => true, ...extra }).catch(() => null);
  // Desktop bulk: route through the user's BYO proxy (UBI_PROXY_URL) with a
  // fresh session IP. The old path only used cycletls — which isn't shipped in
  // the SEA exe — so stats.cc NEVER returned on desktop → ban misses + empty ranks.
  const viaEnrichProxy = async () => {
    const proxyUrl = opts.proxyUrl || process.env.UBI_PROXY_URL;
    if (!proxyUrl) return null;
    try {
      let freshProxy = (u) => u;
      try { freshProxy = require('./auth').freshProxy; } catch {}
      const { HttpsProxyAgent } = require('https-proxy-agent');
      const { cachedLookup } = require('./dnsCache');
      return await attempt({
        httpsAgent: new HttpsProxyAgent(freshProxy(proxyUrl), { lookup: cachedLookup }),
        proxy: false,
      });
    } catch { return null; }
  };
  const viaFreshProxy = async () => {
    try {
      const cyc = getCycletls();
      if (!cyc) return null;
      const pu = cyc.proxyUrl(Math.floor((Date.now() % 100000)));
      if (!pu) return null;
      const { HttpsProxyAgent } = require('https-proxy-agent');
      const { cachedLookup } = require('./dnsCache');
      return await attempt({ httpsAgent: new HttpsProxyAgent(pu, { lookup: cachedLookup }), proxy: false });
    } catch { return null; }
  };
  // stats.cc rate-limits a single IP hard (the x-api-key trick is ~one shot per
  // IP), so under BULK concurrency we must hit it from a FRESH residential IP
  // each call → PROXY-FIRST. A single interactive check is low-volume, so it goes
  // DIRECT-FIRST (fast ~1.2s) and only falls back to the proxy on rate-limit.
  let res;
  if (opts.bulk) {
    res = await viaEnrichProxy();
    if (!res || res.status !== 200) res = await viaFreshProxy();
    if (!res || res.status !== 200) { const d = await attempt({}); if (d && d.status === 200) res = d; }
  } else {
    res = await attempt({});
    if (!res || res.status === 429 || res.status >= 500 || (res.status && res.status !== 200)) {
      const p = await viaEnrichProxy();
      if (p && p.status === 200) res = p;
      if (!res || res.status !== 200) {
        const c = await viaFreshProxy();
        if (c && c.status === 200) res = c;
      }
    }
  }
  if (!res || res.status !== 200 || !res.data || typeof res.data !== 'object') return null;
  const d = res.data;
  const platforms = Array.isArray(d.platform_profiles)
    ? d.platform_profiles.map(p => ({ platform: p.platform, username: p.username, level: p.level, id: p.id || p.user_id }))
    : [];
  return {
    banned: !!d.is_cheating_banned,
    lastPlayedAt: d.last_played_at || null,
    username: d.username || null,
    platforms,
    seasons: d.ranked_season_records || {},
  };
}

// Legacy alias — kept so old callers that import fetchTrackerNetwork still work.
const fetchTrackerNetwork = fetchTrackerGG;

// Race extras (called by player.js for enrichment after primary source).
async function fetchAllExtraSources(username, userId) {
  const all = await Promise.allSettled([
    fetchStatsCC(username, userId),
  ]);
  const results = [];
  for (const r of all) {
    if (r.status === 'fulfilled' && r.value.length > 0) results.push(...r.value);
  }
  return results;
}

module.exports = {
  fetchTrackerGG,
  fetchTrackerGGForPlatform,
  fetchTrackerGGStats,
  parseTrackerGGStats,
  fetchTrackerNetwork, // legacy alias
  fetchStatsCC,
  fetchStatsCcProfile,
  parseStatsCcSeasonRanks,
  fetchAllExtraSources,
  fetchBanStatus,
  parseBanStatus,
  pickHighestPerSeason,
  rankScore,
  // exported for unit tests
  parseTrackerGGSegments,
  buildRankEntry,
  rpToRankId,
  trackerProfileMismatch,
  trackerWrongPlatform,
};
