// Dashboard window renderer — dark cinematic theme.
// Talks to the local API server via window.API (stale-while-revalidate)
// and the Electron preload bridge.
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  let seriesChart   = null;
  let historyChart  = null;
  let nwChart       = null;
  let donutChart    = null;
  let cashflowChart = null;
  let spendingChart = null;
  let currentRange  = '1y';
  let historyRange  = 'all';
  let nwRange       = 'all';
  let latestSeries  = null;
  let currentTab    = 'dashboard';
  let dataIsEmpty   = false;
  let firstChartRender = true;
  let latestAccounts   = [];
  let pendingDisconnect = null;

  // Stored spending data so we can re-render cashflow + AI after series loads
  let latestSpending = null;
  let latestCurrent  = null;
  // Month currently shown in the spending tab (category list + txn table).
  let selectedSpendMonth = null;

  // Categories selectable when recategorizing a transaction (ordered).
  const SPEND_CATEGORIES = [
    'Income', 'Food & Drink', 'Coffee', 'Groceries', 'Transport', 'Travel',
    'Shopping', 'Entertainment', 'Bills & Utilities', 'Health', 'Personal Care',
    'Services', 'Fees', 'Loan Payments', 'P2P', 'Bank Transfer', 'Transfer',
    'Credit Card Payment', 'Other',
  ];

  // Preferences (stored in localStorage)
  const PREF_KEY = 'pf_prefs';
  const defaultPrefs = { alerts: true, autoCat: true, privacy: false };
  let prefs = { ...defaultPrefs, ...JSON.parse(localStorage.getItem(PREF_KEY) || '{}') };

  // Assumed long-term annual growth used for all forward projections. A flat,
  // realistic rate beats extrapolating a noisy short-window delta (which used to
  // swing wildly with only a few weeks of history).
  const ASSUMED_ANNUAL_GROWTH = 0.07;

  // Current age, used to project a Coast-FI retirement age. Persisted locally.
  const AGE_KEY = 'pf_age';
  function getAge() {
    const v = parseInt(localStorage.getItem(AGE_KEY) || '', 10);
    return Number.isFinite(v) && v >= 14 && v <= 90 ? v : null;
  }
  function setAge(v) {
    if (Number.isFinite(v)) localStorage.setItem(AGE_KEY, String(v));
    else localStorage.removeItem(AGE_KEY);
  }

  // Privacy mode: blur monetary figures across the app until hovered.
  function applyPrivacy(on) {
    document.body.classList.toggle('privacy-on', !!on);
  }

  // ---------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------

  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  // Central time, matching how the server keys snapshot dates (see format.js).
  function todayStr() {
    return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
  }

  function fmtDollarsShort(cents) {
    const n = Math.abs(cents) / 100;
    if (n >= 1_000_000) return '$' + (n / 1_000_000).toFixed(2) + 'M';
    if (n >= 1_000)     return '$' + (n / 1_000).toFixed(1) + 'k';
    return '$' + Math.round(n);
  }

  // ---------------------------------------------------------------
  // Today label
  // ---------------------------------------------------------------

  function renderTodayLabel() {
    const now = new Date();
    const label = now.toLocaleDateString('en-US', {
      weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
      timeZone: 'America/Chicago'
    });
    const el = $('today-label');
    if (el) el.textContent = label;
  }

  // ---------------------------------------------------------------
  // Global error
  // ---------------------------------------------------------------

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
  // Chart colour helpers
  // ---------------------------------------------------------------

  function emeraldGradient(ctx, chartArea) {
    const gradient = ctx.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
    gradient.addColorStop(0,    'rgba(52,226,155,0.42)');
    gradient.addColorStop(0.55, 'rgba(52,226,155,0.10)');
    gradient.addColorStop(1,    'rgba(52,226,155,0)');
    return gradient;
  }

  function emeraldLineGradient(ctx, chartArea) {
    const gradient = ctx.createLinearGradient(chartArea.left, 0, chartArea.right, 0);
    gradient.addColorStop(0, '#22d3ee');
    gradient.addColorStop(1, '#34e29b');
    return gradient;
  }

  // ---------------------------------------------------------------
  // Net worth chart (series)
  // ---------------------------------------------------------------

  function buildSeriesAnimation(pointCount) {
    if (reducedMotion || !firstChartRender || pointCount < 2) return false;
    const totalDuration = 900;
    const delayBetween  = totalDuration / pointCount;
    const previousY = (ctx) =>
      ctx.index === 0
        ? ctx.chart.scales.y.getPixelForValue(0)
        : ctx.chart.getDatasetMeta(ctx.datasetIndex).data[ctx.index - 1].getProps(['y'], true).y;
    return {
      x: { type: 'number', easing: 'easeOutQuart', duration: delayBetween, from: NaN,
           delay(ctx) { if (ctx.type !== 'data' || ctx.xStarted) return 0; ctx.xStarted = true; return ctx.index * delayBetween; } },
      y: { type: 'number', easing: 'easeOutQuart', duration: delayBetween, from: previousY,
           delay(ctx) { if (ctx.type !== 'data' || ctx.yStarted) return 0; ctx.yStarted = true; return ctx.index * delayBetween; } },
    };
  }

  function seriesChartConfig(labels, values, animation) {
    const mono = cssVar('--font-mono');
    const inkSoft = cssVar('--ink-soft');
    const hairline = cssVar('--hairline');
    return {
      type: 'line',
      data: {
        labels,
        datasets: [{
          data: values,
          borderColor: function(ctx) {
            const { chartArea, ctx: canvasCtx } = ctx.chart;
            if (!chartArea) return '#34e29b';
            return emeraldLineGradient(canvasCtx, chartArea);
          },
          borderWidth: 2.6,
          backgroundColor: function(ctx) {
            const { chartArea, ctx: canvasCtx } = ctx.chart;
            if (!chartArea) return 'rgba(52,226,155,0.15)';
            return emeraldGradient(canvasCtx, chartArea);
          },
          fill: true,
          pointRadius: 0,
          pointHitRadius: 10,
          tension: 0.35,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: 'rgba(12,16,21,0.92)',
            borderColor: 'rgba(255,255,255,0.12)',
            borderWidth: 1,
            titleColor: cssVar('--ink-soft'),
            bodyColor: cssVar('--ink'),
            titleFont: { family: mono, size: 10 },
            bodyFont: { family: "'Space Grotesk', sans-serif", size: 16, weight: '700' },
            displayColors: false,
            padding: { x: 13, y: 9 },
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
              color: inkSoft, font: { family: mono, size: 9.5 },
              maxTicksLimit: 7, maxRotation: 0,
              callback(value) { return FMT.shortDate(this.getLabelForValue(value)); },
            },
          },
          y: {
            grid: { color: hairline, drawTicks: false },
            border: { display: false },
            ticks: {
              color: inkSoft, font: { family: mono, size: 9.5 }, maxTicksLimit: 4,
              callback: (v) => '$' + Number(v).toLocaleString('en-US', { maximumFractionDigits: 0 }),
            },
          },
        },
      },
    };
  }

  function renderSeries(payload) {
    const series = payload.series || [];
    latestSeries = series;
    const labels = series.map((p) => p.date);
    const values = series.map((p) => p.total_cents / 100);
    const anim   = buildSeriesAnimation(values.length);

    const config = seriesChartConfig(labels, values, anim);
    if (seriesChart) {
      seriesChart.data = config.data;
      seriesChart.options.animation = false;
      seriesChart.update();
    } else {
      seriesChart = new Chart($('series-chart'), config);
      firstChartRender = false;
    }

    // Mirror into history chart if it's been created
    if (historyChart) {
      historyChart.data = config.data;
      historyChart.options.animation = false;
      historyChart.update();
    }

    // Mirror into nwChart if it's been created
    if (nwChart) {
      nwChart.data = config.data;
      nwChart.options.animation = false;
      nwChart.update();
    }

    // Populate net worth tab stats
    renderNetWorthStats(series);
  }

  function renderHistory(payload) {
    const series = payload.series || [];
    const labels = series.map((p) => p.date);
    const values = series.map((p) => p.total_cents / 100);
    const config = seriesChartConfig(labels, values, false);
    if (historyChart) {
      historyChart.data = config.data;
      historyChart.options.animation = false;
      historyChart.update();
    } else {
      if ($('history-chart')) historyChart = new Chart($('history-chart'), config);
    }
  }

  function renderNwHistory(payload) {
    const series = payload.series || [];
    latestSeries = series;
    const labels = series.map((p) => p.date);
    const values = series.map((p) => p.total_cents / 100);
    const config = seriesChartConfig(labels, values, false);
    if (nwChart) {
      nwChart.data = config.data;
      nwChart.options.animation = false;
      nwChart.update();
    } else {
      if ($('nw-chart')) nwChart = new Chart($('nw-chart'), config);
    }
    renderNetWorthStats(series);
  }

  // ---------------------------------------------------------------
  // Net Worth tab — stats strip, monthly table, milestones
  // ---------------------------------------------------------------

  function renderNetWorthStats(series) {
    if (!series || series.length < 2) return;

    const values = series.map((p) => p.total_cents / 100);
    const start   = values[0];
    const current = values[values.length - 1];
    const gain    = current - start;
    const gainPct = start > 0 ? ((gain / start) * 100).toFixed(1) : '0';

    // Annualized growth
    const firstDate = new Date(series[0].date);
    const lastDate  = new Date(series[series.length - 1].date);
    const years = Math.max(0.08, (lastDate - firstDate) / (365.25 * 24 * 3600 * 1000));
    const annRate = start > 0 ? (Math.pow(current / start, 1 / years) - 1) * 100 : 0;

    // Best single month gain
    let bestMonth = 0;
    for (let i = 1; i < values.length; i++) {
      const diff = values[i] - values[i - 1];
      if (diff > bestMonth) bestMonth = diff;
    }

    // Stats strip
    const strip = $('nw-stats-strip');
    if (strip) {
      const stats = [
        { label: 'Starting', value: FMT.dollars(Math.round(start * 100)),   sub: FMT.shortDate(series[0].date),           fg: 'var(--ink)' },
        { label: 'Current',  value: FMT.dollars(Math.round(current * 100)), sub: 'net worth today',                        fg: 'var(--accent)' },
        { label: 'Total Gain', value: (gain >= 0 ? '+' : '') + FMT.dollars(Math.round(Math.abs(gain) * 100)), sub: gainPct + '% total', fg: gain >= 0 ? 'var(--accent)' : 'var(--neg)' },
        { label: 'Annualized', value: (annRate >= 0 ? '+' : '') + annRate.toFixed(1) + '%', sub: 'per year (CAGR)',        fg: annRate >= 0 ? 'var(--accent)' : 'var(--neg)' },
        { label: 'Best Month', value: '+' + FMT.dollars(Math.round(bestMonth * 100)), sub: 'single month gain',            fg: 'var(--accent)' },
      ];
      strip.innerHTML = '';
      for (const st of stats) {
        const el = document.createElement('div');
        el.className = 'nw-stat';
        el.innerHTML =
          `<div class="eyebrow" style="color:var(--ink-muted)">${st.label}</div>
           <div class="nw-stat-val num" style="color:${st.fg}">${st.value}</div>
           <div class="nw-stat-sub soft">${st.sub}</div>`;
        strip.appendChild(el);
      }
    }

    // Monthly snapshot table
    const tableEl = $('nw-monthly-table');
    if (tableEl) {
      const maxVal = Math.max(...values, 1);
      const rows = [];
      for (let i = series.length - 1; i >= 1; i--) {
        const prevVal = series[i - 1].total_cents / 100;
        const currVal = series[i].total_cents / 100;
        const change  = currVal - prevVal;
        const changePct = prevVal > 0 ? (change / prevVal * 100).toFixed(1) : '0';
        rows.push({
          month:     FMT.shortDate(series[i].date),
          value:     FMT.dollars(series[i].total_cents),
          change:    (change >= 0 ? '+' : '−') + FMT.dollars(Math.round(Math.abs(change) * 100)),
          changePct: (change >= 0 ? '+' : '') + changePct + '%',
          barW:      (currVal / maxVal * 100).toFixed(1) + '%',
          barC:      change >= 0 ? '#34e29b' : '#f87171',
          fg:        change >= 0 ? '#34e29b' : '#f87171',
        });
      }

      let html = `<div class="nw-table-head">
        <span>Month</span><span>Net Worth</span><span>Change $</span><span>Change %</span>
      </div>`;
      for (const row of rows) {
        html +=
          `<div class="nw-table-row">
            <span class="nw-table-month">${row.month}</span>
            <div class="nw-table-val-cell">
              <span class="nw-table-val num">${row.value}</span>
              <div class="nw-table-bar-track"><div class="nw-table-bar" style="width:${row.barW};background:${row.barC}"></div></div>
            </div>
            <span class="nw-table-change num" style="color:${row.fg}">${row.change}</span>
            <span class="nw-table-pct num" style="color:${row.fg}">${row.changePct}</span>
          </div>`;
      }
      tableEl.innerHTML = html;
    }

    // Milestones
    const msEl = $('milestones-list');
    if (msEl) {
      const targets = [10000, 25000, 50000, 100000, 250000, 500000, 1000000];
      const milestones = [];

      for (const target of targets) {
        let crossIdx = null;
        for (let i = 0; i < series.length; i++) {
          if (series[i].total_cents / 100 >= target) { crossIdx = i; break; }
        }
        if (crossIdx !== null) {
          const monthsFrom0 = crossIdx;
          milestones.push({ target, date: series[crossIdx].date, months: monthsFrom0, reached: true });
        } else if (current >= target * 0.5) {
          milestones.push({ target, date: null, months: null, reached: false });
        }
      }

      const msIcons = {
        10000:   '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2l3 6 7 1-5 5 1 7-6-3-6 3 1-7-5-5 7-1z"/></svg>',
        25000:   '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>',
        50000:   '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 17l6-6 4 4 8-8"/><path d="M17 7h4v4"/></svg>',
        100000:  '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="m9 12 2 2 4-4"/></svg>',
        250000:  '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2l3 6 7 1-5 5 1 7-6-3-6 3 1-7-5-5 7-1z"/></svg>',
        500000:  '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2l3 6 7 1-5 5 1 7-6-3-6 3 1-7-5-5 7-1z"/></svg>',
        1000000: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2l3 6 7 1-5 5 1 7-6-3-6 3 1-7-5-5 7-1z"/></svg>',
      };

      let html = '';
      for (const ms of milestones) {
        const label  = ms.target >= 1000000 ? '$' + (ms.target / 1000000) + 'M' : '$' + (ms.target / 1000) + 'k';
        const fg     = ms.reached ? 'var(--accent)' : 'var(--ink-muted)';
        const bg     = ms.reached ? 'rgba(52,226,155,0.12)' : 'rgba(255,255,255,0.04)';
        const dateStr = ms.date ? FMT.shortDate(ms.date) : 'Not reached yet';
        const dur = ms.months !== null
          ? (ms.months < 2 ? '< 1 mo' : ms.months < 24 ? ms.months + ' mo' : Math.round(ms.months / 12) + ' yr')
          : '—';
        html +=
          `<div class="milestone-item">
            <div class="milestone-icon" style="background:${bg};color:${fg}">${msIcons[ms.target]}</div>
            <div class="milestone-body">
              <div class="milestone-amount num" style="color:${fg}">${label}</div>
              <div class="milestone-date soft">${dateStr}</div>
            </div>
            <div class="milestone-dur">
              <div class="eyebrow" style="color:var(--ink-muted)">took</div>
              <div class="milestone-time num">${dur}</div>
            </div>
          </div>`;
      }
      msEl.innerHTML = html || '<p class="soft" style="font-size:13px;padding:12px 0">No milestones reached yet — keep building!</p>';
    }
  }

  // ---------------------------------------------------------------
  // Allocation donut
  // ---------------------------------------------------------------

  const ALLOC_COLORS = {
    Stocks:        '#34e29b',
    Crypto:        '#818cf8',
    Collectibles:  '#f0abfc',
    Cash:          '#38bdf8',
    'Invest. cash':'#2dd4bf',
  };

  // HTML tooltip for the donut — positioned over (and allowed to overflow) the
  // canvas so long labels like "Invest. cash" aren't clipped.
  function donutExternalTooltip(context) {
    const { chart, tooltip } = context;
    const parent = chart.canvas.parentNode;
    let el = parent.querySelector('.donut-tip');
    if (!el) {
      el = document.createElement('div');
      el.className = 'donut-tip';
      parent.appendChild(el);
    }
    if (tooltip.opacity === 0) { el.style.opacity = '0'; return; }
    const dp = tooltip.dataPoints && tooltip.dataPoints[0];
    if (dp) {
      const val = dp.parsed || 0;
      const total = dp.dataset.data.reduce((a, b) => a + b, 0);
      const pct = total > 0 ? (val / total * 100).toFixed(1) : '0.0';
      el.innerHTML =
        `<span class="donut-tip-label">${escapeHtml(dp.label)}</span>` +
        `<span class="donut-tip-val">${FMT.dollars(Math.round(val * 100))} · ${pct}%</span>`;
    }
    el.style.opacity = '1';
    el.style.left = tooltip.caretX + 'px';
    el.style.top = tooltip.caretY + 'px';
  }

  function renderDonut(allocation) {
    const stocks       = allocation.investment_stocks_cents ?? allocation.investment_cents ?? 0;
    const crypto       = allocation.investment_crypto_cents   || 0;
    const invCash      = allocation.investment_cash_cents     || 0;
    const collectibles = allocation.collectibles_cents        || 0;
    const cash         = allocation.cash_cents                || 0;
    const credit       = allocation.credit_cents              || 0;

    const slices = [
      { label: 'Stocks',       value: stocks },
      { label: 'Crypto',       value: crypto },
      { label: 'Collectibles', value: collectibles },
      { label: 'Cash',         value: cash },
      { label: 'Invest. cash', value: invCash },
    ].filter((s) => s.value > 0);

    const positiveTotal = slices.reduce((a, s) => a + s.value, 0);
    const colors = slices.map((s) => ALLOC_COLORS[s.label] || '#9aa4b0');

    const config = {
      type: 'doughnut',
      data: {
        labels: slices.map((s) => s.label),
        datasets: [{
          data: slices.map((s) => s.value / 100),
          backgroundColor: colors,
          borderWidth: 0,
          hoverOffset: 4,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '70%',
        animation: reducedMotion ? false : undefined,
        plugins: {
          legend: { display: false },
          // Canvas-drawn tooltips get clipped at the small donut's edges, so use
          // an HTML tooltip that can overflow the canvas (see .donut-tip CSS).
          tooltip: { enabled: false, external: donutExternalTooltip },
        },
      },
    };

    if (donutChart) {
      donutChart.data = config.data;
      donutChart.update('none');
    } else {
      if ($('donut-chart')) donutChart = new Chart($('donut-chart'), config);
    }

    // Legend
    const legend = $('allocation-legend');
    if (!legend) return;
    legend.innerHTML = '';
    for (let i = 0; i < slices.length; i++) {
      const s = slices[i];
      const pct = positiveTotal > 0 ? ((s.value / positiveTotal) * 100).toFixed(1) : '0.0';
      const li = document.createElement('li');
      li.innerHTML =
        `<span class="alloc-swatch" style="background:${colors[i]}"></span>` +
        `<span class="alloc-label">${s.label}</span>` +
        `<span class="alloc-amt">${FMT.dollars(s.value)}</span>` +
        `<span class="alloc-pct">${pct}%</span>`;
      legend.appendChild(li);
    }

    // Donut center
    const center = $('donut-center-val');
    if (center) center.textContent = fmtDollarsShort(positiveTotal + credit);

    // Alloc sub-label
    const sub = $('alloc-sub');
    if (sub) sub.textContent = `${slices.length} asset class${slices.length !== 1 ? 'es' : ''}`;

    // Update credit offset in KPI
    const creditEl = $('kpi-credit-val');
    if (creditEl) creditEl.textContent = credit !== 0 ? FMT.dollars(Math.abs(credit)) : '$0';
    // The "outstanding" descriptor already lives in the sub-label, so drop the
    // trend chip entirely to avoid showing "outstanding" twice.
    const creditTrend = $('kpi-credit-trend');
    if (creditTrend) creditTrend.style.display = 'none';

    // Investment KPI
    const totalInvest = stocks + crypto + invCash;
    const investEl = $('kpi-invest-val');
    if (investEl) investEl.textContent = FMT.dollars(totalInvest);
    const investPct = $('kpi-invest-pct');
    if (investPct && positiveTotal > 0) {
      const pctOfTotal = ((totalInvest / (positiveTotal + credit)) * 100).toFixed(1);
      investPct.textContent = pctOfTotal + '% of net worth';
      investPct.className = 'kpi-trend';
    }
  }

  // ---------------------------------------------------------------
  // Cash flow chart (Dashboard bottom row)
  // ---------------------------------------------------------------

  function renderCashflowChart(months) {
    const canvas = $('cashflow-chart');
    if (!canvas) return;
    const mono = cssVar('--font-mono');
    const inkSoft = cssVar('--ink-soft');
    const hairline = cssVar('--hairline');

    const labels = months.map((m) => {
      const d = new Date(m.month + '-01T00:00:00');
      return isNaN(d.getTime()) ? m.month : d.toLocaleDateString('en-US', { month: 'short' });
    });

    const incomes   = months.map((m) => m.income_cents   / 100);
    const expenses  = months.map((m) => m.expenses_cents / 100);

    const config = {
      type: 'bar',
      data: {
        labels,
        datasets: [
          {
            label: 'Income',
            data: incomes,
            backgroundColor: 'rgba(52,226,155,0.75)',
            borderRadius: { topLeft: 5, topRight: 5 },
            borderSkipped: 'bottom',
            maxBarThickness: 28,
          },
          {
            label: 'Expenses',
            data: expenses,
            backgroundColor: 'rgba(255,255,255,0.13)',
            borderRadius: { topLeft: 5, topRight: 5 },
            borderSkipped: 'bottom',
            maxBarThickness: 28,
          },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        animation: reducedMotion ? false : undefined,
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: 'rgba(12,16,21,0.92)',
            borderColor: 'rgba(255,255,255,0.12)', borderWidth: 1,
            titleColor: inkSoft, bodyColor: cssVar('--ink'),
            titleFont: { family: mono, size: 10 },
            bodyFont: { family: mono, size: 12 },
            displayColors: false,
            callbacks: { label: (item) => `${item.dataset.label} ${FMT.dollars(Math.round(item.parsed.y * 100))}` },
          },
        },
        scales: {
          x: { grid: { display: false }, border: { display: false }, ticks: { color: inkSoft, font: { family: mono, size: 9.5 } } },
          y: { grid: { color: hairline, drawTicks: false }, border: { display: false }, beginAtZero: true,
               ticks: { color: inkSoft, font: { family: mono, size: 9.5 }, maxTicksLimit: 4,
                        callback: (v) => '$' + Number(v).toLocaleString('en-US', { maximumFractionDigits: 0 }) } },
        },
      },
    };

    if (cashflowChart) {
      cashflowChart.data = config.data;
      cashflowChart.update('none');
    } else {
      cashflowChart = new Chart(canvas, config);
    }

    // Summary numbers
    const avgIncome  = incomes.length  ? incomes.reduce((a,b) => a+b, 0)  / incomes.length  : 0;
    const avgExpense = expenses.length ? expenses.reduce((a,b) => a+b, 0) / expenses.length : 0;
    const avgNet = avgIncome - avgExpense;

    const netEl = $('cf-net-avg');
    if (netEl) {
      netEl.textContent = (avgNet >= 0 ? '+' : '') + FMT.dollars(Math.round(avgNet * 100));
      netEl.className = 'cashflow-avg-val num ' + (avgNet >= 0 ? 'pos' : 'neg');
    }
    const incomeAvgEl = $('cf-income-avg');
    if (incomeAvgEl) incomeAvgEl.textContent = FMT.dollars(Math.round(avgIncome * 100));
    const expenseAvgEl = $('cf-expense-avg');
    if (expenseAvgEl) expenseAvgEl.textContent = FMT.dollars(Math.round(avgExpense * 100));
  }

  // ---------------------------------------------------------------
  // Spending tab
  // ---------------------------------------------------------------

  function monthLabel(ym) {
    const d = new Date(ym + '-01T00:00:00');
    return isNaN(d.getTime()) ? ym : d.toLocaleDateString('en-US', { month: 'short' });
  }

  function monthLabelLong(ym) {
    const d = new Date(ym + '-01T00:00:00');
    return isNaN(d.getTime()) ? ym : d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  }

  // Fill the spending month picker, newest first, selecting `selected`.
  function populateMonthSelect(months, selected) {
    const sel = $('month-select');
    if (!sel) return;
    sel.innerHTML = '';
    for (const m of [...months].reverse()) {
      const opt = document.createElement('option');
      opt.value = m.month;
      opt.textContent = monthLabelLong(m.month);
      if (m.month === selected) opt.selected = true;
      sel.appendChild(opt);
    }
  }

  // Render the category breakdown for a single month from a [{category,cents}] list.
  function renderCategoryList(byCategory) {
    const cats = byCategory || [];
    const top  = cats.slice(0, 8);
    const otherCents = cats.slice(8).reduce((a, c) => a + c.cents, 0);
    const rows = top.map((c) => ({ label: prettify(c.category), cents: c.cents }));
    if (otherCents > 0) rows.push({ label: 'Other', cents: otherCents });
    const totalSpend = rows.reduce((a, r) => a + r.cents, 0);
    const catMax     = rows.length ? Math.max(...rows.map((r) => r.cents)) : 1;

    const totalEl = $('month-spend-total');
    if (totalEl) totalEl.textContent = FMT.dollars(totalSpend);

    const list = $('category-list');
    if (!list) return;
    list.innerHTML = '';
    if (rows.length === 0) {
      list.innerHTML = '<p class="soft" style="font-size:13px;padding:16px 0">No spending recorded this month.</p>';
      return;
    }
    for (const r of rows) {
      const color = catColor(r.label);
      const pct   = totalSpend > 0 ? Math.round(r.cents / totalSpend * 100) : 0;
      const barW  = catMax > 0 ? (r.cents / catMax * 100) : 0;
      const div   = document.createElement('div');
      div.className = 'cat-row';
      div.innerHTML =
        `<div class="cat-row-head">
           <span class="cat-icon" style="color:${color}">${catIcon(r.label)}</span>
           <span class="cat-name">${escapeHtml(r.label)}</span>
           <span class="cat-amt">${FMT.dollars(r.cents)}</span>
           <span class="cat-pct">${pct}%</span>
         </div>
         <div class="cat-bar-track">
           <div class="cat-bar-fill" style="width:${barW}%;background:linear-gradient(90deg,${color}cc,${color})"></div>
         </div>`;
      list.appendChild(div);
    }
  }

  // Month picker change → show that month's category breakdown + transactions.
  function onMonthSelectChange() {
    const sel = $('month-select');
    if (!sel) return;
    selectedSpendMonth = sel.value;
    renderSelectedMonth();
  }

  // Render the category breakdown and transaction table for selectedSpendMonth.
  // The current month's breakdown rides along in the summary; older months and
  // the (always live) transaction list are fetched from the cache-backed API.
  async function renderSelectedMonth() {
    const month = selectedSpendMonth;
    if (!month) return;
    const months = (latestSpending && latestSpending.months) || [];
    const currentMonth = months.length ? months[months.length - 1].month : null;

    if (month === currentMonth && latestSpending && latestSpending.current_month) {
      renderCategoryList(latestSpending.current_month.by_category);
    } else {
      try {
        const data = await API.fetchJson(`/api/spending/by-category?month=${month}`);
        renderCategoryList(data.by_category);
      } catch {
        renderCategoryList([]);
      }
    }

    try {
      const data = await API.fetchJson(`/api/spending/transactions?month=${month}`);
      renderTransactions(data.transactions || [], month);
    } catch {
      renderTransactions([], month);
    }
  }

  // Re-fetch the spending summary fresh (server has recomputed totals after an
  // edit), refresh the SWR cache so the next load isn't stale, and re-render —
  // keeping the currently selected month. renderSpending() calls back into
  // renderSelectedMonth(), which re-pulls the edited month's category + txns.
  async function reloadSpendingAfterEdit() {
    try {
      const fresh = await API.fetchJson('/api/spending/summary?months=6');
      try { await window.bridge.setCache('GET /api/spending/summary?months=6', { data: fresh, cachedAt: new Date().toISOString() }); } catch {}
      renderSpending(fresh);
    } catch {
      // Network hiccup — leave the optimistic UI as-is; next load reconciles.
    }
  }

  function formatTxnDate(ymd) {
    const d = new Date(ymd + 'T00:00:00');
    return isNaN(d.getTime()) ? ymd : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  // Build one transaction row. `deleted` switches the trailing control between
  // a delete (trash) and a restore (undo) button.
  function buildTxnRow(t, deleted) {
    const row = document.createElement('div');
    row.className = 'txn-row';

    // Signed so an inflow (Plaid negative) reads as +income, an outflow as −spend.
    const signed = -t.amount_cents;
    const amtClass = signed >= 0 ? 'pos' : 'neg';
    const amtText = (signed >= 0 ? '+' : '−') + FMT.dollars(Math.abs(signed));

    // Make sure the current category is always an option even if non-standard.
    const cats = SPEND_CATEGORIES.includes(t.category)
      ? SPEND_CATEGORIES
      : [t.category, ...SPEND_CATEGORIES];
    const options = cats
      .map((c) => `<option value="${escapeHtml(c)}"${c === t.category ? ' selected' : ''}>${escapeHtml(prettify(c))}</option>`)
      .join('');

    const ctrl = deleted
      ? `<button class="txn-restore" title="Restore transaction" aria-label="Restore">
           <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>
         </button>`
      : `<button class="txn-del" title="Delete transaction" aria-label="Delete">
           <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m2 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M10 11v6M14 11v6"/></svg>
         </button>`;

    row.innerHTML =
      `<span class="txn-date">${escapeHtml(formatTxnDate(t.date))}</span>
       <div class="txn-main">
         <div class="txn-name">${escapeHtml(t.name || '—')}</div>
         <div class="txn-acct">${escapeHtml(t.account || '')}</div>
       </div>
       <select class="txn-cat-select${t.is_custom_category ? ' custom' : ''}" title="Recategorize">${options}</select>
       <span class="txn-amt ${amtClass}">${amtText}</span>
       ${ctrl}`;

    const select = row.querySelector('.txn-cat-select');
    if (select) {
      select.addEventListener('change', async () => {
        select.disabled = true;
        try {
          await API.putJson(`/api/spending/transactions/${encodeURIComponent(t.id)}/category`, { category: select.value });
          await reloadSpendingAfterEdit();
        } catch {
          select.disabled = false;
        }
      });
    }
    const btn = row.querySelector(deleted ? '.txn-restore' : '.txn-del');
    if (btn) {
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          if (deleted) await API.postJson(`/api/spending/transactions/${encodeURIComponent(t.id)}/restore`);
          else await API.del(`/api/spending/transactions/${encodeURIComponent(t.id)}`);
          await reloadSpendingAfterEdit();
        } catch {
          btn.disabled = false;
        }
      });
    }
    return row;
  }

  // Render the editable transaction table for one month (active rows + a
  // collapsible list of soft-deleted ones that can be restored).
  function renderTransactions(transactions, month) {
    const all = transactions || [];
    const active = all.filter((t) => !t.excluded);
    const deleted = all.filter((t) => t.excluded);

    const labelEl = $('txn-month-label');
    if (labelEl) labelEl.textContent = monthLabelLong(month);
    const countEl = $('txn-count');
    if (countEl) countEl.textContent = String(active.length);

    const list = $('txn-list');
    if (list) {
      list.innerHTML = '';
      if (active.length === 0) {
        list.innerHTML = '<p class="txn-empty">No transactions recorded this month.</p>';
      } else {
        for (const t of active) list.appendChild(buildTxnRow(t, false));
      }
    }

    const wrap = $('txn-deleted-wrap');
    const dList = $('txn-deleted-list');
    if (wrap && dList) {
      if (deleted.length === 0) {
        wrap.hidden = true;
        dList.innerHTML = '';
      } else {
        wrap.hidden = false;
        const lbl = $('txn-deleted-label');
        if (lbl) lbl.textContent = `Deleted (${deleted.length})`;
        dList.innerHTML = '';
        for (const t of deleted) dList.appendChild(buildTxnRow(t, true));
      }
    }
  }

  // Keyed on the clean category labels emitted by the server's categorizer.
  const CAT_COLORS = {
    'Food & Drink':      '#22d3ee',
    'Coffee':            '#f59e0b',
    'Groceries':         '#84cc16',
    'Travel':            '#a78bfa',
    'Transport':         '#38bdf8',
    'Shopping':          '#f472b6',
    'Entertainment':     '#818cf8',
    'Bills & Utilities': '#fbbf24',
    'Health':            '#34e29b',
    'Personal Care':     '#fb7185',
    'Services':          '#2dd4bf',
    'Fees':              '#9aa4b0',
    'Loan Payments':     '#9aa4b0',
    'P2P':               '#c084fc',
    'Bank Transfer':     '#60a5fa',
    'Income':            '#34e29b',
    'Transfer':          '#7c8694',
    'Credit Card Payment': '#7c8694',
    'Other':             '#5b6573',
  };

  function catColor(cat) {
    return CAT_COLORS[cat] || '#5b6573';
  }

  // Inner SVG (24×24, stroke=currentColor) per category label.
  const CAT_ICONS = {
    'Food & Drink':      '<path d="M3 2v7a3 3 0 0 0 6 0V2M6 9v13"/><path d="M16 2c-1.5 0-2.5 2-2.5 4.5S15 11 16 11v11"/>',
    'Coffee':            '<path d="M17 8h1a4 4 0 0 1 0 8h-1"/><path d="M3 8h14v9a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4z"/><path d="M6 1v2M10 1v2M14 1v2"/>',
    'Groceries':         '<circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.7 13.4a2 2 0 0 0 2 1.6h9.7a2 2 0 0 0 2-1.6L23 6H6"/>',
    'Travel':            '<path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4 20-7z"/>',
    'Transport':         '<path d="M3 13l1.5-5A2 2 0 0 1 6.4 6.7h11.2a2 2 0 0 1 1.9 1.3L21 13"/><path d="M3 13h18v4H3z"/><circle cx="7.5" cy="17.5" r="1.5"/><circle cx="16.5" cy="17.5" r="1.5"/>',
    'Shopping':          '<path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><path d="M3 6h18"/><path d="M16 10a4 4 0 0 1-8 0"/>',
    'Entertainment':     '<circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8"/>',
    'Bills & Utilities': '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',
    'Health':            '<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8l1.1 1.1L12 21l7.8-7.5 1-1.1a5.5 5.5 0 0 0 0-7.8z"/>',
    'Personal Care':     '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
    'Services':          '<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.8-2.8z"/>',
    'Fees':              '<line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>',
    'Loan Payments':     '<rect x="1" y="4" width="22" height="16" rx="2"/><path d="M1 10h22"/>',
    'P2P':               '<path d="M17 1l4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="M7 23l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>',
    'Bank Transfer':     '<path d="M3 21h18"/><path d="M5 21V10M19 21V10M9 21V10M15 21V10"/><path d="M12 3 3 8h18z"/>',
    'Other':             '<path d="M20.6 13.4 12 22l-9-9V3h10z"/><circle cx="7.5" cy="7.5" r="1.5"/>',
  };

  function catIcon(cat) {
    const inner = CAT_ICONS[cat] || CAT_ICONS['Other'];
    return `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
  }

  // Server now sends clean labels; only transform legacy ALL_CAPS values.
  function prettify(c) {
    const s = String(c);
    if (!s.includes('_')) return s;
    return s.replace(/_/g, ' ').toLowerCase().replace(/^./, (ch) => ch.toUpperCase());
  }

  function renderSpending(data) {
    latestSpending = data;
    const months = data.months || [];
    const cur    = data.current_month || { expenses_cents: 0, income_cents: 0, by_category: [] };

    // Spending tab KPIs
    const expEl = $('spend-month-figure');
    if (expEl) expEl.textContent = FMT.dollars(cur.expenses_cents);

    const incEl = $('qs-income');
    if (incEl) incEl.textContent = FMT.dollars(cur.income_cents);

    const daysInMonth = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate();
    const daysPassed  = Math.max(1, new Date().getDate());
    const dailyAvg = cur.expenses_cents / daysPassed;
    const dailyEl = $('qs-daily');
    if (dailyEl) dailyEl.textContent = FMT.dollars(Math.round(dailyAvg));

    const saved = cur.income_cents - cur.expenses_cents;
    const savedEl = $('qs-saved');
    if (savedEl) {
      savedEl.textContent = (saved >= 0 ? '+' : '') + FMT.dollars(saved);
      savedEl.className = 'kpi-val num ' + (saved >= 0 ? 'pos' : 'neg');
    }

    // Month picker + category list + transactions (defaults to the most recent
    // month; preserves the user's selection across edit-driven re-renders).
    const currentMonth = months.length ? months[months.length - 1].month : null;
    if (!selectedSpendMonth || !months.some((m) => m.month === selectedSpendMonth)) {
      selectedSpendMonth = currentMonth;
    }
    populateMonthSelect(months, selectedSpendMonth);
    renderSelectedMonth();

    // Rail KPIs on dashboard
    renderRailKpis(cur, months);

    // Cash flow chart on dashboard
    if (months.length > 0) renderCashflowChart(months);

    // Monthly spending chart (spending tab)
    renderSpendingChart(months);

    // AI insights (requires both current+spending data)
    if (latestCurrent) renderAiInsights(latestCurrent, data);
    // Coast-FI needs spending; recompute once spending lands (uses latestCurrent).
    renderCoastFi();
  }

  function renderSpendingChart(months) {
    const canvas = $('spending-chart');
    if (!canvas) return;
    const mono    = cssVar('--font-mono');
    const inkSoft = cssVar('--ink-soft');
    const hairline = cssVar('--hairline');

    const config = {
      type: 'bar',
      data: {
        labels: months.map((m) => monthLabel(m.month)),
        datasets: [
          {
            label: 'Income',
            data: months.map((m) => m.income_cents / 100),
            backgroundColor: 'rgba(52,226,155,0.75)',
            borderRadius: { topLeft: 6, topRight: 6 }, borderSkipped: 'bottom', maxBarThickness: 36,
          },
          {
            label: 'Expenses',
            data: months.map((m) => m.expenses_cents / 100),
            backgroundColor: 'rgba(255,255,255,0.13)',
            borderRadius: { topLeft: 6, topRight: 6 }, borderSkipped: 'bottom', maxBarThickness: 36,
          },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        animation: reducedMotion ? false : undefined,
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: 'rgba(12,16,21,0.92)', borderColor: 'rgba(255,255,255,0.12)', borderWidth: 1,
            titleColor: inkSoft, bodyColor: cssVar('--ink'),
            titleFont: { family: mono, size: 10 }, bodyFont: { family: mono, size: 12 },
            displayColors: false,
            callbacks: { label: (item) => `${item.dataset.label} ${FMT.dollars(Math.round(item.parsed.y * 100))}` },
          },
        },
        scales: {
          x: { grid: { display: false }, border: { display: false }, ticks: { color: inkSoft, font: { family: mono, size: 11 } } },
          y: { grid: { color: hairline, drawTicks: false }, border: { display: false }, beginAtZero: true,
               ticks: { color: inkSoft, font: { family: mono, size: 11 }, maxTicksLimit: 4,
                        callback: (v) => '$' + Number(v).toLocaleString('en-US', { maximumFractionDigits: 0 }) } },
        },
      },
    };
    if (spendingChart) {
      spendingChart.data = config.data;
      spendingChart.update('none');
    } else {
      spendingChart = new Chart(canvas, config);
    }
  }

  // ---------------------------------------------------------------
  // Rail KPIs
  // ---------------------------------------------------------------

  function makeBars(container, valuesRaw) {
    if (!container) return;
    container.innerHTML = '';
    const max = Math.max(...valuesRaw, 1);
    valuesRaw.forEach((v, i) => {
      const bar = document.createElement('div');
      bar.className = 'mini-bar';
      const h = Math.max(10, (v / max) * 100);
      const isLast = i === valuesRaw.length - 1;
      bar.style.cssText = `height:${h}%; background:${isLast ? '#34e29b' : 'rgba(255,255,255,0.12)'};`;
      container.appendChild(bar);
    });
  }

  function renderRailKpis(cur, months) {
    const expCents = cur.expenses_cents || 0;
    const incCents = cur.income_cents   || 0;

    // Monthly spend
    const spendEl = $('rail-spend');
    if (spendEl) spendEl.textContent = FMT.dollars(expCents);

    // Savings rate
    const savingsRate = incCents > 0 ? Math.round((incCents - expCents) / incCents * 100) : 0;
    const savingsEl = $('rail-savings');
    if (savingsEl) savingsEl.textContent = savingsRate + '%';
    const savingsBadge = $('rail-savings-badge');
    if (savingsBadge) {
      savingsBadge.textContent = savingsRate >= 20 ? 'On track' : 'Below target';
      savingsBadge.className = 'trend-badge ' + (savingsRate >= 20 ? 'pos' : 'neg');
    }

    // Free cash flow
    const fcf = incCents - expCents;
    const fcfEl = $('rail-fcf');
    if (fcfEl) fcfEl.textContent = (fcf >= 0 ? '+' : '') + FMT.dollars(fcf);
    const fcfBadge = $('rail-fcf-badge');
    if (fcfBadge) {
      fcfBadge.textContent = fcf >= 0 ? 'Positive' : 'Negative';
      fcfBadge.className = 'trend-badge ' + (fcf >= 0 ? 'pos' : 'neg');
    }

    // Mini bars from monthly history
    const expHistory = months.slice(-9).map(m => m.expenses_cents);
    const incHistory = months.slice(-9).map(m => m.income_cents);
    const fcfHistory = months.slice(-9).map(m => Math.max(0, m.income_cents - m.expenses_cents));
    if (expHistory.length) {
      makeBars($('rail-spend-bars'), expHistory);
      makeBars($('rail-savings-bars'), incHistory.map((inc, i) => Math.max(0, inc - (expHistory[i] || 0))));
      makeBars($('rail-fcf-bars'), fcfHistory);
    }

    // Spend trend badge
    if (months.length >= 2) {
      const prev = months[months.length - 2].expenses_cents;
      const curr = months[months.length - 1].expenses_cents;
      const diff = prev > 0 ? ((curr - prev) / prev * 100).toFixed(1) : 0;
      const badge = $('rail-spend-badge');
      if (badge) {
        badge.textContent = (diff >= 0 ? '+' : '') + diff + '%';
        badge.className = 'trend-badge ' + (diff <= 0 ? 'pos' : 'neg');
      }
    }

    // Burn rate KPI
    const burnEl = $('kpi-burn-val');
    if (burnEl) burnEl.textContent = FMT.dollars(expCents) + '/mo';
    const burnTrend = $('kpi-burn-trend');
    if (burnTrend && months.length > 0) {
      const avg = months.reduce((a, m) => a + m.expenses_cents, 0) / months.length;
      const diff = avg > 0 ? ((expCents - avg) / avg * 100).toFixed(1) : 0;
      burnTrend.textContent = (diff >= 0 ? '+' : '') + diff + '% vs avg';
      burnTrend.className = 'kpi-trend ' + (diff <= 0 ? 'pos' : 'neg');
    }
  }

  // ---------------------------------------------------------------
  // Current net worth — hero + KPI strip
  // ---------------------------------------------------------------

  function renderCurrent(data, meta) {
    latestCurrent = data;
    const total    = data.total_cents;
    const figure   = FMT.dollars(total, { dropCents: Math.abs(total) >= 100000 * 100 });

    const heroEl = $('hero-figure');
    if (heroEl) heroEl.textContent = figure;

    const delta   = data.delta_7d_cents;
    const pctNum  = Number(data.delta_7d_pct);
    const badge   = $('hero-growth-badge');
    if (badge) {
      const arrow = delta >= 0 ? '▲' : '▼';
      const sign  = delta >= 0 ? '+' : '−';
      badge.textContent = `${arrow} ${sign}${Math.abs(pctNum).toFixed(1)}%`;
      badge.className = 'growth-badge ' + (delta >= 0 ? 'pos' : 'neg');
      badge.style.background = delta >= 0 ? 'rgba(52,226,155,0.14)' : 'rgba(248,113,113,0.14)';
      badge.style.color      = delta >= 0 ? '#34e29b' : '#f87171';
      badge.hidden = false;
    }

    const sub = $('hero-sub');
    if (sub) {
      const sign = delta >= 0 ? '+' : '−';
      sub.textContent = `${sign}${FMT.dollars(Math.abs(delta))} past 7 days`;
      if (data.last_refresh) {
        const staleSuffix = meta && meta.fromCache ? ' · cached' : '';
        sub.textContent += ` · refreshed ${FMT.shortWhen(data.last_refresh)}${staleSuffix}`;
      }
    }

    // Refreshed-at in summary and networth tabs
    const rAt = $('refreshed-at');
    if (rAt && data.last_refresh) {
      rAt.textContent = 'refreshed ' + FMT.shortWhen(data.last_refresh) + (meta && meta.fromCache ? ' · cached' : '');
    }
    const nwRAt = $('nw-refreshed-at');
    if (nwRAt && data.last_refresh) {
      nwRAt.textContent = 'refreshed ' + FMT.shortWhen(data.last_refresh) + (meta && meta.fromCache ? ' · cached' : '');
    }

    // Collectibles value in settings
    const collectrValEl = $('collectr-value');
    if (collectrValEl) {
      const cb = data.allocation && data.allocation.collectibles_cents;
      collectrValEl.textContent = cb ? FMT.dollars(cb) : '—';
    }

    renderDonut(data.allocation);
    renderKpiStrip(data);
    renderSummaryPage(data);
    renderHealthScore(data);

    if (latestSpending) renderAiInsights(data, latestSpending);
  }

  // ---------------------------------------------------------------
  // KPI strip (4 cards on dashboard)
  // ---------------------------------------------------------------

  function renderKpiStrip(data) {
    const total = data.total_cents;
    const delta7d = data.delta_7d_cents;

    // YTD growth — approximate from 7d delta (will improve if we have series)
    const ytdEl = $('kpi-ytd-val');
    if (ytdEl) ytdEl.textContent = (delta7d >= 0 ? '+' : '') + FMT.dollars(delta7d);
    const ytdPct = $('kpi-ytd-pct');
    if (ytdPct) {
      const pct = Number(data.delta_7d_pct);
      ytdPct.textContent = (pct >= 0 ? '+' : '') + pct.toFixed(1) + '%';
      ytdPct.className = 'kpi-trend ' + (pct >= 0 ? 'pos' : 'neg');
    }
    const ytdSub = $('kpi-ytd-sub');
    if (ytdSub) ytdSub.textContent = 'past 7 days';

    // Set glow on KPI cards via CSS custom property
    const kpiCards = document.querySelectorAll('.kpi-card');
    const glows = ['rgba(52,226,155,0.16)', 'rgba(34,211,238,0.16)', 'rgba(255,255,255,0.05)', 'rgba(34,211,238,0.13)'];
    kpiCards.forEach((card, i) => {
      if (glows[i]) card.style.setProperty('--kpi-glow', glows[i]);
    });
  }

  // ---------------------------------------------------------------
  // Summary page
  // ---------------------------------------------------------------

  function renderSummaryPage(data) {
    const alloc = data.allocation;
    const stocks       = alloc.investment_stocks_cents ?? alloc.investment_cents ?? 0;
    const crypto       = alloc.investment_crypto_cents  || 0;
    const invCash      = alloc.investment_cash_cents    || 0;
    const collectibles = alloc.collectibles_cents       || 0;
    const cash         = alloc.cash_cents               || 0;
    const credit       = Math.abs(alloc.credit_cents    || 0);

    const totalAssets = stocks + crypto + invCash + collectibles + cash;
    const totalLiab   = credit;
    const netWorth    = data.total_cents;

    // Totals
    const taEl = $('total-assets');
    if (taEl) taEl.textContent = FMT.dollars(totalAssets);
    const tlEl = $('total-liabilities');
    if (tlEl) tlEl.textContent = FMT.dollars(totalLiab);

    // Balance rows
    const rowsEl = $('balance-rows');
    if (rowsEl) {
      const defs = [
        { label: 'Stocks & ETFs',     value: stocks,       color: '#34e29b', isAsset: true },
        { label: 'Cash & savings',     value: cash,         color: '#38bdf8', isAsset: true },
        { label: 'Investments (cash)', value: invCash,      color: '#2dd4bf', isAsset: true },
        { label: 'Crypto',             value: crypto,       color: '#818cf8', isAsset: true },
        { label: 'Collectibles',       value: collectibles, color: '#f0abfc', isAsset: true },
        { label: 'Credit cards',       value: -credit,      color: '#f87171', isAsset: false },
      ].filter(d => d.value !== 0);

      const maxAbs = Math.max(...defs.map(d => Math.abs(d.value)), 1);
      rowsEl.innerHTML = '';
      for (const d of defs) {
        const w = (Math.abs(d.value) / maxAbs * 100).toFixed(1);
        const barColor = d.isAsset
          ? `linear-gradient(90deg, ${d.color}aa, ${d.color})`
          : 'linear-gradient(90deg, #f8717188, #f87171)';
        const fg = d.isAsset ? 'var(--ink)' : 'var(--neg)';
        const sign = d.isAsset ? '' : '−';
        const row = document.createElement('div');
        row.className = 'balance-row';
        row.innerHTML =
          `<span class="balance-row-label">${escapeHtml(d.label)}</span>
           <div class="balance-row-bar-track"><div class="balance-row-bar" style="width:${w}%;background:${barColor}"></div></div>
           <span class="balance-row-amt num" style="color:${fg}">${sign}${FMT.dollars(Math.abs(d.value))}</span>`;
        rowsEl.appendChild(row);
      }
    }

    // Projections — flat assumed growth rate (see ASSUMED_ANNUAL_GROWTH).
    const projEl = $('proj-list');
    if (projEl) {
      const annualRate = ASSUMED_ANNUAL_GROWTH;
      const nw = netWorth / 100;

      const projSub = $('proj-sub');
      if (projSub) projSub.textContent = `Assuming ${(annualRate * 100).toFixed(0)}% annual growth`;

      const projs = [
        { yr: '+1y', label: 'Projected net worth · 1 year',  value: nw * (1 + annualRate),           mult: `${(1 + annualRate).toFixed(2)}×` },
        { yr: '+3y', label: 'Projected net worth · 3 years', value: nw * Math.pow(1 + annualRate, 3), mult: `${Math.pow(1 + annualRate, 3).toFixed(2)}×` },
        { yr: '+5y', label: 'Projected net worth · 5 years', value: nw * Math.pow(1 + annualRate, 5), mult: `${Math.pow(1 + annualRate, 5).toFixed(2)}×` },
      ];

      projEl.innerHTML = '';
      for (const p of projs) {
        const item = document.createElement('div');
        item.className = 'proj-item';
        item.innerHTML =
          `<div class="proj-yr">${p.yr}</div>
           <div class="proj-body">
             <div class="proj-label">${p.label}</div>
             <div class="proj-value num">${FMT.dollars(Math.round(p.value * 100))}</div>
           </div>
           <div class="proj-mult">${p.mult}</div>`;
        projEl.appendChild(item);
      }
    }

    renderCoastFi(netWorth / 100);
  }

  // Coast-FI: the age at which today's net worth, left to grow at the assumed
  // rate with no further contributions, reaches 25× your annual spend (the 4%
  // rule). Uses your average monthly spend from completed months.
  function renderCoastFi(netWorthDollars) {
    const ageEl    = $('coastfi-age');
    const detailEl = $('coastfi-detail');
    if (!ageEl || !detailEl) return;

    // Fall back to the latest known net worth (e.g. when re-rendered after an
    // age edit, outside the projections render path).
    if (netWorthDollars == null) {
      if (!latestCurrent) return;
      netWorthDollars = latestCurrent.total_cents / 100;
    }

    const age = getAge();
    const months = (latestSpending && latestSpending.months) || [];
    // Average completed months only (drop the current, partial month).
    const completed = months.slice(0, -1).filter((m) => m.expenses_cents > 0);
    const avgMonthly = completed.length
      ? completed.reduce((a, m) => a + m.expenses_cents, 0) / completed.length / 100
      : 0;
    const annualSpend = avgMonthly * 12;
    const fiTarget = annualSpend * 25; // 4% rule

    if (!age) {
      ageEl.textContent = '—';
      detailEl.textContent = 'Enter your age below to project a retirement age';
      return;
    }
    if (annualSpend <= 0) {
      ageEl.textContent = '—';
      detailEl.textContent = 'Need spending history to estimate your FI number';
      return;
    }
    if (netWorthDollars >= fiTarget) {
      ageEl.textContent = age + ' 🎉';
      detailEl.textContent = `You're already Coast-FI — net worth covers 25× your ${FMT.dollars(Math.round(annualSpend * 100))}/yr spend`;
      return;
    }

    const r = ASSUMED_ANNUAL_GROWTH;
    const years = Math.log(fiTarget / netWorthDollars) / Math.log(1 + r);
    const retireAge = Math.ceil(age + years);
    ageEl.textContent = String(retireAge);
    detailEl.textContent =
      `In ~${Math.ceil(years)} yrs, ${FMT.dollars(Math.round(netWorthDollars * 100))} grows to your `
      + `${FMT.dollars(Math.round(fiTarget * 100))} FI number (25× ${FMT.dollars(Math.round(annualSpend * 100))}/yr) at ${(r * 100).toFixed(0)}%`;
  }

  // ---------------------------------------------------------------
  // AI insights
  // ---------------------------------------------------------------

  function renderAiInsights(current, spending) {
    const container = $('ai-insights');
    if (!container) return;

    const cur = spending.current_month || {};
    const months = spending.months || [];
    const income  = cur.income_cents   || 0;
    const expense = cur.expenses_cents || 0;
    const savingsRate = income > 0 ? Math.round((income - expense) / income * 100) : 0;
    const netWorth = current.total_cents / 100;
    const delta7d  = current.delta_7d_cents / 100;

    const insights = [];

    // Spending alert
    if (months.length >= 2) {
      const prev = months[months.length - 2].expenses_cents;
      const curr = months[months.length - 1].expenses_cents;
      if (prev > 0 && curr > prev * 1.1) {
        const pct = Math.round((curr - prev) / prev * 100);
        insights.push({
          tag: 'Alert', tagFg: '#fbbf24', tagBg: 'rgba(251,191,36,0.14)', bd: 'rgba(251,191,36,0.18)',
          text: `<b>Spending is up ${pct}%</b> vs last month. Consider reviewing your largest categories.`,
        });
      }
    }

    // Savings rate insight
    if (income > 0) {
      const qual = savingsRate >= 20 ? 'healthy' : savingsRate >= 10 ? 'moderate' : 'low';
      insights.push({
        tag: 'Insight', tagFg: '#34e29b', tagBg: 'rgba(52,226,155,0.14)', bd: 'rgba(52,226,155,0.18)',
        text: `Your <b>savings rate is ${savingsRate}%</b> — ${qual}. Net worth ${delta7d >= 0 ? 'grew' : 'dropped'} ${FMT.dollars(Math.abs(current.delta_7d_cents))} this week.`,
      });
    }

    // Forecast
    const deltaAnn = delta7d / 7 * 365;
    if (deltaAnn > 0) {
      const target = Math.ceil(netWorth / 50000) * 50000 + 50000;
      const yearsTo = (target - netWorth) / deltaAnn;
      const targetDate = new Date();
      targetDate.setFullYear(targetDate.getFullYear() + Math.round(yearsTo));
      insights.push({
        tag: 'Forecast', tagFg: '#22d3ee', tagBg: 'rgba(34,211,238,0.14)', bd: 'rgba(34,211,238,0.18)',
        text: `At this pace you could reach <b>$${(target / 1000).toFixed(0)}k by ${targetDate.getFullYear()}</b>. Maximising tax-advantaged accounts can accelerate this.`,
      });
    }

    if (insights.length === 0) {
      insights.push({
        tag: 'Info', tagFg: '#9aa4b0', tagBg: 'rgba(255,255,255,0.06)', bd: 'rgba(255,255,255,0.08)',
        text: 'Connect accounts and sync data to see personalised insights here.',
      });
    }

    container.innerHTML = '';
    for (const ins of insights) {
      const card = document.createElement('div');
      card.className = 'ai-insight-card';
      card.style.borderColor = ins.bd;
      card.innerHTML =
        `<span class="ai-tag" style="color:${ins.tagFg};background:${ins.tagBg}">${ins.tag}</span>
         <div class="ai-text">${ins.text}</div>`;
      container.appendChild(card);
    }
  }

  // Answer a free-text money question locally from the loaded data and prepend
  // it to the insights list. Heuristic (keyword-based), not a live model.
  function answerMoneyQuestion(q) {
    const container = $('ai-insights');
    if (!container) return;
    const card = document.createElement('div');
    card.className = 'ai-insight-card';
    card.style.borderColor = 'rgba(34,211,238,0.18)';
    card.innerHTML =
      `<span class="ai-tag" style="color:#22d3ee;background:rgba(34,211,238,0.14)">Answer</span>
       <div class="ai-text"><div class="ai-q">“${escapeHtml(q)}”</div>${buildMoneyAnswer(q)}</div>`;
    container.insertBefore(card, container.firstChild);
  }

  function buildMoneyAnswer(q) {
    const ql = q.toLowerCase();
    const has = (...ks) => ks.some((k) => ql.includes(k));
    const cur = (latestSpending && latestSpending.current_month) || {};
    const cats = cur.by_category || [];
    const income = cur.income_cents || 0;
    const expense = cur.expenses_cents || 0;
    const nw = latestCurrent ? latestCurrent.total_cents : null;
    const d7 = latestCurrent ? (latestCurrent.delta_7d_cents || 0) : 0;

    if (nw == null && !latestSpending) return 'Your data isn’t loaded yet — give it a moment to sync.';

    if (has('net worth', 'networth', 'worth', 'how much do i have', 'total')) {
      if (nw == null) return 'Net worth isn’t loaded yet.';
      return `Your net worth is <b>${FMT.dollars(nw)}</b>, ${d7 >= 0 ? 'up' : 'down'} ${FMT.dollars(Math.abs(d7))} this week.`;
    }
    if (has('savings rate', 'save', 'saving')) {
      if (income <= 0) return 'No income is recorded this month, so I can’t compute a savings rate.';
      const rate = Math.round((income - expense) / income * 100);
      return `You saved <b>${FMT.dollars(income - expense)}</b> this month — a <b>${rate}%</b> savings rate.`;
    }
    if (has('income', 'earn', 'salary', 'make')) {
      return `Income this month is <b>${FMT.dollars(income)}</b>.`;
    }
    if (has('top', 'biggest', 'largest', 'most', 'category', 'categories')) {
      if (!cats.length) return 'No categorised spending this month yet.';
      return `Your biggest category this month is <b>${prettify(cats[0].category)}</b> at <b>${FMT.dollars(cats[0].cents)}</b>.`;
    }
    if (has('spend', 'spent', 'expense')) {
      const topStr = cats.length ? ` Top category: <b>${prettify(cats[0].category)}</b> (${FMT.dollars(cats[0].cents)}).` : '';
      return `You’ve spent <b>${FMT.dollars(expense)}</b> this month.${topStr}`;
    }
    if (has('retire', 'coast', 'financial independence', ' fi')) {
      const age = getAge();
      if (!age) return 'Set your age in the Summary tab and I’ll project your Coast-FI retirement age.';
      return `Check the Summary tab — your projected Coast-FI age is there, based on 25× your average spend growing at ${(ASSUMED_ANNUAL_GROWTH * 100).toFixed(0)}%.`;
    }
    if (has('invest', 'stock', 'crypto', 'allocation', 'portfolio')) {
      const a = (latestCurrent && latestCurrent.allocation) || {};
      const inv = a.investment_cents || 0;
      const cryptoStr = a.investment_crypto_cents ? `, including ${FMT.dollars(a.investment_crypto_cents)} crypto` : '';
      return `You hold <b>${FMT.dollars(inv)}</b> in investments${cryptoStr}.`;
    }
    const rate = income > 0 ? Math.round((income - expense) / income * 100) : 0;
    return `Snapshot: net worth <b>${nw != null ? FMT.dollars(nw) : '—'}</b>, spent <b>${FMT.dollars(expense)}</b> this month, savings rate <b>${rate}%</b>. Try asking about your net worth, spending, savings rate, top category, or retirement.`;
  }

  // ---------------------------------------------------------------
  // Health score (sidebar)
  // ---------------------------------------------------------------

  function renderHealthScore(data) {
    const alloc   = data.allocation;
    const netWorth = data.total_cents;
    if (!latestSpending) return;
    const cur    = latestSpending.current_month || {};
    const income = cur.income_cents   || 0;
    const expense = cur.expenses_cents || 0;

    let score = 50;
    const savingsRate = income > 0 ? (income - expense) / income : 0;
    score += Math.min(30, savingsRate * 150);   // up to +30 for savings rate
    if (netWorth > 0) score += Math.min(20, (netWorth / 100) / 10000); // small bonus for net worth
    const credit = Math.abs(alloc.credit_cents || 0);
    if (credit > 0 && income > 0) score -= Math.min(20, credit / (income / 100) * 5);

    score = Math.max(0, Math.min(100, Math.round(score)));

    const numEl = $('health-number');
    if (numEl) numEl.textContent = score;
    const fillEl = $('health-fill');
    if (fillEl) fillEl.style.width = score + '%';
    const statusEl = $('health-status');
    if (statusEl) {
      if      (score >= 80) statusEl.textContent = 'Excellent — great financial health.';
      else if (score >= 60) statusEl.textContent = 'Good — a few areas to improve.';
      else if (score >= 40) statusEl.textContent = 'Fair — focus on savings rate.';
      else                  statusEl.textContent  = 'Needs attention — review expenses.';
    }
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
    if (!tbody) return;
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
        const when = a.last_updated
          ? (status === 'ok' ? FMT.shortWhen(a.last_updated + 'T12:00:00') : FMT.shortDate(a.last_updated))
          : '';
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
    dataIsEmpty = isEmpty;
    // Re-apply current tab so the empty state shows/hides correctly without
    // blocking navigation to other tabs.
    setActiveTab(currentTab);
  }

  // ---------------------------------------------------------------
  // Sidebar tabs
  // ---------------------------------------------------------------

  const TAB_IDS   = ['dashboard', 'networth', 'spending', 'summary', 'settings'];
  const TAB_TITLES = {
    dashboard: 'Net Worth Overview',
    networth:  'Net Worth History',
    spending:  'Spending & Budget',
    summary:   'Financial Summary',
    settings:  'Settings',
  };

  function setActiveTab(tab) {
    currentTab = tab;

    // Empty state only takes over the Dashboard tab; other tabs always render
    // so navigation works even before any data is connected.
    const showEmpty = dataIsEmpty && tab === 'dashboard';
    $('empty-state').hidden = !showEmpty;
    $('dashboard').hidden = false;

    for (const id of TAB_IDS) {
      const el = $(`tab-${id}`);
      if (el) el.hidden = showEmpty || id !== tab;
    }
    document.querySelectorAll('.nav-btn').forEach((btn) => {
      const active = btn.dataset.tab === tab;
      btn.classList.toggle('active', active);
      if (active) btn.setAttribute('aria-current', 'page');
      else        btn.removeAttribute('aria-current');
    });

    const titleEl = $('page-title');
    if (titleEl) titleEl.textContent = TAB_TITLES[tab] || '';

    // Create history chart on first visit to summary tab
    if (tab === 'summary' && !historyChart && $('history-chart')) {
      if (seriesChart) {
        historyChart = new Chart($('history-chart'),
          seriesChartConfig(seriesChart.data.labels, seriesChart.data.datasets[0].data, false)
        );
      }
    }

    // Create nwChart on first visit to networth tab
    if (tab === 'networth' && !nwChart && $('nw-chart')) {
      if (seriesChart) {
        nwChart = new Chart($('nw-chart'),
          seriesChartConfig(seriesChart.data.labels, seriesChart.data.datasets[0].data, false)
        );
      }
      if (latestSeries) renderNetWorthStats(latestSeries);
    }

    // Resize all charts after tab switch
    for (const c of [seriesChart, historyChart, nwChart, donutChart, cashflowChart, spendingChart]) {
      if (c) c.resize();
    }
  }

  // ---------------------------------------------------------------
  // Settings: preferences
  // ---------------------------------------------------------------

  function renderPrefs() {
    const list = $('pref-list');
    if (!list) return;
    const defs = [
      {
        key: 'alerts',
        label: 'Spending alerts',
        desc: 'Notify on unusual spending activity',
        icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>',
      },
      {
        key: 'autoCat',
        label: 'Auto-categorize',
        desc: 'AI tags transactions automatically',
        icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M20.6 13.4 12 22l-9-9V3h10z"/><circle cx="7.5" cy="7.5" r="1"/></svg>',
      },
      {
        key: 'privacy',
        label: 'Privacy mode',
        desc: 'Blur balances on screen',
        icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>',
      },
    ];

    list.innerHTML = '';
    for (const d of defs) {
      const row = document.createElement('div');
      row.className = 'pref-row';
      row.setAttribute('role', 'button');
      row.setAttribute('aria-pressed', prefs[d.key] ? 'true' : 'false');
      const on = prefs[d.key];
      row.innerHTML =
        `<span class="pref-icon">${d.icon}</span>
         <div class="pref-text">
           <div class="pref-label">${d.label}</div>
           <div class="pref-desc">${d.desc}</div>
         </div>
         <div class="pref-toggle ${on ? 'on' : 'off'}"><div class="pref-thumb"></div></div>`;
      row.addEventListener('click', () => {
        prefs[d.key] = !prefs[d.key];
        row.setAttribute('aria-pressed', prefs[d.key] ? 'true' : 'false');
        const toggle = row.querySelector('.pref-toggle');
        toggle.classList.toggle('on',  prefs[d.key]);
        toggle.classList.toggle('off', !prefs[d.key]);
        // Privacy applies immediately and persists (no Save needed).
        if (d.key === 'privacy') {
          applyPrivacy(prefs.privacy);
          localStorage.setItem(PREF_KEY, JSON.stringify(prefs));
        }
      });
      list.appendChild(row);
    }

    const saveBtn = $('pref-save');
    if (saveBtn) {
      saveBtn.addEventListener('click', () => {
        localStorage.setItem(PREF_KEY, JSON.stringify(prefs));
        saveBtn.textContent = 'Saved ✓';
        setTimeout(() => { saveBtn.textContent = 'Save changes'; }, 2000);
      });
    }

    const exportBtn2 = $('export-csv-2');
    if (exportBtn2) exportBtn2.addEventListener('click', exportCsv);
  }

  // ---------------------------------------------------------------
  // Settings: Plaid item actions
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
    if (!wrap) return;
    wrap.innerHTML = '';
    const items = uniqueItems();
    for (const item of items) {
      const name = item.institution || 'Bank';
      const initial = name.trim().charAt(0).toUpperCase() || '?';
      const row = document.createElement('div');
      row.className = 'bank-row';

      const meta = document.createElement('div');
      meta.className = 'bank-meta';
      meta.innerHTML =
        `<span class="bank-avatar">${escapeHtml(initial)}</span>
         <div class="bank-text">
           <div class="bank-name">${escapeHtml(name)}</div>
           <div class="bank-status ${item.needsReauth ? 'warn' : 'ok'}">
             <span class="bank-dot"></span>${item.needsReauth ? 'Needs reconnect' : 'Connected'}
           </div>
         </div>`;
      row.appendChild(meta);

      const actions = document.createElement('div');
      actions.className = 'bank-actions';
      if (item.needsReauth) {
        const re = document.createElement('button');
        re.className = 'btn-text';
        re.textContent = 'Reconnect';
        re.addEventListener('click', () => reconnectItem(item.itemId));
        actions.appendChild(re);
      }
      const del = document.createElement('button');
      del.className = 'btn-danger';
      del.textContent = 'Disconnect';
      del.addEventListener('click', () => beginDisconnect(item));
      actions.appendChild(del);
      row.appendChild(actions);

      wrap.appendChild(row);
    }
  }

  function beginDisconnect(item) {
    pendingDisconnect = item;
    $('disconnect-confirm-text').textContent =
      `Deletes connection, token, and history. Type "${item.institution}" to confirm.`;
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
    } catch {
      showGlobalError('Disconnect failed — try again.', null, null);
    } finally {
      btn.textContent = 'Disconnect & delete';
    }
  }

  // ---------------------------------------------------------------
  // Plaid Link
  // ---------------------------------------------------------------

  let hostedPollTimer = null;

  function pollHostedSession(onDone) {
    if (hostedPollTimer) clearInterval(hostedPollTimer);
    const startedAt = Date.now();
    hostedPollTimer = setInterval(async () => {
      if (Date.now() - startedAt > 15 * 60 * 1000) {
        clearInterval(hostedPollTimer); hostedPollTimer = null; return;
      }
      try {
        const result = await API.hostedStatus();
        if (result.status === 'connected') {
          clearInterval(hostedPollTimer); hostedPollTimer = null;
          await onDone();
        } else if (result.status === 'exited') {
          clearInterval(hostedPollTimer); hostedPollTimer = null;
        }
      } catch { /* keep polling */ }
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
    } catch {
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
    } catch {
      showGlobalError('Could not start the reconnect flow — try again.', null, null);
    }
  }

  // ---------------------------------------------------------------
  // Refresh / export / manual collectibles / API URL
  // ---------------------------------------------------------------

  async function manualRefresh() {
    const btn = $('refresh-btn');
    btn.disabled = true;
    btn.classList.add('spinning');
    try {
      await API.refresh(false);
      await loadAll();
    } catch {
      showGlobalError('Refresh failed — check that the local server is running.', 'Retry', manualRefresh);
    } finally {
      btn.disabled = false;
      btn.classList.remove('spinning');
    }
  }

  async function exportCsv() {
    try {
      const res = await fetch(API.exportCsvUrl());
      if (!res.ok) throw new Error('export failed');
      const blob = await res.blob();
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href = url; a.download = 'networth-export.csv';
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
    } catch {
      showGlobalError('Export failed — check that the local server is running.', null, null);
    }
  }

  async function loadPlaidStatus() {
    const el = $('plaid-status');
    if (!el || !window.bridge || !window.bridge.getServerEnvStatus) return;
    try {
      const status = await window.bridge.getServerEnvStatus();
      if (status.plaidConfigured) {
        el.innerHTML = `<span class="dot ok"></span> Configured · ${escapeHtml(status.plaidEnv)}` +
          (status.clientIdHint ? ` · ${escapeHtml(status.clientIdHint)}` : '');
      } else {
        el.innerHTML = '<span class="dot stale"></span> Not configured';
      }
      const envSel = $('plaid-env');
      if (envSel && status.plaidEnv) envSel.value = status.plaidEnv;
    } catch {
      el.innerHTML = '<span class="dot error"></span> Unavailable';
    }
  }

  async function savePlaidCreds() {
    const clientId = $('plaid-client-id').value.trim();
    const secret   = $('plaid-secret').value.trim();
    const env      = $('plaid-env').value;
    const statusEl = $('plaid-save-status');
    if (!clientId || !secret) {
      statusEl.textContent = 'Enter both client ID and secret.';
      return;
    }
    const btn = $('plaid-save');
    if (btn) btn.disabled = true;
    statusEl.textContent = 'Saving & restarting server…';
    try {
      await window.bridge.setServerEnv({
        PLAID_CLIENT_ID: clientId,
        PLAID_SECRET: secret,
        PLAID_ENV: env,
      });
      // Give the restarted server a moment to rebind the port.
      await new Promise((r) => setTimeout(r, 1800));
      $('plaid-secret').value = '';
      statusEl.textContent = 'Saved ✓ — you can now Connect bank.';
      await loadPlaidStatus();
      await loadAll();
    } catch {
      statusEl.textContent = 'Save failed — try again.';
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  // ---------------------------------------------------------------
  // Data loading
  // ---------------------------------------------------------------

  async function loadAll() {
    let networkFailed = false;
    const onNetError  = () => { networkFailed = true; };

    await Promise.all([
      API.getSWR('/api/networth/current',             renderCurrent,  onNetError),
      API.getSWR(`/api/networth/series?range=${currentRange}`, renderSeries, onNetError),
      API.getSWR('/api/accounts',                     renderAccounts, onNetError),
      API.getSWR('/api/spending/summary?months=6',    renderSpending, () => {}),
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

  async function loadHistoryForRange(range) {
    historyRange = range;
    await API.getSWR(`/api/networth/series?range=${range}`, renderHistory, () => {});
  }

  async function loadNwForRange(range) {
    nwRange = range;
    await API.getSWR(`/api/networth/series?range=${range}`, renderNwHistory, () => {});
  }

  async function loadHealth() {
    try {
      const health = await API.health();
      const input = $('collectr-url-input');
      if (input && health.collectr_share_url) input.value = health.collectr_share_url;
    } catch { /* ignore */ }
  }

  async function saveCollectrUrl() {
    const input    = $('collectr-url-input');
    const statusEl = $('collectr-status');
    if (!input) return;
    const url = input.value.trim();
    if (url && !/^https?:\/\//.test(url)) {
      statusEl.textContent = 'Enter a full URL (https://…)';
      return;
    }
    const btn = $('collectr-save');
    if (btn) btn.disabled = true;
    statusEl.textContent = 'Saving…';
    try {
      const result = await API.setCollectrSource(url);
      if (result.status === 'ok' && result.value_cents != null) {
        statusEl.textContent = `Synced ${FMT.dollars(result.value_cents)}`;
      } else if (!url) {
        statusEl.textContent = 'Cleared';
      } else {
        statusEl.textContent = result.message || 'Saved — could not read value yet';
      }
      await loadAll();
    } catch {
      statusEl.textContent = 'Save failed — server unreachable.';
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  // ---------------------------------------------------------------
  // Event wiring
  // ---------------------------------------------------------------

  function wireEvents() {
    // Refresh button (icon-btn in topbar)
    $('refresh-btn').addEventListener('click', manualRefresh);

    // Plaid connect
    $('connect-bank').addEventListener('click', connectBank);
    $('empty-connect').addEventListener('click', connectBank);

    // Sidebar nav
    document.querySelectorAll('.nav-btn').forEach((btn) => {
      btn.addEventListener('click', () => setActiveTab(btn.dataset.tab));
    });

    // Dashboard range toggles
    const dashRanges = [...document.querySelectorAll('.range-btn:not([data-range2])')];
    dashRanges.forEach((btn, i) => {
      btn.addEventListener('click', () => {
        dashRanges.forEach((b) => {
          b.classList.toggle('active', b === btn);
          b.setAttribute('aria-checked', b === btn ? 'true' : 'false');
        });
        loadSeriesForRange(btn.dataset.range);
      });
      btn.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
          e.preventDefault();
          const next = dashRanges[(i + (e.key === 'ArrowRight' ? 1 : dashRanges.length - 1)) % dashRanges.length];
          next.focus(); next.click();
        }
      });
    });

    // Summary/history range toggles
    const histRanges = [...document.querySelectorAll('[data-range2]')];
    histRanges.forEach((btn) => {
      btn.addEventListener('click', () => {
        histRanges.forEach((b) => {
          b.classList.toggle('active', b === btn);
          b.setAttribute('aria-checked', b === btn ? 'true' : 'false');
        });
        loadHistoryForRange(btn.dataset.range2);
      });
    });

    // Net worth tab range toggles
    const nwRanges = [...document.querySelectorAll('[data-range3]')];
    nwRanges.forEach((btn) => {
      btn.addEventListener('click', () => {
        nwRanges.forEach((b) => {
          b.classList.toggle('active', b === btn);
          b.setAttribute('aria-checked', b === btn ? 'true' : 'false');
        });
        loadNwForRange(btn.dataset.range3);
      });
    });

    // Coast-FI age input
    const ageInput = $('age-input');
    if (ageInput) {
      const age = getAge();
      if (age) ageInput.value = String(age);
      ageInput.addEventListener('input', (e) => {
        const v = parseInt(e.target.value, 10);
        setAge(Number.isFinite(v) ? v : null);
        renderCoastFi();
      });
    }

    // Spending month picker
    const monthSel = $('month-select');
    if (monthSel) monthSel.addEventListener('change', onMonthSelectChange);

    // Collapsible "Deleted" section in the transaction table
    const delToggle = $('txn-deleted-toggle');
    if (delToggle) {
      delToggle.addEventListener('click', () => {
        const dList = $('txn-deleted-list');
        if (!dList) return;
        const open = dList.hidden;
        dList.hidden = !open;
        delToggle.classList.toggle('open', open);
      });
    }

    // AI ask box
    const askForm = $('ai-ask-form');
    if (askForm) {
      askForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const input = $('ai-ask-input');
        const q = input ? input.value.trim() : '';
        if (!q) return;
        answerMoneyQuestion(q);
        if (input) input.value = '';
      });
    }

    // Settings
    $('export-csv').addEventListener('click', exportCsv);
    $('collectr-save').addEventListener('click', saveCollectrUrl);
    $('plaid-save').addEventListener('click', savePlaidCreds);
    $('disconnect-cancel-btn').addEventListener('click', cancelDisconnect);
    $('disconnect-confirm-btn').addEventListener('click', confirmDisconnect);
    $('disconnect-confirm-input').addEventListener('input', (e) => {
      $('disconnect-confirm-btn').disabled =
        !pendingDisconnect || e.target.value.trim() !== pendingDisconnect.institution;
    });

    renderPrefs();
  }

  // ---------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------

  async function boot() {
    renderTodayLabel();
    applyPrivacy(prefs.privacy);
    wireEvents();

    // Show dashboard frame immediately (skeletons show while data loads)
    toggleEmptyState(false);

    const ok = await loadAll();
    loadHealth();
    loadPlaidStatus();

    if (ok) {
      try {
        const result = await API.refresh(true);
        if (!result.skipped) await loadAll();
      } catch { /* loadAll already surfaced connectivity issues */ }
    }
  }

  boot();
})();
