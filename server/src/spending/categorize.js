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
// through to the name rules below. Buckets are intentionally coarse: coffee and
// groceries fold into Food & Drink, transport and travel share one bucket, fees
// / loan payments / card payments share Fees & Payments, and medical / personal
// care just land in Other.
const PRIMARY_MAP = {
  FOOD_AND_DRINK: 'Food & Drink',
  GENERAL_MERCHANDISE: 'Shopping',
  TRANSPORTATION: 'Transport & Travel',
  TRAVEL: 'Transport & Travel',
  ENTERTAINMENT: 'Entertainment',
  RENT_AND_UTILITIES: 'Bills & Utilities',
  MEDICAL: 'Other',
  PERSONAL_CARE: 'Other',
  GENERAL_SERVICES: 'Services',
  GOVERNMENT_AND_NON_PROFIT: 'Services',
  BANK_FEES: 'Fees & Payments',
  LOAN_PAYMENTS: 'Fees & Payments',
  TRANSFER_IN: 'Transfer',
  TRANSFER_OUT: 'Transfer',
  INCOME: 'Income',
};

// Retired labels → their current merged bucket. Applied first in cleanCategory
// so transactions stored under an old category get folded in on the next
// re-categorization pass (no Plaid refresh needed).
const MERGED_CATEGORIES = {
  Coffee: 'Food & Drink',
  Groceries: 'Food & Drink',
  Transport: 'Transport & Travel',
  Travel: 'Transport & Travel',
  Health: 'Other',
  'Personal Care': 'Other',
  Fees: 'Fees & Payments',
  'Loan Payments': 'Fees & Payments',
  'Credit Card Payment': 'Fees & Payments',
};

