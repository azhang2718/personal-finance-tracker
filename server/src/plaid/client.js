import { Configuration, PlaidApi, PlaidEnvironments } from 'plaid';
import { getConfig } from '../config.js';

let _client = null;

export function getPlaidClient() {
  if (_client) return _client;
  const config = getConfig();

  const plaidConfig = new Configuration({
    basePath: PlaidEnvironments[config.PLAID_ENV],
    baseOptions: {
      headers: {
        'PLAID-CLIENT-ID': config.PLAID_CLIENT_ID,
        'PLAID-SECRET': config.PLAID_SECRET,
      },
    },
  });

  _client = new PlaidApi(plaidConfig);
  return _client;
}
