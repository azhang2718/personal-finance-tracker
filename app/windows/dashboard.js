// Dashboard window renderer. Talks only to the configured API base URL via
// window.API (stale-while-revalidate) and to the preload bridge.
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  let seriesChart = null;
  let donutChart = null;
  let currentRange = 'all';
  let firstChartRender = true; // draw-in happens once, on load
  let latestAccounts = [];
  let pendingDisconnect = null; // { itemId, institution }

  // ---------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------

  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  function todayStr() {
    return new Date().toISOString().slice(0, 10);
  }

  function showGlobalError(message, actionLabel, action) {
    const el = $('global-error');
    el.textContent = message + ' ';
    if (actionLabel && action) {
      const btn = document.createElement('button');
      btn.className = 'btn-text';
      btn.textContent = `→ ${actionLabel}`;
      btn.addEventListener('click', action);
      el.appendChild(btn);
    }
    el.hidden = false;
  }

  function clearGlobalError() {
    $('global-error').hidden = true;
  }

  // ---------------------------------------------------------------
  // Hero + delta
  // ---------------------------------------------------------------

  function renderCurrent(data, meta) {
    const hero = $('hero-figure');
    const total = data.total_cents;
    // Drop cents when at/above $100k for width, per spec
    hero.textContent = FMT.dollars(total, { dropCents: Math.abs(total) >= 100000 * 100 });

    const delta = data.delta_7d_cents;
    const pctNum = Number(data.delta_7d_pct);
    const line = $('delta-line');
    line.innerHTML = '';
    const arrowSpan = document.createElement('span');
    arrowSpan.className = 'num ' + (delta >= 0 ? 'pos' : 'neg');
    const arrow = delta >= 0 ? '▲' : '▼';
    const sign = delta >= 0 ? '+' : '−';
    arrowSpan.textContent = `${arrow} ${FMT.dollars(Math.abs(delta))} (${sign}${Math.abs(pctNum).toFixed(1)}%)`;
    const words = document.createElement('span');
    words.className = 'soft-words';
    words.textContent = ' past 7 days';
    line.appendChild(arrowSpan);
    line.appendChild(words);

    if (data.last_refresh) {
      const staleSuffix = meta && meta.fromCache ? ' · cached' : '';
      $('refreshed-at').textContent = `refreshed ${FMT.shortWhen(data.last_refresh)}${staleSuffix}`;
    }

    renderDonut(data.allocation);
  }

  // ---------------------------------------------------------------
  // Time-series chart
  // ---------------------------------------------------------------

  function buildSeriesAnimation(pointCount) {
    if (reducedMotion || !firstChartRender || pointCount < 2) return false;
    // Left-to-right draw-in over 600ms ease-out (DESIGN.md Section 6)
    const totalDuration = 600;
    const delayBetween = totalDuration / pointCount;
    const previousY = (ctx) =>
      ctx.index === 0
        ? ctx.chart.scales.y.getPixelForValue(100)
        : ctx.chart.getDatasetMeta(ctx.datasetIndex).data[ctx.index - 1].getProps(['y'], true).y;
    return {
      x: {
        type: 'number',
        easing: 'easeOutQuart',
        duration: delayBetween,
        from: NaN,
        delay(ctx) {
          if (ctx.type !== 'data' || ctx.xStarted) return 0;
          ctx.xStarted = true;
          return ctx.index * delayBetween;
        },
      },
      y: {
        type: 'number',
        easing: 'easeOutQuart',
        duration: delayBetween,
        from: previousY,
        delay(ctx) {
          if (ctx.type !== 'data' || ctx.yStarted) return 0;
          ctx.yStarted = true;
          return ctx.index * delayBetween;
        },
      },
    };
  }

  function renderSeries(payload) {
    const series = payload.series || [];
    const labels = series.map((p) => p.date);
    const values = series.map((p) => p.total_cents / 100);

    const accent = cssVar('--accent');
    const accentSoft = 'rgba(74, 144, 217, 0.10)';
    const inkSoft = cssVar('--ink-soft');
    const hairline = cssVar('--hairline');
    const mono = cssVar('--font-mono');

    const config = {
      type: 'line',
      data: {
        labels,
        datasets: [{
          data: values,
          borderColor: accent,
          borderWidth: 1.5,
          backgroundColor: accentSoft,
          fill: true,
          pointRadius: 0,
          pointHitRadius: 8,
          tension: 0.1,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: buildSeriesAnimation(values.length),
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: cssVar('--bg-raised'),
            borderColor: hairline,
            borderWidth: 1,
            titleColor: cssVar('--ink'),
            bodyColor: cssVar('--ink'),
            titleFont: { family: mono, size: 12 },
            bodyFont: { family: mono, size: 12 },
            displayColors: false,
            callbacks: {
              title: (items) => FMT.shortDate(items[0].label),
              label: (item) => FMT.dollars(Math.round(item.parsed.y * 100)),
            },
          },
        },
        scales: {
          x: {
            grid: { display: false },
            border: { display: false },
            ticks: {
              color: inkSoft,
              font: { family: mono, size: 11 },
              maxTicksLimit: 6,
              maxRotation: 0,
              callback(value) {
                return FMT.shortDate(this.getLabelForValue(value));
              },
            },
          },
          y: {
            grid: { color: hairline, drawTicks: false },
            border: { display: false },
            ticks: {
              color: inkSoft,
              font: { family: mono, size: 11 },
              maxTicksLimit: 3,
              callback: (v) => '$' + Number(v).toLocaleString('en-US', { maximumFractionDigits: 0 }),
            },
          },
        },
      },
    };

    if (seriesChart) {
      seriesChart.data = config.data;
      seriesChart.options.animation = false; // only one orchestrated moment
      seriesChart.update();
    } else {
      seriesChart = new Chart($('series-chart'), config);
      firstChartRender = false;
    }
  }

  // ---------------------------------------------------------------
  // Allocation donut + legend (credit is an offset line, not a slice)
  // ---------------------------------------------------------------

  function renderDonut(allocation) {
    const investments = allocation.investment_cents || 0;
    const collectibles = allocation.collectibles_cents || 0;
    const cash = allocation.cash_cents || 0;
    const credit = allocation.credit_cents || 0;

    const slices = [
      { label: 'Investments', value: investments, color: cssVar('--accent') },
      { label: 'Collectibles', value: collectibles, color: 'rgba(26, 26, 26, 0.7)' },
      { label: 'Cash', value: cash, color: cssVar('--ink-soft') },
    ].filter((s) => s.value > 0);

    const positiveTotal = slices.reduce((a, s) => a + s.value, 0);

    const config = {
      type: 'doughnut',
      data: {
        labels: slices.map((s) => s.label),
        datasets: [{
          data: slices.map((s) => s.value / 100),
          backgroundColor: slices.map((s) => s.color),
          borderWidth: 0,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '70%',
        animation: reducedMotion ? false : undefined,
        plugins: { legend: { display: false }, tooltip: { enabled: false } },
      },
    };

    if (donutChart) {
      donutChart.data = config.data;
      donutChart.update('none');
    } else {
      donutChart = new Chart($('donut-chart'), config);
    }

    // Legend
    const legend = $('allocation-legend');
    legend.innerHTML = '';
    for (const s of slices) {
      const li = document.createElement('li');
      const pctVal = positiveTotal > 0 ? ((s.value / positiveTotal) * 100).toFixed(1) : '0.0';
      li.innerHTML =
        `<span class="swatch" style="background:${s.color}"></span>` +
        `<span>${s.label}</span>` +
        `<span class="lpct">${pctVal}%</span>` +
        `<span class="lval">${FMT.dollars(s.value)}</span>`;
      legend.appendChild(li);
    }

    $('credit-offset').textContent = credit !== 0 ? `Credit offset ${FMT.dollars(credit)}` : '';
  }

  // ---------------------------------------------------------------
  // Accounts table
  // ---------------------------------------------------------------

  function accountStatus(a) {
    if (a.needs_reauth) return 'error';
    if (!a.last_updated) return 'stale';
    return a.last_updated >= todayStr() ? 'ok' : 'stale';
  }

  function renderAccounts(payload) {
    latestAccounts = payload.accounts || [];
    const tbody = $('accounts-tbody');
    tbody.innerHTML = '';

    let anyReauth = null;
    for (const a of latestAccounts) {
      const tr = document.createElement('tr');
      const status = accountStatus(a);

      const tdName = document.createElement('td');
      tdName.innerHTML = `<span class="acct-name">${escapeHtml(a.name)}</span><span class="acct-type">${a.type}</span>`;

      const tdBal = document.createElement('td');
      tdBal.className = 'acct-balance' + (a.balance_cents < 0 ? ' neg' : '');
      tdBal.textContent = a.balance_cents != null ? FMT.dollars(a.balance_cents) : '—';

      const tdStatus = document.createElement('td');
      tdStatus.className = 'acct-status';
      if (status === 'error') {
        anyReauth = a;
        const word = document.createElement('span');
        word.innerHTML = `<span class="dot error"></span><span class="neg">error</span> `;
        const fix = document.createElement('button');
        fix.className = 'btn-text';
        fix.textContent = 'Reconnect';
        fix.addEventListener('click', () => reconnectItem(a.item_id));
        tdStatus.appendChild(word);
        tdStatus.appendChild(fix);
      } else {
        const when = a.last_updated ? (status === 'ok' ? FMT.shortWhen(a.last_updated + 'T12:00:00') : FMT.shortDate(a.last_updated)) : '';
        const cls = status === 'stale' ? 'warn' : '';
        tdStatus.innerHTML = `<span class="dot ${status}"></span><span class="${cls}">${status}</span>${when ? ' · <span class="num">' + when + '</span>' : ''}`;
      }

      tr.appendChild(tdName);
      tr.appendChild(tdBal);
      tr.appendChild(tdStatus);
      tbody.appendChild(tr);
    }

    if (anyReauth) {
      showGlobalError(`${anyReauth.institution || anyReauth.name} needs to be reconnected.`, 'Reconnect', () => reconnectItem(anyReauth.item_id));
    } else {
      clearGlobalError();
    }

    renderItemActions();
    toggleEmptyState(latestAccounts.length === 0);
  }

  function escapeHtml(s) {
    const d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }

  function toggleEmptyState(isEmpty) {
    $('empty-state').hidden = !isEmpty;
    $('dashboard').hidden = isEmpty;
  }

  // ---------------------------------------------------------------
  // Settings: Plaid item actions (reconnect / disconnect with typed confirm)
  // ---------------------------------------------------------------

  function uniqueItems() {
    const map = new Map();
    for (const a of latestAccounts) {
      if (a.item_id != null && !map.has(a.item_id)) {
        map.set(a.item_id, { itemId: a.item_id, institution: a.institution || a.name, needsReauth: a.needs_reauth });
      }
      if (a.item_id != null && a.needs_reauth) map.get(a.item_id).needsReauth = true;
    }
    return [...map.values()];
  }

  function renderItemActions() {
    const wrap = $('item-actions');
    wrap.innerHTML = '';
    for (const item of uniqueItems()) {
      const chip = document.createElement('span');
      chip.className = 'item-chip';
      const name = document.createElement('span');
      name.textContent = item.institution;
      chip.appendChild(name);

      const re = document.createElement('button');
      re.className = 'btn-text';
      re.textContent = 'Reconnect';
      re.addEventListener('click', () => reconnectItem(item.itemId));
      chip.appendChild(re);

      const del = document.createElement('button');
      del.className = 'btn-danger';
      del.textContent = 'Disconnect & delete';
      del.addEventListener('click', () => beginDisconnect(item));
      chip.appendChild(del);

      wrap.appendChild(chip);
    }
  }

  function beginDisconnect(item) {
    pendingDisconnect = item;
    $('disconnect-confirm-text').textContent =
      `This deletes the connection, its stored token, and its history. Type "${item.institution}" to confirm.`;
    const input = $('disconnect-confirm-input');
    input.value = '';
    $('disconnect-confirm-btn').disabled = true;
    $('disconnect-confirm-row').hidden = false;
    input.focus();
  }

  function cancelDisconnect() {
    pendingDisconnect = null;
    $('disconnect-confirm-row').hidden = true;
  }

  async function confirmDisconnect() {
    if (!pendingDisconnect) return;
    const btn = $('disconnect-confirm-btn');
    btn.disabled = true;
    btn.textContent = 'Deleting…';
    try {
      await API.deleteItem(pendingDisconnect.itemId);
      cancelDisconnect();
      await loadAll();
    } catch (err) {
      showGlobalError('Disconnect failed — try again.', null, null);
    } finally {
      btn.textContent = 'Disconnect & delete';
    }
  }

  // ---------------------------------------------------------------
  // Plaid Link
  // ---------------------------------------------------------------

  async function connectBank() {
    try {
      const { link_token } = await API.linkToken();
      const handler = Plaid.create({
        token: link_token,
        onSuccess: async (publicToken, metadata) => {
          const institution = metadata && metadata.institution ? metadata.institution.name : 'Unknown Institution';
          try {
            await API.exchange(publicToken, institution);
            await API.refresh(false).catch(() => {});
            await loadAll();
          } catch (err) {
            showGlobalError('Connecting the bank failed — try again.', 'Connect bank', connectBank);
          }
        },
        onExit: () => {},
      });
      handler.open();
    } catch (err) {
      showGlobalError('Could not reach the local server to start Plaid Link.', 'Retry', connectBank);
    }
  }

  async function reconnectItem(itemId) {
    try {
      const { link_token } = await API.reauthToken(itemId);
      const handler = Plaid.create({
        token: link_token,
        onSuccess: async () => {
          await API.refresh(false).catch(() => {});
          await loadAll();
        },
        onExit: () => {},
      });
      handler.open();
    } catch (err) {
      showGlobalError('Could not start the reconnect flow — try again.', null, null);
    }
  }

  // ---------------------------------------------------------------
  // Refresh / export / manual entry / API base URL
  // ---------------------------------------------------------------

  async function manualRefresh() {
    const btn = $('refresh-btn');
    btn.disabled = true;
    btn.textContent = 'Refreshing…';
    try {
      await API.refresh(false);
      await loadAll();
      btn.textContent = `Refreshed ${FMT.shortWhen(new Date().toISOString())}`;
      setTimeout(() => { btn.textContent = '⟳ Refresh'; btn.disabled = false; }, 4000);
    } catch (err) {
      btn.textContent = '⟳ Refresh';
      btn.disabled = false;
      showGlobalError('Refresh failed — check that the local server is running.', 'Retry', manualRefresh);
    }
  }

  async function exportCsv() {
    try {
      const res = await fetch(API.exportCsvUrl());
      if (!res.ok) throw new Error('export failed');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'networth-export.csv';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      showGlobalError('Export failed — check that the local server is running.', null, null);
    }
  }

  async function saveManualCollectibles() {
    const input = $('manual-collectibles');
    const statusEl = $('manual-status');
    const dollarsVal = parseFloat(input.value);
    if (isNaN(dollarsVal) || dollarsVal < 0) {
      statusEl.textContent = 'Enter a value of 0 or more.';
      return;
    }
    try {
      await API.setManualCollectibles(Math.round(dollarsVal * 100));
      statusEl.textContent = `Saved ${FMT.shortWhen(new Date().toISOString())}`;
      await loadAll();
    } catch (err) {
      statusEl.textContent = 'Save failed — server unreachable.';
    }
  }

  async function saveApiBaseUrl() {
    const input = $('api-base-url');
    const statusEl = $('api-base-status');
    let url = input.value.trim().replace(/\/+$/, '');
    if (!/^https?:\/\//.test(url)) {
      statusEl.textContent = 'Enter a full URL, e.g. http://127.0.0.1:8123';
      return;
    }
    await API.setApiBaseUrl(url);
    statusEl.textContent = 'Saved — reloading data';
    await loadAll();
    statusEl.textContent = `Saved ${FMT.shortWhen(new Date().toISOString())}`;
  }

  // ---------------------------------------------------------------
  // Data loading (stale-while-revalidate everywhere)
  // ---------------------------------------------------------------

  async function loadAll() {
    let networkFailed = false;
    const onNetError = () => { networkFailed = true; };

    await Promise.all([
      API.getSWR('/api/networth/current', renderCurrent, onNetError),
      API.getSWR(`/api/networth/series?range=${currentRange}`, renderSeries, onNetError),
      API.getSWR('/api/accounts', renderAccounts, onNetError),
    ]);

    if (networkFailed) {
      showGlobalError('The local server is unreachable — showing last saved data.', 'Retry', loadAll);
    }
    return !networkFailed;
  }

  async function loadSeriesForRange(range) {
    currentRange = range;
    await API.getSWR(`/api/networth/series?range=${range}`, renderSeries, () => {});
  }

  async function loadHealth() {
    try {
      const health = await API.health();
      if (health.collectr_share_url) $('collectr-url').textContent = health.collectr_share_url;
    } catch {
      /* settings panel just keeps the placeholder */
    }
  }

  // ---------------------------------------------------------------
  // Wiring
  // ---------------------------------------------------------------

  function wireEvents() {
    $('refresh-btn').addEventListener('click', manualRefresh);
    $('connect-bank').addEventListener('click', connectBank);
    $('empty-connect').addEventListener('click', connectBank);
    $('empty-manual').addEventListener('click', () => {
      toggleEmptyState(false);
      $('manual-collectibles').focus();
      $('manual-collectibles').scrollIntoView({ block: 'center' });
    });
    $('export-csv').addEventListener('click', exportCsv);
    $('manual-save').addEventListener('click', saveManualCollectibles);
    $('api-base-save').addEventListener('click', saveApiBaseUrl);
    $('disconnect-cancel-btn').addEventListener('click', cancelDisconnect);
    $('disconnect-confirm-btn').addEventListener('click', confirmDisconnect);
    $('disconnect-confirm-input').addEventListener('input', (e) => {
      $('disconnect-confirm-btn').disabled =
        !pendingDisconnect || e.target.value.trim() !== pendingDisconnect.institution;
    });

    // Range toggles — radiogroup with arrow-key support
    const buttons = [...document.querySelectorAll('.range-btn')];
    buttons.forEach((btn, i) => {
      btn.addEventListener('click', () => {
        buttons.forEach((b) => {
          b.classList.toggle('active', b === btn);
          b.setAttribute('aria-checked', b === btn ? 'true' : 'false');
        });
        loadSeriesForRange(btn.dataset.range);
      });
      btn.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
          e.preventDefault();
          const next = buttons[(i + (e.key === 'ArrowRight' ? 1 : buttons.length - 1)) % buttons.length];
          next.focus();
          next.click();
        }
      });
    });
  }

  async function boot() {
    await API.init();
    $('api-base-url').value = API.baseUrl();
    wireEvents();

    // Show the dashboard frame (with skeletons) unless cache says it's empty.
    toggleEmptyState(false);

    // 1. paint from cache + revalidate
    const ok = await loadAll();
    loadHealth();

    // 2. auto-refresh (server enforces the 24h gate), then reload if it ran
    if (ok) {
      try {
        const result = await API.refresh(true);
        if (!result.skipped) await loadAll();
      } catch {
        /* loadAll already surfaced connectivity problems */
      }
    }
  }

  boot();
})();
