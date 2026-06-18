# Project Requirements: Personal Net Worth Tracker

## 1. Overview

Build a local-first personal net worth tracker for a single user. It aggregates balances from three sources — Chase (checking + credit card) and Fidelity (investments) via the **Plaid API**, and a Pokémon card collection via a **Collectr public share link** — then visualizes net worth over time and its distribution across asset classes.

The product is a **native macOS desktop app** (Electron, distributed as a `.app` / DMG) with a single surface:

1. A **full dashboard window**: full time-series chart, allocation breakdown, per-account detail, and data management.

The dashboard is a thin client rendered by the Electron renderer process. All secrets, API calls, and scraping live in a **local backend server** that the app spawns as a child process on launch (and shuts down on quit). The renderer never holds a Plaid secret or access token.

**Portability requirement:** the app must run on any machine (primary target: macOS on Apple Silicon). The API base URL (host + port) is configurable — defaulting to `http://127.0.0.1:8123` — via app settings, not hardcoded. Nothing in the client or server may assume a single fixed machine, IP, or absolute path; all paths derive from the app's user-data directory.

## 2. Architecture

```
app/                       (Electron app: mini window + dashboard, no secrets,
  main.js                   talks only to the configured local API base URL)
  preload.js               (contextBridge — no nodeIntegration in renderers)
  windows/
    mini.html / mini.js     (compact at-a-glance window)
    dashboard.html / dashboard.js
  shared/  (api client, chart components, design tokens)
server/                    (Node.js + Express, holds all secrets; spawned by the app)
  .env                     (gitignored — see Section 4)
  src/
    plaid/                 (Link token creation, token exchange, balance fetch)
    collectr/              (share-link scraper)
    db/                    (SQLite via better-sqlite3)
    routes/
    crypto/                (at-rest encryption helpers)
```

- **Backend:** Node.js + Express, bound to `127.0.0.1` by default (never `0.0.0.0` unless the user explicitly opts in via config, with documented risks). Host and port come from config, not constants.
- **Database:** SQLite, single file stored under the app's user-data directory (e.g. `~/Library/Application Support/NetWorthTracker/` in the packaged app; `server/data/` in dev), gitignored. Path resolved at runtime, never hardcoded.
- **Frontend:** Electron renderer, vanilla JS or a lightweight bundled React — builder's choice, but no remote code. Charts via Chart.js or Recharts, bundled locally.
- **Packaging:** `electron-builder` producing a signed-or-unsigned macOS `.app`/DMG for Apple Silicon (and Intel via universal build if cheap). The app bundles the server and Node runtime; one double-click launches everything.
- **Plaid SDK:** official `plaid` npm package, latest stable.

### Data model

```sql
accounts  (id, name, source TEXT CHECK(source IN ('plaid','collectr','manual')),
           type TEXT CHECK(type IN ('cash','credit','investment','collectibles')),
           plaid_account_id TEXT NULL)

snapshots (id, account_id, date TEXT, balance_cents INTEGER,
           UNIQUE(account_id, date))

plaid_items (id, institution_name, encrypted_access_token BLOB, created_at)
```

- Net worth on date D = sum of each account's most recent snapshot on or before D. Credit balances stored as negative.
- One snapshot per account per day (upsert on conflict). A failed refresh of one source must never block or corrupt the others.

## 3. Data pipelines

### 3.1 Plaid (Chase + Fidelity)

- **Authentication happens exclusively through Plaid Link.** The app never sees, requests, stores, or transmits banking credentials. Build the standard flow: server creates a `link_token` → frontend opens Plaid Link → frontend returns `public_token` → server exchanges it for an `access_token` and persists it **encrypted** (Section 4).
- Start in Plaid **sandbox** mode; environment (`sandbox`/`development`/`production`) is set via `.env` only. Include a sandbox test path in the README so the app is verifiable without real accounts.
- Balance refresh: `accounts/balance/get` per item. Triggered (a) manually via a "Refresh" button and (b) automatically at most once per 24h when the dashboard loads. Cache the last result; never hammer the API.
- Handle `ITEM_LOGIN_REQUIRED` gracefully: surface a "Reconnect" button that runs Link in update mode. Do not silently retry.

### 3.2 Collectr (scraper)

- The user supplies **one URL — their own public Collectr share link** — via `COLLECTR_SHARE_URL` in `.env`. The scraper fetches only this URL. This is not a general-purpose scraper.
- Approach: plain `fetch` + Cheerio first. If the portfolio value is rendered client-side, fall back to Playwright (headless, single page, no crawling).
- Politeness: at most one fetch per 12 hours, cached in the DB; identify with a normal browser User-Agent; 10s timeout; exponential backoff on failure, max 2 retries.
- Parse the **estimated portfolio value** into cents. If parsing fails (site markup changed), log a warning, keep the last known value, and show a "stale — last updated {date}" badge in the UI. Also provide a **manual entry field** for the collectibles balance as a permanent fallback.

### 3.3 Snapshot job

- A single `refreshAll()` routine: Plaid balances + Collectr value → upsert today's snapshots → return a per-source status report (`ok` / `stale` / `error` with message). The UI shows this status honestly; no fake freshness.

## 4. Security requirements (hard constraints — failing any of these fails the project)

