import { getDb } from './schema.js';
import { encrypt, decrypt } from '../crypto/index.js';
import { cleanCategory } from '../spending/categorize.js';

// Effective category = your manual override if set, else the auto one.
const EFFECTIVE_CATEGORY = `COALESCE(NULLIF(t.user_category, ''), t.category)`;

// ─── Snapshots ────────────────────────────────────────────────────────────────

/**
 * Insert or replace a snapshot for (accountId, date).
 * One snapshot per account per day.
 */
export function upsertSnapshot(accountId, date, balanceCents) {
  const db = getDb();
  db.prepare(`
    INSERT INTO snapshots (account_id, date, balance_cents)
    VALUES (?, ?, ?)
    ON CONFLICT(account_id, date) DO UPDATE SET balance_cents = excluded.balance_cents
  `).run(accountId, date, balanceCents);
}

/**
 * Returns daily net worth series for the given date range.
 * Each row: { date, total_cents }
 * Uses each account's most recent snapshot on or before each date.
 */
export function getNetWorthSeries(sinceDate) {
  const db = getDb();
  // Get all distinct dates with snapshots within range, then compute net worth per date
  const rows = db.prepare(`
    WITH RECURSIVE date_series AS (
      SELECT MIN(date) AS d FROM snapshots WHERE date >= ?
      UNION ALL
      SELECT date(d, '+1 day')
      FROM date_series
      WHERE d < date('now')
    ),
    latest_per_account AS (
      SELECT
        ds.d AS series_date,
        s.account_id,
        s.balance_cents
      FROM date_series ds
      JOIN accounts a ON 1=1
      LEFT JOIN snapshots s ON s.account_id = a.id AND s.date = (
        SELECT MAX(s2.date) FROM snapshots s2
        WHERE s2.account_id = a.id AND s2.date <= ds.d
      )
      WHERE s.balance_cents IS NOT NULL
    )
    SELECT
      series_date AS date,
      SUM(balance_cents) AS total_cents
    FROM latest_per_account
    GROUP BY series_date
    ORDER BY series_date ASC
  `).all(sinceDate);
  return rows;
}

/**
 * Returns the most recent snapshot for each account.
 * Each row: { account_id, name, source, type, balance_cents, date, needs_reauth }
 */
export function getLatestByAccount() {
  const db = getDb();
  return db.prepare(`
    SELECT
      a.id AS account_id,
      a.name,
      a.source,
      a.type,
      a.asset_class,
      a.plaid_item_id,
      a.needs_reauth,
      s.balance_cents,
      s.date
    FROM accounts a
    LEFT JOIN snapshots s ON s.id = (
      SELECT id FROM snapshots
      WHERE account_id = a.id
      ORDER BY date DESC
      LIMIT 1
    )
    ORDER BY a.source, a.name
  `).all();
}

// ─── Plaid items ──────────────────────────────────────────────────────────────

/**
 * Saves a new Plaid item, encrypting the access token at rest.
 * Returns the new item id.
 */
export function saveItem(institutionName, accessToken) {
  const db = getDb();
  const { ciphertext, iv, authTag } = encrypt(accessToken);
  const result = db.prepare(`
    INSERT INTO plaid_items (institution_name, encrypted_access_token, iv, auth_tag)
    VALUES (?, ?, ?, ?)
  `).run(institutionName, ciphertext, iv, authTag);
  return result.lastInsertRowid;
}

/**
 * Decrypts and returns the access token for an item — kept in memory only.
 * Never written to disk in plaintext.
 */
export function getDecryptedToken(itemId) {
  const db = getDb();
  const row = db.prepare(`
    SELECT encrypted_access_token, iv, auth_tag FROM plaid_items WHERE id = ?
  `).get(itemId);
  if (!row) throw new Error(`Plaid item ${itemId} not found`);
  return decrypt({
    ciphertext: row.encrypted_access_token,
    iv: row.iv,
    authTag: row.auth_tag,
  });
}

/**
 * Returns all Plaid items (without tokens).
 */
export function getAllItems() {
  const db = getDb();
  return db.prepare(`
    SELECT id, institution_name, needs_reauth, created_at FROM plaid_items
  `).all();
}

/**
 * Marks a Plaid item as needing reauth.
 */
export function markItemNeedsReauth(itemId) {
  const db = getDb();
  db.prepare(`UPDATE plaid_items SET needs_reauth = 1 WHERE id = ?`).run(itemId);
  db.prepare(`UPDATE accounts SET needs_reauth = 1 WHERE plaid_item_id = ?`).run(itemId);
}

/**
 * Deletes a Plaid item and all associated accounts/snapshots (CASCADE).
 */
