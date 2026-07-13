'use strict';
// Whop card-payment integration — sibling provider to NOWPayments.
//
// Flow:
//   createInvoice(userId, amountUsd)        → POST /checkout_configurations,
//     returns hosted checkout URL on whop.com + records a 'waiting' deposit
//     keyed by OUR generated order_id (also sent as metadata.order_id so the
//     webhook can match the credit back to the user).
//   verifyWebhook(rawBody, headers)         → Standard Webhooks HMAC-SHA256:
//     sign `${webhook-id}.${webhook-timestamp}.${rawBody}`, compare to the v1
//     signature, reject stale timestamps (>5min). Constant-time compare.
//   handleEvent(payload)                    → on 'payment.succeeded',
//     look up the deposit (or subscription invoice) by metadata.order_id and
//     credit balance / extend subscription idempotently.
//   startPoller()                           → backstop if a webhook was lost.
//
// Design notes:
//   • Uses Node's built-in fetch (no axios dep).
//   • OUR `order_id` ('whop_dep_<rand>' or 'whop_sub_<rand>:<plan>') is the
//     primary key in the deposits/subscription_invoices tables. The deposits
//     table has no `provider` column so the prefix prevents collisions with
//     NOWPayments' numeric invoice ids.
//   • http + store are dependency-injectable via _test for unit tests with no
//     live HTTP, no DB writes.

const crypto = require('crypto');

const WHOP_BASE = 'https://api.whop.com/api/v1';
const SITE_URL = (process.env.SITE_URL || 'http://localhost:3000').replace(/\/+$/, '');

// Replay-protection window for webhooks (Standard Webhooks convention is 5min).
const WEBHOOK_TOLERANCE_S = 5 * 60;

function apiKey()       { return process.env.WHOP_API_KEY || ''; }
function companyId()    { return process.env.WHOP_COMPANY_ID || ''; }
function webhookSecret(){
  // Whop secrets are typically `whsec_<base64>`; the base64 part is what gets
  // HMAC'd. We accept both (with and without the prefix) for ergonomics.
  const s = process.env.WHOP_WEBHOOK_SECRET || '';
  return s.startsWith('whsec_') ? s.slice('whsec_'.length) : s;
}

function isConfigured() { return !!(apiKey() && companyId()); }

// ── Dependency injection seams (production: real fetch + ./store) ──────────
let _http  = (url, opts) => fetch(url, opts);   // global fetch (Node 18+)
let _store = null;
function getStore() { if (!_store) _store = require('../store'); return _store; }

// ── Create a hosted checkout (one-time balance deposit) ────────────────────
async function createInvoice(userId, amountUsd) {
  if (!isConfigured()) throw new Error('Whop not configured (WHOP_API_KEY / WHOP_COMPANY_ID missing).');
  const amount = Number(amountUsd);
  if (!Number.isFinite(amount) || amount <= 0) {
    const e = new Error('Invalid amount.'); e.status = 400; throw e;
  }
  const orderId = 'whop_dep_' + crypto.randomBytes(8).toString('hex');
  const body = {
    currency: 'usd',
    plan: {
      initial_price: amount,
      plan_type: 'one_time',
      company_id: companyId(),
      currency: 'usd',
    },
    metadata: {
      order_id: orderId,
      user_id: String(userId),
      kind: 'deposit',
    },
  };
  const { planId, invoiceUrl } = await postCheckout(body);
  getStore().recordDeposit({
    invoiceId: orderId,
    userId,
    amountUsd: amount,
    status: 'waiting',
  });
  return { invoiceId: orderId, invoiceUrl, externalId: planId };
}

// ── Create a SUBSCRIPTION checkout (BYO-proxy access pass) ─────────────────
async function createSubscriptionInvoice(userId, planId) {
  if (!isConfigured()) throw new Error('Whop not configured (WHOP_API_KEY / WHOP_COMPANY_ID missing).');
  const plan = getStore().getPlan(planId);
  if (!plan) { const e = new Error('Unknown subscription plan.'); e.status = 400; throw e; }

  // Encode the plan id into the order id so the webhook handler routes to the
  // subscription path (and knows which plan was bought) without an extra lookup.
  const orderId = 'whop_sub_' + crypto.randomBytes(8).toString('hex') + ':' + planId;
  const body = {
    currency: 'usd',
    plan: {
      initial_price: Number(plan.usd),
      plan_type: 'one_time',
      company_id: companyId(),
      currency: 'usd',
    },
    metadata: {
      order_id: orderId,
      user_id: String(userId),
      kind: 'subscription',
      plan: planId,
    },
  };
  const { planId: whopPlanId, invoiceUrl } = await postCheckout(body);
  getStore().recordSubscriptionInvoice({
    invoiceId: orderId,
    userId,
    plan: planId,
    days: plan.days,
    amountUsd: Number(plan.usd),
    status: 'waiting',
  });
  return { invoiceId: orderId, invoiceUrl, externalId: whopPlanId };
}

