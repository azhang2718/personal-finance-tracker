import express from 'express';
import rateLimit from 'express-rate-limit';
import { getConfig } from './config.js';
import healthRouter from './routes/health.js';
import plaidRouter from './routes/plaid.js';
import collectiblesRouter from './routes/collectibles.js';
import networthRouter from './routes/networth.js';

// Patterns that indicate sensitive data
const SENSITIVE_PATTERNS = [
  /authorization/i,
  /access[_-]?token/i,
  /link[_-]?token/i,
  /public[_-]?token/i,
  /plaid[_-]?secret/i,
  /encryption[_-]?key/i,
  /secret/i,
];

function redactValue(key, value) {
  const isSensitive = SENSITIVE_PATTERNS.some((p) => p.test(key));
  if (!isSensitive) return value;
  if (typeof value !== 'string' || value.length === 0) return '[REDACTED]';
  // Log only first 4 chars for debugging
  return `[REDACTED:${value.slice(0, 4)}...]`;
}

function redactObject(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = redactValue(k, v);
  }
  return out;
}

function loggingMiddleware(req, _res, next) {
  const safeHeaders = redactObject(req.headers);
  const method = req.method;
  const url = req.url;
  // Avoid logging body in case it contains tokens; just log method + url
  console.log(`[http] ${method} ${url} | headers: ${JSON.stringify(safeHeaders)}`);
  next();
}

export function createApp() {
  const config = getConfig();
  const app = express();

  // Body limit
  app.use(express.json({ limit: '100kb' }));

  // Rate limiting
  app.use(
    rateLimit({
      windowMs: 60 * 1000, // 1 minute
      max: 60,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: 'Too many requests, please try again later.' },
    })
  );

  // CORS — Electron renderer origins only:
  //  - no Origin header (non-browser clients, e.g. curl or Electron net)
  //  - Origin "null" (file:// pages — how the renderer windows load)
  //  - app:// custom protocol origins
  //  - the server's own origin (the OAuth resume page it serves itself)
  // Everything else (web origins, extensions) is rejected.
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    const host = req.headers.host;
    const allowed =
      origin === undefined ||
      origin === 'null' ||
      origin.startsWith('file://') ||
      origin.startsWith('app://') ||
      (host !== undefined && origin === `http://${host}`);

    if (!allowed) {
      res.status(403).json({ error: 'Origin not allowed' });
      return;
    }
    if (origin !== undefined) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    }
    if (req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
    next();
  });

  // Logging (after body parse, before routes)
  app.use(loggingMiddleware);

  // Routes
  app.use('/api', healthRouter);
  app.use('/api/plaid', plaidRouter);
  app.use('/api', collectiblesRouter);
  app.use('/api', networthRouter);

  // 404
  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  // Error handler
  app.use((err, _req, res, _next) => {
    console.error('[error]', err.message);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}
