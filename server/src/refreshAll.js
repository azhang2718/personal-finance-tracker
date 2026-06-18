import { getPlaidClient } from './plaid/client.js';
import {
  getAllItems,
  getDecryptedToken,
  findAccountByPlaidId,
  createAccount,
  upsertSnapshot,
  markItemNeedsReauth,
  getOrCreateCollectiblesAccount,
  setAccountMask,
  recategorizeAllTransactions,
  logRefresh,
} from './db/repository.js';
import { scrapeCollectr } from './collectr/scrape.js';
import { splitInvestmentSnapshots } from './plaid/investments.js';
import { todayStr } from './util/date.js';

function mapPlaidType(plaidType, plaidSubtype) {
  const t = (plaidType || '').toLowerCase();
  const st = (plaidSubtype || '').toLowerCase();
  if (t === 'credit') return 'credit';
  if (t === 'investment' || t === 'brokerage') return 'investment';
  if (t === 'depository') return 'cash';
  if (st.includes('credit')) return 'credit';
  if (st.includes('invest') || st.includes('brokerage') || st.includes('401') || st.includes('ira')) return 'investment';
  return 'cash';
}

/**
 * Refresh all Plaid items independently.
 * Returns array of { source: 'plaid', item_id, institution, status, message, lastUpdated }
 */
async function refreshPlaid() {
  const items = getAllItems();
  if (items.length === 0) {
    return [{ source: 'plaid', status: 'ok', message: 'No Plaid items connected', lastUpdated: new Date().toISOString() }];
  }

  const results = [];
  for (const item of items) {
    try {
      const accessToken = getDecryptedToken(item.id);
      const client = getPlaidClient();
      const balanceRes = await client.accountsBalanceGet({ access_token: accessToken });
      const plaidAccounts = balanceRes.data.accounts;

      const today = todayStr();
      for (const pa of plaidAccounts) {
        let account = findAccountByPlaidId(pa.account_id);
        if (!account) {
          const type = mapPlaidType(pa.type, pa.subtype);
          const id = createAccount({
            name: pa.name,
            source: 'plaid',
            type,
            plaidAccountId: pa.account_id,
            plaidItemId: item.id,
            mask: pa.mask,
          });
          account = { id, type };
        } else {
          // Backfill/refresh the mask on existing accounts (needed to classify
          // internal vs external transfers).
          setAccountMask(account.id, pa.mask);
        }
        const raw = pa.balances?.current ?? 0;
        const balanceCents = Math.round((account.type === 'credit' ? -Math.abs(raw) : raw) * 100);
        upsertSnapshot(account.id, today, balanceCents);
      }

      // Investment accounts: split into stocks/crypto/cash sub-accounts via
      // holdings (falls back to the total snapshot just written).
      await splitInvestmentSnapshots(client, accessToken, item.id, plaidAccounts, today);

      results.push({
        source: 'plaid',
        item_id: item.id,
        institution: item.institution_name,
        status: 'ok',
        lastUpdated: new Date().toISOString(),
      });
    } catch (err) {
      const errorCode = err.response?.data?.error_code;
      if (errorCode === 'ITEM_LOGIN_REQUIRED') {
        markItemNeedsReauth(item.id);
        results.push({
          source: 'plaid',
          item_id: item.id,
          institution: item.institution_name,
          status: 'needs_reauth',
          message: `${item.institution_name} needs to be reconnected.`,
          lastUpdated: null,
        });
      } else {
        console.error(`[refreshAll] Plaid error for item ${item.id}:`, err.response?.data?.error_message ?? err.message);
        results.push({
          source: 'plaid',
          item_id: item.id,
          institution: item.institution_name,
          status: 'error',
          message: 'Balance refresh failed — try again later.',
          lastUpdated: null,
        });
      }
    }
  }
  return results;
}

/**
 * Refresh Collectr independently.
 * Returns { source: 'collectr', status, message, lastUpdated }
 */
async function refreshCollectr() {
  try {
    const result = await scrapeCollectr();
    const today = todayStr();

    if (result.value_cents !== null) {
      const account = getOrCreateCollectiblesAccount('collectr');
      upsertSnapshot(account.id, today, result.value_cents);
    }

    return {
      source: 'collectr',
      status: result.status,
      message: result.message ?? null,
      lastUpdated: result.lastUpdated,
    };
  } catch (err) {
    console.error('[refreshAll] Collectr error:', err.message);
    return {
      source: 'collectr',
      status: 'error',
      message: `Collectr refresh failed: ${err.message}`,
      lastUpdated: null,
    };
  }
}

/**
 * Run all refreshes independently — one source failing never blocks others.
 * Returns { results: [...], summary: { ok, errors } }
 */
export async function refreshAll() {
  const [plaidResults, collectrResult] = await Promise.allSettled([refreshPlaid(), refreshCollectr()]);

  const results = [];

  if (plaidResults.status === 'fulfilled') {
    results.push(...plaidResults.value);
  } else {
    results.push({ source: 'plaid', status: 'error', message: plaidResults.reason?.message, lastUpdated: null });
  }

  if (collectrResult.status === 'fulfilled') {
    results.push(collectrResult.value);
  } else {
    results.push({ source: 'collectr', status: 'error', message: collectrResult.reason?.message, lastUpdated: null });
  }

  // Account masks may have just been (back)filled above; re-run categorization
  // so cached transfers get re-judged as internal (excluded) vs external income.
  try {
    recategorizeAllTransactions();
  } catch (err) {
    console.warn('[refreshAll] re-categorization skipped:', err.message);
  }

  const hasError = results.some((r) => r.status === 'error' || r.status === 'needs_reauth');
  logRefresh(hasError ? 'partial' : 'ok', JSON.stringify(results.map((r) => ({ source: r.source, status: r.status }))));

  return {
    results,
    summary: {
      ok: results.filter((r) => r.status === 'ok').length,
      errors: results.filter((r) => r.status !== 'ok').length,
    },
  };
}
