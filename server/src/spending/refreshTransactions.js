// Pulls Plaid transactions into transactions_cache.
//
// Shared by two callers:
//   • the spending summary endpoint — lazy + throttled (skips if refreshed in
//     the last 12h and the cached window already covers the request), and
//   • the global /api/refresh ("reload" button) — forced, so a manual refresh
//     updates transactions and not just account balances.
//
// Pending transactions are stored (not skipped): recent activity should show up
// right away. When a pending charge later settles, Plaid issues a brand-new
// transaction_id and points `pending_transaction_id` back at the original — we
// delete the stale pending row so the settled one cleanly replaces it.
import { getPlaidClient } from '../plaid/client.js';
import {
  getAllItems,
  getDecryptedToken,
  getAccountsByItemId,
  findAccountByPlaidId,
  upsertTransaction,
  deleteTransaction,
  getMeta,
  setMeta,
  getOwnAccountMasks,
} from '../db/repository.js';
import { todayStr } from '../util/date.js';
import { categorizeTxn } from './categorize.js';

const REFRESH_INTERVAL_MS = 12 * 60 * 60 * 1000;
const META_REFRESHED_AT = 'transactions_refreshed_at';
const META_WINDOW_START = 'transactions_window_start';

// First day of the month `monthsBack` months before the current month.
export function monthStart(monthsBack) {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - monthsBack);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}-01`;
}

// Window to pull when the caller gives no start and nothing is cached yet:
// the trailing 6 months, matching the summary endpoint's default.
const DEFAULT_MONTHS_BACK = 5;

// Pull all transactions for one item over [startDate, endDate], paginated.
async function fetchItemTransactions(client, accessToken, startDate, endDate) {
  const all = [];
  let offset = 0;
  for (;;) {
    const res = await client.transactionsGet({
      access_token: accessToken,
      start_date: startDate,
      end_date: endDate,
      options: { count: 250, offset, include_personal_finance_category: true },
    });
    all.push(...res.data.transactions);
    if (all.length >= res.data.total_transactions || res.data.transactions.length === 0) break;
    offset = all.length;
  }
  return all;
}

/**
 * Refresh the transactions cache.
 * @param {object}  [opts]
 * @param {string}  [opts.startDate]  Earliest date to pull (YYYY-MM-DD). Defaults
 *                                    to the cached window, else the last 6 months.
 * @param {boolean} [opts.force]      Bypass the 12h freshness throttle.
 * @returns {Promise<{ refreshed: boolean, errors?: string[] }>}
 *
 * Refreshes when forced, when the cache is stale (>12h), or when the requested
 * window starts earlier than what's been fetched. Tolerates per-item failures —
 * one bank erroring never blocks the others or wipes the cache.
 */
export async function refreshTransactionsCache({ startDate, force = false } = {}) {
  const windowStart = getMeta(META_WINDOW_START);
  const start = startDate || windowStart || monthStart(DEFAULT_MONTHS_BACK);

  const refreshedAt = getMeta(META_REFRESHED_AT);
  const fresh = refreshedAt && Date.now() - new Date(refreshedAt).getTime() < REFRESH_INTERVAL_MS;
  const windowCovered = windowStart && windowStart <= start;
  if (!force && fresh && windowCovered) return { refreshed: false };

  const client = getPlaidClient();
  const endDate = todayStr();
  const items = getAllItems();
  const ownMasks = getOwnAccountMasks();
  let anySucceeded = false;
  const errors = [];

  for (const item of items) {
    const accounts = getAccountsByItemId(item.id);
    // Only items with cash/credit accounts carry spending transactions.
    if (!accounts.some((a) => a.type === 'cash' || a.type === 'credit')) continue;

    try {
      const accessToken = getDecryptedToken(item.id);
      const txns = await fetchItemTransactions(client, accessToken, start, endDate);
      for (const t of txns) {
        const account = findAccountByPlaidId(t.account_id);
        if (!account) continue;
        // A settled transaction supersedes the pending row it came from.
        if (t.pending_transaction_id) deleteTransaction(t.pending_transaction_id);
        upsertTransaction({
          id: t.transaction_id,
          accountId: account.id,
          date: t.date,
          name: t.name ?? '',
          amountCents: Math.round((t.amount ?? 0) * 100),
          category: categorizeTxn(t, ownMasks),
          pending: !!t.pending,
        });
      }
      anySucceeded = true;
    } catch (err) {
      console.warn(
        `[spending] transactions fetch failed for item ${item.id} (${item.institution_name}) — keeping cache:`,
        err.response?.data?.error_code ?? err.message
      );
      errors.push(item.institution_name);
    }
  }

  if (anySucceeded) {
    setMeta(META_REFRESHED_AT, new Date().toISOString());
    const earlier = windowStart && windowStart < start ? windowStart : start;
    setMeta(META_WINDOW_START, earlier);
  }
  return { refreshed: anySucceeded, errors };
}
