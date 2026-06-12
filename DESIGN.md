# UI Design Spec: Personal Net Worth Tracker

Companion to `networth-tracker-requirements.md` (Section 6) and `implementation-pipeline.md` (Phases 7–8). This document is the source of truth for all visual decisions. Where code and this spec disagree, this spec wins.

## 1. Design intent (revised 2026-06-12)

A modern glass fintech dashboard in a **blue-white tone**: soft blue-grey gradient page background, content in **frosted-glass cards** (translucent white, backdrop blur, 1px soft white/blue borders, generous corner radius, soft diffuse shadows). Typography still carries the numbers: Geist Sans for UI, Geist Mono with tabular figures for every numeral. The dashboard is organized as a **left-sidebar tabbed layout** (FundFlow-style):

1. **Summary** — default tab on open: total balance hero card, compact net-worth sparkline, accounts list card, latest refresh status.
2. **Net worth** — oversized net worth figure, full time-series chart with range toggles, allocation donut with stocks/crypto/cash split.
3. **Spending** — monthly expense statistics: month-over-month bar chart, current-month total spend and income, category breakdown list.
4. **Settings** — connections (connect/reconnect/disconnect), Collectr link, manual entry, CSV export, API base URL.

Restraint still applies to color: one blue accent family, desaturated green/red only on change indicators. No neon, no emoji, no heavy drop shadows — the glass should feel airy, not loud.

## 2. Design tokens

Implement as CSS custom properties on `:root` in a shared `tokens.css` used by both the mini window and the dashboard window.

```css
:root {
  /* Color — blue-white glass palette */
  --bg-grad-from:  #EEF3F9;  /* page gradient start (160deg) */
  --bg-grad-to:    #DFE9F5;  /* page gradient end */
  --bg-raised:     rgba(255,255,255,0.8); /* tooltips, inputs, row hover */
  --ink:           #1D2433;  /* primary text */
  --ink-soft:      #6B7689;  /* secondary text, labels, axes */
  --hairline:      rgba(120,150,190,0.18); /* borders and dividers, 1px only */
  --accent:        #4A90D9;  /* sky blue: chart line, primary actions, focus */
  --accent-soft:   #4A90D91A; /* 10% accent: chart area fill, active nav pill */
  --pos:           #4C7A5A;  /* desaturated green, change indicators only */
  --neg:           #B05A52;  /* desaturated red, change indicators only */
  --warn:          #A8842F;  /* stale badges */

  /* Glass cards */
  --glass-bg:       rgba(255,255,255,0.55);
  --glass-bg-hover: rgba(255,255,255,0.68);
  --glass-border:   rgba(255,255,255,0.7);
  --glass-blur:     18px;
  --glass-shadow:   0 8px 24px rgba(70,100,150,0.08);

  /* Type */
  --font-ui:   "Geist", system-ui, sans-serif;
  --font-mono: "Geist Mono", ui-monospace, monospace;

  /* Scale (rem) */
  --text-hero: 3.5rem;   /* net worth figure, mono, weight 500 */
  --text-h1:   1.25rem;  /* section labels, sans, weight 600 */
  --text-body: 0.9375rem;
  --text-small:0.8125rem;/* captions, axes, timestamps */

  /* Space — 4px base scale */
  --s-1: 4px;  --s-2: 8px;  --s-3: 16px;  --s-4: 24px;
  --s-5: 40px; --s-6: 64px;

  --radius: 18px;        /* glass card corner radius */
  --radius-sm: 10px;     /* inputs, small controls */
  --focus-ring: 2px solid var(--accent);
}
```

A frosted-glass card is `--glass-bg` + `backdrop-filter: blur(var(--glass-blur))`
(+ `-webkit-` prefix) + 1px `--glass-border` + `--radius` + `--glass-shadow`;
hover raises opacity to `--glass-bg-hover`.

**Typography rules**
- Every numeral in the product — balances, deltas, dates, axis labels, table figures — is set in `--font-mono` with `font-variant-numeric: tabular-nums`.
- Sans (`--font-ui`) for everything else. Sentence case everywhere; small labels may use letterspaced uppercase (`--text-small`, `letter-spacing: 0.08em`, `--ink-soft`) as eyebrows.
- Currency formatting: `$1,248,310.42` style, always two decimals in tables; the hero may drop cents below $100k width constraints — never abbreviate to "1.2M" except in the sparkline axis.

## 3. Dashboard layout

Fixed left sidebar (~220px, glass panel) + content area, max-width 1240px overall, `--s-4` outer padding and gaps. Every content block is a frosted-glass card; tabs are sections within the same page, shown/hidden client-side. Default tab on open: **Summary**.

```
┌─────────────┬────────────────────────────────────────────────┐
│ NET WORTH   │ ┌─ Total balance ─────────────  ( ⟳ Refresh ) ┐│  hero glass card
│ TRACKER     │ │ $128,442.18                                  ││
│             │ │ (▲ $1,204.55 (+0.9%) past 7 days)  chip      ││
│ ▸ Summary   │ │ refreshed 9:41 AM                            ││
│   Net worth │ └──────────────────────────────────────────────┘│
│   Spending  │ ┌─ Past 30 days ──────────┐ ┌─ This month ────┐│
│   Settings  │ │   ── sparkline ──       │ │ Spent   $318.26 ││
│             │ └─────────────────────────┘ │ Income    $1.70 ││
│             │ ┌─ Accounts ──────────────┐ └─────────────────┘│
│             │ │ Chase Checking  $4,212.10   ok · 9:41 AM    ││
│             │ │ Collectr       $46,432.41   stale · Jun 9   ││
│             │ └─────────────────────────────────────────────┘│
└─────────────┴────────────────────────────────────────────────┘
```

