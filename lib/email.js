// Email sender — wraps nodemailer with SMTP config from .env.
//
// If SMTP_HOST is unset, falls back to console-logging the message so dev
// works without an email provider. On prod, set SMTP_HOST/PORT/USER/PASS
// and FROM in .env and a real email will go out.
//
// Recommended providers for the free tier:
//   - Brevo (sendinblue): 300 emails/day free, easy SMTP
//   - Resend: 100/day free
//   - Mailgun: 5000/month for 3 months
//   - Gmail with an App Password: works but throttles after ~100/day

let _transport = null;
let _warnedNoConfig = false;

function nodemailer() {
  // Lazy-require so the dep isn't loaded until actually needed
  return require('nodemailer');
}

function getTransport() {
  if (_transport !== null) return _transport;
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 587);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!host || !user || !pass) {
    if (!_warnedNoConfig) {
      console.warn('[email] SMTP_HOST/USER/PASS not set — emails will be console-logged only');
      _warnedNoConfig = true;
    }
    _transport = false;
    return false;
  }
  _transport = nodemailer().createTransport({
    host, port,
    secure: port === 465,         // STARTTLS for 587, implicit TLS for 465
    auth: { user, pass },
  });
  console.log(`[email] SMTP transport ready: ${user}@${host}:${port}`);
  return _transport;
}

function from() {
  return process.env.SMTP_FROM || 'R6Checker <noreply@r6checker.xyz>';
}

// Send a plain-text + simple HTML message. Always resolves; logs failures.
async function send({ to, subject, text, html }) {
  const transport = getTransport();
  if (!transport) {
    console.log('\n──── [email] (NO SMTP — would have sent) ────');
    console.log(`  To: ${to}`);
    console.log(`  Subject: ${subject}`);
    console.log(`  Body:\n${text}\n────────────────────────────────────────────\n`);
    return { ok: false, reason: 'no_smtp' };
  }
  try {
    const info = await transport.sendMail({ from: from(), to, subject, text, html });
    console.log(`[email] sent to ${to}: ${info.messageId}`);
    return { ok: true, messageId: info.messageId };
  } catch (e) {
    console.error(`[email] send failed to ${to}:`, e.message);
    return { ok: false, reason: 'send_failed', error: e.message };
  }
}

// ── Templates ────────────────────────────────────────────────────────────
async function sendPasswordReset(email, resetUrl) {
  const subject = 'Reset your R6Checker password';
  const text =
`Hi,

You (or someone using your email) asked to reset your R6Checker password.
Click the link below to set a new one. The link is valid for 1 hour.

${resetUrl}

If you didn't request this, you can ignore this email — nothing will change.

— R6Checker
`;
  const html =
`<div style="font-family:system-ui,-apple-system,sans-serif;max-width:520px;margin:0 auto;padding:1.5rem;color:#222;line-height:1.55">
  <h2 style="color:#3a8dff;margin:0 0 1rem">Reset your password</h2>
  <p>Someone (hopefully you) asked to reset your R6Checker password.</p>
  <p style="margin:1.5rem 0">
    <a href="${resetUrl}" style="display:inline-block;background:#3a8dff;color:#fff;padding:.65rem 1.2rem;border-radius:6px;text-decoration:none;font-weight:600">Reset password</a>
  </p>
  <p style="color:#666;font-size:.85rem">Or paste this link in your browser:<br><a href="${resetUrl}" style="color:#3a8dff;word-break:break-all">${resetUrl}</a></p>
  <p style="color:#888;font-size:.8rem;margin-top:1.5rem">The link is valid for 1 hour. If you didn't request this, ignore this email — your password won't change.</p>
  <p style="color:#aaa;font-size:.75rem;margin-top:2rem;border-top:1px solid #eee;padding-top:1rem">R6Checker — <a href="https://r6checker.xyz" style="color:#aaa">r6checker.xyz</a></p>
</div>`;
  return send({ to: email, subject, text, html });
}

module.exports = { send, sendPasswordReset };
