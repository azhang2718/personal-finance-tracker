import { z } from 'zod';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

// Plaid and the encryption key are only needed to connect bank accounts. They
// are optional so the server can run in collectibles-only mode (scraping a
// Collectr share link) without any Plaid setup. When present, they're still
// validated. Bank-connect routes surface a clear error if Plaid is unconfigured.
const envSchema = z.object({
  PLAID_CLIENT_ID: z.string().min(1).optional(),
  PLAID_SECRET: z.string().min(1).optional(),
  PLAID_ENV: z
    .enum(['sandbox', 'development', 'production'], {
      errorMap: () => ({ message: 'PLAID_ENV must be sandbox, development, or production' }),
    })
    .optional()
    .default('sandbox'),
  ENCRYPTION_KEY: z
    .string()
    .optional()
    .refine((v) => {
      if (v === undefined || v === '') return true;
      try {
        return Buffer.from(v, 'base64').length === 32;
      } catch {
        return false;
      }
    }, 'ENCRYPTION_KEY must be a base64-encoded 32-byte key'),
  COLLECTR_SHARE_URL: z
    .string()
    .url('COLLECTR_SHARE_URL must be a valid URL')
    .optional(),
  PORT: z
    .string()
    .optional()
    .default('8123')
    .transform((v) => parseInt(v, 10)),
  HOST: z.string().optional().default('127.0.0.1'),
  DB_PATH: z.string().optional(),
});

let _config = null;

export function loadConfig() {
  if (_config) return _config;

  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    const missing = result.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    console.error(`[config] Server startup failed — missing or invalid environment variables:\n${missing}`);
    console.error('[config] Copy server/.env.example to server/.env and fill in the values.');
    process.exit(1);
  }

  _config = result.data;

  if (!isPlaidConfigured(_config)) {
    console.warn(
      '[config] Plaid is not configured — bank connections are disabled. ' +
        'Set PLAID_CLIENT_ID, PLAID_SECRET and ENCRYPTION_KEY in server/.env to enable them.'
    );
  }
  if (!_config.COLLECTR_SHARE_URL) {
    console.warn('[config] COLLECTR_SHARE_URL is not set — collectibles scraping is disabled.');
  }

  return _config;
}

export function getConfig() {
  if (!_config) return loadConfig();
  return _config;
}

/** True when Plaid credentials + an encryption key are all present. */
export function isPlaidConfigured(config = getConfig()) {
  return Boolean(config.PLAID_CLIENT_ID && config.PLAID_SECRET && config.ENCRYPTION_KEY);
}
