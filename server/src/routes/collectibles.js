import { Router } from 'express';
import { getOrCreateCollectiblesAccount, upsertSnapshot } from '../db/repository.js';

const router = Router();

/**
 * PUT /api/collectibles/manual
 * Body: { balance_cents: number } or { balance_dollars: number }
 * Manual entry for collectibles balance — permanent fallback if scraping fails.
 */
router.put('/collectibles/manual', (req, res) => {
  const { balance_cents, balance_dollars } = req.body ?? {};

  let cents;
  if (typeof balance_cents === 'number') {
    cents = Math.round(balance_cents);
  } else if (typeof balance_dollars === 'number') {
    cents = Math.round(balance_dollars * 100);
  } else {
    return res.status(400).json({ error: 'Provide balance_cents or balance_dollars' });
  }

  if (cents < 0) {
    return res.status(400).json({ error: 'Collectibles balance cannot be negative' });
  }

  const account = getOrCreateCollectiblesAccount('manual');
  const today = new Date().toISOString().slice(0, 10);
  upsertSnapshot(account.id, today, cents);

  res.json({ ok: true, account_id: account.id, date: today, balance_cents: cents });
});

export default router;
