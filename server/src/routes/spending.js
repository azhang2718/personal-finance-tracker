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
import {
  getSpendingByMonth,
  getSpendingByCategory,
  getTransactionsForMonth,
  setTransactionCategory,
  setTransactionExcluded,
} from '../db/repository.js';
import { monthStart, refreshTransactionsCache } from '../spending/refreshTransactions.js';

const router = Router();

// GET /api/spending/summary?months=6
router.get('/spending/summary', async (req, res) => {
  let months = parseInt(req.query.months, 10);
  if (isNaN(months) || months < 1) months = 6;
  if (months > 24) months = 24;

  const startDate = monthStart(months - 1); // window includes the current month

  try {
    await refreshTransactionsCache({ startDate });
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

// GET /api/spending/transactions?month=YYYY-MM
// Full list of a month's transactions (incl. soft-deleted ones) for the editable
// table. Served straight from cache — no Plaid call.
router.get('/spending/transactions', (req, res) => {
  const month = String(req.query.month || '');
  if (!/^\d{4}-\d{2}$/.test(month)) {
    return res.status(400).json({ error: 'month must be YYYY-MM' });
  }
  try {
    const rows = getTransactionsForMonth(month);
    res.json({
      month,
      transactions: rows.map((r) => ({
        id: r.id,
        date: r.date,
        name: r.name,
        amount_cents: r.amount_cents,
        category: r.category,
        is_custom_category: r.user_category != null && r.user_category !== '',
        excluded: r.excluded === 1,
        pending: r.pending === 1,
        account: r.account,
        account_type: r.account_type,
      })),
    });
  } catch (err) {
    console.error('[spending] transactions error:', err.message);
    res.status(500).json({ error: 'Failed to load transactions' });
  }
});

// PUT /api/spending/transactions/:id/category  { category }
// Manually recategorize a transaction (empty/null category reverts to auto).
router.put('/spending/transactions/:id/category', (req, res) => {
  const id = String(req.params.id || '');
  const category = req.body && typeof req.body.category === 'string' ? req.body.category : '';
  try {
    const ok = setTransactionCategory(id, category);
    if (!ok) return res.status(404).json({ error: 'Transaction not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[spending] recategorize error:', err.message);
    res.status(500).json({ error: 'Failed to update category' });
  }
});

// DELETE /api/spending/transactions/:id        → soft-delete (hide from totals)
// POST   /api/spending/transactions/:id/restore → undo the delete
router.delete('/spending/transactions/:id', (req, res) => {
  try {
    const ok = setTransactionExcluded(String(req.params.id || ''), true);
    if (!ok) return res.status(404).json({ error: 'Transaction not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[spending] delete error:', err.message);
    res.status(500).json({ error: 'Failed to delete transaction' });
  }
});

router.post('/spending/transactions/:id/restore', (req, res) => {
  try {
    const ok = setTransactionExcluded(String(req.params.id || ''), false);
    if (!ok) return res.status(404).json({ error: 'Transaction not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[spending] restore error:', err.message);
    res.status(500).json({ error: 'Failed to restore transaction' });
  }
});

export default router;
