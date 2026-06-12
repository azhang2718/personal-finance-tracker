// Dashboard window renderer. Talks only to the configured API base URL via
// window.API (stale-while-revalidate) and to the preload bridge.
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  let seriesChart = null;
  let donutChart = null;
  let sparkChart = null;
  let spendingChart = null;
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

  // Fills a delta line element; `asChip` wraps it in a glass pill (summary hero).
  function fillDelta(el, delta, pctNum, asChip) {
    el.innerHTML = '';
    const wrap = asChip ? document.createElement('span') : el;
    if (asChip) wrap.className = 'delta-chip';
    const arrowSpan = document.createElement('span');
    arrowSpan.className = 'num ' + (delta >= 0 ? 'pos' : 'neg');
    const arrow = delta >= 0 ? '▲' : '▼';
    const sign = delta >= 0 ? '+' : '−';
    arrowSpan.textContent = `${arrow} ${FMT.dollars(Math.abs(delta))} (${sign}${Math.abs(pctNum).toFixed(1)}%)`;
    const words = document.createElement('span');
    words.className = 'soft-words';
    words.textContent = ' past 7 days';
    wrap.appendChild(arrowSpan);
    wrap.appendChild(words);
    if (asChip) el.appendChild(wrap);
  }

  function renderCurrent(data, meta) {
    const total = data.total_cents;
    // Drop cents when at/above $100k for width, per spec
    const figure = FMT.dollars(total, { dropCents: Math.abs(total) >= 100000 * 100 });
    $('hero-figure').textContent = figure; // Summary hero
    $('nw-figure').textContent = figure;   // Net worth tab hero

    const delta = data.delta_7d_cents;
    const pctNum = Number(data.delta_7d_pct);
    fillDelta($('delta-line'), delta, pctNum, true);
    fillDelta($('nw-delta-line'), delta, pctNum, false);

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

  // The Net worth tab is hidden on load; creating a Chart.js chart in a
  // hidden (zero-size) canvas breaks layout and wastes the draw-in moment.
  // Defer first creation until the tab is shown.
  let pendingSeriesPayload = null;

  function renderSeries(payload) {
    if (!seriesChart && $('tab-networth').hidden) {
      pendingSeriesPayload = payload;
      return;
    }
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
  // Summary sparkline (compact 30-day net worth, no axes)
  // ---------------------------------------------------------------

  function renderSpark(payload) {
    const series = payload.series || [];
    const config = {
      type: 'line',
      data: {
        labels: series.map((p) => p.date),
        datasets: [{
          data: series.map((p) => p.total_cents / 100),
          borderColor: cssVar('--accent'),
          borderWidth: 1.5,
          backgroundColor: 'rgba(74, 144, 217, 0.10)',
          fill: true,
          pointRadius: 0,
          tension: 0.2,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: reducedMotion ? false : undefined,
        plugins: { legend: { display: false }, tooltip: { enabled: false } },
        scales: { x: { display: false }, y: { display: false } },
      },
    };
    if (sparkChart) {
      sparkChart.data = config.data;
      sparkChart.update('none');
    } else {
      sparkChart = new Chart($('summary-spark'), config);
    }
  }

  // ---------------------------------------------------------------
  // Spending tab + summary quick stats
  // ---------------------------------------------------------------

  function monthLabel(ym) {
    const d = new Date(ym + '-01T00:00:00');
    return isNaN(d.getTime()) ? ym : d.toLocaleDateString('en-US', { month: 'short' });
  }

  function renderSpending(data) {
    const months = data.months || [];
    const cur = data.current_month || { expenses_cents: 0, income_cents: 0, by_category: [] };

    // Quick stats on the Summary tab
    $('qs-spend').textContent = FMT.dollars(cur.expenses_cents);
    $('qs-income').textContent = FMT.dollars(cur.income_cents);

    // Current-month card
    $('spend-month-figure').textContent = FMT.dollars(cur.expenses_cents);
    $('spend-month-income').textContent = `${FMT.dollars(cur.income_cents)} income`;

    // Category breakdown: top 8 + Other
    const list = $('category-list');
    list.innerHTML = '';
    const cats = cur.by_category || [];
    const top = cats.slice(0, 8);
    const otherCents = cats.slice(8).reduce((a, c) => a + c.cents, 0);
    const prettify = (c) =>
      String(c).replace(/_/g, ' ').toLowerCase().replace(/^./, (ch) => ch.toUpperCase());
    const rows = top.map((c) => ({ label: prettify(c.category), cents: c.cents }));
    if (otherCents > 0) rows.push({ label: 'Other', cents: otherCents });
    if (rows.length === 0) {
      const li = document.createElement('li');
      li.innerHTML = '<span class="soft">No spending recorded this month.</span>';
      list.appendChild(li);
    }
    for (const r of rows) {
      const li = document.createElement('li');
      const name = document.createElement('span');
      name.textContent = r.label;
      const amt = document.createElement('span');
      amt.className = 'cat-amount';
      amt.textContent = FMT.dollars(r.cents);
      li.appendChild(name);
      li.appendChild(amt);
      list.appendChild(li);
    }

    // Bar chart: expenses (accent, rounded tops) + income (muted)
    const inkSoft = cssVar('--ink-soft');
    const mono = cssVar('--font-mono');
    const config = {
      type: 'bar',
      data: {
        labels: months.map((m) => monthLabel(m.month)),
        datasets: [
          {
            label: 'Expenses',
            data: months.map((m) => m.expenses_cents / 100),
            backgroundColor: cssVar('--accent'),
            borderRadius: { topLeft: 6, topRight: 6 },
            borderSkipped: 'bottom',
            maxBarThickness: 36,
          },
          {
            label: 'Income',
            data: months.map((m) => m.income_cents / 100),
            backgroundColor: 'rgba(107, 118, 137, 0.35)',
            borderRadius: { topLeft: 6, topRight: 6 },
            borderSkipped: 'bottom',
            maxBarThickness: 36,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: reducedMotion ? false : undefined,
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: cssVar('--bg-raised'),
            borderColor: cssVar('--hairline'),
            borderWidth: 1,
            titleColor: cssVar('--ink'),
            bodyColor: cssVar('--ink'),
            titleFont: { family: mono, size: 12 },
            bodyFont: { family: mono, size: 12 },
            displayColors: false,
            callbacks: {
              label: (item) => `${item.dataset.label} ${FMT.dollars(Math.round(item.parsed.y * 100))}`,
            },
          },
        },
        scales: {
          x: {
            grid: { display: false },
            border: { display: false },
            ticks: { color: inkSoft, font: { family: mono, size: 11 } },
          },
          y: {
            grid: { color: cssVar('--hairline'), drawTicks: false },
            border: { display: false },
            beginAtZero: true,
            ticks: {
              color: inkSoft,
              font: { family: mono, size: 11 },
              maxTicksLimit: 4,
              callback: (v) => '$' + Number(v).toLocaleString('en-US', { maximumFractionDigits: 0 }),
            },
          },
        },
      },
    };
    if (spendingChart) {
      spendingChart.data = config.data;
      spendingChart.update('none');
    } else {
      spendingChart = new Chart($('spending-chart'), config);
    }
  }

  // ---------------------------------------------------------------
  // Allocation donut + legend (credit is an offset line, not a slice)
  // ---------------------------------------------------------------

  function renderDonut(allocation) {
    // Older cached payloads may lack the per-class keys — fall back to the
    // investment total as stocks.
    const stocks = allocation.investment_stocks_cents ?? allocation.investment_cents ?? 0;
    const crypto = allocation.investment_crypto_cents || 0;
    const invCash = allocation.investment_cash_cents || 0;
    const collectibles = allocation.collectibles_cents || 0;
    const cash = allocation.cash_cents || 0;
    const credit = allocation.credit_cents || 0;

    const slices = [
      { label: 'Stocks', value: stocks, color: cssVar('--accent') },
      { label: 'Crypto', value: crypto, color: 'rgba(29, 36, 51, 0.45)' },
      { label: 'Collectibles', value: collectibles, color: 'rgba(29, 36, 51, 0.7)' },
      { label: 'Cash', value: cash, color: cssVar('--ink-soft') },
      { label: 'Fidelity cash', value: invCash, color: 'rgba(29, 36, 51, 0.25)' },
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
  // Sidebar tabs (client-side show/hide; Summary is the default)
  // ---------------------------------------------------------------

  const TAB_IDS = ['summary', 'networth', 'spending', 'settings'];

  function setActiveTab(tab) {
    for (const id of TAB_IDS) {
      $(`tab-${id}`).hidden = id !== tab;
    }
    document.querySelectorAll('.nav-btn').forEach((btn) => {
      const active = btn.dataset.tab === tab;
      btn.classList.toggle('active', active);
      if (active) btn.setAttribute('aria-current', 'page');
      else btn.removeAttribute('aria-current');
    });
    // Deferred first render of the series chart (keeps the draw-in moment).
    if (tab === 'networth' && pendingSeriesPayload) {
      const p = pendingSeriesPayload;
      pendingSeriesPayload = null;
      renderSeries(p);
    }
    // Chart.js canvases in previously-hidden sections need a resize nudge.
    for (const c of [seriesChart, donutChart, sparkChart, spendingChart]) {
      if (c) c.resize();
    }
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

  // Hosted Link: the server returns a Plaid-hosted HTTPS URL that runs the
  // whole flow (including bank OAuth pages, e.g. Chase). We open it and poll
  // the server until the session completes.
  let hostedPollTimer = null;

  function pollHostedSession(onDone) {
    if (hostedPollTimer) clearInterval(hostedPollTimer);
    const startedAt = Date.now();
    hostedPollTimer = setInterval(async () => {
      if (Date.now() - startedAt > 15 * 60 * 1000) {
        clearInterval(hostedPollTimer);
        hostedPollTimer = null;
        return;
      }
      try {
        const result = await API.hostedStatus();
        if (result.status === 'connected') {
          clearInterval(hostedPollTimer);
          hostedPollTimer = null;
          await onDone();
        } else if (result.status === 'exited') {
          clearInterval(hostedPollTimer);
          hostedPollTimer = null;
        }
      } catch (err) {
        // keep polling; transient errors are fine
      }
    }, 3000);
  }

  async function connectBank() {
    try {
      const { hosted_link_url } = await API.linkToken();
      window.open(hosted_link_url, '_blank');
      pollHostedSession(async () => {
        await API.refresh(false).catch(() => {});
        await loadAll();
      });
    } catch (err) {
      showGlobalError('Could not reach the local server to start Plaid Link.', 'Retry', connectBank);
    }
  }

  async function reconnectItem(itemId) {
    try {
      const { hosted_link_url } = await API.reauthToken(itemId);
      window.open(hosted_link_url, '_blank');
      pollHostedSession(async () => {
        await API.refresh(false).catch(() => {});
        await loadAll();
      });
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
      API.getSWR('/api/networth/series?range=1m', renderSpark, () => {}),
      API.getSWR('/api/accounts', renderAccounts, onNetError),
      API.getSWR('/api/spending/summary?months=6', renderSpending, () => {}),
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
      setActiveTab('settings');
      $('manual-collectibles').focus();
      $('manual-collectibles').scrollIntoView({ block: 'center' });
    });

    // Sidebar tabs
    document.querySelectorAll('.nav-btn').forEach((btn) => {
      btn.addEventListener('click', () => setActiveTab(btn.dataset.tab));
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
