# PRD 01 — Real data on a private server

> **Status:** blessed by Hannah in session, 2026-10-23 (all five PRDs blessed together; decisions 6 and 7 answered the same day)

**Prerequisite:** milestone M1 "Make it run again" (issues #1–#10) has landed. This PRD assumes integer cents (#8), no Auth0 (#3), working build/Dockerfile/migrate scripts and a minimal `fly.toml` (#6), and a vitest scaffold (#10). It replaces the description of milestone M2.

**Territory.** This PRD owns `server/sync/**`, the accounts and sync-run migrations in `server/db/migrations/`, `fly.toml`, the Litestream config, and the container start script. `client/**`, `src/**`, `shared/**` and the budgets/bills/goals routes and migrations are prd-02's territory; `mcp/**` and the advisor audit file are prd-03's. No wave here enters them, with one named exception: the Dashboard's data-fetching calls in `client/apis/apiClient.ts` (wave 3).

## What we're building

Divvy's server pulls your real bank accounts and transactions from Akahu into its own SQLite database every 15 to 30 minutes, including pending transactions turning into settled ones, and keeps them there. It runs on one always-on Fly machine in Sydney with a volume, with no public IP, so it can only be reached from your own devices over Tailscale. Litestream backs the database up continuously. Divvy keeps its own full copy of every transaction, with Akahu's category kept separate from yours, so a category you fix stays fixed. The existing Dashboard reads from that database instead of calling Akahu live, and shows when the last sync happened. This is the first iteration that shows your real numbers, on your server.

## Why this first

1. Every later screen and the advisor read the database. Nothing in prd-02 or prd-03 means anything until real, correct rows are in it.
2. A wrong upsert key or pending handling corrupts history silently and cannot be repaired after months of use. It has to be right before anything stands on it.
3. Today the only working path hands the owner's bank token to anyone who can reach the server (`server/routes/akahu.ts:10-11`, `server/server.ts:17`). Moving data into the DB lets that proxy be deleted.

Rejected alternatives:

- *Proxy-first*: keep reading Akahu live and cache in memory. Rejected because history, budgets and the advisor all need durable rows, and live reads cannot show a pending-to-settled change.
- *UI-first*: build the handoff screens on the existing live proxy. Rejected because every screen would be rebuilt against data that has no accounts table and no stable key.
- *Sync-only, no server*: run sync on the laptop and defer Fly. Rejected because "always up to date" and "private" were the point of D1, and a laptop sync stops when the lid closes.

## Evidence

- **Nothing writes Akahu data into the database.** `server/routes/akahu.ts:17-22` only proxies and returns the response; no file under `server/` inserts into `transactions`. The only writer is the seed, which depends on a gitignored file (`server/db/seeds/transactions.js:1`).
- **There is a unique key to build on, but only for settled rows.** `server/db/migrations/20250611031435_transactions.js:8` has `akahu_id` unique. There is no `status` column, so a pending row cannot be told from a settled one.
- **There is no accounts table.** The migrations directory has transactions, users, targets, wishlist_items, settings, user_challenges and nothing else; `account_id` is a bare string (`20250611031435_transactions.js:9`). The Akahu account shape already exists in `models/akahu.ts:6-19`.
- **Akahu's category is already stored but there is nowhere for yours.** `20250611031435_transactions.js:22-25` has `category_id`, `category_name`, `category_group_id`, `category_group_name`, and the seed fills them from Akahu (`server/db/seeds/transactions.js:17-20`). The one edit path overwrites `category_group_name` in place (`server/db/transactions.ts:27-29`), so a re-sync would silently undo a correction. The contract is mid-reconciliation in issue #9.
- **The Dashboard is wired to live Akahu calls.** `client/components/Dashboard/Dashboard.tsx:30-33` and `:40-44` call `grabAccounts`/`grabTransactions`; those hit the proxy (`client/apis/apiClient.ts:7`, `:24`). It reads `.items` of an Akahu-shaped envelope (`Dashboard.tsx:53`, `:73`, `:120`).
- **The proxy ignores the account filter the client sends.** `client/apis/apiClient.ts:18` sends `accountIds`; `server/routes/akahu.ts:33-56` never reads it (audit §1).
- **Production already points at a volume path and nothing runs a scheduler.** `server/db/knexfile.js:40` uses `/app/storage/prod.sqlite3`; `server/index.ts:5-8` only calls `listen`.
- **The host and backup are already decided.** D1 and D2 in `docs/decisions.md:7-8`; M1 issue #6 stops short of Litestream, Tailscale and the deploy ("belong to M2").
- **Money must be cents before this writes it.** Issue #8 (float columns replaced with `amount_cents`, `balance_cents`; Akahu dollars converted "at the boundary in the sync/seed code only").
- **Handoff expects a 15-minute worker and a Sync screen.** `docs/design/handoff.md:67` ("sync worker every 15 min") and `:54-55`.

## In scope

- `accounts` table; `status` (pending/settled) on transactions; a `sync_runs` table (start, end, outcome, counts, error text).
- Akahu client in `server/sync/` for accounts and transactions, pending and settled, with overlap-window fetching.
- Own copy of every Akahu transaction; Akahu-category and effective-category fields kept apart, plus a `category_corrections` table, backfilled from the existing category columns.
- Idempotent upsert of settled rows that never touches user-owned fields; pending mirror replaced per account each run.
- In-process scheduler, one run at a time, every 15 minutes, plus a "sync now" trigger.
- `GET /api/v1/sync/status`; accounts and transactions routes reading the DB in the Akahu envelope shape.
- `fly.toml` deploy: one machine, Sydney, volume, no public IP, Tailscale, Litestream with a restore drill.
- Dashboard data calls switched to the DB routes and a "last synced" time shown; live proxy routes deleted.

## Out of scope

| Item | Goes instead to |
|---|---|
| Handoff screens, safe-to-spend, scope toggle, bills/budgets/goals | prd-02 |
| Dashboard's hardcoded targets (`Dashboard.tsx:19-24`) staying as they are | prd-02 replaces them with DB budgets |
| Sync screen UI, "Sync now" button, status pill | prd-02 (reads `/sync/status`) |
| Inline category edit UI on activity rows | prd-02 (calls the update route reconciled in #9; this PRD only guarantees the data survives sync) |
| Transactions page with search | Not in the handoff; a later PRD |
| Rule-based and Claude categorisation, learning from corrections, need/want tags | Later PRD (D3 background jobs); this PRD only records the corrections |
| Xero, email invoices | M4/M5 PRDs |
| MCP server and its read-only copy of the DB | prd-03 (consumes the Litestream replica this PRD produces) |
| Akahu OAuth and per-user tokens | Only if someone else ever connects (audit decision 5) |
| Web push, alert engine | Later PRD (D5) |
| Server-side request auth | None; D4 (Tailscale-only) |

## Done when

1. Two consecutive syncs of the same data change no row. *Not met while* a second run produces any insert, any changed `updated_at` on an unchanged row, or a changed row count (checked by a test against a recorded Akahu fixture, run twice).
2. A transaction that was pending in run N and settled in run N+1 appears exactly once, as settled, with its category/edit fields intact. *Not met while* the pending row survives next to the settled one, or the settled one is missing.
3. A transaction that disappears from Akahu's pending list without settling (cancelled) is gone from the pending mirror but no settled row is ever deleted by sync. *Not met while* a sync can delete a settled row.
4. A run that fails midway (network drop, Akahu 5xx, bad token) leaves the database exactly as it was and writes a `sync_runs` row with the error. *Not met while* a partial write is visible or a failure is silent.
5. The deployed app is reachable from your phone and laptop over Tailscale and from nowhere else. *Not met while* `fly ips list` shows any public address, or the app answers on a `*.fly.dev` name from a device not on the tailnet.
6. A backup restores. *Not met while* a Litestream restore into a clean volume has not been done and its Dashboard totals compared to production.
7. Re-running the sync after a manual recategorisation leaves the category untouched. *Not met while* a sync changes `category`, `category_source`, or removes the `category_corrections` row, or while Akahu's received category is not preserved in `akahu_category_*`.
8. The Dashboard shows your real accounts and transactions from the database with a "last synced" time, and the live proxy routes no longer exist. *Not met while* `server/routes/akahu.ts` still serves a request that spends the Akahu token.

Items 1–4 and 7 are proven by tests (the code does what is written). Items 5–6 are proven by commands run once on the real machine. **Only 8 matters:** you open the Dashboard on your phone, the balances match your bank app, and a transaction you made an hour ago is there (or marked pending). Whether the numbers are right is only judged by you against the bank.

## Rulings

## Ruling 1 — Settled transactions are keyed by Akahu's own id, pending ones are a replaced mirror
Settled rows upsert on `transactions.akahu_id` (`ON CONFLICT ... DO UPDATE`). Pending rows carry `status='pending'` and are deleted-and-reinserted per account inside the same database transaction that upserts settled rows. Why: a pending item has no stable settled identity until it settles, so inventing a key for it is how duplicates and phantom rows appear; replacing the mirror makes cancelled items vanish with no special case. Extends to: nothing else may delete settled rows. Whether Akahu's pending items carry any id is **unverified from memory** and is the first thing wave 1 checks against Akahu's docs and a real response.

## Ruling 2 — Sync re-reads an overlap window, not "since last run"
Each run fetches back a fixed window (30 days) and upserts, rather than a cursor from the last run's end. Why: settled transactions can be amended or appear late, and a cursor silently misses them; idempotency (Ruling 1) is what makes the overlap free. First run backfills as far back as Akahu allows.

## Ruling 3 — Money is converted to cents once, at the sync boundary
Akahu dollars become integer cents in `server/sync/` and nowhere else (matches #8). The DB routes in this PRD convert back to dollars only to keep the existing Dashboard's Akahu-shaped envelope until prd-02 replaces it. Why: one conversion point is one place a rounding bug can live.

## Ruling 4 — Divvy owns a full copy; Akahu's category and yours are separate fields
Every Akahu transaction is stored in full. `akahu_category_*` (id, name, group id, group name) holds what Akahu sent, as received, and is the only category data sync may write. `category` is the effective category, `category_source` is one of `akahu | user | rule | claude`. The sync upsert on `akahu_id` updates Akahu-owned fields only, and updates `category` only while `category_source = 'akahu'`; a user-set category is never overwritten. Every correction also appends a row to `category_corrections` (transaction id, from, to, at, source) so a later categorisation PRD (D3) can learn from it. Why: Akahu's categories are not always accurate (Hannah), and a correction that a 15-minute job can revert is worse than no edit. Backfill: the existing `category_*` columns (`20250611031435_transactions.js:22-25`) become `akahu_category_*` with `category_source='akahu'`. Extends to: prd-02's inline edit writes `category`/`category_source='user'` and a corrections row through the route #9 reconciles; prd-03 reads the effective category and its source. Rule/Claude writers are a later PRD and must obey the same "never override `user`" order.

## Ruling 5 — Akahu runs in personal-app mode with one static token in Fly secrets
`AKAHU_USER_TOKEN` and `AKAHU_APP_ID` are Fly secrets, never in the database, never in the image. Why: one user (audit decision 5). Extends to: no per-user token table, no OAuth. prd-03 relies on the token never being in any table.

## Ruling 6 — The scheduler lives in the web process, one machine, one run at a time
`setInterval` plus a guard against overlap, backed by an "in progress" row in `sync_runs`; exactly one Fly machine is ever run. This closes audit decision 7 (job runner) for now. Why: one user, one machine, a separate worker is a second thing to deploy and monitor. Revisit if the sync ever blocks request handling.

## Ruling 7 — No public surface, ever, in this PRD
`fly.toml` has no `[http_service]` or public ports and the app gets no public IP; Tailscale runs inside the machine and serves the app (and the TLS certificate web push will need later, D5). No server-side auth is added (D4); the tailnet ACL is the access control.

## Ruling 8 — Accounts carry an owner scope column
`accounts.scope` is `personal` or `strawb`, set by you per account (default `personal`), never inferred. Why: prd-02's scope toggle filters on it, and it is cheaper to add the column with the table than to migrate later. prd-01 populates it with a manual mapping and exposes no UI for it.

## Ruling 9 — Business bank transactions come from Akahu; Xero's bank feed is the fallback only (amendment, 2026-10-23)
Strawb's BNZ business transactions are synced from Akahu exactly like personal ones, into the same tables, with `accounts.scope = 'strawb'`. Xero's bank feed already holds the same BNZ transactions and is **not** a second source: importing both would duplicate every Strawb transaction. Each account has exactly one `source` (`akahu` or `xero`), set explicitly by Hannah, never inferred. Wave 1's migration adds `source` (default `akahu`) to `accounts` and `transactions` now, so a fallback needs no later change to prd-01's tables. Xero is used only if the BNZ business link cannot be made, and that fallback is prd-05's to implement behind the same tables with `source = 'xero'`. Why: a duplicate bank line is a silent double-count in every balance and budget downstream. Reason it may be needed: Akahu's docs say BNZ business accounts connect only through a personal customer access number, and that BNZ relies on a government exemption that expires on 1 June 2027 (https://developers.akahu.nz/docs/official-open-banking-feature-support-accounts, read 2026-10-23). Extends to: prd-05 must refuse to import Xero bank transactions for any account that has, or whose bank account has, an Akahu source.

## Sequencing

Waves are **layers**: issues inside a wave are fenced apart and built in parallel; one PR per wave.

**Wave 0 — operator acts (not dispatchable):**
- Confirm the Akahu personal-app token and app id still work (a `curl` to `/accounts`); the repo's token is from 2025 and its validity was never checked (audit "Not checked").
- Fly account, an app name, region `syd`, a billing method; create the volume.
- Tailscale: auth key for the Fly machine, tailnet ACL allowing only your devices, HTTPS certificates enabled.
- Tell us which Akahu accounts are personal and which Strawb. *Amended 2026-10-23:* Strawb banks with BNZ and Hannah confirms the business account is already linked to her personal BNZ access number, so the blocker is reduced to confirming the business account appears in the Akahu connection (see Ruling 9).

**Wave 1 — the keystone (contracts, additive):**
- `prd01 w1: accounts, sync_runs, a source column, transaction status and separate Akahu/user category fields exist as tables` — creates the migrations (incl. `category_corrections` and the backfill; schema-reviewed); confirms Akahu pending semantics against docs.
- `prd01 w1: the Akahu client returns typed, cents-converted accounts and transactions` — creates `server/sync/akahu-client.ts` and a recorded fixture.

**Wave 2 — behaviour (parallel):**
- `prd01 w2: a sync run upserts settled transactions and mirrors pending ones` — `server/sync/run.ts` plus the idempotency and category-survival tests (done-when 1–4, 7).
- `prd01 w2: the container runs on Fly with Tailscale and no public IP` — `fly.toml`, Dockerfile start script, Tailscale (modifies the M1 #6 files).
- `prd01 w2: Litestream replicates the database and a restore is documented` — Litestream config and restore script.

**Wave 3 — the visible slice:**
- `prd01 w3: the scheduler runs syncs every 15 minutes and exposes sync status` — scheduler, `/sync/status`, "sync now" trigger.
- `prd01 w3: the Dashboard reads synced data and shows when it last synced` — new DB-backed accounts/transactions routes, switches `client/apis/apiClient.ts`, small "last synced" element in the Dashboard; deletes the proxy routes.

**Wave 4 — close-out:**
- `prd01 w4: the deployed machine has synced real data and survived a restore` — an operator-run checklist, not a coded change.

Unfiled work implied, described not numbered: a pass to retire the M1 Dashboard once prd-02's Overview lands; a runbook of what to do when Akahu re-consent (90 days) expires.

## Open questions that block this

- Does the personal-app token still work, and does Akahu still allow personal apps with the scopes needed? A dead token means the whole PRD waits on Akahu. Open, not ruled.
- Is a business bank account connected to Akahu? If not, the Strawb scope in prd-02 is empty until it is. Open, not ruled. — *ANSWERED in part (Hannah via coordinator, 2026-10-23):* the business bank is BNZ; connecting it needs her personal BNZ access number and possibly a call to BNZ (not needed: already linked). *Further, same day:* Hannah confirms the account is already linked to her access number; what remains is confirming it appears in the Akahu connection. Open, not ruled.
- How far back does Akahu let the first backfill go? Governs how much history you start with. Open, not ruled.

**Not blocking:** Xero token storage (D6), email ingestion, push notifications, and categorisation. None of these touch this iteration.

## The one risk worth watching

Scope expansion into prd-02: the Dashboard is right there and will invite a re-skin. Hold the line at "same Dashboard, new data source, one new timestamp". The second risk is the sync being declared done on green tests with no real bank data ever compared by a human (done-when 8).

## Amendment — BNZ business account and the Xero fallback (Hannah via coordinator, landed 2026-10-23)
Adds Ruling 9, makes the Wave 0 Strawb-account blocker specific (BNZ access number, possible call to BNZ), answers the business-account question in part, and adds the `source` column to the wave 1 migration. Hannah later confirmed the account is already linked, so the fallback is not expected to be needed. Territory unchanged: the Xero fallback import is prd-05's. New risk to watch: the BNZ exemption in Ruling 9 expires 1 June 2027, after which behaviour of the business link is not ours to predict.
