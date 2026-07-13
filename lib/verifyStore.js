// Verification store (server side). Records the device fingerprint + IP + UA we
// saw for each verified Discord user, so a second account verifying from the
// SAME device/IP can be flagged as an alt. Stored as JSON — verifications are
// bounded by the member count, so a rewrite-on-write file is fine.

const fs = require('fs');
const path = require('path');

const FILE = path.join(process.env.CACHE_DIR || path.join(__dirname, '..', '.cache'), 'verifications.json');

function load() { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')) || { records: [] }; } catch { return { records: [] }; } }
function save(d) {
  try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(d), { mode: 0o600 }); }
  catch (e) { console.warn('[verify] save failed:', e.message); }
}

// Match an IP against a "1.2.3.4, 5.6.7.0/24" allowlist. CIDR support keeps
// office / mobile-carrier ranges simple to add without listing every IP.
function _ipInList(ip, list) {
  if (!ip || !Array.isArray(list) || !list.length) return false;
  for (const raw of list) {
    const entry = String(raw || '').trim();
    if (!entry) continue;
    if (entry === ip) return true;
    if (entry.includes('/')) {
      const [base, bitsStr] = entry.split('/');
      const bits = Number(bitsStr);
      if (!base.includes(':') && !ip.includes(':') && bits >= 0 && bits <= 32) {
        const toInt = (s) => s.split('.').reduce((a, o) => (a << 8 | (Number(o) & 255)) >>> 0, 0);
        const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
        if ((toInt(base) & mask) === (toInt(ip) & mask)) return true;
      }
    }
  }
  return false;
}

// Is this device/IP already tied to a DIFFERENT Discord account? Device cookie is
// the strong signal (same browser → same person); IP is opt-in (VERIFY_IP_CHECK)
// because it's noisy (shared/household/mobile IPs). opts.ipAllowlist bypasses
// the IP match for known-shared networks (office, mobile carriers, etc).
function checkAlt(discordId, deviceId, ip, opts = {}) {
  const d = load();
  for (const r of d.records) {
    if (r.discordId === discordId) continue;
    if (deviceId && r.deviceId === deviceId) return { isAlt: true, reason: 'same device', matchedDiscordId: r.discordId, matchedUsername: r.username };
  }
  if (opts.ipCheck && ip && !_ipInList(ip, opts.ipAllowlist)) {
    for (const r of d.records) {
      if (r.discordId === discordId) continue;
      if (r.ip === ip) return { isAlt: true, reason: 'same IP', matchedDiscordId: r.discordId, matchedUsername: r.username };
    }
  }
  return { isAlt: false };
}

// Upsert a verification record (keyed by Discord id).
function record({ discordId, username, deviceId, ip, ua }) {
  const d = load();
  const existing = d.records.find(r => r.discordId === discordId);
  if (existing) Object.assign(existing, { username, deviceId, ip, ua, verifiedAt: Date.now() });
  else d.records.push({ discordId, username, deviceId, ip, ua, verifiedAt: Date.now() });
  save(d);
}

function isVerified(discordId) { return load().records.some(r => r.discordId === discordId); }

module.exports = { checkAlt, record, isVerified };
