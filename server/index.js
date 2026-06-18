import { loadConfig } from './src/config.js';
import { createApp } from './src/app.js';
import { runMigrations } from './src/db/schema.js';
import { recategorizeAllTransactions } from './src/db/repository.js';

// Load & validate config first — exits with clear message on failure
const config = loadConfig();

// Run DB migrations idempotently
runMigrations();

// Re-apply spending categorization rules to cached transactions so rule changes
// take effect immediately, without waiting for the next Plaid refresh.
try {
  const recategorized = recategorizeAllTransactions();
  if (recategorized > 0) console.log(`[server] Re-categorized ${recategorized} cached transaction(s)`);
} catch (err) {
  console.warn('[server] Re-categorization skipped:', err.message);
}

const app = createApp();

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
if (!LOOPBACK_HOSTS.has(config.HOST)) {
  console.warn('***************************************************************');
  console.warn(`[server] WARNING: binding to non-loopback host "${config.HOST}".`);
  console.warn('[server] This exposes your financial data API to the network');
  console.warn('[server] WITHOUT TLS or authentication. Do not do this unless');
  console.warn('[server] you have added TLS + auth in front of this server.');
  console.warn('***************************************************************');
}

const server = app.listen(config.PORT, config.HOST, () => {
  const note = LOOPBACK_HOSTS.has(config.HOST) ? ' (loopback only)' : ' (NON-LOOPBACK — see warning above)';
  console.log(`[server] Listening on http://${config.HOST}:${config.PORT}${note}`);
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
