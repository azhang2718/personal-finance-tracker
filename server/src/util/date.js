// All snapshot dates are keyed to US Central time so the "day" matches the
// user's wall clock. Using `new Date().toISOString()` instead keys to UTC,
// which rolls over to tomorrow in the evening Central and mislabels snapshots.
const TZ = 'America/Chicago';

/**
 * YYYY-MM-DD for the given date in US Central time.
 * `en-CA` locale formats as an ISO-style date.
 * @param {Date} date
 * @returns {string}
 */
export function toCentralDateStr(date = new Date()) {
  return date.toLocaleDateString('en-CA', { timeZone: TZ });
}

/** Today's date (YYYY-MM-DD) in US Central time. */
export function todayStr() {
  return toCentralDateStr(new Date());
}
