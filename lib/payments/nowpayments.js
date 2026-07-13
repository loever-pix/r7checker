// NOWPayments deposit integration.
//
// Flow:
//   createInvoice(userId, amountUsd)  → returns hosted checkout URL,
//     records 'waiting' deposit row keyed by NOWPayments payment_id.
//   verifyIpnSignature(raw, sig)      → HMAC-SHA512 of the *raw* body
//     against IPN_SECRET, constant-time compare.
//   handleIpn(payload)                → if status='finished' AND not credited
//     → credit user balance in a single SQLite tx (idempotent).
//   pollPendingDeposits()             → fallback if a webhook was lost.

const axios  = require('axios');
const crypto = require('crypto');
const store  = require('../store');

const NP_BASE = 'https://api.nowpayments.io/v1';
const SITE_URL = process.env.SITE_URL || 'http://localhost:3000';

function apiKey() { return process.env.NOWPAYMENTS_API_KEY || ''; }
function ipnSecret() { return process.env.NOWPAYMENTS_IPN_SECRET || ''; }

function isConfigured() {
  return !!apiKey();
}

// ── Create an invoice ────────────────────────────────────────────────────
// Returns { invoiceId, invoiceUrl }. Records a 'waiting' deposit so the
// webhook (or polling fallback) can later credit it idempotently.
async function createInvoice(userId, amountUsd) {
  if (!isConfigured()) throw new Error('NOWPayments not configured (NOWPAYMENTS_API_KEY missing).');

  const orderId = 'dep_' + crypto.randomBytes(8).toString('hex');
  const body = {
    price_amount: Number(amountUsd),
    price_currency: 'usd',
    order_id: orderId,
    order_description: `R6Checker balance deposit ($${amountUsd})`,
    ipn_callback_url: `${SITE_URL}/webhook/nowpayments`,
    success_url: `${SITE_URL}/account?deposit=success`,
    cancel_url:  `${SITE_URL}/account?deposit=cancel`,
  };

  const res = await axios.post(`${NP_BASE}/invoice`, body, {
    headers: { 'x-api-key': apiKey(), 'Content-Type': 'application/json' },
    timeout: 15000,
    validateStatus: () => true,
  });

  if (res.status >= 400) {
    const msg = res.data?.message || `HTTP ${res.status}`;
    console.warn('[nowpayments] createInvoice failed:', res.status, JSON.stringify(res.data).slice(0, 200));
    const e = new Error(`Payment provider error: ${msg}`);
    e.status = res.status >= 500 ? 503 : 400;
    throw e;
  }

  const invoiceId = String(res.data.id || res.data.invoice_id || res.data.iid);
  const invoiceUrl = res.data.invoice_url;
  if (!invoiceId || !invoiceUrl) {
    console.warn('[nowpayments] unexpected response:', JSON.stringify(res.data).slice(0, 300));
    throw Object.assign(new Error('Payment provider returned an unexpected response.'), { status: 502 });
  }
  // Defence: verify the invoice URL lives on a NOWPayments domain before
  // handing it to the client (which will window.open it). Without this an
  // (admittedly hostile) NOWPayments response could redirect users to any
  // URL — including javascript: or attacker-controlled phishing pages.
  try {
    const parsed = new URL(invoiceUrl);
    const ok = parsed.protocol === 'https:' &&
               (parsed.hostname === 'nowpayments.io' || parsed.hostname.endsWith('.nowpayments.io'));
    if (!ok) {
      console.warn('[nowpayments] suspicious invoice URL:', invoiceUrl);
      throw new Error('Payment provider returned an unexpected invoice URL.');
    }
  } catch (e) {
    throw Object.assign(new Error('Payment provider returned a malformed invoice URL.'), { status: 502 });
  }

  store.recordDeposit({
    invoiceId, userId,
    amountUsd: Number(amountUsd),
    status: 'waiting',
  });

  return { invoiceId, invoiceUrl };
}

