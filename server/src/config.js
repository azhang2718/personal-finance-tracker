import { z } from 'zod';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const envSchema = z.object({
  PLAID_CLIENT_ID: z.string().min(1, 'PLAID_CLIENT_ID is required'),
  PLAID_SECRET: z.string().min(1, 'PLAID_SECRET is required'),
  PLAID_ENV: z.enum(['sandbox', 'development', 'production'], {
    errorMap: () => ({ message: 'PLAID_ENV must be sandbox, development, or production' }),
  }),
  ENCRYPTION_KEY: z
    .string()
    .min(1, 'ENCRYPTION_KEY is required')
    .refine((v) => {
      try {
        return Buffer.from(v, 'base64').length === 32;
      } catch {
        return false;
      }
    }, 'ENCRYPTION_KEY must be a base64-encoded 32-byte key'),
  COLLECTR_SHARE_URL: z.string().url('COLLECTR_SHARE_URL must be a valid URL'),
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
  return _config;
}

export function getConfig() {
  if (!_config) return loadConfig();
  return _config;
}
