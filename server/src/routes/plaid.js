import { Router } from 'express';
import { Products, CountryCode } from 'plaid';
import { getPlaidClient } from '../plaid/client.js';
import { getConfig } from '../config.js';
import {
  saveItem,
  getDecryptedToken,
  getAllItems,
  deleteItem,
  markItemNeedsReauth,
  createAccount,
  findAccountByPlaidId,
  getAccountsByItemId,
  upsertSnapshot,
} from '../db/repository.js';
import { splitInvestmentSnapshots } from '../plaid/investments.js';
import { todayStr } from '../util/date.js';

const router = Router();

// Hosted Link: Plaid hosts the entire Link flow (incl. OAuth redirects for
// Chase) on its own HTTPS page, so no local redirect URI is needed —
// production rejects http:// redirect URIs, which rules out the local
// resume-page approach for a loopback desktop app.
let lastLinkToken = null;

// Map Plaid account subtypes/types to our types
function mapPlaidType(plaidType, plaidSubtype) {
  const t = (plaidType || '').toLowerCase();
  const st = (plaidSubtype || '').toLowerCase();

  if (t === 'credit') return 'credit';
  if (t === 'investment' || t === 'brokerage') return 'investment';
  if (t === 'depository') return 'cash';
  // Fallback by subtype
  if (st.includes('credit')) return 'credit';
  if (st.includes('invest') || st.includes('brokerage') || st.includes('401') || st.includes('ira')) return 'investment';
  return 'cash';
}

// POST /api/plaid/link-token
router.post('/link-token', async (_req, res) => {
  try {
    const client = getPlaidClient();
    const response = await client.linkTokenCreate({
      user: { client_user_id: 'local-user' },
      client_name: 'Net Worth Tracker',
      // balance is accessible via accounts/balance/get on any item; transactions
      // covers checking/credit (Chase), investments added when the institution
      // supports it (Fidelity)
      products: [Products.Transactions],
      optional_products: [Products.Investments],
      country_codes: [CountryCode.Us],
      language: 'en',
      hosted_link: { url_lifetime_seconds: 900 },
    });
    // Only return the link token — never return secrets
    lastLinkToken = response.data.link_token;
    res.json({
      link_token: response.data.link_token,
      hosted_link_url: response.data.hosted_link_url,
    });
  } catch (err) {
    console.error('[plaid] link-token error:', err.response?.data?.error_message ?? err.message);
    res.status(500).json({ error: 'Failed to create link token' });
  }
});

// Exchange a public token, persist the encrypted access token, create
// accounts, write today's snapshots. Shared by /exchange and /hosted/status.
async function ingestPublicToken(public_token, institution_name) {
  const client = getPlaidClient();

  // Exchange public token for access token
  const exchangeRes = await client.itemPublicTokenExchange({ public_token });
  const accessToken = exchangeRes.data.access_token;
  // access_token never returned to client

  // Store encrypted
  const itemId = saveItem(institution_name ?? 'Unknown Institution', accessToken);

  // Fetch accounts
  const accountsRes = await client.accountsGet({ access_token: accessToken });
  const plaidAccounts = accountsRes.data.accounts;

  const created = [];
  for (const pa of plaidAccounts) {
    const type = mapPlaidType(pa.type, pa.subtype);
    const existing = findAccountByPlaidId(pa.account_id);
    if (!existing) {
      const id = createAccount({
        name: pa.name,
        source: 'plaid',
        type,
        plaidAccountId: pa.account_id,
        plaidItemId: itemId,
        mask: pa.mask,
      });
      created.push({ id, name: pa.name, type });
    }
  }

  // Write initial snapshots
  const today = todayStr();
  for (const pa of plaidAccounts) {
    const account = findAccountByPlaidId(pa.account_id);
    if (!account) continue;
    const raw = pa.balances?.current ?? 0;
    // Credit balances stored as negative
    const balanceCents = Math.round((account.type === 'credit' ? -Math.abs(raw) : raw) * 100);
    upsertSnapshot(account.id, today, balanceCents);
  }

  // Split investment accounts into stocks/crypto/cash via holdings (no-op if
  // the item doesn't support investments).
  await splitInvestmentSnapshots(client, accessToken, itemId, plaidAccounts, today);

  return { item_id: itemId, accounts_created: created.length };
}

// GET /api/plaid/hosted/status
// Polls the current Hosted Link session. When the user finishes the flow in
// the browser, ingest the resulting public token and report success.
router.get('/hosted/status', async (_req, res) => {
  if (!lastLinkToken) {
    return res.status(404).json({ error: 'No Link session in progress' });
  }
  try {
    const client = getPlaidClient();
    const tokenRes = await client.linkTokenGet({ link_token: lastLinkToken });
    const sessions = tokenRes.data.link_sessions ?? [];

    for (const session of sessions) {
      const addResults = session.results?.item_add_results ?? [];
      for (const result of addResults) {
        if (result.public_token) {
          const institution = result.institution?.name ?? 'Unknown Institution';
          // Consume the session so a later poll can't double-ingest
          lastLinkToken = null;
          const out = await ingestPublicToken(result.public_token, institution);
          return res.json({ status: 'connected', institution, ...out });
        }
      }
      if (session.exit) {
        lastLinkToken = null;
        return res.json({ status: 'exited' });
      }
    }
    res.json({ status: 'pending' });
  } catch (err) {
    console.error('[plaid] hosted-status error:', err.response?.data?.error_message ?? err.message);
    res.status(500).json({ error: 'Failed to check Link session status' });
  }
});

// DELETE /api/plaid/items/:id
router.delete('/items/:id', async (req, res) => {
  const itemId = parseInt(req.params.id, 10);
  if (isNaN(itemId)) return res.status(400).json({ error: 'Invalid item id' });

  try {
    const accessToken = getDecryptedToken(itemId);
    const client = getPlaidClient();

    // Tell Plaid to remove the item
    try {
      await client.itemRemove({ access_token: accessToken });
    } catch (err) {
      // Log but continue — we still delete local data
      console.warn('[plaid] item/remove warning:', err.response?.data?.error_message ?? err.message);
    }

    // Delete item (cascades to accounts + snapshots)
    deleteItem(itemId);
    res.json({ ok: true });
  } catch (err) {
    console.error('[plaid] delete item error:', err.message);
    res.status(500).json({ error: 'Failed to delete item' });
  }
});

// POST /api/plaid/reauth-token/:id — update mode link token
router.post('/reauth-token/:id', async (req, res) => {
  const itemId = parseInt(req.params.id, 10);
  if (isNaN(itemId)) return res.status(400).json({ error: 'Invalid item id' });

  try {
    const accessToken = getDecryptedToken(itemId);
    const client = getPlaidClient();

    const response = await client.linkTokenCreate({
      user: { client_user_id: 'local-user' },
      client_name: 'Net Worth Tracker',
      country_codes: [CountryCode.Us],
      language: 'en',
      access_token: accessToken, // update mode
      hosted_link: { url_lifetime_seconds: 900 },
    });

    lastLinkToken = response.data.link_token;
    res.json({
      link_token: response.data.link_token,
      hosted_link_url: response.data.hosted_link_url,
    });
  } catch (err) {
    console.error('[plaid] reauth-token error:', err.response?.data?.error_message ?? err.message);
    res.status(500).json({ error: 'Failed to create reauth token' });
  }
});

export default router;