export function deleteItem(itemId) {
  const db = getDb();
  db.prepare(`DELETE FROM plaid_items WHERE id = ?`).run(itemId);
}

// ─── Accounts ─────────────────────────────────────────────────────────────────

/**
 * Creates an account row.
 */
export function createAccount({ name, source, type, plaidAccountId, plaidItemId, assetClass, mask }) {
  const db = getDb();
  const result = db.prepare(`
    INSERT INTO accounts (name, source, type, plaid_account_id, plaid_item_id, asset_class, mask)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(name, source, type, plaidAccountId ?? null, plaidItemId ?? null, assetClass ?? null, mask ?? null);
  return result.lastInsertRowid;
}

/**
 * Sets an account's mask (its last 2–4 digits, from Plaid). No-op for a falsy
 * mask so we never clobber a known value with null.
 */
export function setAccountMask(accountId, mask) {
  if (!mask) return;
  const db = getDb();
  db.prepare(`UPDATE accounts SET mask = ? WHERE id = ?`).run(String(mask), accountId);
}

/**
 * Set of your own accounts' masks (digits only), used to tell an internal
 * transfer from an external one during categorization.
 */
export function getOwnAccountMasks() {
  const db = getDb();
  const rows = db.prepare(`SELECT mask FROM accounts WHERE mask IS NOT NULL AND mask != ''`).all();
  return new Set(rows.map((r) => String(r.mask).replace(/\D/g, '')).filter(Boolean));
}

/**
 * Sets the asset_class of an account ('stocks' | 'crypto' | 'cash' | null).
 */
export function setAccountAssetClass(accountId, assetClass) {
  const db = getDb();
  db.prepare(`UPDATE accounts SET asset_class = ? WHERE id = ?`).run(assetClass, accountId);
}


/**
 * Finds an account by plaid_account_id.
 */
export function findAccountByPlaidId(plaidAccountId) {
  const db = getDb();
  return db.prepare(`SELECT * FROM accounts WHERE plaid_account_id = ?`).get(plaidAccountId);
}

/**
 * Returns accounts belonging to a Plaid item.
 */
export function getAccountsByItemId(itemId) {
  const db = getDb();
  return db.prepare(`SELECT * FROM accounts WHERE plaid_item_id = ?`).all(itemId);
}

// ─── Collectr / manual accounts ───────────────────────────────────────────────

/**
 * Gets or creates the collectibles account (source: collectr or manual).
 */
export function getOrCreateCollectiblesAccount(source = 'collectr') {
  const db = getDb();
  let account = db.prepare(`SELECT * FROM accounts WHERE type = 'collectibles' LIMIT 1`).get();
  if (!account) {
    const result = db.prepare(`
      INSERT INTO accounts (name, source, type)
      VALUES (?, ?, 'collectibles')
    `).run('Collectibles', source);
    account = db.prepare(`SELECT * FROM accounts WHERE id = ?`).get(result.lastInsertRowid);
  }
  return account;
}

// ─── Refresh log ──────────────────────────────────────────────────────────────

export function logRefresh(status, message) {
  const db = getDb();
  db.prepare(`INSERT INTO refresh_log (status, message) VALUES (?, ?)`).run(status, message ?? null);
}

export function getLastRefresh() {
  const db = getDb();
  return db.prepare(`SELECT * FROM refresh_log ORDER BY ran_at DESC LIMIT 1`).get();
}

// ─── Meta (key/value) ─────────────────────────────────────────────────────────

export function getMeta(key) {
  const db = getDb();
  const row = db.prepare(`SELECT value FROM meta WHERE key = ?`).get(key);
  return row ? row.value : null;
}

export function setMeta(key, value) {
  const db = getDb();
  db.prepare(`
    INSERT INTO meta (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value);
}

// ─── Transactions cache ───────────────────────────────────────────────────────

export function upsertTransaction({ id, accountId, date, name, amountCents, category, pending }) {
  const db = getDb();
  db.prepare(`
    INSERT INTO transactions_cache (id, account_id, date, name, amount_cents, category, pending)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      account_id = excluded.account_id,
      date = excluded.date,
      name = excluded.name,
      amount_cents = excluded.amount_cents,
      category = excluded.category,
      pending = excluded.pending
  `).run(id, accountId, date, name, amountCents, category, pending ? 1 : 0);
  // NB: user_category and excluded are intentionally NOT updated on conflict, so
  // a manual recategorization or delete survives the next Plaid re-sync.
}

/**
 * Re-run categorization over every cached transaction using the current rules.
 * Stored rows only carry a name + a previously-stored category (no Plaid
 * `detailed`), which is exactly what cleanCategory() is built to handle. Run at
 * startup so rule improvements take effect without waiting for a Plaid refresh.
 * Only writes rows whose category actually changes. Returns the count updated.
 */
export function recategorizeAllTransactions() {
  const db = getDb();
  const ownMasks = getOwnAccountMasks();
  const rows = db.prepare('SELECT id, name, category FROM transactions_cache').all();
  const update = db.prepare('UPDATE transactions_cache SET category = ? WHERE id = ?');
  let changed = 0;
  const tx = db.transaction(() => {
    for (const r of rows) {
      const next = cleanCategory(r.category, '', r.name, ownMasks);
      if (next !== r.category) {
        update.run(next, r.id);
        changed++;
      }
    }
  });
  tx();
  return changed;
}

/**
 * Monthly expense/income totals from the transactions cache, oldest→newest.
 * Every transaction counts unless you've deleted it (excluded = 1): expenses are
 * outflows (positive) on cash/credit, income is inflows (negative, sign-flipped)
 * on cash. No category-based exclusions — curation is manual via the txn list.
 */
export function getSpendingByMonth(sinceDate) {
  const db = getDb();
  return db.prepare(`
    SELECT
      substr(t.date, 1, 7) AS month,
      SUM(CASE WHEN t.amount_cents > 0 AND a.type IN ('cash','credit')
               THEN t.amount_cents ELSE 0 END) AS expenses_cents,
      SUM(CASE WHEN t.amount_cents < 0 AND a.type = 'cash'
               THEN -t.amount_cents ELSE 0 END) AS income_cents
    FROM transactions_cache t
    JOIN accounts a ON a.id = t.account_id
    WHERE t.date >= ?
      AND t.pending = 0
      AND t.excluded = 0
    GROUP BY substr(t.date, 1, 7)
    ORDER BY month ASC
  `).all(sinceDate);
}

/**
 * One month's spending grouped by effective category (outflows only), sorted
 * desc. Includes every non-deleted outflow — no category exclusions.
 */
export function getSpendingByCategory(monthPrefix) {
  const db = getDb();
  return db.prepare(`
    SELECT ${EFFECTIVE_CATEGORY} AS category, SUM(t.amount_cents) AS cents
    FROM transactions_cache t
    JOIN accounts a ON a.id = t.account_id
    WHERE substr(t.date, 1, 7) = ?
      AND t.pending = 0
      AND t.excluded = 0
      AND t.amount_cents > 0
      AND a.type IN ('cash','credit')
    GROUP BY category
    ORDER BY cents DESC
  `).all(monthPrefix);
}

/**
 * Every cached transaction for one month (newest first), including deleted ones
 * (excluded = 1) so the UI can show and restore them. `category` is the
 * effective category; `amount_cents` keeps Plaid's sign (positive = money out).
 */
export function getTransactionsForMonth(monthPrefix) {
  const db = getDb();
  return db.prepare(`
    SELECT t.id AS id, t.date AS date, t.name AS name,
           t.amount_cents AS amount_cents,
           ${EFFECTIVE_CATEGORY} AS category,
           t.category AS auto_category,
           t.user_category AS user_category,
           t.excluded AS excluded,
           a.name AS account, a.type AS account_type
    FROM transactions_cache t
    JOIN accounts a ON a.id = t.account_id
    WHERE substr(t.date, 1, 7) = ?
      AND t.pending = 0
      AND a.type IN ('cash','credit')
    ORDER BY t.date DESC, t.amount_cents DESC
  `).all(monthPrefix);
}

/**
 * Set a manual category override (or clear it, reverting to auto, when blank).
 * Returns true if a row was affected.
 */
export function setTransactionCategory(id, category) {
  const db = getDb();
  const value = category && String(category).trim() !== '' ? String(category).trim() : null;
  return db.prepare(`UPDATE transactions_cache SET user_category = ? WHERE id = ?`).run(value, id).changes > 0;
}

/**
 * Soft-delete (excluded = 1) or restore (0) a transaction. Returns true if a
 * row was affected.
 */
export function setTransactionExcluded(id, excluded) {
  const db = getDb();
  return db.prepare(`UPDATE transactions_cache SET excluded = ? WHERE id = ?`)
    .run(excluded ? 1 : 0, id).changes > 0;
}

// ─── Snapshots read ───────────────────────────────────────────────────────────

export function getAllSnapshots() {
  const db = getDb();
  return db.prepare(`
    SELECT s.date, a.name AS account, a.type, a.source, s.balance_cents
    FROM snapshots s
    JOIN accounts a ON a.id = s.account_id
    ORDER BY s.date, a.name
  `).all();
}
