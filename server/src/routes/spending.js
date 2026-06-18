// Spending statistics: GET /api/spending/summary?months=6
//
// Backed by transactions_cache, refreshed from Plaid transactionsGet at most
// once per 12 hours (tracked in the meta table). Per-item failures are
// tolerated — we keep serving whatever is cached.
//
// Sign conventions (Plaid): positive amount = money out of the account.
// Expenses = positive amounts on cash/credit accounts; income = negative
// amounts on depository accounts, sign-flipped. Transfers between own
// accounts are approximated by excluding primary categories TRANSFER_IN /
// TRANSFER_OUT (see DECISIONS.md).
import { Router } from 'express';
import { getPlaidClient } from '../plaid/client.js';
import {
  getAllItems,
  getDecryptedToken,
  getAccountsByItemId,
  findAccountByPlaidId,
  upsertTransaction,
  getMeta,
  setMeta,
  getSpendingByMonth,
  getSpendingByCategory,
  getOwnAccountMasks,
} from '../db/repository.js';
import { todayStr } from '../util/date.js';
import { categorizeTxn } from '../spending/categorize.js';

const router = Router();

const REFRESH_INTERVAL_MS = 12 * 60 * 60 * 1000;
const META_REFRESHED_AT = 'transactions_refreshed_at';
const META_WINDOW_START = 'transactions_window_start';

// First day of the month `monthsBack` months before the current month.
function monthStart(monthsBack) {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - monthsBack);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}-01`;
}

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

// Refresh the cache if stale (>12h) or if the requested window starts earlier
// than the last-fetched window. Tolerates per-item failures.
async function refreshCacheIfNeeded(startDate) {
  const refreshedAt = getMeta(META_REFRESHED_AT);
  const windowStart = getMeta(META_WINDOW_START);
  const fresh =
    refreshedAt && Date.now() - new Date(refreshedAt).getTime() < REFRESH_INTERVAL_MS;
  const windowCovered = windowStart && windowStart <= startDate;
  if (fresh && windowCovered) return { refreshed: false };

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
      const txns = await fetchItemTransactions(client, accessToken, startDate, endDate);
      for (const t of txns) {
        if (t.pending) continue; // skip pending; they re-post with a new id
        const account = findAccountByPlaidId(t.account_id);
        if (!account) continue;
        upsertTransaction({
          id: t.transaction_id,
          accountId: account.id,
          date: t.date,
          name: t.name ?? '',
          amountCents: Math.round((t.amount ?? 0) * 100),
          category: categorizeTxn(t, ownMasks),
          pending: false,
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
    const earlier = windowStart && windowStart < startDate ? windowStart : startDate;
    setMeta(META_WINDOW_START, earlier);
  }
  return { refreshed: anySucceeded, errors };
}

// GET /api/spending/summary?months=6
router.get('/spending/summary', async (req, res) => {
  let months = parseInt(req.query.months, 10);
  if (isNaN(months) || months < 1) months = 6;
  if (months > 24) months = 24;

  const startDate = monthStart(months - 1); // window includes the current month

  try {
    await refreshCacheIfNeeded(startDate);
  } catch (err) {
    // Whole-refresh failure: still serve whatever is cached.
    console.warn('[spending] cache refresh failed — serving cached data:', err.message);
  }

  try {
    const rows = getSpendingByMonth(startDate);
    const byMonth = new Map(rows.map((r) => [r.month, r]));

    // Dense month list oldest→newest, zero-filled where no transactions.
    const monthsOut = [];
    for (let i = months - 1; i >= 0; i--) {
      const month = monthStart(i).slice(0, 7);
      const row = byMonth.get(month);
      monthsOut.push({
        month,
        expenses_cents: row?.expenses_cents ?? 0,
        income_cents: row?.income_cents ?? 0,
      });
    }

    const currentMonth = monthsOut[monthsOut.length - 1];
    const byCategory = getSpendingByCategory(currentMonth.month);

    res.json({
      months: monthsOut,
      current_month: {
        expenses_cents: currentMonth.expenses_cents,
        income_cents: currentMonth.income_cents,
        by_category: byCategory.map((c) => ({ category: c.category, cents: c.cents })),
      },
    });
  } catch (err) {
    console.error('[spending] summary error:', err.message);
    res.status(500).json({ error: 'Failed to load spending summary' });
  }
});

// GET /api/spending/by-category?month=YYYY-MM
// Category breakdown for any single month already in the cache (no Plaid call —
// the summary endpoint keeps a rolling window cached). Used by the month picker.
router.get('/spending/by-category', (req, res) => {
  const month = String(req.query.month || '');
  if (!/^\d{4}-\d{2}$/.test(month)) {
    return res.status(400).json({ error: 'month must be YYYY-MM' });
  }
  try {
    const byCategory = getSpendingByCategory(month);
    const total = byCategory.reduce((a, c) => a + c.cents, 0);
    res.json({
      month,
      expenses_cents: total,
      by_category: byCategory.map((c) => ({ category: c.category, cents: c.cents })),
    });
  } catch (err) {
    console.error('[spending] by-category error:', err.message);
    res.status(500).json({ error: 'Failed to load category breakdown' });
  }
});

export default router;
