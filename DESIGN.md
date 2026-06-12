# UI Design Spec: Personal Net Worth Tracker

Companion to `networth-tracker-requirements.md` (Section 6) and `implementation-pipeline.md` (Phases 7–8). This document is the source of truth for all visual decisions. Where code and this spec disagree, this spec wins.

## 1. Design intent

A precision instrument for reading numbers, in the owner's existing Swiss/editorial design language: disciplined grid, generous whitespace, typography carrying the personality. The single memorable element is the **hero**: an oversized monospaced net worth figure with the time-series chart running edge-to-edge directly beneath it, axes set like footnotes. Everything else stays quiet.

Explicitly avoid: gradients, glassmorphism, card shadows, rounded "fintech app" pills, emoji, decorative icons, dark-mode-with-neon-accent defaults. Restraint is the style.

## 2. Design tokens

Implement as CSS custom properties on `:root` in a shared `tokens.css` used by both the mini window and the dashboard window.

```css
:root {
  /* Color */
  --bg:            #FAF9F6;  /* warm off-white, page background */
  --bg-raised:     #FFFFFF;  /* settings panel, table rows on hover */
  --ink:           #1A1A1A;  /* primary text */
  --ink-soft:      #6B6B66;  /* secondary text, labels, axes */
  --hairline:      #E4E1DA;  /* all borders and dividers, 1px only */
  --accent:        #4A90D9;  /* sky blue: chart line, primary actions, focus */
  --accent-soft:   #4A90D91A; /* 10% accent: chart area fill */
  --pos:           #4C7A5A;  /* desaturated green, change indicators only */
  --neg:           #B05A52;  /* desaturated red, change indicators only */
  --warn:          #A8842F;  /* stale badges */

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

  --radius: 2px;          /* near-square; this is editorial, not bubbly */
  --focus-ring: 2px solid var(--accent);
}
```

**Typography rules**
- Every numeral in the product — balances, deltas, dates, axis labels, table figures — is set in `--font-mono` with `font-variant-numeric: tabular-nums`.
- Sans (`--font-ui`) for everything else. Sentence case everywhere; small labels may use letterspaced uppercase (`--text-small`, `letter-spacing: 0.08em`, `--ink-soft`) as eyebrows.
- Currency formatting: `$1,248,310.42` style, always two decimals in tables; the hero may drop cents below $100k width constraints — never abbreviate to "1.2M" except in the sparkline axis.

## 3. Dashboard layout

12-column grid, max-width 1080px, centered, `--s-5` outer padding. Hairline dividers between sections; no boxes around sections.

```
┌──────────────────────────────────────────────────────────────┐
│ NET WORTH                         refreshed 9:41 AM  ⟳ Refresh│  header row
│                                                              │
│ $128,442.18                                                  │  hero figure (mono)
│ ▲ $1,204.55 (+0.9%) past 7 days                              │  delta line
│                                                              │
│ ┌─ time-series chart, full content width ────────────────┐  │
│ │                                            ╱─╲           │  │
│ │                                   ╱──╲ ╱──╱   ╲──        │  │
│ │                          ╱───────╱    ╳                  │  │
│ │  ──╲   ╱────╲   ╱───────╱                                │  │
│ └──────────────────────────────────────────────────────────┘  │
│   1M   3M   1Y   All                                          │  range toggles
├──────────────────────────────────────────────────────────────┤
│ ALLOCATION                    │ ACCOUNTS                      │
│                               │ Chase Checking   cash         │
│      ◐ donut                  │   $4,212.10      ok · 9:41 AM │
│                               │ Chase Freedom    credit       │
│  ● Investments  61.2%  $78.6k │   −$842.33       ok · 9:41 AM │
│  ● Cash          3.3%   $4.2k │ Fidelity         investment   │
│  ● Collectibles 36.1%  $46.4k │   $78,640.00     ok · 9:41 AM │
│  (credit shown as offset)     │ Collectr         collectibles │
│                               │   $46,432.41     stale · Jun 9│
├──────────────────────────────────────────────────────────────┤
│ SETTINGS                                                      │
│ Connect bank · Reconnect · Disconnect & delete                │
│ Collectibles: share link (read-only display) · manual entry   │
│ Export CSV                                                    │
└──────────────────────────────────────────────────────────────┘
```

**Hero & chart**
- Hero figure: `--text-hero`, `--font-mono`, `--ink`. Delta line beneath in `--text-body`: arrow + amount + percent in `--pos`/`--neg`, the words "past 7 days" in `--ink-soft`.
- Chart: line `--accent` at 1.5px; area fill `--accent-soft`; no chart border, no vertical gridlines, horizontal gridlines `--hairline` at most 3; axis labels `--text-small` mono `--ink-soft`. Tooltip: small raised panel (`--bg-raised`, 1px `--hairline`) with date, total, and per-account breakdown, all mono.
- Range toggles: text buttons; active = `--ink` with 2px `--accent` underline; inactive = `--ink-soft`. No pill backgrounds.

**Allocation**
- Donut, 4 series max, colors: accent (investments), ink at 70% (collectibles), ink-soft (cash) — credit is not a donut slice; show it under the legend as a mono line: `Credit offset −$842.33`. Legend rows: swatch square (8px), label sans, then % and $ right-aligned mono.

**Accounts table**
- Hairline row dividers only. Columns: name (sans) + type eyebrow, balance (mono, right-aligned, negatives in `--neg`), status (dot + word + timestamp in `--text-small`). Status dot colors: ok `--pos`, stale `--warn`, error `--neg`. An error row shows its fix inline as a text button: "Reconnect".

## 4. Mini window (360 × 480)

Same tokens at small scale. Number first, sparkline second, controls last.

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

- **Empty (fresh install):** centered block — eyebrow "NET WORTH TRACKER", one sentence ("Connect your first account to start tracking."), one primary button "Connect bank", secondary text link "Add collectibles manually". No empty chart skeletons.
- **Loading:** skeleton bars (hairline-colored, subtle pulse) sized exactly like the content they replace. Never spinners, never blank flashes.
- **Stale:** content renders normally; a `--warn` badge "stale · {date}" next to the affected account and the timestamp. Data is never hidden just because it's old.
- **Error:** plain-language line naming the problem and the action: "Chase needs to be reconnected. → Reconnect". Errors never apologize and never show raw API messages.
- **Confirm-destructive:** "Disconnect & delete" requires a typed confirmation of the institution name and states exactly what is deleted (connection, stored token, its history).

## 6. Interaction & motion

- One orchestrated moment only: on dashboard load, the chart line draws in left-to-right over 600ms ease-out. Everything else is instant. Honor `prefers-reduced-motion: reduce` by disabling it.
- Hover: table rows raise to `--bg-raised`; chart hover shows a 1px vertical hairline crosshair + tooltip.
- Buttons: primary = `--accent` background, white text, `--radius`; secondary = text button in `--accent`; destructive = text button in `--neg`. Same label through a flow: "Refresh" → progress → "Refreshed 9:41 AM".
- Focus: `--focus-ring` outline with 2px offset on every interactive element. Full keyboard path: range toggles are a radiogroup; table actions reachable by Tab.

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
