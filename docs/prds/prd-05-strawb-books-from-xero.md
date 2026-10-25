# PRD 05 — Strawb's books from Xero

> **Status:** blessed by Hannah in session, 2026-10-23 (all five PRDs blessed together; decisions 6 and 7 answered the same day)

**Prerequisites.** M1 has landed. prd-01 is deployed (database, scheduler pattern, Tailscale HTTPS, `accounts.source`). prd-02 wave 2 has landed the Overview and its overview route. prd-03 and prd-04 are not required.

**Territory.** This PRD owns `server/xero/**` (including its routes, scheduler and token vault), the Xero migrations (tables namespaced `xero_*`), and `models/xero.ts`. `server/sync/**`, `fly.toml`, Litestream and the accounts/sync migrations are prd-01's territory; `client/**`, `src/**`, `shared/**` and the budgets/bills/goals/overview routes are prd-02's; `mcp/**` is prd-03's; `server/agents/**` is prd-04's. No wave here enters them, with these declared exceptions in wave 3: the Overview's "Owed to you" line, the Sync screen's Xero rows and the Privacy "outbound calls" line (prd-02's components), and the overview route's inputs. It consumes prd-01's `accounts`, `transactions`, `sync_runs`.

## What we're building

Divvy connects to Strawb Collective Ltd's Xero (read-only, one organisation, NZD) and keeps its own copy of what Xero knows: money owed to Strawb, money Strawb owes, pay runs, and this tax year's profit. The Overview then shows "Owed to you · Xero · N invoices" with the real amount, the tax hold uses Xero's profit instead of a number you type, and Strawb's bills due come from Xero. Money that is owed but not yet in the bank is shown and never spent. The advisor can already read Xero through the Claude Xero connector in Claude desktop; this PRD is for Divvy's own numbers.

## Why this first (after prd-01, 02)

1. The Strawb side of the Overview is empty or typed-in until Xero arrives (prd-02 ruling 4), and the tax hold rests on a figure you enter by hand.
2. Xero is where Strawb's invoices, bills and profit live; none of it is in a bank feed.
3. Pay runs are the future salary link (audit row "Salary as the link"), and have to be stored before matching can be built.

Rejected alternatives:

- *Bank feed as the Strawb source*: take Strawb's transactions from Xero's bank feed. Rejected because Akahu already supplies BNZ business transactions (prd-01 ruling 9) and two sources for one account duplicate every line. Kept as a fallback only.
- *Advisor-only*: rely on the Claude Xero connector and build nothing. Rejected because Divvy's safe-to-spend, tax hold and Sync screen need these numbers in Divvy's own tables, and an advisor answer cannot feed a number the screens must also show.
- *Custom Connection first*: see Ruling 1.

## Evidence

- **No Xero code exists.** Audit gap row "Strawb Xero: absent" (`docs/audit-2026-10-23.md:81`) and decision 6 (`:113`); no `xero` path under `server/` or `models/`, and no Xero dependency in `package.json:27-52`.
- **The decision is still open.** "D6 Xero token storage" is listed as undecided in `docs/decisions.md:13`; this PRD rules it (Ruling 2).
- **The design says where Xero shows.** Strawb card with "Owed to you · Xero · 2 invoices" as `~$3,200`, pending, excluded from safe-to-spend (`docs/design/handoff.md:28`); Sync screen Xero row and "Pulled from Xero this week" (`:55`); the formula (`:25`).
- **The Privacy screen lists outbound calls.** `docs/design/handoff.md:58`; a Xero API call is one more.
- **The typed profit figure is a stopgap.** prd-02 ruling 2 defines tax hold from a typed profit and says it holds "until Xero lands"; prd-02 ruling 4 hides the Xero line.
- **Host and storage are decided.** D1 (Fly, no public IP, Tailscale only) and D2 (SQLite plus Litestream) in `docs/decisions.md:7-8`; the replica and backups will hold whatever this PRD stores, hence encrypted tokens.
- **The real numbers exist outside the repo.** Via the Claude Xero connector, Hannah reports (as of 14 Oct, not in the repo): cash 13,773, owed to Strawb 5,276, Strawb owes 8, for "Strawb Collective Ltd" (NZD). The handoff's `3,200` is sample data (`Divvy.dc.html:419-421`).
- **The bank link makes the fallback unlikely.** prd-01 ruling 9: BNZ business already linked to her access number (Hannah, 2026-10-23); Akahu docs note an exemption expiring 1 June 2027.

## In scope

- Xero OAuth2 for one org, read-only scopes; connect, callback, disconnect.
- A token vault: tokens and tenant encrypted at rest, refresh tokens rotated and persisted atomically.
- A Xero sync on the 15-minute cadence for receivable invoices, payable bills, pay runs, and the P&L summary for the current tax year.
- Overview: the "Owed to you" line; Xero payables in the ledger; Xero YTD profit as the profit input.
- Sync screen: Xero row and the "Pulled from Xero this week" list; Privacy outbound-calls line.
- Conditional: the bank-feed fallback import (Ruling 5), built only if the BNZ business link fails.

## Out of scope

| Item | Goes instead to |
|---|---|
| The tax-hold formula, GST, PAYE, company tax rates and filing periods | prd-02 owns the formula (ruling 2); a tax PRD owns rates and periods. This PRD supplies only the profit input |
| Matching pay runs to salary transactions | Later PRD (salary link); this PRD only stores pay runs |
| Writing to Xero (create, approve, mark paid) | A future write PRD; scopes stay read-only |
| Email invoice ingestion and matching to Xero bills | M5 PRD |
| The advisor reading Xero | Claude Xero connector in Claude desktop today; an MCP Xero tool only by amendment to prd-03 |
| Multiple orgs, Xero for other people | Not planned (one user) |
| Using Xero bank feed as a routine source | Never; fallback only |

## Done when

1. The Overview shows "Owed to you · Xero · N invoices" with Xero's own outstanding-receivables total. *Not met while* the amount or count differs from Xero's at the same time, or safe-to-spend changes because an invoice was raised or marked paid in Xero (it moves only when cash reaches the bank, through Akahu).
2. A refresh token is never lost. *Not met while* killing the process at any step of a token refresh (before the response is stored, after storing, between calls), or two refreshes racing, leaves the next sync unable to authenticate; and *not met while* a failed refresh leaves the Sync row looking healthy instead of showing "reconnect Xero".
3. Xero money is never counted twice. *Not met while* Xero cash balance enters liquid, an invoice total enters safe-to-spend, or a Strawb bill appears both as a Divvy bill and as a Xero payable.
4. Tokens are encrypted. *Not met while* a dump of the SQLite file, the Litestream replica or the prd-03 replica contains a plaintext access or refresh token, or the encryption key is in the database or the image.
5. The consent is read-only. *Not met while* the granted scopes include any write scope.
6. With Xero connected, the tax hold's profit is Xero's year-to-date profit. *Not met while* the typed figure is still used, or the stored profit differs from Xero's P&L report for the same dates.
7. Pay runs are stored. *Not met while* a pay run is missing from the table, or pay-run rows appear in any prd-03 replica.
8. The Sync screen's Xero row and the "Pulled from Xero this week" list show true status and data. *Not met while* the row shows "ok" with a stale `last_synced` older than two intervals.
9. If the fallback is enabled: no account has two sources. *Not met while* any bank transaction exists twice, or the Xero import runs for an account whose bank account has an Akahu source.

Items 2–5 and 9 are tests (the code does what is written). Items 1 and 6 are checked against Xero itself. **Only 1 matters:** you open the Overview and the amount owed to Strawb is the amount you see in Xero. On the day of acceptance, compare with the Claude Xero connector's numbers (14 Oct baseline: 5,276 owed to Strawb, 8 owed by Strawb).

## Rulings

## Ruling 1 — Standard OAuth2 with a tailnet callback, not Xero Custom Connection
The Xero app uses the authorization-code flow. The callback is a redirect of Hannah's own browser to an `https` address on the tailnet (the Tailscale certificate D5 already needs), so the machine never has to be reachable from Xero's servers. Why: it is free; the Custom Connection (client credentials, no callback, no rotating refresh token) is paid (audit `:113`) and its availability for a NZ org was not checked. The cost: refresh-token rotation is the risk this PRD is built around. If wave 1's spike shows Xero will not accept a tailnet redirect address, Ruling 1 is amended to the Custom Connection, and Ruling 3 simplifies. Whether Xero accepts the address, and the refresh-token lifetime, are **unverified from memory** and checked in the spike.

## Ruling 2 — Tokens and tenant are encrypted in SQLite with a key from Fly secrets
AES-256-GCM, key in a Fly secret (`XERO_TOKEN_KEY`), never in the database, image or replica. This closes D6. Why: SQLite and its Litestream backups hold the file; the key is in neither. Extends to: the prd-03 replica allowlist excludes every `xero_*` token table.

## Ruling 3 — A refresh token is stored before it is used, in one transaction, by one refresher
A refresh writes the new token pair in a single database transaction, guarded by a version check, before any call uses the new access token; only one refresh runs at a time. The old token is never discarded until the new one is committed. A failed refresh marks the connection `needs_reconnect` and the Sync row says so. Why: Xero rotates refresh tokens, so losing the new one means re-consenting and a Strawb side that goes stale unnoticed.

## Ruling 4 — Xero never adds money to liquid, and only two Xero figures enter safe-to-spend
Entering the formula: payables due (as the Strawb scope's "unpaid bills") and year-to-date profit (as the tax-hold input). Not entering: receivables (shown, "pending, excluded", `handoff.md:28`), Xero cash (it is the same money as the BNZ balance from Akahu). Once Xero is connected, Strawb bills come from Xero payables and manual Strawb bills are disabled. This amends prd-02 ruling 2 by reference (profit source and Strawb bills), and does not rewrite it. The formula stays in `shared/safe-to-spend.ts`.

> Amended 2026-10-25 by Ruling 7.

## Ruling 5 — The bank-feed fallback stays, and is not expected to be needed
Business bank transactions come from Akahu (prd-01 ruling 9, and Hannah confirms the BNZ business account is already linked to her access number). The Xero fallback imports bank transactions into prd-01's tables with `source = 'xero'` only if Hannah sets `strawb_bank_source = xero`, and never for an account whose bank account has an Akahu source.

## Ruling 6 — Xero data lives in `xero_*` tables and is a copy, not a ledger
Invoices, bills, pay runs and the P&L summary are stored as received (amounts in integer cents) and replaced by upsert on Xero's own ids. Divvy never edits them. The P&L is stored per period with its fetch time, because "this year's profit" is only as good as when it was fetched.

## Ruling 7 — Only NZD is ever summed; other currencies are kept apart (operator amendment, 2026-10-25; amends Ruling 4 and Done-when 1)
Every figure Divvy derives from Xero (receivables owed, payables, anything that enters safe-to-spend) sums only invoices and bills whose `currency` is NZD. Amounts in any other currency are kept per currency and shown separately (e.g. "plus USD 100.00 owed"), never converted with a rate and never added to an NZD total. Why: Hannah chose the simplest honest rule (2026-10-25, #102); a converted figure moves with the exchange rate and a refused list would break the screen the first time Strawb invoices abroad. Extends to: the Xero sync (#66), the Overview's "owed to Strawb" line (#71) and the tax hold's payables (#73). Done-when 1's match with Xero's own figure compares the NZD total only.

## Sequencing

Waves are **layers**: issues in a wave are fenced apart and built in parallel; one PR per wave.

**Wave 0 — operator acts (not dispatchable):**
- Confirm you are the Xero org admin and create the Xero developer app; register the redirect address.
- Add `XERO_CLIENT_ID`, `XERO_CLIENT_SECRET` and `XERO_TOKEN_KEY` as Fly secrets.
- Tell us the company's tax year / balance date, and which Xero bank account is the BNZ business one.
- Confirm the BNZ business account appears in the Akahu connection (prd-01 wave 0); set `strawb_bank_source = akahu`.

**Wave 1 — the keystone (contracts, additive):**
- `prd05 w1: Xero tables exist under their own namespace` — migrations, schema-reviewed.
- `prd05 w1: tokens are encrypted and a refresh is stored atomically before use` — creates `server/xero/vault/**` with crash-at-every-step tests.
- `prd05 w1: a typed read-only Xero client returns invoices, bills, pay runs and the P&L in cents` — creates `server/xero/client/**` and fixtures; the one dependency-adding issue if an SDK is used.
- `prd05 w1: a tailnet OAuth callback is accepted by Xero` — a spike on the real machine; reports whether Ruling 1 stands.

**Wave 2 — behaviour (parallel):**
- `prd05 w2: Hannah can connect and disconnect Xero from the app` — connect, callback, disconnect routes.
- `prd05 w2: a Xero sync stores receivables, payables, pay runs and year-to-date profit` — `server/xero/sync/**`, own 15-minute timer, one run at a time.
- `prd05 w2: the app can read Xero totals and connection health` — read routes.

**Wave 3 — the visible slice and surfaces (parallel):**
- `prd05 w3: the Overview shows what Strawb is owed, from Xero` — the thinnest slice (declared widening).
- `prd05 w3: the tax hold uses Xero profit and the ledger includes Xero payables` — feeds the overview route's inputs; does not edit `shared/safe-to-spend.ts` (declared widening).
- `prd05 w3: the Sync screen and Privacy list show Xero` — Xero row, "Pulled from Xero this week", outbound call (declared widening).

**Wave 4 — conditional, only if the BNZ business link fails:**
- `prd05 w4: Xero bank transactions fill a Strawb account that has no Akahu source` — behind prd-01's `source` column; refuses a double source.

**Wave 5 — acceptance:**
- `prd05 w5: the Overview matches Xero's own receivables and profit on a real day` — operator-run, against the Claude Xero connector.

Unfiled work implied, described not numbered: salary link (pay run to transaction matching); reconnect reminder before refresh-token expiry; tax PRD (rates, filing periods).

## Open questions that block this

- Is Hannah the Xero organisation admin, and can she create a developer app for Strawb Collective Ltd? Open, not ruled.
- Does Xero accept a tailnet `https` redirect address? If not, Ruling 1 moves to the paid Custom Connection. Wave 1 spike answers it. — ANSWERED (Hannah, 2026-10-23): Ruling 1 stands as the chosen approach (standard OAuth2, tailnet callback). The spike remains a technical check, not a decision.
- What is Strawb's tax year? "Current tax year" profit depends on it. Open, not ruled.
- Is Xero's profit (accrual basis: invoiced, not necessarily received) the right input for the tax hold? — ANSWERED (Hannah, 2026-10-23): yes. Year-to-date profit, accrual basis, from Xero's P&L feeds the tax hold. Landed in prd-02 Ruling 2's profit input.

**Not blocking:** GST/PAYE rates and filing periods (a tax PRD), the salary-link matching, email invoices, and the advisor's Xero access.

## The one risk worth watching

Double-counting. Xero holds the same bank money, bills and invoices Divvy sees from other angles, and each "helpful" addition (show cash, add receivables, count a bill twice) makes the hero number look more complete and be wrong. Hold Ruling 4 as a contract, with its done-when test (3). The second risk is token-refresh loss going unnoticed, which is why a failed refresh must be visible.
