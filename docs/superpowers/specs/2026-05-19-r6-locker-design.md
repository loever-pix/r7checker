# R6 Skin Locker — Design Spec
**Date:** 2026-05-19  
**Stack:** Node.js + Express backend, Vanilla HTML/CSS/JS frontend  
**Environment:** Local only (localhost:3000)

---

## Overview

A local web app where a Rainbow Six Siege player logs in with their Ubisoft credentials and sees their full locker: season rank history, cosmetic inventory (seasonals, universals, black ices, ranked charms, attachment skins), account stats, and linked platforms. Items are displayed as clickable buttons; clicking opens a modal with the item image, name, rarity, and type.

---

## Architecture

```
R6 Skin/
├── server.js              # Express backend + r6api.js integration
├── package.json
├── public/
│   ├── index.html         # Login page
│   ├── locker.html        # Main locker page
│   ├── style.css          # Shared dark theme styles
│   └── app.js             # Frontend JS (fetch, render, modal)
```

**Backend:** Express serves static files from `/public` and exposes two API routes. r6api.js handles all Ubisoft API communication. Player data is held in-memory for the session duration only — nothing is written to disk.

**Frontend:** Plain HTML + CSS + vanilla JS. No build tools. Edit and refresh.

---

## Backend API Routes

### `POST /api/login`
- Body: `{ email, password }`
- Initiates Ubisoft auth via r6api.js
- If 2FA required: returns `{ requires2FA: true, ticket: "<temp_ticket>" }`
- On success: returns full player data object (see Data Shape below)
- On failure: returns `{ error: "Invalid credentials" }`

### `POST /api/verify-2fa`
- Body: `{ code, ticket }`
- Completes auth using the 2FA code + the ticket from the first request
- On success: returns full player data object
- On failure: returns `{ error: "Invalid code" }`

The pending ticket is held in a server-side Map keyed by ticket string, cleaned up after use or after 10 minutes.

---

## Login Flow

1. User opens `localhost:3000` → served `index.html` (login form)
2. Enters Ubisoft email + password → frontend POSTs to `/api/login`
3. **Path A (no 2FA):** Backend returns player data → frontend stores in `sessionStorage` → redirects to `locker.html`
4. **Path B (2FA required):** Backend returns `{ requires2FA: true, ticket }` → frontend reveals 2FA code input → user enters code → frontend POSTs to `/api/verify-2fa` → on success same as Path A
5. `locker.html` reads player data from `sessionStorage` and renders all sections

---

## Data Shape (player object)

```json
{
  "username": "Mythiical.",
  "level": 241,
  "renown": 130804,
  "credits": 759,
  "linkedPlatforms": ["ubisoft", "psn"],
  "avatar": "<url>",
  "seasonRanks": [
    { "season": "Tenfold Pursuit", "rank": "Diamond", "rankImage": "<url>" }
  ],
  "seasonals": [
    { "id": "...", "name": "Renaissance", "image": "<url>", "rarity": "Seasonal", "type": "Seasonal" }
  ],
  "universals": [...],
  "blackIces": [...],
  "rankedCharms": [...],
  "attachmentSkins": [...]
}
```

---

## Frontend UI

### Login Page (`index.html`)
- Dark background (#0d0d0d), centered card
- R6 logo / title at top
- Email + password fields
- "Sign In" button with loading state
- 2FA code field (hidden by default, revealed when required)
- Error message area

### Locker Page (`locker.html`)

**Top bar:**
- Player avatar (circular)
- Username + Level
- Renown amount with coin icon
- R6 Credits amount with credit icon
- Linked platform icons (Ubisoft, PSN, Xbox)

**Season Rank History:**
- Horizontal scrollable strip of season cards
- Each card: season name, rank icon image, rank label (e.g. "Diamond")
- Ordered most recent first

**Inventory Sections (stacked vertically):**
Each section has a heading with item count badge and a flex-wrap grid of pill buttons:
- Seasonals
- Universals
- Black Ices (dark accent styling)
- Ranked Charms
- Attachment Skins

Pill buttons show item name as text. Styled like the screenshot: rounded border, dark background, subtle hover effect.

**Item Modal:**
- Triggered on pill click
- Dark overlay backdrop
- Centered modal: item image (top), name, rarity badge (color-coded), type label
- Close on backdrop click or X button
- Smooth fade-in animation

---

## Styling

- Color scheme: `#0d0d0d` background, `#1a1a1a` cards, `#2a2a2a` pill buttons
- Accent: R6 orange (`#f05a00`) for highlights and rank badges
- Font: system sans-serif or Inter
- Responsive down to 768px width (single column)
- Season rank cards horizontally scrollable on overflow

---

## Error Handling

- Invalid credentials: show inline error on login form
- 2FA timeout (>10 min): ticket cleaned up server-side, user shown "Session expired, please try again"
- API fetch failure (Ubisoft down): show "Could not reach Ubisoft servers" message
- Missing item images: fallback placeholder image

---

## Out of Scope

- Persistence across sessions (no database, no localStorage)
- Multi-profile switching
- Equipping or modifying items
- Hosting / deployment
