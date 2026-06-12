# Implementation Pipeline: Personal Net Worth Tracker

Follow these phases **in order**. Each phase ends with a verification gate — do not start the next phase until every check in the current gate passes. Reference documents: `networth-tracker-requirements.md` (the contract) and `ui_design.md` (visual spec for Phases 7–9).

---

## Phase 0 — Scaffold & secret hygiene (do this before any code)

**Tasks**
1. Create the repo structure: `server/` and `chrome-extension/` as described in the requirements doc.
2. Write `.gitignore` first: `.env`, `server/data/`, `*.db`, `node_modules/`, build output.
3. Create `server/.env.example` with placeholder values: `PLAID_CLIENT_ID`, `PLAID_SECRET`, `PLAID_ENV=sandbox`, `ENCRYPTION_KEY`, `COLLECTR_SHARE_URL`, `PORT=8123`.
4. Initialize git and make the first commit containing the `.gitignore` and `.env.example` only.
5. `npm init` in `server/` with pinned dependencies: `express`, `plaid`, `better-sqlite3`, `dotenv`, `express-rate-limit`, `cheerio`, `zod`.

**Gate**
- `git status` shows `.env` and `data/` untracked even after creating dummy versions.
- `grep -r "PLAID_SECRET" --include="*.js"` returns nothing outside `.env.example` references via `process.env`.

---

## Phase 1 — Backend foundation

