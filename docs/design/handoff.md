# Handoff: Divvy — personal + Strawb finance app

## Overview
Divvy is a single-user, self-hosted finance app for one person who runs a business ("Strawb") alongside personal money. It pulls bank accounts (Open Banking, read-only) and Xero, works out **safe to spend** after tax reserve, bills and budgets, and surfaces alerts. Claude Code acts as the **advisor**: it sets up and adjusts budgets, checks outstanding invoices in Xero, maintains the tax reserve, and answers questions in the Advisor chat. Everything runs on the owner's own server; no third-party AI API.

## About the design files
`Divvy.dc.html` (+ `support.js`, its tiny runtime) is a **design reference built in HTML** — an interactive prototype showing intended look and behaviour, not production code. Recreate it in the target codebase's stack. There is no existing codebase; a sensible default is a small full-stack app (e.g. Next.js/SvelteKit + SQLite/Postgres) with a scheduled sync worker and a tool-calling layer Claude Code can drive. Open the HTML in a browser to click through every screen; resize under 720px for the mobile layout.

## Fidelity
**High-fidelity.** Colours, type, spacing, radii and copy are final. Recreate pixel-close. Numbers are sample data.

## Global layout
- Desktop (≥720px): 224px sticky left sidebar (wordmark "DIVVY" Outfit 600 22px 0.04em + tagline "HOLD THE REINS" 10px 600 0.14em `#C2386A`; nav with 28px blush icon tiles using rounded 2px-stroke line icons: house, pie, receipt, heart, speedometer, sparkle, sync arrows, lock; "Self-hosted" blush card) + main column, max-width 1040px, padding 36px 40px.
- Mobile (<720px): no sidebar; "Divvy" wordmark above title; fixed bottom tab bar (Home, Budgets, Habits, Goals, Advisor), 44px min tap targets, white, 1px top border `#F0E4E6`.
- Header on every screen: title (Outfit 600 36px, letter-spacing −0.02em) + subtitle (14px `#7A6A6F`); right side: **scope toggle** All / Personal / Strawb (pill group, blush track `#FBE4EA` padding 4px, active pill white with `#C2386A` text, inactive `#A12A56`), and a sync status pill (white, 1px `#F0E4E6`, 7px status dot).
- Cards: white, 1px `#F0E4E6` border, radius 24px, padding 24px. Alternate tints: blush `#FBE4EA` (no border) and solid rose `#D9507D` with white text (Strawb card, Privacy hero).
- Grid: `repeat(auto-fit, minmax(300px,1fr))`, gap 16px; hero card spans full width.

## Scope toggle (All / Personal / Strawb)
Global filter. Affects: safe-to-spend maths, which account cards show (Personal card hidden in Strawb scope; Strawb + Tax cards hidden in Personal scope), alerts, activity feed, budgets, bills, bill summary tiles. Recent-activity sub-filter collapses to the in-scope option.

## Screens

### 1. Overview ("Good morning" / date)
- **Safe to spend hero** (full width, 2-col at ≥260px each): eyebrow "SAFE TO SPEND" 12px 600 `#C2386A` uppercase 0.1em; amount Outfit 500 72px, −0.03em; line "until payday on 28 Nov · after tax, bills and budgets"; 10px progress bar (track `#FBE4EA`, fill `#EC6A94`, width = safe ÷ liquid); "X a day for the next N days".
  Right: breakdown ledger in DM Mono 13px on `#FAF6F3` radius 16px: Across accounts, − Tax reserve, − Bills due, − Budgets left, = Safe to spend (pink). Formula: `liquid − unpaid bills − remaining budget − tax hold`.
- **Personal card**: title + total (Outfit 28px); rows name/kind/balance (DM Mono 14px).
- **Strawb card** (`#D9507D`, white): Starling Business, Tax pot, "Owed to you · Xero · 2 invoices" shown as `~$3,200` (pending, excluded from safe-to-spend). Dividers `#E27A9B`.
- **Tax set-aside** (blush): "25% of profit" (tweakable), amount Outfit 40px, "of X owed so far", bar (track white), "Next payment 31 Jan" / "X short · auto top-up Friday".
- **Alerts**: list with 8px colour dot (red `#D23F5B` over budget, amber `#D9893A` upcoming/overdue, pink `#EC6A94` advisory), text 14px, link action (navigates), × dismiss. Empty: "All clear. Nothing needs you right now."
- **Recent activity**: filter pills All/Personal/Strawb; rows: 36px radius-11 tag tile (P = `#FAF6F3`/`#7A6A6F`, B = `#D9507D`/white, T tax = blush/`#A12A56`), name + meta, amount DM Mono (income green `#3E9A6E`).

### 2. Budgets ("Resets on payday · 23 days left")
Cards per budget: name, status (`$X left` green / amber when >80% / `$X over` red), spent Outfit 34px "of limit", 10px bar (pink / amber / red), note, − / + buttons (28px, blush, adjust limit by 10). Advisor banner (blush): one-sentence insight + "Ask why →" link to Advisor. **Claude Code owns budget creation and limits.**

### 3. Bills
Three summary tiles (Due before payday, Next one, Paid this month — last is blush). List rows: 56×52 date tile (next two: solid `#EC6A94` white; others blush/rose; paid: `#FAF6F3` muted), name (strikethrough when paid) + meta "Personal · Monzo" / "Strawb · Starling", amount DM Mono 15px, "Mark paid" pill → "Paid" (row opacity .55).

### 4. Goals
Cards: name, "by Mon YYYY", saved Outfit 40px "of target", 10px pink bar, pace "$X/mo · N months to go", two buttons (+$50 blush, +$200 solid pink). Dashed "New goal — Set one with the advisor" card (hover blush) → Advisor. Footer note: contributions come from Personal · Savings, never the tax reserve.

