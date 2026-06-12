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

  console.log('[db] Migrations complete');
}
