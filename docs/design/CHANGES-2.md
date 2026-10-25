# Divvy — Handoff update 2 (changes since the previous package)

Read `README.md` first for the full product spec. This file lists only what changed. `Divvy.dc.html` in this folder is the current design reference; open it in a browser.

## 1. Visual rebrand — "Candy pink"
Replaces the soft blush palette in README.md. **All pinks are now theme tokens** (CSS custom properties on the app root) so the whole UI can be re-skinned:

| Token | Default | Used for |
|---|---|---|
| `--dv-bg` | `#FFF0F5` | page background, inset tiles |
| `--dv-blush` | `#FFD3E2` | tinted cards, pill tracks, secondary buttons, Strawb card |
| `--dv-blush2` | `#FFBFD5` | hover on blush, dividers inside blush cards |
| `--dv-pink` | `#FF5C9E` | primary accent: progress fills, primary buttons, active icon tiles |
| `--dv-solid` | `#F0418A` | primary hover, Privacy hero |
| `--dv-shadow` | `#FF9CC4` | **card shadow** |
| `--dv-deep` | `#E0297A` | page titles, wordmark, eyebrow labels, active nav text |
| `--dv-rose` | `#B81E63` | text on blush surfaces |
| `--dv-border` | `#F7C9D8` | (legacy; borders removed) |
| `--dv-divider` | `#FBDDE7` | row dividers in white cards |

Neutrals unchanged: ink `#2B2224`, muted `#8A5A70` (pink-tinted), faint `#C9A0B3`, ok `#3E9A6E`, warn `#D9893A`, danger `#D23F5B`.

**Theme presets** (user-selectable; see `applyTheme()` in Divvy.dc.html for exact hex sets): Candy (default), Hot pink, Ballet, Magenta, Mauve. Each preset sets all ten tokens; any single token can also be overridden by the user. Implement as a settings screen: preset picker + ten colour fields; persist server-side.

### Surfaces
- **Cards: no border.** Hard offset shadow `5px 5px 0 var(--dv-shadow)`. Radius **12px** (summary tiles 10px, inset tiles 8px).
- **Pills/buttons/chips/progress bars: 6px radius** (no longer fully round). Applies to scope toggle, filter pills, nav badges, tag chips, buttons, bar tracks/fills.
- Page title `<h1>` is `--dv-deep`. Wordmark is `--dv-deep`.

### Wordmark (sidebar)
No logo mark. Two justified lines in a 104px block: `DIVVY` (Outfit 600 22px, letters spread with space-between) over `HOLD THE REINS` (10px 600, 0.14em tracking, `--dv-deep`, words spread to the same width).

## 2. Overview layout changes
- **Account cards redesigned** (Personal + Strawb): uppercase eyebrow (12px 600, 0.1em; Personal uses `--dv-deep`, Strawb uses `--dv-rose`), total in Outfit 500 40px, then accounts as a grid of **inset tiles** (`minmax(120px,1fr)`, gap 8px, radius 8px, padding 12px: name 11px 600 → balance DM Mono 15px → kind 11px). Personal card is white with `--dv-bg` tiles; Strawb card is `--dv-blush` with `rgba(255,255,255,.7)` tiles. (Strawb is no longer a dark/solid card.)
- **Alerts + Recent activity** sit side by side in their own row: `grid auto-fit minmax(280px,1fr)`, gap 18px, `align-items:start`. Top row keeps Safe-to-spend hero (full width), Personal, Strawb, Tax set-aside.

## 3. New screen — Subscriptions
Sidebar position: after Bills. Icon: three lines + small arrow. Title "Subscriptions" / "Recurring charges, found automatically". Respects the global All / Personal / Strawb scope.
- Summary tiles: **Per month**, **Per year** (white), **Barely used** (blush) = monthly cost of low-usage subs, caption "a month you could get back".
- List card rows (`1fr auto auto`): name (strikethrough when cancelled) + two chips — side tag (Strawb = blush/`--dv-rose`, Personal = `--dv-bg`/muted) and usage tag (Barely used = `#FDE2E7`/danger, Some use = `#FFF1DC`/warn, Used often = `#E3F3EA`/ok); meta line (usage evidence, renewal date, overlaps). Right: amount DM Mono 15px + "per month / per year". Button "Cancel" (blush/`--dv-rose`) → "Cancelled" (white/muted, row opacity .55). Yearly subs are divided by 12 for totals.
- Advisor banner (blush): names the barely-used subs with monthly + yearly cost, link "Help me cancel →" opens Advisor.
- **Backend:** detect recurring merchants from transactions + Xero bills; usage signal from app-open/last-charge heuristics where available (Claude Code may ask the user); cancel = mark + remind, not an API action.

## 4. Habits screen (added since the first handoff; summarised here)
Runway (months of zero-income cover), Freedom date, Streaks, "Worth it?" self-tagging (Worth it / Not really), Patterns (unflattering correlations), Weekly truth report CTA → Advisor. Full spec in README.md §5.

## 5. Nav order (desktop)
Overview · Budgets · Bills · Subscriptions · Goals · Habits · Advisor · Sync · Privacy. Mobile tabs: Home · Budgets · Habits · Goals · Advisor.

## 6. Tweaks / settings exposed in the prototype
`theme` (preset enum), ten `*Pink` colour overrides, `currency` ($ default, NZ$, £), `taxRate` (10–45%, default 25).
