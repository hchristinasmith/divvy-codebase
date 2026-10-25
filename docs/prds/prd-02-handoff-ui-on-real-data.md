# PRD 02 — The handoff UI on real data

> **Status:** blessed by Hannah in session, 2026-10-23 (all five PRDs blessed together; decisions 6 and 7 answered the same day)

**Kind: specifying.** This PRD runs long because the handoff leaves several money rules open (liquid, tax hold, goal contributions, negative safe-to-spend), and a stranger building the Overview needs them ruled.

**Prerequisites.** M1 has landed (#1–#10; in particular integer cents #8 and no Auth0 #3), and prd-01 wave 1 has landed (the `accounts`, `sync_runs` tables and `transactions.status`). Screens can be built against the M1 fixture seed (#7) before prd-01's sync is deployed; "on real data" is met only once prd-01 w3 has landed.

**Territory.** This PRD owns `client/**`, `src/**`, a new `shared/**`, the budgets/bills/goals/overview/settings/habits routes in `server/routes/` and their data modules, and the migrations for those tables. `server/sync/**`, `fly.toml`, Litestream, and the accounts/sync migrations are prd-01's territory; `mcp/**` and the advisor audit file are prd-03's. No wave here enters them. This PRD consumes prd-01's `accounts` (with `scope`), `transactions` (effective `category`, `category_source`, `status`) and `sync_runs`. *Added 2026-10-23:* `server/xero/**` and the Xero migrations are prd-05's territory; no wave here enters them. Exception, prd-05 wave 3 (declared): it edits the Overview's "Owed to you" line and the Sync screen's Xero rows, and supplies the profit input to Ruling 2 (see prd-05).

## What we're building

The handoff design, rebuilt pixel-close in the existing React, Vite and Tailwind 4 app and fed by your real data: Overview with the safe-to-spend hero and the All / Personal / Strawb toggle, Budgets, Bills, Goals, Habits, Sync and Privacy, plus the phone tab bar. Budgets, bills and goals become things you create and edit in the app. The Advisor screen is a placeholder card that points you to Claude desktop; the advisor itself is prd-03. Strawb here means your business bank accounts from Akahu only; Xero is not connected yet.

## Why this first (after prd-01)

1. The safe-to-spend number is the product, and both the screens and the advisor (prd-03) read it. It must be one function with one definition before a second consumer exists.
2. The data has to be real to judge the design; a pixel-close screen on fixture data proves nothing about whether the number is right.
3. Bills, budgets and goals have no routes or tables today, so the screens cannot exist until the data layer does.

Rejected alternatives:

- *Reskin-first*: restyle the current Dashboard and add screens one at a time on the live proxy. Rejected because the proxy is deleted in prd-01 and the screens would be rebuilt twice.
- *Advisor-in-app first*: build the Advisor chat screen now. Rejected because it needs an API key that contradicts the handoff's own line "no third-party AI API" (`docs/design/handoff.md:4`), and prd-03 gives the advisor to Claude desktop at no extra cost (D3).
- *Pretend Strawb*: fill the Strawb side with sample or estimated Xero numbers so the design looks complete. Rejected; a fake number in a money app is the one thing that cannot be corrected later.

## Evidence

- **The design is final and specific.** 8 screens, tokens, formulas and state in `docs/design/handoff.md:22-80`; high fidelity, "Recreate pixel-close" (`:9-10`).
- **The formula is given, the inputs are not.** `handoff.md:25` states `liquid − unpaid bills − remaining budget − tax hold`; the prototype defines liquid as two hand-picked balances and tax hold as a constant (`docs/design/Divvy.dc.html:494-499`), and clamps at zero (`:499`).
- **Only budgets have a table, and it is unused.** `server/db/migrations/20250619122142_targets.js:6-20` (unique on user, category, period; amount decimal); no `server/routes/` file serves it (`server/server.ts:22-24` mounts only accounts, categories, transactions). The Dashboard's budgets are hardcoded (`client/components/Dashboard/Dashboard.tsx:19-24`).
- **No bills, goals or habit tables exist.** Migrations list: transactions, users, targets, wishlist_items, settings, user_challenges. Audit gap matrix rows "Bill reminders", "Progress bars + streaks" (`docs/audit-2026-10-23.md:93-101`).
- **A key/value settings table exists for tax rate and payday.** `server/db/migrations/20250619122207_settings.js:6-14`.
- **The current client has none of the screens.** Pages are shells, fakes or stubs (`docs/audit-2026-10-23.md:44-52`); nav is a lucide-react list (`client/components/Sidebar.tsx:2-26`). Tailwind 4 and shadcn primitives are in place (`vite.config.js:8`, `src/components/ui/*`).
- **Money must already be cents.** Issue #8; the shared formatter/parser it creates is used here, not rewritten.
- **The handoff's Privacy and Advisor copy is partly untrue for this build.** "Advisor (local model)", "nightly backup" and "encrypted" (`handoff.md:58`) versus D3 (Claude, not local) and D2 (Litestream is continuous).
- **The toggle needs an owner on each account.** prd-01 ruling 8 adds `accounts.scope`; the handoff's scope behaviour is `handoff.md:19-20`.

## In scope

- App shell: tokens, self-hosted fonts, sidebar, header with scope toggle and sync pill, mobile tab bar at <720px.
- `shared/safe-to-spend.ts`: one pure function used by the server and, in prd-03, the MCP.
- Tables and CRUD routes: `budgets`, `bills` (+ `bill_payments`), `goals` (+ `goal_contributions`), `account_settings` (role per account), `alert_dismissals`; settings keys for tax rate, profit figure, payday day, currency.
- Screens: Overview, Budgets, Bills, Goals, Habits (what can be computed), Sync, Privacy, Advisor placeholder.
- Inline category edit on the Overview recent-activity rows, calling the update route reconciled in #9; row shows the effective category and a subtle marker when `category_source` is `user`.
- Alerts derived on read (over budget, bill due soon or overdue); dismiss persisted.

## Out of scope

| Item | Goes instead to |
|---|---|
| Advisor chat, budget creation/limits by Claude, write tools | prd-03 (read-only advisor in Claude desktop); writes a future PRD |
| Xero: owed-to-you line, real profit, GST/PAYE/company tax | M4 PRD; until then profit is typed in |
| Auto-matching bills to transactions, email invoices | M5 PRD; "Mark paid" is manual here |
| Sync engine, accounts/sync tables, deploy | prd-01 |
| Alert engine, web push, advisory alerts | Later PRD (D5) |
| Freedom date | Open question below; hidden, not faked |
| Patterns card content, "suggestions" pill, charts | prd-04 mounts them on the Habits and Overview components this PRD builds; until then the Patterns card is an empty state |
| Weekly truth report | Later PRD / prd-03 open question; the CTA links to Claude desktop |
| Rule/Claude auto-categorisation | Later PRD (D3) |
| Wishlist, `wish_web` concept | D11, still open; the Wishlist page is left untouched |
| Per-account role/scope editing UI beyond a plain settings list | Not needed for one user; set once |

### Out-of-scope addition (2026-10-25)
| Theme presets and colour overrides | Later; Hannah 2026-10-25 "i dont want presets yet" |
| Usage tags and the "Barely used" tile | Later; Hannah 2026-10-25 "Drop usage for now" |
| Subscriptions from Xero bills | M4 (prd-05) |

## Done when

1. The server returns one safe-to-spend number per scope, and the Overview shows exactly it. *Not met while* the client recomputes it, or a hand calculation from the same rows (liquid, bills, budgets, hold) differs by one cent.
2. All / Personal / Strawb change every figure that the handoff says they change (`handoff.md:19-20`), and Strawb shows only business-scope Akahu accounts. *Not met while* a personal account balance, bill or budget leaks into the Strawb figure (or the reverse), or any Xero-looking line renders.
3. Editing a budget, marking a bill paid, or adding a goal contribution is reflected in the Overview within one refetch, no reload. *Not met while* the hero keeps the old number after a mutation, or a mutation succeeds without being saved server-side.
4. Every amount in tables and routes is integer cents; display rounds only at the final formatting step. *Not met while* a float money column or `Number` division sits in a sum.
5. Changing a transaction's category inline persists, survives the next sync (prd-01 done-when 7), and shows its source. *Not met while* a refresh or sync reverts it.
6. Each screen matches `Divvy.dc.html` at 1040px and 390px wide on colours, type sizes, radii and spacing. *Not met while* you, looking at both side by side, can point to a difference that is not a data difference.
7. The phone tab bar shows Home, Budgets, Habits, Goals, Advisor and every tap target is at least 44px. *Not met while* a tab is smaller or a screen is unreachable.
8. The Privacy screen says only things that are true of this build. *Not met while* it says "local model", "nightly" or "encrypted" without a checked basis.

### Done-when addition (2026-10-25)
9. The Subscriptions screen lists each regular charge in your data for the chosen scope, with per-month and per-year totals, and asks about name-matched merchants. *Not met while* a charge you know repeats is missing, a one-off charge appears without being asked about, a merchant you marked is shown the other way, or a personal subscription shows under Strawb (or the reverse).

Items 1, 3, 4 are tests (the code does what is written). Items 2, 5 need a real-data check. Items 6–8 are a human reading. **Only 1 matters:** you read the hero number and agree it is what you could actually spend. Whether the *formula is right* is only judged by you, with your own bills and budgets in front of you.

## Rulings

## Ruling 1 — Safe-to-spend is computed on the server, by one shared pure function
`shared/safe-to-spend.ts` takes rows and a scope and returns the signed result and its parts; the overview route calls it and the client displays what it returns. prd-03's `get_safe_to_spend` imports the same function. Why: two implementations of the number is how the advisor and the screen come to disagree. The prototype recomputes in the browser (`Divvy.dc.html:497-499`); the real build does not. Extends to: any new consumer imports it, never re-derives it.

> Note 2026-10-25 (#271): Spending by category follows the same split. `shared/spending.ts` is the one place a month's outflow per category is added up, in integer cents, with the user's category over Akahu's (prd-01 Ruling 4), largest first and uncategorised kept apart. `GET /api/v1/spending/categories` loads rows and calls it, and the Overview's "Spending by category" card displays what it returns, including the top-5 grouping and "Other", with no client sum. Drawings are left out (Ruling 15). Transfers between her own accounts other than drawings are not yet excluded; that rule is open on #52, and one predicate in the shared module, `countsAsSpending`, is where it will go.

## Ruling 2 — The inputs of the formula are defined, not guessed
- **liquid**: sum of balances of in-scope accounts whose `account_settings.role` is `current`. Savings and the tax pot are not liquid.
- **unpaid bills**: in-scope bills due on or before the next payday and not yet paid.
- **remaining budget**: sum over in-scope budgets of `max(0, limit − spent)`; spent is effective-category outflow, settled and pending, since the last payday.
- **tax hold**: `max(0, taxRate × profit − taxPotBalance)` in All and Strawb scope; `0` in Personal. `taxRate` and `profit` are settings you type in until Xero lands.
Why: the handoff's formula (`handoff.md:25`) only works once each term is pinned. Netting the tax pot balance stops money already set aside from being held twice, since the pot is outside liquid. This is a money judgement for you to confirm at blessing.

> Amended 2026-10-25 by Rulings 9, 10 and 11.
>
> Amended 2026-10-25 by Ruling 15: drawings are not spent.
>
> Amended 2026-10-25 (#35): bills repeat none/weekly/monthly/yearly; Hannah chose option C on #35. Each bill has its own repeat (none is a one-off), anchored on `first_due_date`, and every occurrence is computed from that anchor. A monthly bill keeps its day of month, clamped to the month's end; a yearly bill dated 29 Feb falls on 28 Feb outside leap years. "Mark paid" records a `bill_payments` row for that occurrence and the bill comes back next cycle; a one-off is done once paid. A bill's "unpaid" occurrences are those with no payment row. Open, not ruled: when several occurrences of one bill are unpaid on or before the next payday (a weekly bill overdue), whether each one counts toward "unpaid bills".
>
> Amended 2026-10-25 (#151), answering the open question in the #35 note: Hannah ruled that every unpaid occurrence of an overdue repeating bill counts toward "unpaid bills". A weekly bill two cycles overdue holds back both occurrences that fall on or before the next payday, so safe-to-spend never counts money already owed.
>
> Roles are stored as `current`, `savings`, `tax_pot` and `credit_card`; the text above writes "tax pot" and "credit card".

## Ruling 3 — A negative result is shown as $0 plus how short you are
The function returns the signed value; the hero shows `$0` and a "short by $X" line when it is negative. The design clamps silently (`Divvy.dc.html:499`), which would hide an overspend and contradicts "never flattering" (`handoff.md:42`).

## Ruling 4 — Strawb is Akahu business accounts only until Xero exists
No Xero line, no estimated or sample invoice figure, no "Owed to you". The Strawb card shows business-scope accounts and the tax pot. Why: nothing may look like data we do not have. Extends to: when M4 lands it adds the line; this PRD adds no placeholder for it.

## Ruling 5 — Goal contributions are records, not transfers, and do not change safe-to-spend
Divvy cannot move money. A "+$50" records a contribution against the goal; the savings account is outside liquid (Ruling 2), so the bank balance reflecting the real transfer is what changes the number after the next sync. This departs from `handoff.md:64`, which says contributions recompute safe-to-spend live; flagged for you to confirm.

## Ruling 6 — `budgets` replaces `targets`
A new `budgets` table (scope, category, limit in cents, note) and the unused `targets` table is dropped in the same migration. Why: `targets` has no scope, a decimal amount, and nothing reads it (`20250619122142_targets.js:16,20`). Reviewed as a schema change.

## Ruling 7 — Fonts are self-hosted
Outfit, DM Sans and DM Mono ship from the app, not Google Fonts (`handoff.md:71`). Why: the Privacy screen claims your data stays on one machine; a page that calls a third party on every load makes that claim false.

## Ruling 8 — Old pages are removed last, from the nav first
The shell stops linking Transactions, Targets, Subscriptions and Challenges immediately; their files are deleted in the final sweep. Wishlist stays until D11.

## Ruling 9 — Payday is weekly, on a weekday (operator amendment, 2026-10-25; amends Ruling 2)
Payday is one weekday, every week; Hannah's is Tuesday. The setting is `payday_weekday` (0 = Sunday … 6 = Saturday), replacing a day of the month. The last payday is the most recent payday weekday on or before today (today itself when today is payday); the next payday is seven days after it. So "unpaid bills due on or before the next payday" covers at most the next seven days plus anything overdue, "spent since the last payday" covers at most the last seven days, and every budget `limit` is a weekly amount. Why: Hannah pays herself weekly on Tuesday (2026-10-25); a monthly window would hold a month of bills against one week's pay. Extends to: every consumer of `lastPayday`/`nextPayday`, the settings panel (#46) and prd-03's `get_safe_to_spend`. Monthly paydays are not supported; adding them later is a new ruling.

## Ruling 10 — What is owed on a credit card is subtracted (operator amendment, 2026-10-25; amends Ruling 2)
`account_settings.role` gains `credit card`. A credit-card account is never liquid. What is owed on it, `max(0, −balance)` in integer cents under Akahu's sign convention (owed is a negative balance; confirm against live data before merge), is a new term **card debt**, subtracted from safe-to-spend in every scope the account belongs to: `safe = liquid − unpaid bills − remaining budget − tax hold − card debt`. A card in credit contributes 0. Why: Hannah's card is personal debt she means to pay off (2026-10-25); leaving it out would show money as spendable that is already spent. Extends to: the ledger shows card debt as its own line; prd-03 reports it as a part of the number.

## Ruling 11 — Each scope holds its own tax, against its own pot (operator amendment, 2026-10-25; amends Ruling 2)
There is a tax pot per scope, marked by role `tax pot` on an account of that scope; neither is liquid.
- **Strawb tax hold**: `max(0, taxRate × profit − Strawb tax pot balance)`, as Ruling 2 had it, netting only Strawb-scope tax pots.
- **Personal tax hold**: `max(0, personalTaxOwed − personal tax pot balance)`. `personal_tax_owed_cents` is a setting Hannah types in: what she owes Inland Revenue in personal income tax. No rate is applied.
- Personal scope uses the personal hold; Strawb scope the Strawb hold; All the sum of both.
Why: Hannah owes substantial personal income tax and is setting a personal account aside for it (2026-10-25); Ruling 2's "0 in Personal" would show that money as owed nowhere. Strawb's whole business account is its tax pot for now, which is a role setting (#30), not a rule. Extends to: the settings panel (#46) gains the owed amount; prd-05's Xero profit feeds only the Strawb hold.

> Amended 2026-10-25 by Ruling 12.

## Ruling 12 — Strawb's bills are paid from the Strawb tax pot first, so that money never counts as tax set aside (operator amendment, 2026-10-25; amends Ruling 11)
Strawb's business account is both its tax pot and where its bills are paid from. So the Strawb pot is split, automatically, every time safe-to-spend runs: `strawb bills buffer = min(Strawb pot, Strawb unpaid bills)`; the pot counted against tax is `Strawb pot − buffer`, so `Strawb hold = max(0, taxRate × profit − (Strawb pot − buffer))`; and only the part of Strawb's unpaid bills the pot cannot cover, `Strawb unpaid bills − buffer`, is subtracted from liquid. No setting: the buffer follows the bills as they change, are added or are marked paid. Why: Hannah chose the automatic buffer over a fixed amount (2026-10-25); a fixed amount drifts out of date when a bill changes, and counting bill money as tax set aside understates the hold. Extends to: the Strawb and All views; the personal pot and personal bills are unchanged. Total money subtracted is the same as before whenever the pot covers the bills; only which line it sits on moves.

## Ruling 13 — Handoff update 2 is the design reference (operator amendment, 2026-10-25)
`docs/design/Divvy.dc.html` is replaced by handoff update 2, and its change list lands as `docs/design/CHANGES-2.md` beside `handoff.md` (unchanged). Update 2 is the "Candy pink" look: ten pink tokens as CSS custom properties, cards with no border and a hard offset shadow, 6px radius on pills, buttons, chips and bars, a text wordmark, and a new Overview layout (inset account tiles, Alerts and Recent activity side by side). Hannah chose (2026-10-25) to apply it to the built shell before any more screens, so the Overview (#45) and every later screen are built once, in the new look. Done-when 6 is judged against the new file from now on. Why: re-skinning after the screens exist would redo every screen. Extends to: every prd-02 screen. Theme presets and per-user colour overrides are out of scope (Hannah: "i dont want presets yet"); the tokens exist so presets can be added later without touching components. Where update 2 contradicts a ruling (its Google Fonts link against Ruling 7, its `taxRate` default against the settings rulings), the ruling wins.

## Ruling 14 — Subscriptions is a screen, detected from Akahu transactions (operator amendment, 2026-10-25; amends Ruling 8 and the Out-of-scope row "Need/want tagging, subscription detection" in prd-04)
A Subscriptions screen sits after Bills in the nav and follows the All / Personal / Strawb scope (CHANGES-2.md §3). On the phone it is reached from the Overview links (the #33 answer); the tab bar stays at five.
- **Detection is computed on read, by a pure function in `shared/subscriptions.ts`.** A subscription is a merchant (Akahu `merchant_id`, else the normalised description) with at least 3 settled charges in scope whose gaps are all weekly (7 ± 2 days), all monthly (30 ± 4) or all yearly (365 ± 10). Its amount is the latest charge. These numbers are named constants with tests.
- **Hannah has the last word on what is a subscription.** She can mark any merchant as a subscription, and unmark a detected one; her mark wins over detection both ways. A merchant with fewer than 3 charges whose name matches a fixed list of subscription hints (a named constant, e.g. streaming, software, "membership", "subscription") is not counted; it is shown as "Is this a subscription?" with Yes and No, and her answer is remembered. Hannah, 2026-10-25: "if i say that its a subscription then you can tag it as one … if it looks like it might be because of name of merchant too, then ask me".
- **Totals are integer cents.** Per month sums monthly charges, weekly × 52 ÷ 12 and yearly ÷ 12, each rounded half-up once per subscription. Per year is the same set × 12 from those per-month figures.
- **No usage tags.** Hannah dropped usage for now (2026-10-25): no Barely used / Some use / Used often chips and no "Barely used" tile. The summary shows Per month and Per year only.
- **Cancel marks, it never acts.** "Cancel" records the date in a new table (keyed by scope and merchant key, which also holds her subscription / not-a-subscription answer); no call goes to the merchant or bank. If a charge lands after that date, the row shows "charged again on <date> after you cancelled" and returns to active.
- **Subscriptions are not part of safe-to-spend.** Their charges already land as transactions and future ones are held by Bills where Hannah enters them.
- **Xero bills are not read** until M4 (prd-05).
- The advisor banner ("Help me cancel →") opens Claude desktop, like the Advisor placeholder; without usage tags it names no subscriptions.
Ruling 8 still deletes the old Subscriptions page in wave 5; the new screen is a new component in the same nav slot. Why: Hannah added the screen to prd-02 on 2026-10-25 ("Add to prd-02 now"). Extends to: prd-03 may later read the same function; prd-04's detection row is superseded for subscriptions only.

> Amended 2026-10-25 by Ruling 15: drawings are not charges.

## Ruling 15 — Drawings are transfers, not spending (operator amendment, 2026-10-25)
A transfer out of a `strawb` account matched by the same amount arriving in a `personal` account (within a small date window the architect sets and states) is a **drawing**. Both halves show the category **Drawings** unless Hannah has set a different category on that row by hand, which always wins. Drawings are left out of Strawb spending, budgets and subscriptions, and the personal half is not counted as spending or as a budget credit. They still move balances. "Drawings" is added to the categories Hannah can pick, so an unmatched one can be tagged by hand. Why: counting a drawing as spending double-counts her own money and makes Strawb look like it spends what it pays her.

## Sequencing

Waves are **layers**: issues in a wave are fenced apart and built in parallel; one PR per wave. Where a screen and its route are in the same wave they are built against the typed contract from wave 1 (`shared/contracts.ts`), not against each other. `server/server.ts` is a shared mount point that prd-01 and prd-03 also touch; wave 1 turns it into a route barrel so later edits are one-line and merge trivially.

**Wave 0 — operator acts (not dispatchable):**
- Set each Akahu account's `scope` (personal or Strawb) and `role` (current, savings, tax pot).
- Choose payday day of month, tax rate, and a first profit figure.
- Confirm Rulings 2, 3 and 5 (they are money rules).

**Wave 1 — the keystone (contracts, additive):**
- `prd02 w1: safe-to-spend is one pure function with a fixed test table` — creates `shared/safe-to-spend.ts` (including the per-budget `spent` helper), its tests, `shared/contracts.ts` (response types).
- `prd02 w1: budgets, bills, goals, account roles and dismissals exist as tables` — migration (drops `targets`), schema-reviewed.
- `prd02 w1: the app shell has tokens, fonts, nav, scope toggle and the phone tab bar` — creates shell components; scope in a context.
- `prd02 w1: server routes mount through a barrel` — modifies `server/server.ts`, creates `server/routes/index.ts`.

**Wave 2 — the visible slice:**
- `prd02 w2: the overview route returns safe-to-spend, ledger, accounts and alerts for a scope`
- `prd02 w2: the Overview screen shows the hero, ledger, cards and activity for the chosen scope` — includes inline category edit.
- `prd02 w2: tax rate, profit, payday and currency are settings you can change` — settings route and a small panel.

**Wave 3 — data routes (parallel):**
- `prd02 w3: budgets can be created, adjusted and deleted`
- `prd02 w3: bills can be created, edited and marked paid`
- `prd02 w3: goals can be created and given contributions`
- `prd02 w3: habits route returns runway, computable streaks and worth-it verdicts` (adds the verdict table; the runway and streak maths live in `shared/habits.ts`, which prd-03 imports).

**Wave 4 — screens (parallel):**
- `prd02 w4: the Budgets screen` · `the Bills screen` · `the Goals screen` · `the Habits screen` · `the Sync screen (reads prd-01 status)` · `the Privacy and Advisor placeholder screens`.

**Wave 5 — sweep:**
- `prd02 w5: the old Dashboard, Transactions, Targets, Subscriptions and Challenges pages are gone`.

Unfiled work implied, described not numbered: pixel review pass against the prototype; the Advisor screen becomes a chat if the API question in prd-03 resolves; Strawb gains Xero lines in M4.

### Sequencing addition (2026-10-25)
- **Wave 2:** `prd02 w2: the shell uses handoff update 2 (Candy pink tokens, borderless cards, wordmark)` (#228) — lands `Divvy.dc.html` and `CHANGES-2.md`, re-skins the built shell. Blocks #45.
- **Wave 3:** `prd02 w3: subscriptions are detected from transactions and can be marked and cancelled` (#229) — `shared/subscriptions.ts`, a migration for the marks table (subscription / not, cancelled date), the route.
- **Wave 4:** `prd02 w4: the Subscriptions screen shows regular charges, totals, "Is this a subscription?" and cancel` (#230).

## Open questions that block this

- How is the Freedom date computed ("when savings cover your costs", `handoff.md:44`)? No formula is given; Habits ships without it until it is. Open, not ruled.
- Is the profit figure per month, per tax year, or year to date? Changes what "taxRate × profit" means in Ruling 2. — ANSWERED (Hannah, 2026-10-23): year to date, accrual basis, from Xero's P&L (prd-05). Until Xero is connected the Strawb profit input is 0 and the tax hold is driven by the tax pot alone.
- Which accounts are your Strawb business accounts in Akahu, and is there one at all? Blocks the Strawb scope having content. Open, not ruled.
- How are Bills, Sync and Privacy reached on the phone? The tab bar has five items and none of them (`handoff.md:14`). — ANSWERED (Hannah, 2026-10-25): links on the Overview. Bills, Sync and Privacy are reached from cards or a footer row on the Overview, and the tab bar stays at five. The Overview screen (#45) builds the links.

**Not blocking:** Xero, the Advisor chat, the weekly report, the Patterns card text, dark mode.

## The one risk worth watching

The safe-to-spend function and the scope filter being "mostly right". Every screen and the advisor read them, so an off-by-a-bill number looks plausible and is trusted. Hold the fixed test table (wave 1) as the contract, and resist adding a screen before the number matches your own arithmetic. The second risk is pixel work swallowing the data work.
