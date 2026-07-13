// Small shared helpers for the bot commands.

const { cfg } = require('./config');

// True if the interacting member holds the owner role. Works whether roles are
// a GuildMemberRoleManager (cache) or a raw array of role-id strings.
function isOwner(interaction) {
  const roles = interaction.member && interaction.member.roles;
  if (!roles) return false;
  if (Array.isArray(roles)) return roles.includes(cfg.ownerRoleId);
  if (roles.cache) return roles.cache.has(cfg.ownerRoleId);
  return false;
}

// True if the member is the owner OR holds one of the extra recheck-allowed roles.
function canRecheck(interaction) {
  if (isOwner(interaction)) return true;
  const roles = interaction.member && interaction.member.roles;
  if (!roles) return false;
  const allowed = cfg.rechekRoleIds || [];
  if (Array.isArray(roles)) return allowed.some(r => roles.includes(r));
  if (roles.cache) return allowed.some(r => roles.cache.has(r));
  return false;
}

// brandon@example.com → b****n@example.com
function maskEmail(email) {
  if (typeof email !== 'string' || !email.includes('@')) return String(email || '');
  const [user, domain] = email.split('@');
  const head = user.slice(0, 1);
  const tail = user.length > 1 ? user.slice(-1) : '';
  return `${head}${'*'.repeat(Math.max(1, user.length - 2))}${tail}@${domain}`;
}

function sameEmail(a, b) {
  return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
}

module.exports = { isOwner, canRecheck, maskEmail, sameEmail };
