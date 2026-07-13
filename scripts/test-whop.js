'use strict';
// Unit tests for the Whop payment provider — zero live HTTP, zero DB writes.
// http + store are injected as fakes via the module's _test hook.

const assert = require('assert');
const crypto = require('crypto');

// Configure required env BEFORE requiring the module (it reads them at load time).
process.env.WHOP_API_KEY = 'apik_test';
process.env.WHOP_COMPANY_ID = 'biz_test';
process.env.WHOP_WEBHOOK_SECRET = 'whsec_test_secret';
process.env.SITE_URL = 'https://r6checker.xyz';

const whop = require('../lib/payments/whop');

// ── Fakes ───────────────────────────────────────────────────────────────────
function makeFakes() {
  const sent = [];
  const http = async (url, opts) => {
    sent.push({ url, method: (opts && opts.method) || 'GET', body: opts && opts.body && JSON.parse(opts.body), headers: opts && opts.headers });
    if (sent[sent.length - 1]._reply) return sent[sent.length - 1]._reply;
    // default: success creating a checkout — Whop returns plan.id
    return {
      ok: true, status: 200,
      json: async () => ({ plan: { id: 'plan_xyz_' + sent.length } }),
      text: async () => '',
    };
  };
  const store = {
    deposits: new Map(), subs: new Map(), credits: [], extensions: [],
    PLANS: { daily: { usd: 5, days: 1 }, weekly: { usd: 15, days: 7 } },
    recordDeposit: (d) => { store.deposits.set(d.invoiceId, { ...d, credited: 0 }); },
    getDeposit: (id) => store.deposits.get(id) || null,
    updateDepositStatus: (id, status) => { const d = store.deposits.get(id); if (d) d.status = status; },
    creditDeposit: (id, userId, amountCents) => {
      const d = store.deposits.get(id);
      if (!d || d.credited) return { credited: false };
      d.credited = 1; store.credits.push({ id, userId, amountCents });
      return { credited: true, balanceAfter: amountCents };
    },
    recordSubscriptionInvoice: (s) => { store.subs.set(s.invoiceId, { ...s, credited: 0 }); },
    getSubscriptionInvoice: (id) => store.subs.get(id) || null,
    updateSubscriptionInvoiceStatus: (id, status) => { const s = store.subs.get(id); if (s) s.status = status; },
    creditSubscriptionInvoice: (id) => {
      const s = store.subs.get(id);
      if (!s || s.credited) return { credited: false };
      s.credited = 1;
      const expiresAt = 1_700_000_000_000 + s.days * 86_400_000;
      store.extensions.push({ id, userId: s.userId, plan: s.plan, expiresAt });
      return { credited: true, userId: s.userId, plan: s.plan, expiresAt };
    },
    listPendingDeposits: () => [...store.deposits.values()].filter(d => !d.credited),
    listPendingSubscriptionInvoices: () => [...store.subs.values()].filter(s => !s.credited),
    getPlan: (id) => store.PLANS[id] || null,
  };
  return { sent, http, store };
}

// ── isConfigured ────────────────────────────────────────────────────────────
assert.strictEqual(whop.isConfigured(), true, 'configured with env');

// ── createInvoice: builds the right body, validates URL, records deposit ────
(async () => {
  const { sent, http, store } = makeFakes();
  whop._test.setHttp(http); whop._test.setStore(store);

  const { invoiceId, invoiceUrl } = await whop.createInvoice(42, 25);
  assert(invoiceId.startsWith('whop_dep_'), 'invoiceId is our generated order_id, not Whop\'s');
  assert.strictEqual(invoiceUrl, 'https://whop.com/checkout/plan_xyz_1', 'URL points to whop.com checkout');

  const req = sent[0];
  assert.strictEqual(req.method, 'POST');
  assert.strictEqual(req.url, 'https://api.whop.com/api/v1/checkout_configurations');
  assert.strictEqual(req.headers.Authorization, 'Bearer apik_test', 'Bearer auth');
  assert.strictEqual(req.body.currency, 'usd');
  assert.strictEqual(req.body.plan.initial_price, 25, 'price as supplied');
  assert.strictEqual(req.body.plan.plan_type, 'one_time');
  assert.strictEqual(req.body.plan.company_id, 'biz_test');
  assert.strictEqual(req.body.metadata.order_id, invoiceId, 'order_id metadata echoes our id');

  const d = store.getDeposit(invoiceId);
  assert(d && d.status === 'waiting' && d.amountUsd === 25 && d.userId === 42, 'deposit recorded waiting');

  console.log('  ✓ createInvoice');
})()

