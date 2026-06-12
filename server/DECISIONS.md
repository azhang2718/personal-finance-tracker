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

## CORS: extension origin only

CORS is restricted to origins matching `chrome-extension://`. No wildcard. The server also binds to `127.0.0.1` only, so LAN/internet access is impossible regardless.

---

## Rate limiting: global, not per-route

60 req/min applied globally. The extension popup has minimal API calls; a single user on loopback will never hit this limit during normal use, but it prevents accidental loops or malicious local scripts.

---

## `DELETE /api/plaid/items/:id` — Plaid error tolerance

The `/item/remove` Plaid API call is wrapped in a try/catch with a warning log. If Plaid's side fails (e.g., token already invalidated), the local data is still deleted. This ensures "Disconnect & delete" always completes from the user's perspective.
