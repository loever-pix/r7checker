# Whop card payments for r6checker.xyz — design

**Date:** 2026-06-30
**Status:** Draft — awaiting owner spec sign-off, then builds in tested stages.

## Goal

Add **Whop card payment** as a second checkout option (alongside the existing
crypto-only NOWPayments flow) for both **balance top-up** and **BYO-proxy
subscription** purchases on r6checker.xyz. Customer picks card or crypto at
checkout; everything else (credit/extend logic, billing) is unchanged.

## Why this design

- **Mirror, don't replace.** The existing `lib/payments/nowpayments.js` is the
  template — Whop becomes a sibling provider with the same surface
  (`createInvoice`, `createSubscriptionInvoice`, IPN verify, `handleIpn`,
  poller). Site routes call **either** depending on the user's choice. Zero
  refactor of the credit/extend code paths.
- **Idempotent crediting.** The `deposits` table already keys on `(provider,
  invoiceId)` — adding a `provider: 'whop'` row prevents double-crediting if a
  webhook fires twice or the poller races.
- **Safety: verify before trust.** Whop uses the Standard Webhooks HMAC spec —
  always verify the raw body against `WHOP_WEBHOOK_SECRET` before crediting. The
  hosted checkout URL is also validated against the `whop.com` domain before the
  client opens it (same defence already in nowpayments.js).

## Components

### 1. `lib/payments/whop.js` (NEW)
Pure provider module — no Express, no DB schema changes. Surface mirrors
nowpayments.js so callers can be branched on a single env flag.

- `isConfigured()` — true iff `WHOP_API_KEY` + `WHOP_COMPANY_ID` are set.
- `createInvoice(userId, amountUsd)` →
  POSTs `/api/v1/checkout_configurations` with
  `{ currency:'usd', plan:{ initial_price: amountUsd, plan_type:'one_time',
    company_id, currency:'usd' }, metadata:{ order_id:'whop_dep_<rand>' } }`.
  Builds `invoiceUrl = https://whop.com/checkout/<plan.id>`, **validates** the
  URL is on `whop.com`, then records a `waiting` deposit keyed on `(provider:
  'whop', invoiceId: plan.id, orderId)`.
  Returns `{ invoiceId, invoiceUrl }`.
- `createSubscriptionInvoice(userId, plan)` — same call, USD price = the
  selected pass's price, `metadata.order_id = 'whop_sub_<rand>:<plan>'` so the
  webhook handler knows whether to credit balance OR extend a subscription.
- `verifyWebhook(rawBody, headers)` — Standard Webhooks HMAC verification using
  `WHOP_WEBHOOK_SECRET`; reject malformed/expired signatures. Returns boolean.
- `handleEvent(payload)` — on `payment.succeeded`, look up the waiting deposit
  by `order_id`, mark it `credited`, then either `store.creditBalance(...)` OR
  `store.extendSubscription(...)` based on the `order_id` prefix
  (`whop_dep_*` vs `whop_sub_*`). Idempotent (no-op if already credited).
- `startPoller()` — every 60s, list recent waiting Whop deposits and ask
  `GET /api/v1/payments?metadata.order_id=...` (or list-and-match if the API
  doesn't expose a metadata filter) to catch any missed webhook. Same backstop
  as `nowpayments.pollPendingDeposits`.

### 2. Server routes (in `server.js`)
- `POST /webhook/whop` — raw-body Express handler for the IPN. Verifies HMAC,
  delegates to `whop.handleEvent`, returns 200 to ack.
- Extend the existing top-up route (`POST /api/balance/topup`) and the
  subscription purchase route (`POST /api/subscribe`): accept a new
  `provider: 'crypto' | 'card'` field on the body; route to
  `nowpayments.createInvoice(...)` or `whop.createInvoice(...)` accordingly.
- Boot: `if (whop.isConfigured()) whop.startPoller();` next to the existing
  NOWPayments poller boot.

### 3. UI
- On the **balance top-up** and **subscription purchase** pages, add a payment-
  method selector with two options: **"Crypto (NOWPayments)"** (current default)
  and **"Card (Whop)"**. Visible only when both providers are configured (a
  single-provider site shows nothing extra and behaves as today). The button
  the user clicks just changes the `provider` field on the request.

### 4. Config
New `.env` entries:
```
WHOP_API_KEY=
WHOP_COMPANY_ID=
WHOP_WEBHOOK_SECRET=
```
Absent → Whop is hidden from the UI (graceful fallback to crypto-only).

## Hard safety rules
1. **Verify the webhook HMAC before any DB write.** A malformed/missing
   signature returns 401 — no credit, no balance change.
2. **Idempotent credit.** A second `payment.succeeded` for the same `order_id`
   must be a no-op (the deposit row already shows `credited`).
3. **Validate the checkout URL** against `whop.com` before returning it to the
   browser (defence-in-depth, same as nowpayments.js does).
4. **No live writes in tests.** Provider unit tests use fakes for the HTTP layer
   so we never accidentally hit Whop's real API from CI.

## Phasing
- **2a — Provider module + tests.** Pure `lib/payments/whop.js` + unit tests
  with fake HTTP. No site changes, no live writes.
- **2b — Webhook + routes.** `/webhook/whop`, the `provider` branch in
  topup/subscribe, the poller wiring. UI still hidden by default.
- **2c — UI + go-live.** Add the card option to the checkout pages, document
  the env vars, smoke-test with a $1 Whop payment.

## Out of scope
- SellAuth shop checkout — that's configured in SellAuth's own dashboard
  (the screenshot the owner shared); no code from us.
- Refunds via the Whop API.
- Changing the existing NOWPayments path.

## Open question (owner)
Whop's "plan" model lets the price be set per-checkout (`initial_price`) for
custom amounts. **Does Whop's account class on your business support setting a
custom price per checkout** (some Whop merchants are locked to fixed-price
products)? If only fixed-price products are allowed, the subscription path
becomes "select a pre-created Whop product per pass tier" instead of
`initial_price`. I'll confirm against the live API in 2a before building the
top-up flow.

---

Sources:
- [Whop Webhooks Docs](https://docs.whop.com/developer/guides/webhooks)
- [Whop API Quick Start](https://docs.whop.com/developer/api/getting-started)
- [How to use the Whop REST API to accept payments](https://whop.com/blog/how-to-use-the-whop-api/)
