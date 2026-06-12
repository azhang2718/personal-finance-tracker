// Mini window renderer. First paint comes from cache only — never awaits the
// network. Revalidation happens after paint and updates numbers in place
// (fixed heights in CSS mean zero layout shift).
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  let sparkChart = null;

  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  function renderCurrent(data, meta) {
    const total = data.total_cents;
    $('mini-figure').textContent = FMT.dollars(total, { dropCents: Math.abs(total) >= 100000 * 100 });

    const delta = data.delta_7d_cents;
    const pctNum = Number(data.delta_7d_pct);
    const el = $('mini-delta');
    el.innerHTML = '';
    const span = document.createElement('span');
    span.className = delta >= 0 ? 'pos' : 'neg';
    span.textContent = `${delta >= 0 ? '▲' : '▼'} ${delta >= 0 ? '+' : '−'}${Math.abs(pctNum).toFixed(1)}%`;
    const words = document.createElement('span');
    words.className = 'soft-words';
    words.textContent = ' past 7 days';
    el.appendChild(span);
    el.appendChild(words);

    if (data.last_refresh) $('mini-time').textContent = FMT.shortWhen(data.last_refresh);

    const alloc = data.allocation;
    $('alloc-investments').textContent = FMT.dollars(alloc.investment_cents || 0);
    $('alloc-collectibles').textContent = FMT.dollars(alloc.collectibles_cents || 0);
    $('alloc-cashcredit').textContent = FMT.dollars((alloc.cash_cents || 0) + (alloc.credit_cents || 0));

    if (meta && meta.fromCache) {
      // Cached paint — if revalidation later fails, the stale line stays.
      setStale(meta.cachedAt);
    } else {
      clearStale();
    }
  }

  function setStale(cachedAt) {
    $('mini-stale').textContent = `stale · ${cachedAt ? FMT.shortWhen(cachedAt) : 'cached'}`;
  }

  function setSourceStale(text) {
    $('mini-stale').textContent = text;
  }

  function clearStale() {
    $('mini-stale').textContent = '';
  }

  function renderSpark(payload) {
    const series = payload.series || [];
    const values = series.map((p) => p.total_cents / 100);
    const labels = series.map((p) => p.date);

    const config = {
      type: 'line',
      data: {
        labels,
        datasets: [{
          data: values,
          borderColor: cssVar('--accent'),
          borderWidth: 1.5,
          pointRadius: 0,
          fill: false,
          tension: 0.1,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        events: [],
        plugins: { legend: { display: false }, tooltip: { enabled: false } },
        // No axes — the baseline hairline comes from CSS.
        scales: {
          x: { display: false },
          y: { display: false },
        },
      },
    };

    if (sparkChart) {
      sparkChart.data = config.data;
      sparkChart.update('none');
    } else {
      sparkChart = new Chart($('sparkline'), config);
    }
  }

  // If any account/source is stale, show one quiet line under the timestamp.
  function checkSourceStaleness(payload) {
    const today = new Date().toISOString().slice(0, 10);
    const stale = (payload.accounts || []).find(
      (a) => a.needs_reauth || !a.last_updated || a.last_updated < today
    );
    if (stale) {
      const label = stale.source === 'collectr' ? 'Collectr' : (stale.institution || stale.name);
      const when = stale.last_updated ? ` · ${FMT.shortDate(stale.last_updated)}` : '';
      setSourceStale(`${label} stale${when}`);
    }
  }

  async function refresh() {
    const btn = $('mini-refresh');
    btn.disabled = true;
    btn.textContent = '⟳ Refreshing…';
    try {
      await API.refresh(false);
      await revalidate();
      btn.textContent = `Refreshed ${FMT.shortWhen(new Date().toISOString())}`;
      setTimeout(() => { btn.textContent = '⟳ Refresh'; btn.disabled = false; }, 4000);
    } catch {
      btn.textContent = '⟳ Refresh';
      btn.disabled = false;
      setSourceStale('server unreachable — showing saved data');
    }
  }

  async function revalidate() {
    let failed = false;
    const onErr = () => { failed = true; };
    await Promise.all([
      API.getSWR('/api/networth/current', renderCurrent, onErr),
      API.getSWR('/api/networth/series?range=1m', renderSpark, onErr),
      API.getSWR('/api/accounts', checkSourceStaleness, onErr),
    ]);
    if (failed) setSourceStale('server unreachable — showing saved data');
  }

  async function boot() {
    await API.init();

    $('mini-refresh').addEventListener('click', refresh);
    $('open-dashboard').addEventListener('click', () => window.bridge.openDashboard());

    // 1. First paint: cache only — never waits on the network.
    await Promise.all([
      API.getSWR('/api/networth/current', renderCurrent, null, { cacheOnly: true }),
      API.getSWR('/api/networth/series?range=1m', renderSpark, null, { cacheOnly: true }),
      API.getSWR('/api/accounts', checkSourceStaleness, null, { cacheOnly: true }),
    ]);

    // 2. Then revalidate in the background.
    revalidate();
  }

  boot();
})();