// ── createInvoice: rejects a Whop response with a non-whop.com URL ──────────
.then(async () => {
  const { http, store } = makeFakes();
  let firstCall = true;
  const evilHttp = async (url, opts) => {
    if (firstCall) {
      firstCall = false;
      // Whop "tells" us the buyer URL is on some other host (the code constructs
      // it from plan.id, so simulate by feeding a poisoned id).
      return { ok: true, status: 200, json: async () => ({ plan: { id: '../evil.com/path' } }), text: async () => '' };
    }
    return http(url, opts);
  };
  whop._test.setHttp(evilHttp); whop._test.setStore(store);
  await assert.rejects(() => whop.createInvoice(1, 5), /unexpected/i, 'rejects non-whop.com URL');
  console.log('  ✓ createInvoice rejects bad URL');
})

// ── createInvoice: propagates upstream errors ───────────────────────────────
.then(async () => {
  const { store } = makeFakes();
  const errHttp = async () => ({ ok: false, status: 401, json: async () => ({ message: 'unauthorised' }), text: async () => '' });
  whop._test.setHttp(errHttp); whop._test.setStore(store);
  await assert.rejects(() => whop.createInvoice(1, 5), /unauthorised|whop/i, 'propagates 401');
  console.log('  ✓ createInvoice propagates 4xx');
})

// ── createSubscriptionInvoice: uses the plan's usd, prefixes order_id ───────
.then(async () => {
  const { sent, http, store } = makeFakes();
  whop._test.setHttp(http); whop._test.setStore(store);
  const r = await whop.createSubscriptionInvoice(7, 'weekly');
  assert(r.invoiceId.startsWith('whop_sub_'), 'sub invoiceId prefixed');
  assert(r.invoiceId.includes(':weekly'), 'sub invoiceId encodes the plan');
  assert.strictEqual(sent[0].body.plan.initial_price, 15, 'weekly = $15');
  const sub = store.getSubscriptionInvoice(r.invoiceId);
  assert(sub && sub.plan === 'weekly' && sub.days === 7);
  await assert.rejects(() => whop.createSubscriptionInvoice(7, 'monthly'), /unknown.*plan/i, 'unknown plan rejected');
  console.log('  ✓ createSubscriptionInvoice');
})

