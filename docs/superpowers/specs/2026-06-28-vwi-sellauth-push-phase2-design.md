# Phase 2 — SellAuth auto-push + pricing engine — design

**Date:** 2026-06-28
**Status:** APPROVED — pricing constants + live-store facts locked (owner-confirmed 2026-06-28).
Parent spec: `2026-06-28-vwi-sellauth-byo-design.md`.

## Goal

A "Push to SellAuth" button on the VWI sorter that, for each bucket, creates per-account
buyable variants on the matching SellAuth product (creating the product if missing),
each priced by a contents-based pricing engine. Replaces download→manual `/restock`.

## Hard safety rule — dry-run first

The push is **two-step and never writes to SellAuth without an explicit confirm**:
1. **Plan (preview):** compute, for every account, its price + matched product + whether
   that product must be created. Return the plan to the UI. NO writes.
2. **Execute:** only after the owner clicks confirm. Idempotent + timeout-safe (re-running
   never double-charges or double-adds; dedupe by account serial).

Creating products and setting prices are live-store, real-money actions — they only ever
happen in step 2, after the owner sees the plan.

## Decomposition

- **Phase 2a** — pricing engine (pure, fully unit-tested) + Plan endpoint + UI preview. No writes.
- **Phase 2b** — Execute: create missing products, push per-account variants with prices,
  set pooled prices. Live SellAuth writes, behind the confirm gate.

This phase 2a/2b split lets the owner verify pricing on real data before anything goes live.

---

## Pricing engine (`lib/bot/vwiPricing.js`, pure)

`priceAccount(parsed) → { price, floors: [{rule, amount}] }`, where `parsed` carries the
account's **full** contents: skins (family→count) and ranks (tier + peak season).

**Pricing is whole-account, not per-bucket.** An account is sorted into one bucket for
*which product it lands on*, but its price considers everything it owns (e.g. a Champion
account that also has Glacier is priced by the Glacier+Champion combo even though it sits
in the Champion product).

**Final price = the single highest applicable floor** (the owner thinks in minimums; you
never sell an $80-worthy account for its $18 rank floor). Rounded to 2 dp; global floor $1.

### Item floors
| Family | Floor |
|--------|-------|
| Glacier (count *n*) | `min($50, $10 + (n−1) × $1.026)` → 1=$10 … 40/40=$50 |
| Glacier **+ any Champion rank** | **$80** (combo overrides the scale) |
| Chroma Streaks | $3 |
| Obsidian | $4 |
| Chroma Streaks **+** Obsidian (both) | $10 (combo) |
| Silver GO4 | $20 |
| Gold GO4 | $30 |
| Spellbound R4-C | $30 |

### Rank floors (per highest tier × era; multi-rank adds)
Era from peak season: **1.0 = season ≤ 24**, **2.0 = season 25–28**, **3.0 = season ≥ 29**.
(Codebase already encodes Champion@S15, Emerald@S28.)

`rankFloor = basePrice[highestTier][era] + MULTI_RANK_ADD × (qualifyingTierCount − 1)`
(Highest-tier base + a flat add per *extra* qualifying tier. "Qualifying tier" = a tier
listed in the account's Ranks field: Plat/Emerald/Diamond/Champion.)

### Mystery Items floor
Any wanted skin that is NOT one of the 5 named families (Gold Dust, Dust Line 45/45,
Heart Attack, Lucky, Ralphie, Board Game, …) → flat `MYSTERY_FLAT` per platform.

### Banned VWI floor
Same item/rank floors apply (a banned Champion+Obsidian account still prices off those
floors). Lands on the Banned-VWI product instead of the clean ones.

---

## Pricing constants — LOCKED (owner-confirmed 2026-06-28)

**Rank base table (USD), `RANK_BASE[tier][era]`:**
| Tier | Ranked 1.0 | Ranked 2.0 | Ranked 3.0 |
|------|-----------|-----------|-----------|
| Champion | 18 | 12 | 8 |
| Diamond | 10 | 7 | 5 |
| Emerald | — | — | 4 |
| Plat | 5 | 4 | 3 |

- **MULTI_RANK_ADD** = $3 (flat, per extra qualifying tier beyond the highest).
- **MYSTERY_FLAT** = $5 (per-platform Mystery Items product). NOTE: this is ~5× the
  current live mystery price (~$1); owner may revise to $1 — trivial constant change.

All constants live in `lib/bot/vwiPricing.js` and are unit-tested. The dry-run preview
shows computed prices on real accounts before any live write, so these can be tuned safely.

---

## Product routing + creation (Phase 2b)

**Live store naming convention (from owner's storefront):**
`[<PLATFORM>] <Bucket> NFA`, where `<PLATFORM>` ∈ `PSN` | `XBX` | `XBX/PSN`.
Mystery is pooled and named `[<PLATFORM>] Mystery Wanted Items`.

**Already exist:** `[PSN|XBX|XBX/PSN] Champion NFA`, `… Diamond NFA`, `… Emerald NFA`,
`… Platinum NFA`; `[PSN] Mystery Wanted Items`, `[XBX] Mystery Wanted Items`.

**Must be created by the push (owner has none of these):**
- `[PSN|XBX|XBX/PSN] Glacier NFA`
- `[PSN|XBX|XBX/PSN] Obsidian NFA`
- `[PSN|XBX|XBX/PSN] Chroma Streaks NFA`
- `[PSN|XBX|XBX/PSN] Silver GO4 NFA`
- `[PSN|XBX|XBX/PSN] Gold GO4 NFA`
- `[PSN|XBX|XBX/PSN] Banned VWI NFA` (banned accounts that ARE still linkable);
  non-linkable banned → a single `[NFA] Banned VWI` catch product.
- `[XBX/PSN] Mystery Wanted Items` (the only missing Mystery platform).

`classifyProduct` is extended to recognise the bracketed `[PLATFORM]` prefix and the new
bucket names (Glacier / Obsidian / Chroma Streaks / Silver GO4 / Gold GO4 / Banned VWI).

**Create-if-missing:** add `sellauth.createProduct(...)` by cloning an existing rank
product as a template (fetch via `getProductRaw`, strip ids, set new name + first-variant
price, POST). Rank/named-item products store accounts as per-account **variants**; Mystery
products stay **pooled** (one variant, many serials). The exact create endpoint/payload is
verified live during 2b implementation (flagged risk — SellAuth product-create is not yet
exercised by this codebase; the dry-run preview lists every product that would be created
before anything is sent).

**Per-account variant pricing:** `addAccountVariants` currently copies the product base
price to every variant. Phase 2b adds an optional `priceFor(line)` so each variant is
written at its computed price. Pooled (Mystery) products get one price = `MYSTERY_FLAT`.

---

## Endpoints + UI

- `POST /api/admin/vwi/plan` (owner) — body: bucket lines. Returns the full plan
  (per-account price + product match + to-create list + totals). No writes.
- `POST /api/admin/vwi/push` (owner) — body: the confirmed plan. Executes 2b. Idempotent.
- `public/admin.html`: each bucket gets a **Push ▸** action → calls plan, shows a preview
  modal (counts, total $, products to create), → confirm → push.

## Out of scope
- No change to billing or the checker. No change to existing pooled restock behavior
  except the new optional per-variant pricing.
- Discord `/restock` stays as-is (this is the website equivalent).

## Phase 1 amendment
Owner revised Dust Line: qualify only at **45/45** (complete set). Change
`WANTED_SKIN_MINS['Dust Line']` from 8 → 45 (catalog has exactly 45). Small follow-up edit
to skinCheck.js + its test.
