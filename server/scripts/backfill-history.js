// One-time historical backfill.
// Reconstructs daily balances for a Plaid item's cash/credit accounts by
// walking transaction history backwards from today's known balance:
//   stored(d) = stored(today) + sum(amount_cents of txns dated after d)
// (Plaid amounts are positive for money leaving a depository account and for
// charges on a credit account; with credit stored negative, the same formula
// holds for both.)
// Investment accounts are skipped — transactions don't capture market value.
// Usage: node scripts/backfill-history.js <item_id> [months_back=24]
import 'dotenv/config';
import { getConfig } from '../src/config.js';
import { runMigrations, getDb } from '../src/db/schema.js';
import { getDecryptedToken, getAccountsByItemId, upsertSnapshot } from '../src/db/repository.js';
import { getPlaidClient } from '../src/plaid/client.js';

const itemId = parseInt(process.argv[2], 10);
const monthsBack = parseInt(process.argv[3] || '24', 10);
if (isNaN(itemId)) {
  console.error('Usage: node scripts/backfill-history.js <item_id> [months_back]');
  process.exit(1);
}

getConfig();
runMigrations();

function dstr(d) {
  return d.toISOString().slice(0, 10);
}

async function fetchAllTransactions(client, accessToken, startDate, endDate) {
  const all = [];
  let offset = 0;
  // PRODUCT_NOT_READY: initial pull may still be running — retry briefly
  for (let attempt = 0; ; attempt++) {
    try {
      for (;;) {
        const res = await client.transactionsGet({
          access_token: accessToken,
          start_date: startDate,
          end_date: endDate,
          options: { count: 500, offset, include_personal_finance_category: false },
        });
        all.push(...res.data.transactions);
        if (all.length >= res.data.total_transactions) return all;
        offset = all.length;
      }
    } catch (err) {
      const code = err.response?.data?.error_code;
      if (code === 'PRODUCT_NOT_READY' && attempt < 12) {
        console.log(`[backfill] transactions not ready yet, waiting 10s (attempt ${attempt + 1}/12)...`);
        await new Promise((r) => setTimeout(r, 10000));
        continue;
      }
      throw err;
    }
  }
}

const client = getPlaidClient();
const accessToken = getDecryptedToken(itemId);
const accounts = getAccountsByItemId(itemId).filter((a) => a.type === 'cash' || a.type === 'credit');
if (accounts.length === 0) {
  console.error('[backfill] no cash/credit accounts on this item');
  process.exit(1);
}

const today = new Date();
const start = new Date(today);
start.setMonth(start.getMonth() - monthsBack);

console.log(`[backfill] item ${itemId}: fetching transactions ${dstr(start)} → ${dstr(today)}`);
const txns = (await fetchAllTransactions(client, accessToken, dstr(start), dstr(today)))
  .filter((t) => !t.pending);
console.log(`[backfill] ${txns.length} settled transactions`);

const db = getDb();
const latestStmt = db.prepare(
  'SELECT balance_cents FROM snapshots WHERE account_id = ? ORDER BY date DESC LIMIT 1'
);

let written = 0;
for (const account of accounts) {
  const latest = latestStmt.get(account.id);
  if (!latest) {
    console.warn(`[backfill] ${account.name}: no current snapshot, skipping (refresh first)`);
    continue;
  }
  const mine = txns
    .filter((t) => t.account_id === account.plaid_account_id)
    .sort((a, b) => (a.date < b.date ? 1 : -1)); // newest first
  if (mine.length === 0) {
    console.log(`[backfill] ${account.name}: no transactions, skipping`);
    continue;
  }

  const earliest = mine[mine.length - 1].date;
  let running = latest.balance_cents;
  let i = 0;
  const cursor = new Date(today);
  cursor.setDate(cursor.getDate() - 1); // start at yesterday; today stays as-is

  const insertMany = db.transaction(() => {
    while (dstr(cursor) >= earliest) {
      const d = dstr(cursor);
      // add back txns dated after d that we haven't applied yet
      while (i < mine.length && mine[i].date > d) {
        running += Math.round(mine[i].amount * 100);
        i++;
      }
      upsertSnapshot(account.id, d, running);
      written++;
      cursor.setDate(cursor.getDate() - 1);
    }
  });
  insertMany();
  console.log(`[backfill] ${account.name}: ${earliest} → yesterday backfilled`);
}

console.log(`[backfill] done — ${written} snapshots written`);
