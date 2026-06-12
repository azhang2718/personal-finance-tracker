import { loadConfig } from './src/config.js';
import { createApp } from './src/app.js';
import { runMigrations } from './src/db/schema.js';

// Load & validate config first — exits with clear message on failure
const config = loadConfig();

// Run DB migrations idempotently
runMigrations();

const app = createApp();

const server = app.listen(config.PORT, '127.0.0.1', () => {
  console.log(`[server] Listening on http://127.0.0.1:${config.PORT} (loopback only)`);
  console.log(`[server] Plaid environment: ${config.PLAID_ENV}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('[server] SIGTERM received, shutting down...');
  server.close(() => process.exit(0));
});
process.on('SIGINT', () => {
  console.log('[server] SIGINT received, shutting down...');
  server.close(() => process.exit(0));
});