// ── Create a SUBSCRIPTION invoice (BYO-proxy access) ───────────────────────
// planId ∈ store.SUBSCRIPTION_PLANS (daily/weekly/monthly). Records a
// subscription_invoice so the webhook can extend the user's access idempotently.
async function createSubscriptionInvoice(userId, planId) {
  if (!isConfigured()) throw new Error('NOWPayments not configured (NOWPAYMENTS_API_KEY missing).');
  const plan = store.getPlan(planId);
  if (!plan) { const e = new Error('Unknown subscription plan.'); e.status = 400; throw e; }

  const orderId = 'sub_' + crypto.randomBytes(8).toString('hex');
  const body = {
    price_amount: Number(plan.usd),
    price_currency: 'usd',
    order_id: orderId,
    order_description: `R6Checker BYO-proxy access (${planId}, ${plan.days}d)`,
    ipn_callback_url: `${SITE_URL}/webhook/nowpayments`,
    success_url: `${SITE_URL}/account?sub=success`,
    cancel_url:  `${SITE_URL}/account?sub=cancel`,
  };
  const res = await axios.post(`${NP_BASE}/invoice`, body, {
    headers: { 'x-api-key': apiKey(), 'Content-Type': 'application/json' },
    timeout: 15000, validateStatus: () => true,
  });
  if (res.status >= 400) {
    const msg = res.data?.message || `HTTP ${res.status}`;
    const e = new Error(`Payment provider error: ${msg}`); e.status = res.status >= 500 ? 503 : 400; throw e;
  }
  const invoiceId = String(res.data.id || res.data.invoice_id || res.data.iid);
  const invoiceUrl = res.data.invoice_url;
  if (!invoiceId || !invoiceUrl) throw Object.assign(new Error('Payment provider returned an unexpected response.'), { status: 502 });
  try {
    const parsed = new URL(invoiceUrl);
    const ok = parsed.protocol === 'https:' && (parsed.hostname === 'nowpayments.io' || parsed.hostname.endsWith('.nowpayments.io'));
    if (!ok) throw new Error('bad host');
  } catch { throw Object.assign(new Error('Payment provider returned a malformed invoice URL.'), { status: 502 }); }

  store.recordSubscriptionInvoice({ invoiceId, userId, plan: planId, days: plan.days, amountUsd: Number(plan.usd), status: 'waiting' });
  return { invoiceId, invoiceUrl };
}

// ── Webhook signature verification ───────────────────────────────────────
// NOWPayments signs the JSON body (sorted-by-key) with HMAC-SHA512 using
// the IPN secret. We compute HMAC over both candidate forms and accept either
// match, because their server-side JSON serializer doesn't always match
// Node's byte-for-byte (number formatting like `1.0`→`1`, nested-key sort vs
// top-level-only sort, etc.). Either matching form proves the same secret
// signed the same logical payload.
function sortKeys(obj, recursive) {
  if (Array.isArray(obj)) return recursive ? obj.map(v => sortKeys(v, true)) : obj;
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const k of Object.keys(obj).sort()) {
      out[k] = recursive ? sortKeys(obj[k], true) : obj[k];
    }
    return out;
  }
  return obj;
}

function verifyIpnSignature(rawBodyOrPayload, sigHeader) {
  const secret = ipnSecret();
  if (!secret) {
    console.warn('[nowpayments] NOWPAYMENTS_IPN_SECRET not set — refusing webhook');
    return false;
  }
  if (!sigHeader || typeof sigHeader !== 'string') return false;

  // Accept either: raw body string/Buffer (preferred), or a parsed object.
  let payload;
  if (Buffer.isBuffer(rawBodyOrPayload) || typeof rawBodyOrPayload === 'string') {
    try { payload = JSON.parse(rawBodyOrPayload.toString('utf8')); }
    catch { return false; }
  } else {
    payload = rawBodyOrPayload;
  }

  // Compute three candidate canonical forms — NOWPayments' actual signer
  // could use any of them. Accept if ANY matches.
  const candidates = [
    JSON.stringify(sortKeys(payload, true)),   // Python-style: recursive sort
    JSON.stringify(sortKeys(payload, false)),  // PHP-style:    top-level sort only
  ];

  for (const canonical of candidates) {
    const expected = crypto.createHmac('sha512', secret).update(canonical).digest('hex');
    if (sigHeader.length !== expected.length) continue;
    try {
      if (crypto.timingSafeEqual(Buffer.from(sigHeader, 'hex'), Buffer.from(expected, 'hex'))) {
        return true;
      }
    } catch { /* malformed hex */ }
  }
  return false;
}

