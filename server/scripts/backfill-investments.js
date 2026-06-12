// One-time historical backfill for investment accounts (approximation).
// Reconstructs total account value backwards from today's snapshot using
// investment transactions: only EXTERNAL cash flows (type 'cash' — deposits,
// withdrawals, transfers in/out) move the line; buys/sells/dividends/fees are
// internal re-shuffles and ignored. Market movement is NOT reconstructable
// from transactions, so this is a contributions-only approximation.
//   value(d) = value(today) − net external inflows after d
// Plaid convention: positive amount = cash LEAVING the account, so an inflow
// after d has a negative amount and value(d) = value(today) + sum(amounts
// after d). Sanity-checked against real data (values must stay plausible);
// pass --flip to invert if the convention proves reversed for an institution.
// Snapshots are written onto the ORIGINAL account rows (the stocks bucket) —
// the historical per-asset-class split is not reconstructable either.
// Usage: node scripts/backfill-investments.js <item_id> [months_back=24] [--flip] [--dry-run]
import 'dotenv/config';
import { getConfig } from '../src/config.js';
import { runMigrations, getDb } from '../src/db/schema.js';
import { getDecryptedToken, getAccountsByItemId, upsertSnapshot } from '../src/db/repository.js';
import { getPlaidClient } from '../src/plaid/client.js';

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const flip = process.argv.includes('--flip');
const dryRun = process.argv.includes('--dry-run');
const itemId = parseInt(args[0], 10);
const monthsBack = parseInt(args[1] || '24', 10);
if (isNaN(itemId)) {
  console.error('Usage: node scripts/backfill-investments.js <item_id> [months_back] [--flip] [--dry-run]');
  process.exit(1);
}

getConfig();
runMigrations();

function dstr(d) {
  return d.toISOString().slice(0, 10);
}

async function fetchAllInvestmentTransactions(client, accessToken, startDate, endDate) {
  const all = [];
  let offset = 0;
  for (let attempt = 0; ; attempt++) {
    try {
      for (;;) {
        const res = await client.investmentsTransactionsGet({
          access_token: accessToken,
          start_date: startDate,
          end_date: endDate,
          options: { count: 500, offset },
        });
        all.push(...res.data.investment_transactions);
        if (all.length >= res.data.total_investment_transactions) return all;
        offset = all.length;
      }
    } catch (err) {
      const code = err.response?.data?.error_code;
      if (code === 'PRODUCT_NOT_READY' && attempt < 12) {
        console.log(`[backfill-inv] investments not ready yet, waiting 10s (attempt ${attempt + 1}/12)...`);
        await new Promise((r) => setTimeout(r, 10000));
        continue;
      }
      throw err;
    }
  }
}

const client = getPlaidClient();
const accessToken = getDecryptedToken(itemId);
// Original investment rows only — siblings (::crypto/::cash) carry no history.
const accounts = getAccountsByItemId(itemId).filter(
  (a) => a.type === 'investment' && !a.plaid_account_id.includes('::')
);
if (accounts.length === 0) {
  console.error('[backfill-inv] no investment accounts on this item');
  process.exit(1);
}

const today = new Date();
const start = new Date(today);
start.setMonth(start.getMonth() - monthsBack);

console.log(`[backfill-inv] item ${itemId}: fetching investment transactions ${dstr(start)} → ${dstr(today)}`);
const txns = await fetchAllInvestmentTransactions(client, accessToken, dstr(start), dstr(today));
console.log(`[backfill-inv] ${txns.length} investment transactions total`);

// External flows only: type 'cash' (deposit/withdrawal/transfer in-out).
const external = txns.filter((t) => t.type === 'cash');
console.log(`[backfill-inv] ${external.length} external cash-flow transactions (type 'cash')`);
const bySubtype = {};
for (const t of external) bySubtype[t.subtype] = (bySubtype[t.subtype] || 0) + 1;
console.log('[backfill-inv] subtypes:', bySubtype);

const db = getDb();
const latestStmt = db.prepare(
  'SELECT balance_cents FROM snapshots WHERE account_id = ? ORDER BY date DESC LIMIT 1'
);

let written = 0;
for (const account of accounts) {
  const latest = latestStmt.get(account.id);
  if (!latest) {
    console.warn(`[backfill-inv] ${account.name}: no current snapshot, skipping (refresh first)`);
    continue;
  }
  // Today's snapshot may be just the stocks bucket; reconstruct from the
  // TOTAL (stocks + sibling buckets today) so history reflects whole-account value.
  const sibTotal = db.prepare(`
    SELECT COALESCE(SUM(s.balance_cents), 0) AS c FROM accounts a
    JOIN snapshots s ON s.id = (
      SELECT id FROM snapshots WHERE account_id = a.id ORDER BY date DESC LIMIT 1
    )
    WHERE a.plaid_account_id LIKE ? AND a.id != ?
  `).get(`${account.plaid_account_id}::%`, account.id).c;
  const totalToday = latest.balance_cents + sibTotal;

  const mine = external
    .filter((t) => t.account_id === account.plaid_account_id)
    .sort((a, b) => (a.date < b.date ? 1 : -1)); // newest first
  if (mine.length === 0) {
    console.log(`[backfill-inv] ${account.name}: no external flows, skipping`);
    continue;
  }

  const earliest = mine[mine.length - 1].date;
  let running = totalToday;
  let i = 0;
  let minSeen = running;
  const cursor = new Date(today);
  cursor.setDate(cursor.getDate() - 1); // start at yesterday; today stays as-is

  const rows = [];
  while (dstr(cursor) >= earliest) {
    const d = dstr(cursor);
    // Walking backwards: undo flows dated after d. Positive amount = cash
    // leaving the account, so add it back (same formula as the cash script).
    while (i < mine.length && mine[i].date > d) {
      const cents = Math.round(mine[i].amount * 100);
      running += flip ? -cents : cents;
      i++;
    }
    rows.push([d, running]);
    if (running < minSeen) minSeen = running;
    cursor.setDate(cursor.getDate() - 1);
  }

  console.log(
    `[backfill-inv] ${account.name}: today=${(totalToday / 100).toFixed(2)} ` +
    `earliest(${earliest})=${(rows[rows.length - 1]?.[1] / 100).toFixed(2)} min=${(minSeen / 100).toFixed(2)}`
  );
  if (minSeen < 0) {
    console.warn(
      `[backfill-inv] ${account.name}: reconstructed value goes NEGATIVE — sign convention likely inverted. ` +
      `Not writing. Re-run with --flip after reviewing.`
    );
    continue;
  }
  if (dryRun) {
    console.log(`[backfill-inv] dry-run: would write ${rows.length} snapshots for ${account.name}`);
    continue;
  }
  const insertMany = db.transaction(() => {
    for (const [d, cents] of rows) {
      upsertSnapshot(account.id, d, cents);
      written++;
    }
  });
  insertMany();
  console.log(`[backfill-inv] ${account.name}: ${earliest} → yesterday backfilled (${rows.length} days)`);
}

console.log(`[backfill-inv] done — ${written} snapshots written${dryRun ? ' (dry run)' : ''}`);
