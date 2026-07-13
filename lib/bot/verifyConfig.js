// Persisted verification config — the Verified role to grant and an optional
// alt-alert log channel. Set by /setupverify, read by the bot's grant endpoint.

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', '..', '.cache', 'verify-config.json');

function get() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')) || {}; } catch { return {}; }
}
function set(patch) {
  const next = { ...get(), ...patch };
  try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(next)); }
  catch (e) { console.warn('[verify] config save failed:', e.message); }
  return next;
}

module.exports = { get, set };