### 5. Habits ("An honest mirror · last 90 days")
Purpose: unbiased self-awareness and earned confidence. Never flattering by default.
- Row 1 (auto-fit 260px): **Runway** (white card; eyebrow; Outfit 48px, e.g. "7.8"; "months you could live with zero income, at this month's spending" — formula: liquid + savings ÷ trailing-month spend). **Freedom date** (rose `#D9507D` card, white; "Mar 2034"; note "When savings cover your costs. Moved 11 days closer this month." — projection that moves with every decision). **Streaks** (blush card; rows label / Outfit 600 20px value: No overdraft 94 days, Tax fully reserved 6 months, Under budget overall 14 days, No purchases after 9pm 0 days — streaks break honestly).
- Row 2: **Worth it?** (white card): header + summary "N not worth it · N worth it"; sub "Your own verdict on recent spending. The advisor uses this, not its opinion."; rows: merchant + meta (category · amount · time), two pills "Worth it" (selected = green `#3E9A6E` white) / "Not really" (selected = red `#D23F5B` white), unselected blush. Tap again to clear.
  **Patterns** (white card): "Unflattering on purpose. Pulled from the last 90 days." 4 bullet rows with colour dot (red / amber / green) — behavioural correlations (time of day, day of week, before/after invoices), not transaction lists. Claude Code generates these from data.
  **Weekly truth report** CTA (blush, hover `#F7D2DC`): eyebrow, Outfit 20px "Ask the advisor for this week's honest read →", "Every Monday. Must name at least one flaw, even in a good week." → opens Advisor and sends the prompt.

### 6. Advisor
Chat card min-height 560px: scrollable thread (AI bubbles blush, ink text; user bubbles `#EC6A94` white; radius 18px, 14.5px/1.5), typing indicator (3 dots, 1.2s pulse), suggestion chips (blush pills: "Weekly truth report", "What can I cut?", "Am I on track for tax?", "Set a goal", "Who owes me?"), input (radius 14, `#FAF6F3`, focus border pink) + Send button. Footer: "Runs locally on your server…". Enter sends. **Backend: route messages to Claude Code with tools: read accounts/transactions, read Xero invoices & P&L, create/update budgets, set tax reserve rate/top-up, create goals, mark bills, read "worth it" tags, compute runway/freedom date/streaks.**

**Weekly truth report (advisor system prompt rules):** runs every Monday and on demand. Structure: *What held* (facts with numbers) → *What didn't* (must name ≥1 flaw, quantified, tied to a pattern not a single purchase) → *One thing* (a single 7-day experiment and its effect on freedom date). Tone: plain, direct, no cheerleading, no shaming; uses the user's own "not really" tags as evidence; every number must match what the Habits screen shows.

### 7. Sync
Rows per source (Monzo · Personal, Starling Business · Strawb, Xero · Books): status dot (green ok / amber stale), tag chip, detail line, relative time (DM Mono 12px). "Sync now" pink pill with spinner (~1.6s) → all "just now". "Pulled from Xero this week" list (paid invoice green, overdue amber, profit so far).

### 8. Privacy
Rose hero (`#D9507D`): "Your money data lives on one machine. Yours." Three white cards: Banks (read-only, 90-day re-consent), Advisor (local model), Storage (encrypted, nightly backup). Blush "Server" card with host/uptime/last backup/outbound calls in DM Mono.

## Interactions
- Nav/tab click → screen switch, no transition. Active nav: white bg, `#C2386A` text, icon tile solid pink/white; inactive tile blush/`#A12A56`.
- Hover: buttons lighten/darken one step (`#EC6A94`→`#D9507D`; blush→`#F7D2DC`); outlined pills get pink border.
- Dismiss alert removes it; nav badge count = open alerts.
- Budget ±, bill mark-paid, goal contributions all recompute safe-to-spend live.

## State
`screen`, `scope` (all|personal|strawb), `filter`, `dismissed[]`, `budgets[]`, `bills[]` (paid flag), `goals[]`, `regrets[]` (verdict yes|no|null), `messages[]`, `typing`, `syncing`, `synced`. Real build: persist all of it server-side; sync worker every 15 min; Claude Code advisor writes budgets/goals/tax settings via the same API.

## Design tokens
Colours — bg `#FAF6F3`; surface `#FFFFFF`; border `#F0E4E6`; divider `#F6ECEE`; blush `#FBE4EA`; blush-hover `#F7D2DC`; pink `#EC6A94`; pink-hover/solid `#D9507D`; deep rose text `#C2386A`; rose text `#A12A56`; ink `#2B2224`; muted `#7A6A6F`; faint `#B3A3A8`; ok `#3E9A6E`; warn `#D9893A`; danger `#D23F5B`.
Type — Display: Outfit 500/600 (72 / 40 / 36 / 34 / 28 / 26 / 22). Body: DM Sans 400/500/600 (15 / 14 / 13 / 12 / 11). Numbers: DM Mono 400/500 (15 / 14 / 13 / 12). Google Fonts.
Radii — cards 24, tiles 14–18, buttons 12–14, pills 999, tag tiles 8–11.
Spacing — 4/6/8/10/12/14/16/20/24/28/36/40. Bars 10px. No shadows.
Tweaks — `currency` ($ | NZ$ | £, default $), `taxRate` (10–45%, default 25).

## Assets
None. Wordmark only (no logo mark). Nav icons are inline SVG line icons (24 viewBox, stroke 2, round caps) — see `icon()` in Divvy.dc.html for exact paths.

## Files
- `Divvy.dc.html` — full prototype (template + logic)
- `support.js` — prototype runtime (not needed in the real build)
