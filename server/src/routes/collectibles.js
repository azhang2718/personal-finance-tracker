import { Router } from 'express';
import { getOrCreateCollectiblesAccount, upsertSnapshot } from '../db/repository.js';
import { getCollectrUrl, setCollectrUrl, scrapeCollectr } from '../collectr/scrape.js';
import { todayStr } from '../util/date.js';

const router = Router();


/**
 * PUT /api/collectibles/source
 * Body: { url: string }  (empty string clears it)
 * Persists the Collectr share link and immediately re-scrapes it.
 */
router.put('/collectibles/source', async (req, res) => {
  const { url } = req.body ?? {};

  if (url !== '' && url != null) {
    try {
      // eslint-disable-next-line no-new
      new URL(url);
    } catch {
      return res.status(400).json({ error: 'Provide a valid URL' });
    }
  }

  setCollectrUrl(url ?? '');

  // Re-scrape right away so the new value lands without waiting for a refresh.
  let scrape = null;
  if (url) {
    scrape = await scrapeCollectr({ force: true });
    if (scrape.value_cents !== null) {
      const account = getOrCreateCollectiblesAccount('collectr');
      const today = todayStr();
      upsertSnapshot(account.id, today, scrape.value_cents);
    }
  }

  res.json({
    ok: true,
    url: getCollectrUrl(),
    value_cents: scrape ? scrape.value_cents : null,
    status: scrape ? scrape.status : 'ok',
    message: scrape ? scrape.message ?? null : null,
  });
});

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
  const today = todayStr();
  upsertSnapshot(account.id, today, cents);

  res.json({ ok: true, account_id: account.id, date: today, balance_cents: cents });
});

export default router;
