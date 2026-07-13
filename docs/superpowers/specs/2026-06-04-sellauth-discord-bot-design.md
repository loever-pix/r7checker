# R6 SellAuth Discord Bot — Design

**Date:** 2026-06-04
**Status:** Approved (design); pending spec review

## Purpose

A Discord bot for the R6 account store that lets the owner restock accounts
into SellAuth products, issue replacement accounts to customers, announce
restocks with a role ping, and let members self-assign the restock-ping role
via a reaction.

SellAuth (`https://api.sellauth.com`, shop `5822532`) is the **single source of
truth** for products, stock, and orders. The bot holds no stock of its own.

## Non-goals

- The bot does NOT process sales or payments — SellAuth handles checkout.
- The bot does NOT maintain its own account/stock database.
- No web UI; this is a Discord-only surface. It lives in the existing repo and
  shares `.env` + `lib/email.js`, but runs as its own process.

## Architecture

A standalone Node process (`bot.js`) built on **discord.js v14**, started
separately from `server.js`. Logic is split into focused modules under
`lib/bot/`:

```
bot.js                     # client bootstrap, command registration, event wiring
lib/bot/sellauth.js        # SellAuth REST client (products, stock, invoices)
lib/bot/commands/restock.js
lib/bot/commands/replace.js
lib/bot/reactionRole.js    # self-assign restock-ping role
lib/bot/config.js          # reads IDs/keys from .env, validates on boot
```

### Configuration (`.env`, gitignored)

| Key | Meaning |
|-----|---------|
| `DISCORD_BOT_TOKEN` | Bot token |
| `DISCORD_GUILD_ID` | `1511134219055927337` — for instant guild slash-command registration |
| `SELLAUTH_API_KEY` | Full bearer key `5822532\|…` |
| `SELLAUTH_SHOP_ID` | `5822532` |
| `OWNER_ROLE_ID` | `1511260307337642047` — gates `/restock` and `/replace` |
| `RESTOCK_PING_ROLE_ID` | `1512288110225129634` — pinged on restock; granted by reaction |
| `REACTION_ROLE_CHANNEL_ID` | `1512288064683114536` — holds reaction-role msg + restock alerts |
| `SMTP_*` | Already present; drives replacement email. Falls back to console log if unset. |

`config.js` fails fast on boot if any required key is missing (except SMTP,
which has a documented console fallback).

## SellAuth client — `lib/bot/sellauth.js`

Base `https://api.sellauth.com`, every path prefixed `/v1/shops/{SHOP_ID}`,
header `Authorization: Bearer {SELLAUTH_API_KEY}`.

- `listProducts()` → `GET /products` — returns `{id, name, variantId, stockCount, image}[]` for autocomplete.
- `getProduct(id)` → `GET /products/{id}` — variant `stock_count`, image, deliverables.
- `appendStock(productId, variantId, lines[])` → `PUT /products/{productId}/deliverables/append/{variantId}`.
- `getInvoice(orderId)` → `GET /invoices/{orderId}` — `items[].product.{id,name}`, `items[].variant.{id,name}`, customer `email`, `status`.
- `popOneSerial(productId, variantId)` → reads current serials, removes one, writes the remainder back via the `deliverables/overwrite/{variantId}` endpoint; returns the removed line. The exact "read current deliverables" call is confirmed by probing the live API during implementation (the get-product response, or a dedicated stock GET).

All methods throw a typed error on non-2xx; callers translate to a Discord
message.

## Command: `/restock` (owner-gated)

**Options:** `product` (string, autocomplete from `listProducts()`) + `accounts`
(attachment, `.txt`).

**Flow:**
1. Reject if the invoking member lacks `OWNER_ROLE_ID` (ephemeral).
2. Download the attachment; split into non-empty trimmed lines. Each line is one
   stock unit, stored **verbatim** (full `email:pass | User:… | Profile:…`
   format). Reject if zero lines or attachment isn't `.txt`.
3. `appendStock(productId, variantId, lines)`.
4. `getProduct` to read the new `stock_count`.
5. Post a **restock alert** to `REACTION_ROLE_CHANNEL_ID`, content
   `<@&RESTOCK_PING_ROLE_ID>`, with an embed: product **name** (title), product
   **image** (thumbnail/image), **`+N added`**, **`Inventory: <stock_count>`**.
6. Reply to the owner (ephemeral) confirming N added and the new total.

## Command: `/replace` (owner-gated)

**Options:** `order_id` (string), `email` (string).

**Flow:**
1. Reject if not owner (ephemeral).
2. `getInvoice(order_id)`. If not found → ephemeral error.
3. Verify the invoice customer email equals the provided email
   (case-insensitive, trimmed). Mismatch → ephemeral error, no stock touched.
4. Verify order status is completed/paid. Otherwise → ephemeral error.
5. Read the product + variant from the invoice's first item.
6. If that product's `stock_count` is 0 → refuse, tell owner to restock first.
7. `popOneSerial(productId, variantId)` to take one account.
8. Email the account to the order email via `lib/email.js`
   (`send({to, subject, text, html})`), subject e.g. "Your replacement account".
9. Reply to the owner (ephemeral): product name, masked email, remaining stock.
   If the email send fails, the reply says so and includes the account so the
   owner can deliver manually (the serial was already removed from stock).

## Reaction role — `lib/bot/reactionRole.js`

- On `ready`, ensure a self-assign message exists in
  `REACTION_ROLE_CHANNEL_ID`. The message ID is persisted (e.g.
  `.cache/reactionrole.json`) so restarts don't create duplicates; if the stored
  message is gone, post a fresh one and re-react with 🔔.
- `messageReactionAdd` with 🔔 on that message → add `RESTOCK_PING_ROLE_ID`.
- `messageReactionRemove` with 🔔 → remove the role.
- Requires the `GuildMessageReactions` + `GuildMembers` intents and partials for
  reactions/messages (so reactions on pre-cache messages still fire).

## Error handling

- Every owner command checks `OWNER_ROLE_ID` first and rejects others ephemerally.
- `/replace` is fail-safe ordered: all validation (order exists, email match,
  status, stock > 0) happens **before** any serial is removed.
- SellAuth and email failures are caught and surfaced to the owner; nothing
  fails silently.
- Bot logs structured lines (`[bot] …`) consistent with the repo's logging style.

## Testing

- **Unit (mocked HTTP):** `sellauth.js` request shaping + error handling;
  restock line-parsing; replacement email-match (case/space-insensitive) and
  the "refuse before pop" ordering.
- **Manual:** slash-command registration, autocomplete, a live restock against a
  test product, the restock-alert embed + ping, reaction add/remove role grant,
  and a `/replace` end-to-end (email received).

## Dependencies

- Add `discord.js` (^14) to `package.json`.
- Reuses existing `axios`/`node-fetch`, `nodemailer` (via `lib/email.js`),
  `dotenv`.
