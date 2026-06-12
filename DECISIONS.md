# Decisions

## Investment asset-class split (2026-06-12)

- **Classification lumping.** Plaid security types map to three buckets:
  `cryptocurrency` → **crypto**; `is_cash_equivalent === true` or type `cash`
  → **cash**; everything else (equity, etf, mutual fund, fixed income,
  derivative) → **stocks**. Finer granularity (bonds vs equities) isn't worth
  separate buckets at this portfolio size.
- **Original row = stocks bucket.** The pre-existing investment account row
  keeps its id, name, and snapshot history and simply becomes the `stocks`
  bucket (`asset_class='stocks'`). Crypto/cash become sibling accounts with
  synthetic `plaid_account_id`s (`<original>::crypto` / `<original>::cash`),
  created lazily only when holdings of that class exist.
- **Uncaptured cash.** If `accounts/balance/get` current balance exceeds the
  sum of holdings' `institution_value`, the difference is treated as
  uninvested cash and added to the cash bucket — Fidelity reports the core
  position inconsistently as a holding.
- **Crypto ETFs are stocks.** The actual Fidelity crypto exposure (HODL,
  FETH, spot-ETH ETF) is typed `etf` by Plaid, so it lands in **stocks** per
  the rule above — only directly-held coins (type `cryptocurrency`) would
  show as crypto. Accepted: Plaid doesn't expose look-through classification.
- **Empty holdings = no split.** A freshly linked item can return zero
  holdings with no error (Fidelity took an on-demand `investmentsRefresh` +
  ~10 min before data appeared). With zero holdings for an account we keep
  the plain total snapshot instead of misclassifying the whole balance.
- **Fallback.** If `investmentsHoldingsGet` fails (e.g. product unsupported),
  the old single total snapshot on the original row stands; NULL
  `asset_class` investment balances count as stocks in the allocation API.
- **Donut/legend.** Slices: Stocks (accent), Crypto (ink at 45% —
  `rgba(26,26,26,0.45)`, a distinguishable neutral between Collectibles' 70%
  ink and Fidelity cash's 25% ink), Collectibles, Cash (bank), Fidelity cash
  (only if nonzero). Bank cash and Fidelity cash are NOT merged in the donut;
  max-series rule flexed to 5. Credit remains the offset line, not a slice.
  Mini window folds investment cash into its "Cash − Credit" row and shows
  Stocks / Crypto / Collectibles.

## Fidelity historical backfill (2026-06-12)

- **Approximation, market-blind.** History is reconstructed backwards from
  today's total using only external cash flows (investment transactions of
  type `cash`: deposits/withdrawals/transfers). Buys, sells, dividends, and
  fees are internal and ignored. Market movement is invisible — the line only
  moves on contributions/withdrawals. Good enough for a net-worth trend.
- **Sign convention.** Plaid documents positive amount = cash leaving the
  account; verified empirically (reconstructed values stay positive and
  plausible). The script refuses to write if values go negative and offers
  `--flip`.
- **No historical class split.** Per-asset-class history is not
  reconstructable from transactions, so backfilled snapshots land on the
  ORIGINAL account rows (ids 18, 19 — now the stocks buckets). Pre-split
  history therefore reads as "stocks", which slightly overstates stocks vs
  crypto/cash before 2026-06-12.

## Spending summary endpoint (2026-06-12)

- **Transfer exclusion is category-based only.** Expenses/income exclude
  transactions whose primary personal-finance category is `TRANSFER_IN` or
  `TRANSFER_OUT`. Credit-card payments from own checking (`LOAN_PAYMENTS`)
  are NOT excluded — Plaid can't reliably distinguish paying our own card
  from paying someone else's loan, and the card charge itself is the expense
  we count, so a payment shows as money out of checking but the category
  filter on the card side keeps double counting limited to the LOAN_PAYMENTS
  rows. Revisit if it skews the numbers.
- **Cache refresh policy.** `transactions_cache` refreshes from
  `transactionsGet` at most once per 12 h (meta keys
  `transactions_refreshed_at` / `transactions_window_start`); a request for
  an earlier window than previously fetched forces a refresh. Pending
  transactions are skipped (they re-post with a new id). Per-item fetch
  failures are logged and skipped; cached rows keep serving.
- **Income definition.** Negative amounts (money in) on depository accounts
  only — credit-card refunds are not income.

## Glass UI redesign (2026-06-12)

- **Layout.** Left glass sidebar (~220px, sticky) with four client-side tabs
  (Summary default / Net worth / Spending / Settings); show/hide sections,
  no routing. Empty state replaces the content area; the sidebar stays.
- **Series chart deferral.** The full time-series chart lives in the hidden
  Net worth tab; Chart.js in a zero-size canvas breaks, so its first render
  (and the one orchestrated draw-in) is deferred until the tab is first
  shown. Other charts get a `resize()` nudge on tab switch.
- **Both heroes share data.** `/api/networth/current` fills the Summary
  "Total balance" hero (delta as a glass chip) and the Net worth tab figure
  (delta as a plain line) from one render call.
- **Spending UI.** Bar chart = expenses (accent, rounded tops) + income
  (muted grey bars) per month; categories prettified from Plaid's
  SNAKE_CASE primaries, top 8 + aggregated "Other".
- **Mini window** got only a CSS-level glass treatment (body gradient from
  tokens + the .mini container as one glass card); mini.js untouched.
