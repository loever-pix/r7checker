// Persistent invite-join log. Records who joined via whose invite (+ the
// joiner's account-creation time) so /invites can show each inviter their joins.
// Stored as JSON keyed by inviterId for O(1) lookups; joins are infrequent so a
// rewrite-on-write file is fine.

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', '..', '.cache', 'invite-log.json');

function load() { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')) || {}; } catch { return {}; } }
function save(data) {
  try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(data)); }
  catch (e) { console.warn('[inviteLog] save failed:', e.message); }
}

// Record a join. rec = { inviterId, joinerId, joinerName, createdAt, code }.
function record(rec) {
  if (!rec || !rec.inviterId || !rec.joinerId) return;
  const data = load();
  const arr = data[rec.inviterId] || (data[rec.inviterId] = []);
  arr.push({
    joinerId: rec.joinerId,
    joinerName: rec.joinerName || '',
    createdAt: rec.createdAt || null,   // joiner's account-creation ms
    joinedAt: Date.now(),
    code: rec.code || null,
    left: false,
  });
  save(data);
}

// Mark the latest open record for a leaving member as "left".
function markLeft(joinerId) {
  const data = load();
  let changed = false;
  for (const arr of Object.values(data)) {
    for (let i = arr.length - 1; i >= 0; i--) {
      if (arr[i].joinerId === joinerId && !arr[i].left) { arr[i].left = true; changed = true; break; }
    }
    if (changed) break;
  }
  if (changed) save(data);
}

// All join records credited to an inviter (oldest → newest).
function forInviter(inviterId) {
  return (load()[inviterId] || []).slice();
}

module.exports = { record, markLeft, forInviter };