1. **No secrets in code, ever.** `PLAID_CLIENT_ID`, `PLAID_SECRET`, `ENCRYPTION_KEY`, and `COLLECTR_SHARE_URL` live in `server/.env`. Ship a `.env.example` with placeholder values and a `.gitignore` that excludes `.env`, `server/data/`, and any `*.db` files **before the first commit**. Verify with `git status` that no secret-bearing file is ever staged.
2. **Plaid access tokens are encrypted at rest.** AES-256-GCM with a key from `ENCRYPTION_KEY` (32-byte, base64). Tokens are decrypted only in memory at call time. Never write decrypted tokens to disk.
3. **No secrets reach the renderer.** Electron renderers run with `contextIsolation: true`, `nodeIntegration: false`, and talk only to the configured local API base URL (default `http://127.0.0.1:{PORT}`). No Plaid endpoint is called from renderer code. Code-review checklist item: grep the renderer bundle for `PLAID`, `secret`, and `access-` before considering it done.
4. **No secrets in logs.** Logging middleware must redact `Authorization` headers, access tokens, and link tokens. Log token *prefixes* (first 4 chars) at most, for debugging.
5. **Credentials are never handled.** All bank auth flows through Plaid Link. There is no form anywhere in this app that accepts a bank username or password.
6. **Local attack surface minimized.** Server binds to loopback by default; non-loopback binding requires an explicit config opt-in and is documented as unsafe without TLS + auth. CORS allows only the app's renderer origin; basic rate limiting (e.g., `express-rate-limit`, 60 req/min) on all routes; request body size capped.
7. **Dependency hygiene.** Pin dependencies, run `npm audit` as part of the build, and document in the README how to update and rotate: (a) dependencies, (b) the Plaid secret, (c) the encryption key (include a small `rotate-key` script that re-encrypts stored tokens).
8. **Data deletion.** Provide a "Disconnect & delete" action per Plaid item that calls `/item/remove` and deletes the stored token and its snapshots — honoring delete-when-done.
9. **HTTPS posture.** All outbound calls (Plaid, Collectr) are HTTPS. Document clearly in the README that localhost HTTP is acceptable *only* because the server is loopback-bound, and what must change (TLS, auth) if it's ever exposed beyond the machine.

## 5. Functional requirements

- **F1 — Net worth over time:** line/area chart of total net worth, with range toggles (1M / 3M / 1Y / All). Tooltip shows per-date total and per-account breakdown.
- **F2 — Distribution:** donut or stacked-bar of current net worth by asset class (cash, investments, collectibles, minus credit). Show both $ and %.
- **F3 — Accounts view:** list of connected accounts with current balance, source, last-updated time, and per-source status (ok/stale/error).
- **F4 — Connect flow:** "Connect bank" button launching Plaid Link; Collectr URL and manual balances configurable in a Settings panel.
- **F5 — Refresh:** manual refresh button + automatic daily snapshot as in 3.3; visible last-refresh timestamp.
- **F6 — Mini window:** current net worth, change vs. 7 days ago (value + %), 30-day sparkline, refresh button, and an "Open dashboard" action (opens/focuses the dashboard window). Loads in under 1 second from cached data — the mini window never blocks on a network call.
- **F7 — CSV export:** export all snapshots as CSV (date, account, balance) so data is never locked in.
- **F8 — Backfill (nice-to-have):** manual entry of historical balances for any account/date to seed the chart.

## 6. Design requirements

The aesthetic should match the owner's existing portfolio language: **Swiss/editorial** — disciplined grid, generous whitespace, typography doing the heavy lifting. This is a precision instrument for reading numbers, not a flashy fintech landing page.

- **Type:** Geist Sans for UI and headings; **Geist Mono for every numeral** (balances, deltas, dates, axis labels). Tabular figures everywhere numbers align. Clear scale: one large display size reserved for the net worth figure, restrained elsewhere.
- **Palette:** warm off-white background (`#FAF9F6`-family), near-black ink (`#1A1A1A`), a single **sky-blue accent** (`#4A90D9`-family) used only for the net-worth line and primary actions. Semantic green/red appear *only* on change indicators, desaturated, never as large fills. No gradients, no glassmorphism, no drop shadows heavier than 1px borders.
- **Signature element:** the dashboard hero is the net worth figure itself — very large, mono, with the time-series chart running directly beneath it edge-to-edge, axis labels set like footnotes. Everything else (allocation, accounts, settings) sits quietly below on a 12-column grid with hairline dividers.
- **Charts:** minimal — no chart borders or heavy gridlines; thin lines; subtle area fill at low opacity; mono-typeset axes.
- **Mini window:** same tokens at small scale (~360×480px). Number first, sparkline second, controls last.
- **States:** design empty (no accounts yet — make "Connect bank" the obvious single action), loading (skeletons, not spinners), stale (quiet badge), and error (plain-language message + the action that fixes it, e.g., "Reconnect Chase"). Visible keyboard focus; respects `prefers-reduced-motion`; the only animation is a brief draw-in of the chart on load.
- **Copy:** sentence case, plain verbs ("Refresh balances", "Connect bank", "Export CSV"). No filler, no exclamation points.

## 7. Acceptance criteria

1. Fresh clone → `cp .env.example .env`, fill sandbox keys → `npm install && npm run dev` → app window opens, connect a Plaid sandbox bank → snapshot appears, chart renders.
2. `git log -p` and the packaged app bundle contain zero secrets or tokens.
3. Killing the Collectr scrape (bad URL) degrades gracefully: dashboard still loads, collectibles shows stale badge, manual entry works.
4. Mini window renders from cache instantly with the network disabled.
5. "Disconnect & delete" removes the Plaid item, its token, and its snapshots.
6. `npm audit` reports no high/critical vulnerabilities at delivery.
7. `npm run dist` produces a macOS `.app`/DMG that launches the server and UI with one double-click on a different machine, with no hardcoded paths or addresses (API base URL configurable in Settings).

## 8. Out of scope

Multi-user support, cloud deployment, transaction-level budgeting, mobile, browser extensions, and scraping any page other than the single configured Collectr share link.