**Tasks**
1. Express app bound to `127.0.0.1` only, with: JSON body limit (100kb), `express-rate-limit` (60 req/min), CORS restricted to the extension origin, and a logging middleware that **redacts** any field or header containing `token`, `secret`, or `authorization`.
2. `GET /api/health` returning `{ ok: true, env: PLAID_ENV }`.
3. Config loader that validates all required env vars on boot (fail fast with a clear message listing what's missing) using zod.

**Gate**
- Server refuses to start with a missing env var and names it.
- `curl http://127.0.0.1:8123/api/health` works; binding to LAN IP does not.
- A test request with a fake `Authorization` header appears redacted in logs.

---

## Phase 2 — Database & crypto layer

**Tasks**
1. SQLite schema from the requirements doc (`accounts`, `snapshots`, `plaid_items`) with migrations run idempotently on boot.
2. `crypto/` module: AES-256-GCM `encrypt(plaintext)` / `decrypt(blob)` using `ENCRYPTION_KEY` (32-byte base64). Random IV per encryption, auth tag stored alongside.
3. Repository functions: `upsertSnapshot(accountId, date, balanceCents)`, `getNetWorthSeries()`, `getLatestByAccount()`, `saveItem(institution, accessToken)` (encrypts), `getDecryptedToken(itemId)` (memory only).
4. `scripts/rotate-key.js`: decrypts all tokens with the old key (from arg/env), re-encrypts with the new key, in a transaction.

**Gate**
- Unit test: encrypt → decrypt round-trips; tampered ciphertext throws.
- Unit test: two `upsertSnapshot` calls for same account+date leave one row.
- Inspecting the DB file shows no plaintext token substring.

---

## Phase 3 — Plaid integration (sandbox)

**Tasks**
1. `POST /api/plaid/link-token` — creates a Link token (products: `transactions` not needed; use `auth`/`investments` balance scope via `accounts/balance/get`; just request what balances require).
2. `POST /api/plaid/exchange` — exchanges `public_token`, stores encrypted access token, creates `accounts` rows from `/accounts/get` (map Plaid types → `cash` / `credit` / `investment`; credit balances stored negative).
3. `POST /api/plaid/refresh` — for each item, `accounts/balance/get`, upsert today's snapshots. Handle `ITEM_LOGIN_REQUIRED` by marking the item `needs_reauth` instead of throwing.
4. `DELETE /api/plaid/items/:id` — calls `/item/remove`, deletes token, accounts, and their snapshots.
5. Update-mode link token endpoint for reauth.

**Gate**
- Full sandbox walkthrough scripted in README: connect `user_good` sandbox bank → accounts created → refresh writes snapshots.
- Token never appears in any response body or log line.
- Removing an item deletes its rows.

---

## Phase 4 — Collectr scraper

**Tasks**
1. `collectr/scrape.js`: fetch `COLLECTR_SHARE_URL` (browser-like User-Agent, 10s timeout), parse estimated portfolio value with Cheerio. Parsing strategy: look for the value by data attribute/selector first, fall back to a currency-pattern match scoped to the portfolio header region; reject ambiguous matches rather than guessing.
2. If the page is client-rendered (no value in HTML), implement the Playwright fallback behind the same interface: load the single page, wait for the value selector, extract, close.
3. Cache layer: skip the network entirely if the last successful fetch is < 12h old. Exponential backoff, max 2 retries.
4. On failure: keep last known snapshot, set source status `stale`, log a warning (no stack spam).
5. `PUT /api/collectibles/manual` — manual balance entry that writes a snapshot for the collectibles account.

**Gate**
- Scrape against the real share URL extracts a sane dollar value (log it for manual confirmation once).
- With a deliberately broken URL: server stays healthy, status reports `stale`, dashboard data still serves.
- Two refreshes within 12h produce exactly one network fetch.

---

## Phase 5 — Snapshot engine & read API

**Tasks**
1. `refreshAll()`: runs Plaid refresh + Collectr scrape independently (one failing never blocks the other), upserts snapshots, returns per-source `{ status: ok|stale|error, message, lastUpdated }`.
2. Auto-refresh policy: `POST /api/refresh` runs `refreshAll()`; the dashboard triggers it on load only if the last run is > 24h old.
3. Read endpoints: `GET /api/networth/series?range=1m|3m|1y|all`, `GET /api/networth/current` (total, 7-day delta, allocation by type), `GET /api/accounts` (with per-source status), `GET /api/export.csv`.

**Gate**
- Series math verified by a unit test with hand-computed fixtures (including a missing-day gap → carry forward last snapshot).
- CSV export opens cleanly and round-trips every snapshot.

---

## Phase 6 — Extension shell

**Tasks**
1. Manifest V3: `action.default_popup = popup.html`, dashboard as an extension page; `host_permissions` limited to `http://127.0.0.1:8123/*`. No remote code.
2. Shared API client module with cache: every GET is served from `chrome.storage.local` immediately, then revalidated in the background (stale-while-revalidate). Popup reads cache only — it never awaits the network before first paint.
3. "Open dashboard" via `chrome.tabs.create`.

**Gate**
- Extension loads unpacked with zero console errors.
- With the server stopped, the popup still renders the last cached numbers plus a stale indicator.

---

## Phase 7 — Dashboard UI

Build to `ui_design.md` exactly: tokens, layout, all four states (empty/loading/stale/error).

**Tasks**
1. Implement design tokens (CSS custom properties) and base typography first.
2. Hero: net worth figure + edge-to-edge time-series chart with range toggles.
3. Allocation donut + accounts table with statuses; Settings panel (Collectr URL display, manual collectibles entry, connect/reconnect/disconnect, export CSV, refresh).
4. Plaid Link integration in the connect flow (Link runs in the dashboard page).

**Gate**
- Side-by-side check against `ui_design.md` wireframes; numerals all tabular mono; only the accent color appears on the chart line and primary buttons.
- Empty state: a fresh install shows the single "Connect bank" action, not a broken chart.
- Keyboard: every control reachable, visible focus ring; `prefers-reduced-motion` disables the chart draw-in.

---

## Phase 8 — Popup UI

**Tasks**
1. Net worth figure, 7-day delta chip, 30-day sparkline, refresh button, "Open dashboard" — per `ui_design.md` popup spec.
2. First paint from cache in < 1s; refresh button shows inline progress and updates numbers in place.

**Gate**
- Cold open with network disabled: full render from cache.
- Lighthouse-style sanity check: no layout shift after data arrives (reserve space for numbers).

---

## Phase 9 — Hardening & delivery QA

**Tasks**
1. `npm audit` — resolve high/critical.
2. Secret sweep: grep repo and built extension bundle for `secret`, `access-`, `PLAID`, base64-looking tokens.
3. Run every acceptance criterion from the requirements doc (Section 7) and record results in `QA.md`.
4. README: setup, sandbox walkthrough, key rotation procedure, dependency update policy, security posture notes (loopback-only rationale, what must change before any remote exposure).

**Gate** — all Section 7 acceptance criteria pass. Project complete.

---

## Working rules for all phases

- Commit at the end of each phase with the phase number in the message; never commit a failing gate.
- When a decision isn't specified in the two reference docs, choose the simpler option and note it in `DECISIONS.md` rather than asking or adding scope.
- Never add a dependency beyond those listed without recording why in `DECISIONS.md`.
- Any error message shown to the user must name the fix ("Reconnect Chase"), not just the failure.