// Ordered merchant-name rules: first match wins.
const NAME_RULES = [
  [/coffee|café|\bcafe\b|espresso|\blatte\b|roaster|starbucks|dunkin|peet'?s/i, 'Food & Drink'],
  [/grocery|grocer|supermarket|whole foods|trader joe|safeway|kroger|\bh-?e-?b\b|\baldi\b|costco|publix|wegmans|sam'?s club|samsclub/i, 'Food & Drink'],
  [/\btst\*|restaurant|grill|kitchen|pizza|\btaco|sushi|ramen|\bthai\b|\bbbq\b|burger|eatery|diner|bistro|grubhub|doordash|uber\s?eats|mcdonald|chipotle|panera|chick-?fil|noodle|\bdeli\b|bakery|\bbar\b|cantina/i, 'Food & Drink'],
  [/\bair(line|ways|lines)?\b|qatar|emirates|\bklm\b|lufthansa|\bflight\b|\bhotel\b|airbnb|expedia|booking\.com|marriott|hilton|hyatt|\bdelta\b|united air|southwest air|american air/i, 'Transport & Travel'],
  [/\buber\b|\blyft\b|shell|chevron|exxon|\bmobil\b|\bgas\b|fuel|parking|\bmetro\b|capmetro|cap metro|transit|\btoll\b|amtrak|\bbp\b/i, 'Transport & Travel'],
  [/amazon|aliexpress|\bebay\b|\betsy\b|target|walmart|best buy|\bikea\b|\bnike\b|uniqlo|\bh&m\b/i, 'Shopping'],
  [/steam|spotify|netflix|\bhulu\b|disney\+|\bxbox\b|playstation|nintendo|cinema|\bamc\b|\bmovie|patreon|twitch/i, 'Entertainment'],
  [/at&t|verizon|t-?mobile|comcast|xfinity|\belectric\b|water util|\butility\b|spectrum|google fiber/i, 'Bills & Utilities'],
];

// Names that signal a credit-card payment — bucketed with fees & loan payments.
const CC_PAYMENT_NAME = /credit\s*(crd|card)|card\s*(payment|autopay)|\bcc\s*autopay/i;

// Names that signal a peer-to-peer money app (Venmo, Zelle, Cash App, PayPal,
// Apple Cash). Unlike a bank transfer between your *own* accounts, these move
// real money to and from other people, so they count as income (when received)
// or expense (when paid) rather than being excluded. See cleanCategory.
const P2P_NAME = /\bvenmo\b|\bzelle\b|cash\s*app|cashapp|paypal|apple\s*cash/i;

// Bank-transfer descriptions embed the *other* account's last digits, e.g.
// "Online Transfer from SAV ...3657" or "...to CHK x9406". Pull those out so we
// can check them against your own accounts' masks. Anchored on the "..."/"x"
// mask prefix so we never grab the trailing "transaction#: 28603246990".
const ACCT_REF = /(?:\.{2,}|\bx)\s*(\d{3,6})/gi;
function accountRefs(name) {
  const out = [];
  let m;
  ACCT_REF.lastIndex = 0;
  while ((m = ACCT_REF.exec(String(name || '')))) out.push(m[1]);
  return out;
}

// True when `ref` plausibly names one of your own accounts. Masks can be stored
// as the last 2–4 digits while the description shows 4, so match on suffix
// either way (a 2-digit mask "57" still matches a "3657" reference).
function refIsOwn(ref, ownMasks) {
  for (const mask of ownMasks) {
    if (!mask) continue;
    if (ref.endsWith(mask) || mask.endsWith(ref)) return true;
  }
  return false;
}

// Every resolved label this module can emit. Used to make re-categorization
// idempotent: a row already holding a clean label is left as-is (so we never
// lose a Plaid-derived category on a re-run), except 'Other', which is retried
// against the name rules in case those rules have since improved.
const CLEAN_LABELS = new Set([
  ...Object.values(PRIMARY_MAP),
  ...NAME_RULES.map(([, bucket]) => bucket),
  'Fees & Payments',
  'P2P',
  'Bank Transfer',
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
 * @param {Set<string>} [ownMasks] Last-digit masks of your own accounts, used to
 *        tell internal transfers (excluded) from external ones (income/expense).
 * @returns {string} clean category label
 */
export function cleanCategory(primary, detailed, name, ownMasks = new Set()) {
  const raw = String(primary || '');
  const n = String(name || '');
  const p = raw.toUpperCase();

  // Fold a retired category into its current merged bucket (handles rows stored
  // under the old taxonomy without needing a Plaid refresh).
  if (MERGED_CATEGORIES[raw]) return MERGED_CATEGORIES[raw];

  // Credit-card payoffs, loans, and bank fees share one bucket. Detect first so
  // a card autopay that Plaid happens to tag as a transfer still lands here
  // rather than being swallowed by the transfer block below.
  if (CC_PAYMENT_NAME.test(n) || /CREDIT_CARD/.test(String(detailed || '').toUpperCase())) {
    return 'Fees & Payments';
  }

  // Transfers need disambiguating before anything else (incl. the idempotent
  // shortcut), so already-stored 'Transfer'/'Bank Transfer' rows get re-judged
  // on the next re-categorization pass once account masks are known.
  const isTransfer =
    p === 'TRANSFER' || p === 'TRANSFER_IN' || p === 'TRANSFER_OUT' || p === 'BANK TRANSFER';
  if (isTransfer) {
    // P2P apps move real money to/from people — count by direction. Checked
    // first so a merchant charge routed through PayPal still resolves below.
    if (P2P_NAME.test(n)) return 'P2P';
    // A transfer that names an account number we don't own (e.g. another bank
    // paying you) is real income/expense; one naming only your own accounts —
    // or naming none at all — is an internal move and stays excluded. Only
    // promote when we actually know our own masks: with none on hand (e.g. before
    // the first balance refresh) we can't verify ownership, so stay conservative
    // and keep it excluded rather than risk counting an internal move as income.
    if (ownMasks.size) {
      const refs = accountRefs(n);
      if (refs.length && refs.some((r) => !refIsOwn(r, ownMasks))) return 'Bank Transfer';
    }
    return 'Transfer';
  }

  // Idempotent re-runs: an already-resolved clean label stays put (so we don't
  // clobber a Plaid-derived category whose merchant name matches no rule).
  // 'Other' is the exception — retry it, in case the name rules improved.
  if (raw !== 'Other' && CLEAN_LABELS.has(raw)) return raw;

  if (p === 'LOAN_PAYMENTS') return 'Fees & Payments';

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
 * @param {Set<string>} [ownMasks] Last-digit masks of your own accounts.
 * @returns {string} clean category label
 */
export function categorizeTxn(txn, ownMasks = new Set()) {
  const pfc = txn.personal_finance_category || {};
  const name = txn.merchant_name || txn.name || '';
  return cleanCategory(pfc.primary, pfc.detailed, name, ownMasks);
}

// Categories excluded from spending/expense totals (money moving between your
// own accounts, not actual outflow). 'Bank Transfer' is intentionally NOT here:
// it marks a transfer to/from someone *else*, which counts as income/expense by
// direction. Shared with repository.js.
export const EXCLUDED_FROM_SPENDING = ['Transfer', 'Credit Card Payment'];