**Sidebar** — glass panel: app name eyebrow at top, vertical nav of real buttons (keyboard focusable, focus rings). Active item: `--accent` text on an `--accent-soft` pill background; inactive: `--ink-soft`.

**Tab 1 — Summary (default)**: hero card ("Total balance" eyebrow, `--text-hero` mono figure, 7-day delta chip in a glass pill, last-refreshed line, Refresh pill button), compact 30-day sparkline card (no axes), quick-stat card (this month's spend + income from `/api/spending/summary`), and the accounts card.

**Tab 2 — Net worth**: oversized figure + delta line, full time-series chart with range toggles, and the allocation donut card.
- Chart: line `--accent` at 1.5px; area fill `--accent-soft`; no chart border, no vertical gridlines, horizontal gridlines `--hairline` at most 3; axis labels `--text-small` mono `--ink-soft`. Tooltip: small raised panel (`--bg-raised`, 1px `--hairline`), all mono. Draw-in animation runs the first time the tab is shown.
- Range toggles: text buttons; active = `--ink` with 2px `--accent` underline; inactive = `--ink-soft`.
- Allocation donut: slices per DECISIONS.md (stocks/crypto/collectibles/cash/Fidelity cash; neutral slices use ink `#1D2433` at varying alpha); credit is not a slice — mono line `Credit offset −$842.33` under the legend. Legend rows: swatch (8px), label sans, % and $ right-aligned mono.

**Tab 3 — Spending**: bar chart card — monthly expenses for the last 6 months (accent bars, rounded tops, mono axes) with income as muted secondary bars; current-month card — big mono expenses figure with income beneath; category breakdown card — rows of category + mono amount, sorted desc, top 8 + "Other".

**Tab 4 — Settings**: glass cards for Connections (connect/reconnect/disconnect with typed confirm), Collectibles (Collectr share link display, manual value entry), and Data (Export CSV, API base URL).

**Accounts table**
- Hairline row dividers only, inside its glass card. Columns: name (sans) + type eyebrow, balance (mono, right-aligned, negatives in `--neg`), status (dot + word + timestamp in `--text-small`). Status dot colors: ok `--pos`, stale `--warn`, error `--neg`. An error row shows its fix inline as a text button: "Reconnect".

## 4. Mini window (360 × 480)

Same tokens at small scale; the whole window body is a single glass card on the gradient background. Number first, sparkline second, controls last.

```
┌──────────────────────────────┐
│ NET WORTH        9:41 AM     │  eyebrow + timestamp
│ $128,442.18                  │  2rem mono
│ ▲ +0.9% past 7 days          │
│                              │
│  ── 30-day sparkline ──────  │  accent line, no axes,
│        ╱╲    ╱───╲   ╱──     │  baseline hairline only
│ ──╲ ╱─╱  ╲──╱     ╲─╱        │
│                              │
│ Investments      $78,640.00  │  3-row mini allocation,
│ Collectibles     $46,432.41  │  mono right-aligned
│ Cash − Credit     $3,369.77  │
│                              │
│ ⟳ Refresh      Open dashboard│  text buttons, accent
└──────────────────────────────┘
```

- First paint comes from cache; reserve fixed heights for every number so refreshed data causes zero layout shift.
- If any source is stale: a single quiet line under the timestamp — `Collectr stale · Jun 9` in `--warn`.

## 5. States

Design these explicitly; they are not afterthoughts.

- **Empty (fresh install):** the content area (sidebar stays) shows a centered block — eyebrow "NET WORTH TRACKER", one sentence ("Connect your first account to start tracking."), one primary button "Connect bank", secondary text link "Add collectibles manually" (jumps to the Settings tab). No empty chart skeletons.
- **Loading:** skeleton bars (hairline-colored, subtle pulse) sized exactly like the content they replace. Never spinners, never blank flashes.
- **Stale:** content renders normally; a `--warn` badge "stale · {date}" next to the affected account and the timestamp. Data is never hidden just because it's old.
- **Error:** plain-language line naming the problem and the action: "Chase needs to be reconnected. → Reconnect". Errors never apologize and never show raw API messages.
- **Confirm-destructive:** "Disconnect & delete" requires a typed confirmation of the institution name and states exactly what is deleted (connection, stored token, its history).

## 6. Interaction & motion

- One orchestrated moment only: the first time the Net worth tab is shown, the chart line draws in left-to-right over 600ms ease-out. Everything else is instant (tab switches included). Honor `prefers-reduced-motion: reduce` by disabling it.
- Hover: glass cards raise to `--glass-bg-hover`; table rows raise to `--bg-raised`; chart hover shows a 1px vertical hairline crosshair + tooltip.
- Buttons: pills are now allowed — primary = `--accent` fill, white text, fully rounded; secondary = glass pill (`--glass-bg`, glass border, fully rounded); tertiary = text button in `--accent`; destructive = text button in `--neg`. Same label through a flow: "Refresh" → progress → "Refreshed 9:41 AM".
- Focus: `--focus-ring` outline with 2px offset on every interactive element. Full keyboard path: sidebar nav are real buttons; range toggles are a radiogroup; table actions reachable by Tab.

## 7. Copy reference

| Context            | Copy                                                |
|--------------------|-----------------------------------------------------|
| Primary actions    | Connect bank · Refresh balances · Export CSV        |
| Reauth             | Chase needs to be reconnected. → Reconnect          |
| Stale badge        | stale · Jun 9                                       |
| Manual entry label | Collectibles value                                  |
| Delete confirm     | This deletes the connection, its stored token, and its history. Type "Chase" to confirm. |
| Empty state        | Connect your first account to start tracking.       |

Plain verbs, sentence case, no exclamation points, no filler. A label labels; nothing does double duty.
