# Net Worth Tracker

Local-first personal net worth tracker. An Electron macOS desktop app (mini
window + full dashboard) backed by a loopback-bound Node/Express server that
aggregates Chase + Fidelity balances via **Plaid** and a Pokémon card
collection via a **Collectr** public share link, stores daily snapshots in
SQLite, and charts net worth over time.

- `server/` — Express API, SQLite, Plaid client, Collectr scraper, crypto. Holds all secrets.
- `app/` — Electron app (main process, preload bridge, two renderer windows). Holds none.

Design and product contracts: `PRD.md`, `IMPLEMENTATION.md`, `DESIGN.md`.
Implementation decisions: `server/DECISIONS.md`. QA results: `QA.md`.

## Setup (dev)

Requires Node ≥ 18.

```sh
# 1. server
cd server
npm install
cp .env.example .env        # then edit .env

# 2. app
cd ../app
npm install                 # postinstall copies Chart.js into app/lib/

# 3. run (spawns the server automatically as a child process)
npm start
```

Fill `server/.env`:

| Var | Value |
|-----|-------|
| `PLAID_CLIENT_ID` / `PLAID_SECRET` | from the Plaid dashboard (Sandbox keys) |
| `PLAID_ENV` | `sandbox` |
| `ENCRYPTION_KEY` | 32-byte base64 key: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` |
| `COLLECTR_SHARE_URL` | your public Collectr share link |
| `PORT` / `HOST` | default `8123` / `127.0.0.1` (keep loopback — see Security) |
| `DB_PATH` | optional SQLite path override (default `server/data/networth.db`) |

`npm start` opens the mini window; "Open dashboard" opens the full dashboard.
The mini window paints from cache instantly and revalidates in the background.

## Plaid sandbox walkthrough

1. Set `PLAID_ENV=sandbox` with sandbox keys, launch the app, open the dashboard.
2. Click **Connect bank**. Plaid Link opens inside the dashboard window.
3. Pick any institution (e.g. Chase). Credentials: username `user_good`,
   password `pass_good`. Complete the flow.
4. On success the app exchanges the public token server-side, creates accounts,
   writes today's snapshots, and the hero figure + chart render.
5. Click **Refresh** to re-pull balances; **Export CSV** to round-trip the data.
6. To test reauth, use Plaid's sandbox `ITEM_LOGIN_REQUIRED` reset; the account
   row shows an error with an inline **Reconnect** action (Link update mode).
7. **Disconnect & delete** (Settings) requires typing the institution name and
   removes the item, its encrypted token, and all of its snapshots.

No real bank credentials ever touch this app — all bank auth flows through
Plaid Link, and access tokens are stored AES-256-GCM-encrypted.

## macOS packaging & install

`npm run dist` must be run **on the MacBook** (electron-builder mac targets
don't cross-build from Windows).

```sh
cd app
npm install
npm run dist          # produces dist/*.dmg and *.zip (arm64)
```

Install/run on any Mac:

1. Open the DMG, drag **Net Worth Tracker** to Applications, launch it
   (right-click → Open the first time if unsigned).
2. On first launch the app creates its user-data dir at
   `~/Library/Application Support/networth-tracker/`. Create the server config
   file there — `server.env` — with the same keys as `server/.env.example`.
3. Relaunch. The app runs the bundled server from its resources directory and
   stores the SQLite DB at `~/Library/Application Support/networth-tracker/networth.db`.

Nothing is hardcoded to a machine: the DB path derives from the user-data
directory and the API base URL is editable in dashboard Settings
(default `http://127.0.0.1:8123`).

## Key & secret rotation

- **Encryption key:** `server/scripts/rotate-key.js` re-encrypts all stored
  Plaid access tokens in a transaction:
  ```sh
  cd server
  node scripts/rotate-key.js "$OLD_KEY_BASE64" "$NEW_KEY_BASE64"
  # then put the new key in .env (or server.env in the packaged app)
  ```
- **Plaid secret:** rotate it in the Plaid dashboard, update `PLAID_SECRET` in
  `.env`, restart. Stored access tokens remain valid.

## Dependency update policy

- Dependencies are version-pinned via `package-lock.json` in both `server/`
  and `app/`.
- Before any release: `npm audit` in both directories; high/critical findings
  block delivery (see QA.md #6). Use `npm audit fix`, escalating to
  `--force` only for dev-time tooling (electron, electron-builder).
- Update routinely with `npm outdated` → bump → re-run the sandbox walkthrough.
- New runtime dependencies require a rationale entry in `server/DECISIONS.md`.

## Security posture

- **Loopback by default.** The server binds `127.0.0.1`; plain HTTP is
  acceptable *only* because traffic never leaves the machine. Setting `HOST`
  to anything non-loopback logs a prominent warning — do not do it without
  putting TLS **and** authentication in front of the server first.
- **Secrets live only in `server/.env`** (dev) or
  `~/Library/Application Support/networth-tracker/server.env` (packaged) —
  both gitignored / outside the repo. Plaid access tokens are encrypted at
  rest (AES-256-GCM, random IV, auth tag) and decrypted only in memory.
- **Renderers hold no secrets.** `contextIsolation: true`,
  `nodeIntegration: false`, a minimal preload bridge, and CSP per window.
  The only remote script is Plaid's official Link loader, in the dashboard
  window only.
- **CORS** allows only Electron renderer origins (no Origin / `null` /
  `file://` / `app://`); rate limiting 60 req/min; 100kb body cap; logging
  redacts anything token/secret/authorization-shaped.
- **Data deletion**: "Disconnect & delete" calls Plaid `/item/remove` and
  deletes the stored token and its snapshot history.
