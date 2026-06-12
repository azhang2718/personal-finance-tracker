import { Router } from 'express';
import { getLastLinkToken } from './plaid.js';

const router = Router();

// GET /api/plaid/oauth/link-token — the in-memory token Link was opened with,
// so the resume page can re-initialize Link after the bank redirects back.
router.get('/api/plaid/oauth/link-token', (_req, res) => {
  const token = getLastLinkToken();
  if (!token) {
    res.status(404).json({ error: 'No Link session in progress. Start "Connect bank" from the app first.' });
    return;
  }
  res.json({ link_token: token });
});

// GET /plaid-oauth-return — OAuth redirect target registered in the Plaid
// dashboard. Re-initializes Link with receivedRedirectUri to finish the flow,
// then exchanges the public token server-side.
router.get('/plaid-oauth-return', (_req, res) => {
  res
    .type('html')
    .send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Net Worth Tracker — finishing bank connection</title>
<style>
  body { font-family: system-ui, sans-serif; background: #FAF9F6; color: #1A1A1A;
         display: grid; place-items: center; min-height: 100vh; margin: 0; }
  main { text-align: center; max-width: 28rem; padding: 24px; }
  .soft { color: #6B6B66; font-size: 0.9rem; }
  .err { color: #B05A52; }
</style>
</head>
<body>
<main>
  <h1 id="status">Finishing your bank connection…</h1>
  <p id="detail" class="soft">Do not close this window yet.</p>
</main>
<script src="https://cdn.plaid.com/link/v2/stable/link-initialize.js"></script>
<script>
(async () => {
  const status = document.getElementById('status');
  const detail = document.getElementById('detail');
  const fail = (msg) => { status.textContent = 'Connection not completed'; status.className = 'err'; detail.textContent = msg; };
  try {
    const r = await fetch('/api/plaid/oauth/link-token');
    if (!r.ok) { fail((await r.json()).error || 'No Link session found.'); return; }
    const { link_token } = await r.json();
    const handler = Plaid.create({
      token: link_token,
      receivedRedirectUri: window.location.href,
      onSuccess: async (public_token, metadata) => {
        const name = (metadata && metadata.institution && metadata.institution.name) || 'Bank';
        const ex = await fetch('/api/plaid/exchange', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ public_token, institution_name: name }),
        });
        if (ex.ok) {
          status.textContent = name + ' connected';
          detail.textContent = 'You can close this window and return to the app. Click Refresh there to pull balances.';
        } else {
          fail('The bank authorized, but saving the connection failed. Try again from the app.');
        }
      },
      onExit: (err) => {
        fail(err ? 'The bank connection was not completed. Start again from the app.' : 'Connection cancelled. You can close this window.');
      },
    });
    handler.open();
  } catch (e) {
    fail('Could not resume the connection. Start again from the app.');
  }
})();
</script>
</body>
</html>`);
});

export default router;
