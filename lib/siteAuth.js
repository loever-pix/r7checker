// Site-level email/password auth — separate from existing Discord OAuth.
//
// Password storage: scrypt (Node stdlib). No bcrypt/argon2 dep.
// Session storage: SQLite row keyed by 32-byte hex token in HttpOnly cookie.
// Cookie name `r6_sid` is distinct from Discord's `r6locker_discord_session`.

const crypto = require('crypto');
const store  = require('./store');
const email  = require('./email');

const COOKIE_NAME = 'r6_sid';
const SCRYPT_N = 16384, SCRYPT_R = 8, SCRYPT_P = 1, SCRYPT_KEYLEN = 64;
const SCRYPT_MAXMEM = 64 * 1024 * 1024; // 64MB - room for N=16384,r=8 (~16MB)

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAXMEM });
  return `${salt.toString('hex')}$${hash.toString('hex')}`;
}

// Verify a password against a stored hash. Constant-time compare.
// Always does the scrypt work even on a fake hash so attackers can't
// distinguish "user doesn't exist" from "wrong password" by timing.
const DUMMY_HASH = (() => {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync('not-a-real-password', salt, SCRYPT_KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAXMEM });
  return `${salt.toString('hex')}$${hash.toString('hex')}`;
})();

function verifyPassword(password, stored) {
  const target = stored || DUMMY_HASH;
  const [saltHex, hashHex] = target.split('$');
  if (!saltHex || !hashHex) return false;
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  let actual;
  try {
    actual = crypto.scryptSync(password, salt, expected.length, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAXMEM });
  } catch { return false; }
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected) && !!stored;
}

// ── Cookies ──────────────────────────────────────────────────────────────
function setSessionCookie(res, token) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${30 * 24 * 60 * 60}${secure}`);
}
function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
}
function readSessionCookie(req) {
  const raw = req.headers.cookie || '';
  const m = raw.match(new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([^;]+)`));
  return m ? m[1] : null;
}

// ── Middleware ───────────────────────────────────────────────────────────
// Attaches req.siteUser when a valid session is found, else null.
function siteUserMiddleware(req, _res, next) {
  const token = readSessionCookie(req);
  const session = token ? store.getSession(token) : null;
  if (session) {
    req.siteUser = store.getUserById(session.user_id);
    req.siteSessionToken = token;
    // Slide expiry on activity (cheap — 1 UPDATE)
    if (session.expires_at - Date.now() < 7 * 24 * 60 * 60 * 1000) {
      try { store.renewSession(token); } catch {}
    }
  } else {
    req.siteUser = null;
  }
  next();
}

function requireUser(req, res, next) {
  if (!req.siteUser) return res.status(401).json({ error: 'Sign in required.' });
  next();
}

// Owner allowlist from env (comma-separated emails), case-insensitive.
// Defaults to the operator's email if unset.
function ownerEmails() {
  return (process.env.OWNER_EMAILS || 'owner@example.com')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
}
function isOwner(user) {
  return !!user && ownerEmails().includes(String(user.email || '').toLowerCase());
}
// Gate a route to the owner only. 404 (not 403) so the endpoint's existence
// isn't even confirmed to non-owners.
function requireOwner(req, res, next) {
  if (!isOwner(req.siteUser)) return res.status(404).json({ error: 'Not found.' });
  next();
}

// ── Validation ───────────────────────────────────────────────────────────
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function validateEmail(email) {
  return typeof email === 'string' && email.length <= 254 && EMAIL_RE.test(email);
}
// Minimum 12 chars. Sweet spot for 2026 — substantially better than 8 against
// offline cracking, still memorable as a short passphrase.
const MIN_PASSWORD_LEN = 12;
function validatePassword(pw) {
  return typeof pw === 'string' && pw.length >= MIN_PASSWORD_LEN && pw.length <= 200;
}

// ── Route handlers ───────────────────────────────────────────────────────
async function handleSignup(req, res, verifyTurnstile, getTurnstileToken) {
  const { email, password } = req.body || {};
  if (!validateEmail(email))    return res.status(400).json({ error: 'Invalid email format.' });
  if (!validatePassword(password)) return res.status(400).json({ error: `Password must be ${MIN_PASSWORD_LEN}–200 characters.` });
  const ip = req.headers['cf-connecting-ip'] || req.ip || '';
  if (verifyTurnstile && !(await verifyTurnstile(getTurnstileToken(req), ip))) {
    return res.status(403).json({ error: 'Captcha check failed — complete the challenge and try again.' });
  }
  if (store.getUserByEmail(email)) {
    return res.status(409).json({ error: 'An account with that email already exists.' });
  }
  const user = store.createUser(email, hashPassword(password));
  const token = store.createSession(user.id);
  setSessionCookie(res, token);
  store.touchLogin(user.id);
  res.json({ user: publicUser(user) });
}