// Common POST → checkout helper. Throws with a useful .status on failure,
// validates the resulting URL is on whop.com before returning it.
async function postCheckout(body) {
  let res;
  try {
    res = await _http(`${WHOP_BASE}/checkout_configurations`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey()}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    const err = new Error('Payment provider unreachable: ' + e.message);
    err.status = 503; throw err;
  }
  let data; try { data = await res.json(); } catch { data = {}; }
  if (!res.ok) {
    const msg = (data && (data.message || data.error)) || `HTTP ${res.status}`;
    const e = new Error(`Whop error: ${msg}`);
    e.status = res.status >= 500 ? 503 : 400;
    throw e;
  }
  const planId = data && data.plan && data.plan.id;
  if (!planId) {
    const e = new Error('Whop returned an unexpected response.'); e.status = 502; throw e;
  }
  const invoiceUrl = `https://whop.com/checkout/${planId}`;
  // Defence in depth: the response must produce a URL that lives on whop.com.
  // Whop returns a plan id that's used as a path segment — reject anything that
  // could escape the host (e.g. a `../evil.com/` poisoned id).
  try {
    const parsed = new URL(invoiceUrl);
    const okHost = parsed.protocol === 'https:' && (parsed.hostname === 'whop.com' || parsed.hostname.endsWith('.whop.com'));
    const okPath = parsed.pathname.startsWith('/checkout/') && !parsed.pathname.includes('..');
    if (!okHost || !okPath) throw new Error('bad host/path');
  } catch {
    const e = new Error('Payment provider returned an unexpected URL.'); e.status = 502; throw e;
  }
  return { planId, invoiceUrl };
}

// ── Webhook verification (Standard Webhooks spec, HMAC-SHA256) ─────────────
// Signed string: `${webhook-id}.${webhook-timestamp}.${rawBody}`
// Header `webhook-signature` is one or more space-separated `v1,<base64>` parts.
function verifyWebhook(rawBody, headers) {
  const secret = webhookSecret();
  if (!secret) { console.warn('[whop] WHOP_WEBHOOK_SECRET not set — refusing webhook'); return false; }
  if (!headers || typeof headers !== 'object') return false;
  const id  = headers['webhook-id'];
  const ts  = headers['webhook-timestamp'];
  const sig = headers['webhook-signature'];
  if (!id || !ts || !sig) return false;
  // Replay protection: drop anything older than the tolerance window.
  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum)) return false;
  const ageS = Math.abs(Math.floor(Date.now() / 1000) - tsNum);
  if (ageS > WEBHOOK_TOLERANCE_S) return false;

  const body = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody || '');
  const signed = `${id}.${ts}.${body}`;
  const expected = crypto.createHmac('sha256', secret).update(signed).digest('base64');

  // Accept any of the comma/space-separated v1 signatures (Standard Webhooks
  // supports multiple signatures for key rotation).
  for (const part of String(sig).split(/[\s,]+/).filter(Boolean)) {
    const m = /^v1,(.+)$/.exec(part) || /^(.+)$/.exec(part);
    if (!m) continue;
    const got = m[1];
    if (got.length !== expected.length) continue;
    try {
      if (crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected))) return true;
    } catch { /* malformed */ }
  }
  return false;
}