// ── verifyWebhook: Standard Webhooks HMAC-SHA256 ────────────────────────────
.then(() => {
  // Module strips the 'whsec_' prefix (per Standard Webhooks convention), so
  // we HMAC with the bare secret here to match what production computes.
  const secret = 'test_secret';
  const id = 'msg_abc';
  const ts = String(Math.floor(Date.now() / 1000));
  const body = JSON.stringify({ event: 'payment.succeeded', data: { metadata: { order_id: 'whop_dep_x' } } });
  const signed = `${id}.${ts}.${body}`;
  const expected = crypto.createHmac('sha256', secret).update(signed).digest('base64');
  const goodHeaders = { 'webhook-id': id, 'webhook-timestamp': ts, 'webhook-signature': `v1,${expected}` };

  assert.strictEqual(whop.verifyWebhook(body, goodHeaders), true, 'valid sig accepted');
  assert.strictEqual(whop.verifyWebhook(body + 'x', goodHeaders), false, 'tampered body rejected');
  assert.strictEqual(whop.verifyWebhook(body, { 'webhook-id': id, 'webhook-timestamp': ts }), false, 'missing sig rejected');
  const wrong = crypto.createHmac('sha256', 'other_secret').update(signed).digest('base64');
  assert.strictEqual(whop.verifyWebhook(body, { ...goodHeaders, 'webhook-signature': `v1,${wrong}` }), false, 'wrong secret rejected');
  // Replay protection: stale timestamp (10 minutes old) rejected.
  const stale = String(Math.floor(Date.now() / 1000) - 600);
  const staleSig = crypto.createHmac('sha256', secret).update(`${id}.${stale}.${body}`).digest('base64');
  assert.strictEqual(whop.verifyWebhook(body, { 'webhook-id': id, 'webhook-timestamp': stale, 'webhook-signature': `v1,${staleSig}` }), false, 'stale timestamp rejected');
  // Also: a v1 with the right base64 but wrong length is rejected (defence).
  assert.strictEqual(whop.verifyWebhook(body, { ...goodHeaders, 'webhook-signature': 'v1,abc' }), false, 'short sig rejected');

  console.log('  ✓ verifyWebhook');
})

// ── handleEvent: credit a balance deposit (idempotent) ──────────────────────
.then(async () => {
  const { store } = makeFakes();
  whop._test.setStore(store);
  store.recordDeposit({ invoiceId: 'whop_dep_a', userId: 9, amountUsd: 20, status: 'waiting' });

  // Non-success event: no credit.
  let r = whop.handleEvent({ event: 'payment.pending', data: { metadata: { order_id: 'whop_dep_a' } } });
  assert.strictEqual(r.credited, false, 'non-success not credited');

  // Success event: credits exactly once.
  r = whop.handleEvent({ event: 'payment.succeeded', data: { metadata: { order_id: 'whop_dep_a' } } });
  assert.strictEqual(r.credited, true, 'success credits');
  assert.strictEqual(store.credits.length, 1, 'one credit recorded');
  assert.strictEqual(store.credits[0].amountCents, 2000, '20 USD = 2000 cents');

  // Replay: same event again is a no-op.
  r = whop.handleEvent({ event: 'payment.succeeded', data: { metadata: { order_id: 'whop_dep_a' } } });
  assert.strictEqual(r.credited, false, 'replay does not double-credit');
  assert.strictEqual(store.credits.length, 1, 'still one credit');

  console.log('  ✓ handleEvent deposit (idempotent)');
})

// ── handleEvent: subscription extend (idempotent) ───────────────────────────
.then(async () => {
  const { store } = makeFakes();
  whop._test.setStore(store);
  store.recordSubscriptionInvoice({ invoiceId: 'whop_sub_b:daily', userId: 4, plan: 'daily', days: 1, amountUsd: 5, status: 'waiting' });

  let r = whop.handleEvent({ event: 'payment.succeeded', data: { metadata: { order_id: 'whop_sub_b:daily' } } });
  assert.strictEqual(r.credited, true);
  assert.strictEqual(r.subscription, true);
  assert.strictEqual(store.extensions.length, 1);
  r = whop.handleEvent({ event: 'payment.succeeded', data: { metadata: { order_id: 'whop_sub_b:daily' } } });
  assert.strictEqual(r.credited, false, 'replay no-op');
  console.log('  ✓ handleEvent subscription (idempotent)');
})

// ── handleEvent: unknown order_id is a safe no-op (does not throw) ──────────
.then(() => {
  const { store } = makeFakes();
  whop._test.setStore(store);
  const r = whop.handleEvent({ event: 'payment.succeeded', data: { metadata: { order_id: 'whop_dep_unknown' } } });
  assert.strictEqual(r.ok, false, 'unknown order_id reports not-ok');
  assert.strictEqual(store.credits.length, 0, 'no credit');
  console.log('  ✓ handleEvent unknown order_id');
})

.then(() => console.log('OK test-whop'))
.catch(e => { console.error(e); process.exit(1); });
