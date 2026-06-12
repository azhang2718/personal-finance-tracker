import { Router } from 'express';
import { getConfig } from '../config.js';

const router = Router();

router.get('/health', (_req, res) => {
  const config = getConfig();
  res.json({ ok: true, env: config.PLAID_ENV });
});

export default router;