// ── Handle a verified webhook event ────────────────────────────────────────
// Whop's `payment.succeeded` payload puts our metadata at `data.metadata`.
// We route by order_id prefix: whop_dep_* → balance credit, whop_sub_*:plan
// → subscription extend. Idempotent — replays no-op.
function handleEvent(payload) {
  const event = String(payload && payload.event || '').toLowerCase();
  const data  = (payload && payload.data) || {};
  const meta  = data.metadata || data.metaData || {};
  const orderId = String(meta.order_id || meta.orderId || '');
  if (!orderId) return { ok: false, error: 'missing order_id' };

  const st = getStore();
  const isSubscription = orderId.startsWith('whop_sub_');
  const isDeposit      = orderId.startsWith('whop_dep_');

  // Look up first so we can ALWAYS update status (waiting → failed/refunded)
  // even when the event isn't a success.
  const inv = isSubscription ? st.getSubscriptionInvoice(orderId)
            : isDeposit      ? st.getDeposit(orderId)
            : null;
  if (!inv) return { ok: false, error: 'unknown order_id' };

  // Map Whop event names to a coarse status. Anything that isn't a clean
  // success returns without crediting (or, on a failure-AFTER-credit, marks
  // the row but does NOT refund here — that's left for a manual review step).
  const succeeded = event === 'payment.succeeded' || event === 'membership.went_valid';
  const failed    = event === 'payment.failed'   || event === 'payment.refunded' || event === 'membership.cancel_at_period_end_changed';

  const statusTag = succeeded ? 'finished' : (failed ? event.split('.')[1] : event || 'waiting');
  if (isSubscription) st.updateSubscriptionInvoiceStatus(orderId, statusTag);
  else                st.updateDepositStatus(orderId, statusTag, null, null);

  if (!succeeded) return { ok: true, credited: false, status: statusTag };

  if (isSubscription) {
    const r = st.creditSubscriptionInvoice(orderId);
    if (r.credited) console.log(`[whop] SUBSCRIPTION ${orderId} → user ${r.userId} (${r.plan}) until ${new Date(r.expiresAt).toISOString()}`);
    return { ok: true, credited: r.credited, subscription: true, expiresAt: r.expiresAt };
  }
  // Balance deposit.
  const amountCents = Math.floor(Number(inv.amount_usd != null ? inv.amount_usd : inv.amountUsd) * 100);
  const r = st.creditDeposit(orderId, inv.user_id != null ? inv.user_id : inv.userId, amountCents, {
    txid: data.id || null, payCurrency: 'usd',
  });
  if (r.credited) console.log(`[whop] CREDITED ${orderId} (user ${inv.user_id != null ? inv.user_id : inv.userId}, +${amountCents}¢)`);
  return { ok: true, credited: r.credited, balanceAfter: r.balanceAfter };
}

// ── Polling backstop ───────────────────────────────────────────────────────
// Runs every 60s. For pending deposits/subscriptions newer than 24h, fetch the
// current status from Whop (by our order_id metadata) and synthesize a webhook
// to handleEvent. Catches lost webhooks.
async function pollPendingDeposits() {
  if (!isConfigured()) return;
  const sinceMs = Date.now() - 24 * 60 * 60 * 1000;
  const st = getStore();
  const pending = [
    ...st.listPendingDeposits(sinceMs).map(r => ({ ...r, _kind: 'dep' })),
    ...st.listPendingSubscriptionInvoices(sinceMs).map(r => ({ ...r, _kind: 'sub' })),
  ];
  for (const row of pending) {
    const orderId = row.invoice_id || row.invoiceId;
    if (!orderId) continue;
    try {
      const res = await _http(`${WHOP_BASE}/payments?metadata.order_id=${encodeURIComponent(orderId)}`, {
        headers: { Authorization: `Bearer ${apiKey()}`, Accept: 'application/json' },
      });
      if (!res.ok) continue;
      const data = await res.json().catch(() => null);
      const list = (data && (data.data || data.payments)) || [];
      const hit = list.find(p => (p.status || '').toLowerCase() === 'succeeded' || (p.status || '').toLowerCase() === 'paid');
      if (!hit) continue;
      handleEvent({ event: 'payment.succeeded', data: { id: hit.id, metadata: { order_id: orderId } } });
    } catch (e) {
      console.warn(`[whop] poll ${orderId} failed:`, e.message);
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
  verifyWebhook,
  handleEvent,
  pollPendingDeposits,
  startPoller,
  // Test-only injection seams. Production code reads real env / store / fetch.
  _test: {
    setHttp: (fn) => { _http = fn; },
    setStore: (st) => { _store = st; },
  },
};
