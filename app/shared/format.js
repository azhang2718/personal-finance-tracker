// Shared formatting helpers (plain script; exposes window.FMT).
(function () {
  'use strict';

  function dollars(cents, opts) {
    const o = opts || {};
    const negative = cents < 0;
    const abs = Math.abs(cents) / 100;
    const str = abs.toLocaleString('en-US', {
      minimumFractionDigits: o.dropCents ? 0 : 2,
      maximumFractionDigits: o.dropCents ? 0 : 2,
    });
    return `${negative ? '−' : ''}$${str}`;
  }

  // "9:41 AM" for today, "Jun 9" otherwise.
  function shortWhen(isoOrDate) {
    if (!isoOrDate) return '';
    const d = new Date(isoOrDate);
    if (isNaN(d.getTime())) return String(isoOrDate);
    const now = new Date();
    if (d.toDateString() === now.toDateString()) {
      return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    }
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  function shortDate(dateStr) {
    const d = new Date(dateStr + 'T00:00:00');
    if (isNaN(d.getTime())) return dateStr;
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  // Today's date (YYYY-MM-DD) in US Central time, matching how the server keys
  // snapshot dates. Using toISOString() instead keys to UTC, which rolls over
  // to tomorrow in the evening Central and breaks "is today" comparisons.
  function todayStr() {
    return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
  }

  window.FMT = { dollars, shortWhen, shortDate, todayStr };
})();
