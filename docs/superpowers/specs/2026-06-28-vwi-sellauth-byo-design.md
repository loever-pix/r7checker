# VWI sorter rules, SellAuth auto-push, and BYO server never-skip — design

**Date:** 2026-06-28
**Status:** Approved direction (decisions locked via brainstorming); pending spec review.

## Background / investigation result

A check of the most recent BYO download (`bulk-5a6928…`, 32,529 invalid + 1,064 valid)
confirmed the server-side classifier is **sound**: every invalid line is genuine
`| INVALID`, and no `PARTIAL` / `ERROR_*` / `Banned: Y` / `Linkable: —` lines leak
into valid or invalid downloads. `decideOutcome` only marks `INVALID` on HTTP 401
or an explicit wrong-password message; 429 / network / timeout route to
`retry` / `network`, and the BYO worker never emits `PARTIAL` (returns `retry`).

The one real gap: BYO retries only `NET_RETRIES=3` then writes a **terminal**
`ERROR_RETRY` / `ERROR_NETWORK` and moves on. Those don't pollute valid/invalid
(safe for customers) but are *unresolved* — unlike the desktop's never-skip
slow-lane. That is Phase 3 below.

## Scope — three phases, in this order

1. **VWI rules + sorter** (this is what ships first)
2. **SellAuth auto-push + pricing engine**
3. **BYO server-side never-skip + efficiency**

---

## Phase 1 — VWI rules + sorter

### 1.1 New / changed wanted families (`lib/checker/skinCheck.js`)

Add to `WANTED_SKIN_RULES`:

| Display name      | Rule                                                       |
|-------------------|------------------------------------------------------------|
| `Heart Attack`    | `category === 'Universals' && name === 'Heart Attack'`     |
| `Lucky`           | `category === 'Universals' && name === 'Lucky'`            |
| `Ralphie`         | `category === 'Universals' && name === 'Ralphie'`          |
| `Board Game`      | `category === 'Board Game'`                                 |
| `Spellbound R4-C` | `category === 'Special' && name === 'Spellbound (R4C)'` (primary gun skin, not an attachment) |

- `Gold Dust` already exists (`category === 'Gold Dusts'`) — keep, surface in sorter.
- `Silver GO4 Charm` / `Gold GO4 Charm` already exist (id-based) — keep.
- **Dust Line threshold:** `WANTED_SKIN_MINS['Dust Line'] = 8` — account needs 8+
  distinct Dust Line weapon skins to qualify (mirrors the existing Black Ice 20+ rule).

### 1.2 New classification constants (server source of truth)

Add to `skinCheck.js` and expose via `/api/admin/vwi/meta`:

- `NAMED_ITEM_BUCKETS = ['Silver GO4 Charm', 'Gold GO4 Charm', 'Obsidian', 'Chroma Streaks', 'Glacier']`
  — the only item families that keep their **own** sorter bucket.
- All other wanted items collapse into a single **`Mystery Items`** bucket.
- `BANNED_VWI = { ranks: ['Champion','Diamond'], items: ['Chroma Streaks','Obsidian','Silver GO4 Charm','Gold GO4 Charm','Spellbound R4-C'] }`
  — qualifiers for the banned-only bucket.

`/api/admin/vwi/meta` returns:
```json
{ "ranks": [...], "items": [...all wanted...],
  "namedItemBuckets": [...5...], "bannedVwi": { "ranks": [...], "items": [...] } }
```

### 1.3 Sorter bucketing changes (`public/admin.html`)

Each account still lands in **exactly one** bucket. New priority:

1. **Banned?** → if it has any `bannedVwi.ranks` or `bannedVwi.items` qualifier →
   **Banned VWI** bucket (ignores the linkable requirement — banned accounts are
   sold for their cosmetics). Otherwise excluded as today.
2. Not banned + linkable → highest **rank** → that rank bucket.
3. Else **top named item** (one of the 5) → that item bucket.
4. Else any other wanted item → **Mystery Items** bucket.
5. Else → leftover by level (unchanged).

Each bucket keeps the existing per-platform split (double / PSN-only / Xbox-only)
and download buttons. New buckets: the 5 named item buckets, `Mystery Items`,
`Banned VWI`.

### 1.4 Desktop sorter parity (note)

`cli/local/menu.js` + `cli/checker.js` carry their own copy of the sorter
classification "mirroring website/server". Phase 1 targets the **website**
(as requested). Desktop parity is a tracked follow-up in the same phase so the
two don't diverge; ideally the classification constants become a shared module.

---

## Phase 2 — SellAuth auto-push + pricing engine (design level)

### 2.1 Push flow

New owner-only endpoint `POST /api/admin/vwi/push`. Body = sorted bucket lines +
bucket descriptors `{ type: rank|item|mystery|banned, name, platform }`.

For each bucket:
1. Resolve target SellAuth product by name match (`storeSync.classifyProduct`
   tier+platform). **If none exists, create it.**
2. Compute price via the pricing engine (2.2).
3. Push every account as its **own variant** via `storeSync.addAccountVariants`.

**Robustness:** idempotent + timeout-safe. Dedupe by account so a re-push after a
timeout never double-adds; retry the SellAuth calls with backoff; partial success
is reported per bucket.

### 2.2 Pricing engine (`lib/bot/vwiPricing.js`)

Minimums and curves (USD), from owner:

- **Glacier:** smooth scale, $10 at 1 → ~$50 at 40/40.
  `price = min(50, 10 + (count − 1) × (40/39))`.
- **Chroma Streaks:** min $3.
- **Obsidian:** min $4.
- **Chroma Streaks + Obsidian together:** min $10.
- **Silver GO4:** min $20. **Gold GO4:** min $30.
- **Spellbound R4-C:** min $30.
- **Ranks:** Ranked 1.0 > 2.0 > 3.0. Champion (Ranked 1.0) min $18.
  Multi-rank accounts add more. *Exact ranked-era→season mapping and the
  multi-rank increment will be confirmed with an explicit price table before
  anything goes live.*

> Pricing publishes live store products with real prices. Final numbers (esp. the
> ranked era map and multi-rank increment) get an explicit owner-approved table in
> the Phase 2 plan before any product is created or priced.

---

## Phase 3 — BYO server never-skip + efficiency (design level)

`lib/checker/bulkWorker.js` (+ `bulkRunner.js`): replace the "3 retries then
terminal ERROR" with a bounded **slow-lane requeue** mirroring the desktop
`pool.js`: transient `retry`/`network` outcomes go to a slow lane with backoff
for up to N more attempts (fresh proxy/fingerprint) before a final terminal
classification, so the job still finishes but no line is silently skipped.
Optionally add per-proxy 429 cooldown for the customer's own proxies.

---

## Out of scope

- No change to the encryption / download format.
- No change to billing rules (`isBillable`) — errors stay non-billable.
- No new UI framework; sorter stays vanilla JS in `admin.html`.
