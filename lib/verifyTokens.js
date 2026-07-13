// Per-Discord-id OAuth-token store backed by the main SQLite DB (table
// `discord_oauth`). Was a JSON file (.cache/verify-tokens.json) — kept here as
// the same .save/.get API so callers don't change. We also one-shot migrate
// any leftover JSON on load.

const fs    = require('fs');
const path  = require('path');
const store = require('./store');

const OLD_JSON = path.join(process.env.CACHE_DIR || path.join(__dirname, '..', '.cache'), 'verify-tokens.json');

// One-shot migrate any pre-existing JSON into the DB the first time we boot.
// Idempotent (UPSERT) so re-running is safe. Renames the JSON to .migrated.
(function migrateLegacyJson() {
  try {
    if (!fs.existsSync(OLD_JSON)) return;
    const raw = JSON.parse(fs.readFileSync(OLD_JSON, 'utf8'));
    let n = 0;
    for (const [discordId, r] of Object.entries(raw || {})) {
      if (!discordId || !r) continue;
      store.upsertDiscordOauth({
        discordId,
        username:    r.username || null,
        email:       r.email || null,
        refreshToken: r.refreshToken || null,
        accessToken:  r.accessToken || null,
        // The legacy JSON stored an absolute expires-at; reconstruct an
        // approximate expiresIn so upsert's column math comes out right.
        expiresIn:   r.accessTokenExpiresAt ? Math.max(0, Math.round((r.accessTokenExpiresAt - Date.now()) / 1000)) : null,
        scope:       r.scope || null,
      });
      n++;
    }
    fs.renameSync(OLD_JSON, OLD_JSON + '.migrated');
    if (n) console.log(`[verify-tokens] migrated ${n} record(s) from JSON to DB`);
  } catch (e) { console.warn('[verify-tokens] legacy JSON migration failed:', e.message); }
})();

function save(rec) { return store.upsertDiscordOauth(rec); }
function get(discordId) {
  const r = store.getDiscordOauth(discordId);
  if (!r) return null;
  // Return a shape callers can use without knowing about the DB columns.
  return {
    discordId:    r.discord_id,
    username:     r.username,
    email:        r.email,
    refreshToken: r.refresh_token,
    accessToken:  r.access_token,
    accessTokenExpiresAt: r.access_token_expires_at,
    scope:        r.scope,
    updatedAt:    r.updated_at,
  };
}

module.exports = { save, get };
