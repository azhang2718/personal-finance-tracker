import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DB_PATH = path.join(__dirname, '..', '..', 'data', 'networth.db');

// DB_PATH env var lets the packaged Electron app point the database at the
// app's user-data directory. Default remains server/data/networth.db (dev).
function resolveDbPath() {
  return process.env.DB_PATH && process.env.DB_PATH.trim() !== ''
    ? path.resolve(process.env.DB_PATH)
    : DEFAULT_DB_PATH;
}

let _db = null;

export function getDb() {
  if (_db) return _db;
  const dbPath = resolveDbPath();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  _db = new Database(dbPath);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  return _db;
}

export function runMigrations() {
  const db = getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS plaid_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      institution_name TEXT NOT NULL,
      encrypted_access_token BLOB NOT NULL,
      iv BLOB NOT NULL,
      auth_tag BLOB NOT NULL,
      needs_reauth INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      source TEXT NOT NULL CHECK(source IN ('plaid','collectr','manual')),
      type TEXT NOT NULL CHECK(type IN ('cash','credit','investment','collectibles')),
      plaid_account_id TEXT NULL,
      plaid_item_id INTEGER NULL REFERENCES plaid_items(id) ON DELETE CASCADE,
      needs_reauth INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      date TEXT NOT NULL,
      balance_cents INTEGER NOT NULL,
      UNIQUE(account_id, date)
    );

    CREATE TABLE IF NOT EXISTS refresh_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ran_at TEXT NOT NULL DEFAULT (datetime('now')),
      status TEXT NOT NULL,
      message TEXT
    );
  `);

  // Transactions cache for spending statistics + a small key/value meta table
  // (tracks when the cache was last refreshed). Both idempotent.
  db.exec(`
    CREATE TABLE IF NOT EXISTS transactions_cache (
      id TEXT PRIMARY KEY,            -- plaid transaction_id
      account_id INTEGER,             -- accounts.id
      date TEXT,
      name TEXT,
      amount_cents INTEGER,           -- positive = money out
      category TEXT,
      pending INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_txcache_date ON transactions_cache(date);

    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  // Idempotent column add: asset_class on accounts ('stocks'|'crypto'|'cash'
  // for investment sub-buckets; NULL elsewhere — NULL investment = stocks).
  const hasAssetClass = db
    .prepare(`SELECT COUNT(*) AS n FROM pragma_table_info('accounts') WHERE name = 'asset_class'`)
    .get().n > 0;
  if (!hasAssetClass) {
    db.exec(`ALTER TABLE accounts ADD COLUMN asset_class TEXT NULL`);
  }

  // Idempotent column add: mask (account's last 2–4 digits, from Plaid). Used to
  // tell an internal transfer between your own accounts (excluded from spending)
  // from an external one — i.e. someone paying you — which counts as income.
  const hasMask = db
    .prepare(`SELECT COUNT(*) AS n FROM pragma_table_info('accounts') WHERE name = 'mask'`)
    .get().n > 0;
  if (!hasMask) {
    db.exec(`ALTER TABLE accounts ADD COLUMN mask TEXT NULL`);
  }

  // Idempotent column adds for manual curation of cached transactions:
  //   user_category — a category you set by hand; overrides the auto one and
  //                   survives Plaid re-syncs (the auto `category` is still
  //                   refreshed underneath, but the override wins when present).
  //   excluded      — a soft "delete": hidden from all spending totals, the
  //                   category breakdown, and the monthly history, but kept so
  //                   it can be restored and isn't re-added on the next sync.
  const txCols = db.prepare(`SELECT name FROM pragma_table_info('transactions_cache')`).all().map((r) => r.name);
  if (!txCols.includes('user_category')) {
    db.exec(`ALTER TABLE transactions_cache ADD COLUMN user_category TEXT NULL`);
  }
  if (!txCols.includes('excluded')) {
    db.exec(`ALTER TABLE transactions_cache ADD COLUMN excluded INTEGER NOT NULL DEFAULT 0`);
  }

  console.log('[db] Migrations complete');
}
