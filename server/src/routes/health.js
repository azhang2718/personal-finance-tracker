import { Router } from 'express';
import { getConfig } from '../config.js';
import { getCollectrUrl } from '../collectr/scrape.js';

const router = Router();

router.get('/health', (_req, res) => {
  const config = getConfig();
  // collectr_share_url is the user's own public share link (not a secret);
  // exposed so the dashboard settings panel can display/edit it. Uses the
  // effective value (in-app override, or env fallback).
  res.json({ ok: true, env: config.PLAID_ENV, collectr_share_url: getCollectrUrl() });
});

export default router;