async function handleLogin(req, res, verifyTurnstile, getTurnstileToken) {
  const { email, password } = req.body || {};
  if (typeof email !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'Email and password required.' });
  }
  const ip = req.headers['cf-connecting-ip'] || req.ip || '';
  if (verifyTurnstile && !(await verifyTurnstile(getTurnstileToken(req), ip))) {
    return res.status(403).json({ error: 'Captcha check failed — complete the challenge and try again.' });
  }
  const user = store.getUserByEmail(email);
  // Always run scrypt — even when user is missing — so timing can't reveal
  // whether the email is registered.
  const ok = verifyPassword(password, user ? user.password_hash : null);
  if (!ok || !user) return res.status(401).json({ error: 'Invalid email or password.' });
  const token = store.createSession(user.id);
  setSessionCookie(res, token);
  store.touchLogin(user.id);
  res.json({ user: publicUser(user) });
}

function handleLogout(req, res) {
  if (req.siteSessionToken) store.deleteSession(req.siteSessionToken);
  clearSessionCookie(res);
  res.json({ ok: true });
}

function handleMe(req, res) {
  if (!req.siteUser) return res.json({ user: null });
  // Re-read for fresh balance (req.siteUser was captured at middleware time)
  const fresh = store.getUserById(req.siteUser.id);
  res.json({ user: { ...publicUser(fresh), isOwner: isOwner(fresh) } });
}

// ── Password reset ───────────────────────────────────────────────────────
// Forgot-password: always returns 200 regardless of whether the email exists,
// to prevent attackers from probing valid emails. The email is sent only if
// the user actually exists; otherwise we silently no-op.
async function handleForgot(req, res) {
  const { email: emailAddr } = req.body || {};
  // Don't reveal validation errors to attackers — always return the same 200.
  if (validateEmail(emailAddr)) {
    const user = store.getUserByEmail(emailAddr);
    if (user) {
      try {
        const token = store.createResetToken(user.id);
        const siteUrl = process.env.SITE_URL || 'http://localhost:3000';
        const resetUrl = `${siteUrl}/account/reset?token=${token}`;
        await email.sendPasswordReset(user.email, resetUrl);
        console.log(`[auth/forgot] reset link sent to user ${user.id} (${user.email})`);
      } catch (e) {
        // Never throw to the caller — would expose existence of user.
        console.error('[auth/forgot] internal error:', e.message);
      }
    } else {
      console.log(`[auth/forgot] no user for ${emailAddr} — silent no-op`);
    }
  }
  // Always:
  res.json({ ok: true, message: 'If that email is registered, a reset link has been sent.' });
}

async function handleReset(req, res) {
  const { token, password } = req.body || {};
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) {
    return res.status(400).json({ error: 'Invalid or missing reset token.' });
  }
  if (!validatePassword(password)) {
    return res.status(400).json({ error: `Password must be ${MIN_PASSWORD_LEN}–200 characters.` });
  }
  const newHash = hashPassword(password);
  const result = store.consumeResetToken(token, newHash);
  if (!result.ok) {
    return res.status(400).json({ error: 'This reset link is invalid or has expired. Request a new one.' });
  }
  console.log(`[auth/reset] password changed for user ${result.userId}, ${result.sessionsKilled} session(s) invalidated`);
  res.json({ ok: true });
}

// GET handler for /account/reset — verifies the token is valid before
// serving the reset form. Returns null if invalid (so the page can show
// a "link expired" message).
function getResetTokenInfo(token) {
  const row = store.getResetToken(token);
  if (!row) return null;
  return { valid: true, expiresAt: row.expires_at };
}

function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    email: user.email,
    balanceCents: user.balance_cents,
    createdAt: user.created_at,
  };
}

module.exports = {
  COOKIE_NAME,
  siteUserMiddleware, requireUser,
  hashPassword, verifyPassword,
  handleSignup, handleLogin, handleLogout, handleMe,
  handleForgot, handleReset, getResetTokenInfo,
  requireOwner, isOwner,
  publicUser, MIN_PASSWORD_LEN,
};
