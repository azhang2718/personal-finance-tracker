// Spending categorization.
//
// Plaid's personal_finance_category is trusted when it's specific, but for many
// real merchants it returns OTHER (coffee shops, local restaurants, airlines all
// landed in OTHER in practice). When that happens we fall back to matching the
// merchant name against keyword rules so expenses land in clean, human buckets
// (Food & Drink, Travel, Coffee, …) instead of one giant "Other" pile.
//
// Two categories are *excluded* from spending totals downstream (see
// repository.js): 'Transfer' (money between your own accounts) and
// 'Credit Card Payment' (paying off a card — the underlying charges are already
// counted, so counting the payment too would double-count).

// Plaid PFC primary → clean bucket. OTHER is intentionally absent so it falls
// through to the name rules below.
const PRIMARY_MAP = {
  FOOD_AND_DRINK: 'Food & Drink',
  GENERAL_MERCHANDISE: 'Shopping',
  TRANSPORTATION: 'Transport',
  TRAVEL: 'Travel',
  ENTERTAINMENT: 'Entertainment',
  RENT_AND_UTILITIES: 'Bills & Utilities',
  MEDICAL: 'Health',
  PERSONAL_CARE: 'Personal Care',
  GENERAL_SERVICES: 'Services',
  GOVERNMENT_AND_NON_PROFIT: 'Services',
  BANK_FEES: 'Fees',
  LOAN_PAYMENTS: 'Loan Payments',
  TRANSFER_IN: 'Transfer',
  TRANSFER_OUT: 'Transfer',
  INCOME: 'Income',
};

// Ordered merchant-name rules: first match wins. Order matters — Coffee before
// Food & Drink (a "coffee" shop shouldn't be generic food), Groceries before
// Shopping (a grocery store isn't general shopping).
const NAME_RULES = [
  [/coffee|café|\bcafe\b|espresso|\blatte\b|roaster|starbucks|dunkin|peet'?s/i, 'Coffee'],
  [/grocery|grocer|supermarket|whole foods|trader joe|safeway|kroger|\bh-?e-?b\b|\baldi\b|costco|publix|wegmans|sam'?s club|samsclub/i, 'Groceries'],
  [/\btst\*|restaurant|grill|kitchen|pizza|\btaco|sushi|ramen|\bthai\b|\bbbq\b|burger|eatery|diner|bistro|grubhub|doordash|uber\s?eats|mcdonald|chipotle|panera|chick-?fil|noodle|\bdeli\b|bakery|\bbar\b|cantina/i, 'Food & Drink'],
  [/\bair(line|ways|lines)?\b|qatar|emirates|\bklm\b|lufthansa|\bflight\b|\bhotel\b|airbnb|expedia|booking\.com|marriott|hilton|hyatt|\bdelta\b|united air|southwest air|american air/i, 'Travel'],
  [/\buber\b|\blyft\b|shell|chevron|exxon|\bmobil\b|\bgas\b|fuel|parking|\bmetro\b|capmetro|cap metro|transit|\btoll\b|amtrak|\bbp\b/i, 'Transport'],
  [/amazon|aliexpress|\bebay\b|\betsy\b|target|walmart|best buy|\bikea\b|\bnike\b|uniqlo|\bh&m\b/i, 'Shopping'],
  [/steam|spotify|netflix|\bhulu\b|disney\+|\bxbox\b|playstation|nintendo|cinema|\bamc\b|\bmovie|patreon|twitch/i, 'Entertainment'],
  [/pharmacy|\bcvs\b|walgreens|\bclinic\b|dental|hospital|\bmedical\b|optometr|urgent care|\bgym\b|fitness|climbing|crossfit|\byoga\b|pilates/i, 'Health'],
  [/at&t|verizon|t-?mobile|comcast|xfinity|\belectric\b|water util|\butility\b|spectrum|google fiber/i, 'Bills & Utilities'],
];

// Names that signal a credit-card payment (so we can exclude it from spending).
const CC_PAYMENT_NAME = /credit\s*(crd|card)|card\s*(payment|autopay)|\bcc\s*autopay/i;

// Every resolved label this module can emit. Used to make re-categorization
// idempotent: a row already holding a clean label is left as-is (so we never
// lose a Plaid-derived category on a re-run), except 'Other', which is retried
// against the name rules in case those rules have since improved.
const CLEAN_LABELS = new Set([
  ...Object.values(PRIMARY_MAP),
  ...NAME_RULES.map(([, bucket]) => bucket),
  'Credit Card Payment',
  'Other',
]);

/**
 * Resolve a clean spending bucket from a Plaid primary category, an optional
 * detailed category, and the transaction name. Pure + deterministic so it can
 * also re-categorize already-stored rows (which only carry name + old category).
 *
 * @param {string} primary  Plaid PFC primary (or a previously-stored value)
 * @param {string} detailed Plaid PFC detailed (may be empty for stored rows)
 * @param {string} name     Transaction / merchant name
 * @returns {string} clean category label
 */
export function cleanCategory(primary, detailed, name) {
  const raw = String(primary || '');

  // Idempotent re-runs: an already-resolved clean label stays put (so we don't
  // clobber a Plaid-derived category whose merchant name matches no rule).
  // 'Other' is the exception — retry it, in case the name rules improved.
  if (raw !== 'Other' && CLEAN_LABELS.has(raw)) return raw;

  const p = raw.toUpperCase();
  const n = String(name || '');

  // Credit-card payoffs are a transfer between your own accounts, not spending
  // (the underlying charges are already counted). Detect by name regardless of
  // how Plaid — or a prior categorization pass — labelled the row.
  if (CC_PAYMENT_NAME.test(n) || /CREDIT_CARD/.test(String(detailed || '').toUpperCase())) {
    return 'Credit Card Payment';
  }
  if (p === 'LOAN_PAYMENTS') return 'Loan Payments';

  // Trust Plaid when it gave a specific category.
  if (p && p !== 'OTHER' && PRIMARY_MAP[p]) return PRIMARY_MAP[p];

  // Otherwise lean on the merchant name.
  for (const [re, bucket] of NAME_RULES) {
    if (re.test(n)) return bucket;
  }
  return 'Other';
}

/**
 * Categorize a raw Plaid transaction object.
 * @param {object} txn Plaid transaction
 * @returns {string} clean category label
 */
export function categorizeTxn(txn) {
  const pfc = txn.personal_finance_category || {};
  const name = txn.merchant_name || txn.name || '';
  return cleanCategory(pfc.primary, pfc.detailed, name);
}

// Categories excluded from spending/expense totals (money moving between your
// own accounts, not actual outflow). Shared with repository.js.
export const EXCLUDED_FROM_SPENDING = ['Transfer', 'Credit Card Payment'];
