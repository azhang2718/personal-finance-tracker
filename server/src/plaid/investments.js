// Splits investment accounts into asset-class sub-accounts (stocks / crypto /
// cash) using Plaid investments holdings. The ORIGINAL account row is the
// stocks bucket (keeps its name + history); crypto/cash siblings are created
// lazily with plaid_account_id = original + '::crypto' / '::cash'.
// See DECISIONS.md for the classification lumping.
import {
  findAccountByPlaidId,
  createAccount,
  setAccountAssetClass,
  upsertSnapshot,
} from '../db/repository.js';

// Spot/futures crypto ETFs report as type 'etf' through Plaid; classify them
// as crypto by ticker (owner's request — see DECISIONS.md).
const CRYPTO_ETF_TICKERS = new Set([
  'HODL', 'FETH', 'FBTC', 'IBIT', 'ETHA', 'GBTC', 'ETHE', 'ARKB', 'BITB',
  'BTCO', 'EZBC', 'BRRR', 'BTCW', 'ETHW', 'ETHV', 'QETH', 'CETH', 'BITO',
]);

// security.type === 'cryptocurrency' or known crypto-ETF ticker → crypto;
// is_cash_equivalent or type 'cash' → cash; everything else → stocks.
function classifySecurity(security) {
  if (!security) return 'stocks';
  if (security.type === 'cryptocurrency') return 'crypto';
  if (security.ticker_symbol && CRYPTO_ETF_TICKERS.has(security.ticker_symbol.toUpperCase())) return 'crypto';
  if (security.is_cash_equivalent === true || security.type === 'cash') return 'cash';
  return 'stocks';
}

/**
 * For each investment account in `plaidAccounts`, write per-asset-class
 * snapshots for `today`. Call AFTER the plain balance snapshot has been
 * written — if holdings aren't available (product not supported) this is a
 * no-op and the single-snapshot behavior stands.
 *
 * @param {object} client      Plaid client
 * @param {string} accessToken decrypted item access token
 * @param {number} itemId      plaid_items.id
 * @param {Array}  plaidAccounts accounts from accountsGet/accountsBalanceGet
 * @param {string} today       YYYY-MM-DD
 * @returns {Promise<{split: boolean, classes?: object}>}
 */
export async function splitInvestmentSnapshots(client, accessToken, itemId, plaidAccounts, today) {
  const investmentAccounts = plaidAccounts.filter((pa) => {
    const acct = findAccountByPlaidId(pa.account_id);
    return acct && acct.type === 'investment';
  });
  if (investmentAccounts.length === 0) return { split: false };

  let holdings, securities;
  try {
    const res = await client.investmentsHoldingsGet({ access_token: accessToken });
    holdings = res.data.holdings;
    securities = new Map(res.data.securities.map((s) => [s.security_id, s]));
  } catch (err) {
    // Graceful fallback: keep the plain total snapshot already written.
    console.warn(
      `[plaid] holdings unavailable for item ${itemId} — keeping single snapshot:`,
      err.response?.data?.error_code ?? err.message
    );
    return { split: false };
  }

  const classes = {};
  for (const pa of investmentAccounts) {
    const original = findAccountByPlaidId(pa.account_id);

    const sums = { stocks: 0, crypto: 0, cash: 0 };
    let holdingCount = 0;
    for (const h of holdings) {
      if (h.account_id !== pa.account_id) continue;
      holdingCount++;
      const cls = classifySecurity(securities.get(h.security_id));
      sums[cls] += Math.round((h.institution_value ?? 0) * 100);
    }

    // Zero holdings = no information (e.g. Plaid hasn't ingested holdings for
    // this institution yet) — keep the plain total snapshot rather than
    // misclassifying the whole balance. See DECISIONS.md.
    if (holdingCount === 0) {
      console.warn(`[plaid] no holdings reported for ${original.name} — keeping single snapshot`);
      continue;
    }

    // Cash not represented as a holding: if the reported current balance
    // exceeds the holdings total, the remainder is uninvested cash.
    const currentCents = Math.round((pa.balances?.current ?? 0) * 100);
    const holdingsTotal = sums.stocks + sums.crypto + sums.cash;
    if (currentCents > holdingsTotal) sums.cash += currentCents - holdingsTotal;

    // Original row = stocks bucket.
    if (original.asset_class !== 'stocks') setAccountAssetClass(original.id, 'stocks');
    upsertSnapshot(original.id, today, sums.stocks);

    // Sibling buckets, created only once that class has value.
    for (const cls of ['crypto', 'cash']) {
      const siblingPlaidId = `${pa.account_id}::${cls}`;
      let sibling = findAccountByPlaidId(siblingPlaidId);
      if (!sibling && sums[cls] > 0) {
        const suffix = cls === 'crypto' ? ' (Crypto)' : ' (Cash)';
        const id = createAccount({
          name: original.name + suffix,
          source: 'plaid',
          type: 'investment',
          plaidAccountId: siblingPlaidId,
          plaidItemId: itemId,
          assetClass: cls,
        });
        sibling = { id };
      }
      if (sibling) upsertSnapshot(sibling.id, today, sums[cls]);
    }

    classes[original.name] = sums;
  }

  return { split: true, classes };
}
