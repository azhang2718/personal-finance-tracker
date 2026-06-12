import { Router } from 'express';
import {
  getNetWorthSeries,
  getLatestByAccount,
  getAllSnapshots,
  getLastRefresh,
} from '../db/repository.js';
import { refreshAll } from '../refreshAll.js';
import { getAllItems } from '../db/repository.js';

const router = Router();

function getRangeSinceDate(range) {
  const now = new Date();
  switch (range) {
    case '1m': {
      const d = new Date(now);
      d.setMonth(d.getMonth() - 1);
      return d.toISOString().slice(0, 10);
    }
    case '3m': {
      const d = new Date(now);
      d.setMonth(d.getMonth() - 3);
      return d.toISOString().slice(0, 10);
    }
    case '1y': {
      const d = new Date(now);
      d.setFullYear(d.getFullYear() - 1);
      return d.toISOString().slice(0, 10);
    }
    case 'all':
    default:
      return '1970-01-01';
  }
}

// GET /api/networth/series?range=1m|3m|1y|all
router.get('/networth/series', (req, res) => {
  const range = req.query.range || 'all';
  const since = getRangeSinceDate(range);
  try {
    const series = getNetWorthSeries(since);
    res.json({ range, since, series });
  } catch (err) {
    console.error('[networth] series error:', err.message);
    res.status(500).json({ error: 'Failed to load series data' });
  }
});

// GET /api/networth/current
router.get('/networth/current', (req, res) => {
  try {
    const accounts = getLatestByAccount();

    let totalCents = 0;
    const allocation = { cash: 0, credit: 0, investment: 0, collectibles: 0 };

    for (const a of accounts) {
      const bal = a.balance_cents ?? 0;
      totalCents += bal;
      if (a.type in allocation) {
        allocation[a.type] += bal;
      }
    }

    // 7-day delta: compare to net worth from 7 days ago
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const since7d = sevenDaysAgo.toISOString().slice(0, 10);
    const series7d = getNetWorthSeries(since7d);

    let deltaCents = 0;
    if (series7d.length >= 2) {
      const oldest = series7d[0].total_cents;
      deltaCents = totalCents - oldest;
    }

    const lastRefresh = getLastRefresh();

    res.json({
      total_cents: totalCents,
      total_dollars: (totalCents / 100).toFixed(2),
      delta_7d_cents: deltaCents,
      delta_7d_dollars: (deltaCents / 100).toFixed(2),
      delta_7d_pct: totalCents !== 0 ? ((deltaCents / (totalCents - deltaCents)) * 100).toFixed(2) : '0.00',
      allocation: {
        cash_cents: allocation.cash,
        credit_cents: allocation.credit,
        investment_cents: allocation.investment,
        collectibles_cents: allocation.collectibles,
      },
      last_refresh: lastRefresh?.ran_at ?? null,
    });
  } catch (err) {
    console.error('[networth] current error:', err.message);
    res.status(500).json({ error: 'Failed to load current net worth' });
  }
});

// GET /api/accounts
router.get('/accounts', (req, res) => {
  try {
    const accounts = getLatestByAccount();
    const items = getAllItems();
    const itemMap = new Map(items.map((i) => [i.id, i]));

    const out = accounts.map((a) => {
      const item = a.plaid_item_id ? itemMap.get(a.plaid_item_id) : null;
      return {
        id: a.account_id,
        name: a.name,
        source: a.source,
        type: a.type,
        balance_cents: a.balance_cents ?? null,
        balance_dollars: a.balance_cents != null ? (a.balance_cents / 100).toFixed(2) : null,
        last_updated: a.date ?? null,
        needs_reauth: a.needs_reauth === 1,
        institution: item?.institution_name ?? null,
        item_id: a.plaid_item_id ?? null,
      };
    });

    res.json({ accounts: out });
  } catch (err) {
    console.error('[accounts] error:', err.message);
    res.status(500).json({ error: 'Failed to load accounts' });
  }
});

// GET /api/export.csv
router.get('/export.csv', (req, res) => {
  try {
    const snapshots = getAllSnapshots();

    const lines = ['date,account,type,source,balance_cents,balance_dollars'];
    for (const s of snapshots) {
      const dollars = (s.balance_cents / 100).toFixed(2);
      lines.push(`${s.date},${JSON.stringify(s.account)},${s.type},${s.source},${s.balance_cents},${dollars}`);
    }

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="networth-export.csv"');
    res.send(lines.join('\n'));
  } catch (err) {
    console.error('[export] error:', err.message);
    res.status(500).json({ error: 'Failed to export data' });
  }
});

// POST /api/refresh
router.post('/refresh', async (req, res) => {
  try {
    const lastRefresh = getLastRefresh();
    const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;

    // Check if auto-refresh (from dashboard load) — only run if > 24h since last run
    const isAuto = req.query.auto === 'true';
    if (isAuto && lastRefresh) {
      const lastRanAt = new Date(lastRefresh.ran_at).getTime();
      if (Date.now() - lastRanAt < TWENTY_FOUR_HOURS) {
        return res.json({
          skipped: true,
          reason: 'Last refresh was less than 24 hours ago',
          last_refresh: lastRefresh.ran_at,
        });
      }
    }

    const result = await refreshAll();
    res.json(result);
  } catch (err) {
    console.error('[refresh] error:', err.message);
    res.status(500).json({ error: 'Refresh failed' });
  }
});

export default router;
