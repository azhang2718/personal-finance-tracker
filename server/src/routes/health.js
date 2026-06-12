import { Router } from 'express';
import { getConfig } from '../config.js';

const router = Router();

router.get('/health', (_req, res) => {
  const config = getConfig();
  // collectr_share_url is the user's own public share link (not a secret);
  // exposed so the dashboard settings panel can display it read-only.
  res.json({ ok: true, env: config.PLAID_ENV, collectr_share_url: config.COLLECTR_SHARE_URL });
});

export default router;
