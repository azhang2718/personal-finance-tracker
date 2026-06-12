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

  function pct(value) {
    const n = Number(value);
    return `${n >= 0 ? '+' : '−'}${Math.abs(n).toFixed(1)}%`;
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

  window.FMT = { dollars, pct, shortWhen, shortDate };
})();
