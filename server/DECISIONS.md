# Implementation Decisions

Decisions made during implementation where the spec left room for choice.

---

## Module system: ESM (`"type": "module"`)

Used ES modules (import/export) throughout the server. All dependencies used (express, plaid, better-sqlite3, cheerio, zod, dotenv) support ESM. This avoids mixing require/import and is standard for Node ≥ 18.

---

## Plaid product: `assets`

The spec says to request what balances require. `accounts/balance/get` does not require a product — any valid product enables it. In sandbox, `assets` is the most permissive option that doesn't require additional data agreements. For real accounts, switch to `transactions` or `auth` per Plaid guidance.

---

## SQLite `refresh_log` table

Added a `refresh_log` table (not in the original data model) to track when refreshes were last run. This powers the 24-hour auto-refresh gate in `POST /api/refresh?auto=true` without in-memory state.

---

## Collectr cache in SQLite

The scraper cache is stored in a `collectr_cache` table in the same SQLite DB. This persists across server restarts, so the 12-hour cache TTL survives process restarts (important since the server runs locally and may restart often).

---

## `refreshAll.js` — independent source failure

Both Plaid and Collectr refresh are run with `Promise.allSettled` so neither blocks the other. A Plaid `ITEM_LOGIN_REQUIRED` is surfaced per-item rather than as a global error, matching the spec's requirement to never corrupt other sources on single-source failure.

---

## Credit balances as negative

When storing Plaid credit account balances, the sign is always negated (`-Math.abs(raw)`). The Plaid API returns credit balances as positive amounts owed; we negate them so they subtract from net worth correctly.

---

## Collectr parsing strategy (three-tier)

1. Data attributes (most reliable, structured)
2. Known class names / CSS selectors (common in portfolio apps)
3. Currency-pattern scan restricted to header/hero region — rejected if more than one match (ambiguity guard per spec)

Playwright fallback only if Cheerio finds nothing, keeping the dependency optional.

---

## `server/data/` gitignore

The `server/data/` directory containing the SQLite database is gitignored per spec. The directory is created at runtime by the DB module if it doesn't exist.

---

## CORS: Electron renderer origins only

CORS allows only requests that look like the Electron app's renderer: requests with **no Origin header**, Origin `null` (what Chromium sends for `file://` pages, which is how the renderer windows load), or origins starting with `file://` or `app://`. Any other origin (web pages, browser extensions) receives 403. No wildcard. The earlier `chrome-extension://` allowance from the extension prototype was removed — the product is an Electron desktop app. The server also binds to `127.0.0.1` by default, so LAN/internet access is impossible regardless.

---

## Configurable HOST and DB_PATH

`HOST` env var (default `127.0.0.1`) controls the bind address; any non-loopback value logs a prominent warning at startup per PRD Section 4.6. `DB_PATH` env var overrides the SQLite file location (default `server/data/networth.db`) so the packaged Electron app can store the DB under `app.getPath('userData')`.

---

## Collectr share URL exposed via `/api/health`

The dashboard settings panel must display the configured Collectr share link (read-only, per DESIGN.md). Rather than a new settings endpoint, `GET /api/health` includes `collectr_share_url`. It is the user's own public share link, not a credential, and the API is loopback-bound.

---

## Rate limiting: global, not per-route

60 req/min applied globally. The extension popup has minimal API calls; a single user on loopback will never hit this limit during normal use, but it prevents accidental loops or malicious local scripts.

---

## `DELETE /api/plaid/items/:id` — Plaid error tolerance

The `/item/remove` Plaid API call is wrapped in a try/catch with a warning log. If Plaid's side fails (e.g., token already invalidated), the local data is still deleted. This ensures "Disconnect & delete" always completes from the user's perspective.