// ── Handle a webhook payload (HMAC already verified by caller) ──────────
// Returns { ok, credited, balanceAfter? }.
function handleIpn(payload) {
  const invoiceId = String(payload.payment_id || payload.invoice_id || '');
  const status    = String(payload.payment_status || '').toLowerCase();
  if (!invoiceId) return { ok: false, error: 'missing payment_id' };

  const deposit = store.getDeposit(invoiceId);
  if (!deposit) {
    // Not a balance deposit — maybe a BYO-proxy subscription purchase.
    const subInv = store.getSubscriptionInvoice(invoiceId);
    if (subInv) return handleSubscriptionIpn(invoiceId, status, subInv);
    return { ok: false, error: 'unknown invoice' };
  }

  // Always update status + currency/address details
  store.updateDepositStatus(invoiceId, status, payload.pay_currency, payload.pay_address);

  // ── Refund / failure AFTER a previously successful credit ────────────
  // If NOWPayments now says the payment was refunded, failed, or expired,
  // and we already credited the user, debit it back so they don't keep
  // both the balance AND their crypto.
  if ((status === 'refunded' || status === 'failed' || status === 'expired') && deposit.credited) {
    const result = store.refundDeposit(invoiceId, {
      reason: 'nowpayments_status_' + status,
      txid: payload.outcome?.hash || payload.payin_hash || null,
    });
    if (result.reversed) {
      console.warn(`[nowpayments] REFUNDED ${invoiceId} (user ${deposit.user_id}, -${result.debited}¢)`);
    }
    return { ok: true, credited: false, refunded: result.reversed, status };
  }

  // Only credit on terminal success states.
  // NOWPayments uses: waiting → confirming → confirmed → sending → finished
  if (status !== 'finished' && status !== 'confirmed') {
    return { ok: true, credited: false, status };
  }

  // Round-down to cents. amount_usd is the *requested* price; we credit that.
  const amountCents = Math.floor(deposit.amount_usd * 100);
  const result = store.creditDeposit(invoiceId, deposit.user_id, amountCents, {
    txid: payload.outcome?.hash || payload.payin_hash || null,
    payCurrency: payload.pay_currency || null,
    actuallyPaid: payload.actually_paid || null,
  });
  if (result.credited) {
    console.log(`[nowpayments] CREDITED ${invoiceId} (user ${deposit.user_id}, +${amountCents}¢, bal ${result.balanceAfter}¢)`);
  }
  return { ok: true, credited: result.credited, balanceAfter: result.balanceAfter };
}

// Handle a subscription-invoice webhook (HMAC already verified). Extends the
// user's BYO-proxy access on terminal success, idempotently.
function handleSubscriptionIpn(invoiceId, status, subInv) {
  store.updateSubscriptionInvoiceStatus(invoiceId, status);
  if (status !== 'finished' && status !== 'confirmed') return { ok: true, credited: false, status };
  const result = store.creditSubscriptionInvoice(invoiceId);
  if (result.credited) {
    console.log(`[nowpayments] SUBSCRIPTION ${invoiceId} → user ${result.userId} (${result.plan}) until ${new Date(result.expiresAt).toISOString()}`);
    // Email the buyer their desktop CLI key (fire-and-forget).
    require('../keyMailer').sendKey(result.userId, result.expiresAt).catch(() => {});
  }
  return { ok: true, credited: result.credited, subscription: true, expiresAt: result.expiresAt };
}

// ── Polling fallback ─────────────────────────────────────────────────────
// Runs every 60s. For any deposit still 'waiting'/'confirming' newer than 24h,
// ask NOWPayments for its current status. Catches lost webhooks.
async function pollPendingDeposits() {
  if (!isConfigured()) return;
  const sinceMs = Date.now() - 24 * 60 * 60 * 1000;
  const pending = [
    ...store.listPendingDeposits(sinceMs),
    ...store.listPendingSubscriptionInvoices(sinceMs),
  ];
  for (const d of pending) {
    try {
      const res = await axios.get(`${NP_BASE}/payment/${encodeURIComponent(d.invoice_id)}`, {
        headers: { 'x-api-key': apiKey() }, timeout: 10000, validateStatus: () => true,
      });
      if (res.status >= 400) continue;
      // Synthesize a webhook-shaped payload from the status response. handleIpn
      // routes to deposit or subscription handling based on the invoice id.
      handleIpn({
        payment_id:    res.data.payment_id || d.invoice_id,
        payment_status: res.data.payment_status,
        pay_currency:  res.data.pay_currency,
        pay_address:   res.data.pay_address,
        actually_paid: res.data.actually_paid,
      });
    } catch (e) {
      console.warn(`[nowpayments] poll ${d.invoice_id} failed:`, e.message);
    }
  }
}

function startPoller() {
  setInterval(() => { pollPendingDeposits().catch(() => {}); }, 60_000).unref();
}

module.exports = {
  isConfigured,
  createInvoice,
  createSubscriptionInvoice,
  verifyIpnSignature,
  handleIpn,
  pollPendingDeposits,
  startPoller,
};
