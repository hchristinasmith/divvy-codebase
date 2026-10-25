# PRD 03 — Read-only MCP advisor

> **Status:** blessed by Hannah in session, 2026-10-23 (all five PRDs blessed together; decisions 6 and 7 answered the same day)

**Kind: specifying (security).** This PRD runs longer than a usual one because a stranger will build a security boundary without you in the room. Hannah's brief: "i want the ai integration to be here and mcp server please - i want it to be super secure and read only".

**Prerequisites.** M1 has landed. prd-01 is deployed (database on the Fly machine, Tailscale up, Litestream running). prd-02 wave 1 has landed (`shared/safe-to-spend.ts`, the budgets/bills/goals tables) and wave 3 for the habits maths (`shared/habits.ts`).

**Territory.** This PRD owns `mcp/**` (top-level, see Ruling 6) and the advisor-audit schema. `server/sync/**`, `fly.toml`, Litestream config and the accounts/sync migrations are prd-01's territory; `client/**`, `src/**`, `shared/**` and the budgets/bills/goals migrations are prd-02's. No wave here enters them, with two declared exceptions: one edit to the container Dockerfile and start script (prd-01's files) for the OS users and the refresh loop (wave 2), and one read-only route plus a Privacy-screen list for "Advisor reads" (wave 3, named there). It consumes prd-01's tables and prd-02's `shared/`. *Added 2026-10-23:* `server/xero/**` and the Xero migrations are prd-05's territory; no wave here enters them. The Xero token tables are never in the replica allowlist (Ruling 2).

## What we're building

A small server that lets Claude desktop on your Mac read your Divvy data and answer questions about it, and can do nothing else: it cannot change a number, create a budget, or reach your bank. It exposes a fixed set of named questions (safe to spend, transactions, budgets, bills, goals, habits, sync status), runs as its own locked-down user against a read-only copy of the database, is reachable only over your private Tailscale network, and writes a log of everything Claude asked, which the Privacy screen shows. Claude proposes in chat; you apply changes in the Divvy app.

## Why this first (after prd-01 and prd-02's number)

1. You asked for the AI integration to be here, and the advisor is the part of the handoff that makes Divvy more than a dashboard (`docs/design/handoff.md:4`).
2. It is the cheapest way to get an advisor: it runs on your Claude subscription (D3), with no API key on the server and no spend.
3. The security shape must exist before the first tool does. A read-only guarantee added afterwards is a promise; one built in from the first tool is a property.

Rejected alternatives:

- *Chat-in-app*: build the handoff's Advisor screen with a server-side Claude API call. Rejected for this iteration: it needs an API key (a cost, a secret on the box) and contradicts the handoff's own "no third-party AI API" line (`handoff.md:4`). Left as an open question.
- *Write tools now*: let the advisor create budgets and goals as the handoff describes (`handoff.md:34`, `:50`). Rejected: a mistaken or manipulated write is not recoverable by a log. Deferred to a future PRD.
- *Raw SQL tool*: one `query(sql)` tool for flexibility. Rejected: it makes every other control (allowlist, masking, limits, audit meaning) unenforceable.

## Evidence

- **The advisor decision is made.** D3 (MCP first, API only for background jobs) and D4 (Tailscale-only, no Auth0) in `docs/decisions.md:9-10`; audit decision 3 (`docs/audit-2026-10-23.md:109-111`).
- **The gap is total.** "Advisor via Claude desktop, phone later: absent" (`docs/audit-2026-10-23.md:104`); no MCP code or dependency exists (`package.json:27-52` has no `@modelcontextprotocol/*`).
- **The Akahu token is an environment variable and must stay out of reach.** `server/routes/akahu.ts:10-11` reads `AKAHU_USER_TOKEN` and `AKAHU_APP_ID` from `process.env`; prd-01 ruling 5 keeps it in Fly secrets and out of every table.
  — Note (2026-10-26, #201): #32 deleted `server/routes/akahu.ts`. The token and app id are now read only by `server/sync/scheduler.ts:106-107`, at the start of each sync run; the point of the bullet (environment only, never in a table) still holds.
- **Account numbers are in the data model.** `formatted_account` on accounts (`models/akahu.ts:12`).
- **Transaction free text comes from third parties.** `description`, `particulars`, `code`, `reference`, `merchant_name` (`server/db/migrations/20250611031435_transactions.js:15,28-30,40`); anything in them reaches Claude's context.
- **The number to match exists only after prd-02.** `shared/safe-to-spend.ts` is prd-02 ruling 1; the Overview shows what the server computes.
- **The connection layer defaults to read-write.** `server/db/connection.ts:7` opens knex on the production file with no mode, and `server/db/knexfile.js:40` points at `/app/storage/prod.sqlite3`; the MCP must not use this module.
  — Note (2026-10-26, #238): `server/db/knexfile.js:42` now points at `/data/divvy.sqlite3` (or `DATABASE_PATH`), not `/app/storage/prod.sqlite3`; the point of the bullet (the MCP must not use this module) still holds. `server/db/connection.ts:7` is still accurate.
- **The handoff expects an auditable surface.** The Privacy screen's "outbound calls" and server card (`handoff.md:58`).
- **Habits maths and category source are available.** prd-02 `shared/habits.ts`; prd-01 ruling 4 (`category`, `category_source`).

## In scope

- `mcp/` server over stdio with the fixed tool set (Ruling 1) and the typed schemas.
- A scrubbed, read-only copy of the database, rebuilt on a schedule and after each sync.
- Separate OS user and filesystem permissions for the MCP process.
- Transport: Tailscale SSH restricted to the MCP user (fallback `fly ssh`), stdio through it, and the Claude desktop entry that uses it.
- Audit log of every tool call and the "Advisor reads" list on the Privacy screen.
- A guard test that fails if the tool list, the database mode or the process environment drifts.

## Out of scope

| Item | Goes instead to |
|---|---|
| Write tools, budget creation by Claude, tax-rate changes by Claude | A future PRD, after this one has run in real use |
| Background categorisation (rules first, then Haiku via API) | prd-04 |
| In-app Advisor chat | Open question below; needs an API key |
| Weekly truth report delivery | Open question below |
| Phone access to the advisor | After Claude desktop works |
| Xero tools | M4 PRD |
| Public HTTP/OAuth endpoint for the MCP | Not unless D4 is revisited |
| The Privacy screen itself | prd-02 (this PRD supplies the data it lists) |

## Done when

1. Asking Claude desktop "what's my safe to spend?" returns the same number as the Overview for the same scope. *Not met while* the two differ by one cent after a data refresh, or Claude computes it itself instead of calling the tool.
2. Nothing the MCP does can change data. *Not met while*, as the MCP OS user, any of these succeed: opening the live database file, writing or creating a file in the replica directory, or an `INSERT`/`UPDATE`/`DELETE`/`PRAGMA` through the replica connection.
3. The MCP process holds no secrets. *Not met while* its environment contains `AKAHU_*` or any Fly secret, or the replica contains a token column or a full account number.
4. The tool surface is exactly the fixed list. *Not met while* `tools/list` returns an unlisted tool, or any tool takes SQL, a file path, or a table name as input.
5. No network listener exists. *Not met while* the MCP process opens a socket, or the entry works from a device not on the tailnet.
6. Every call is logged. *Not met while* a call, including a rejected or failed one, leaves no row with tool, parameters, row count, outcome and time, or the Privacy screen does not list it.
7. Bounds hold. *Not met while* `list_transactions` returns more than 200 rows, accepts `limit` above 200 without rejecting, or runs with an unbounded date range.
8. You ask Claude desktop to "delete my Starling transactions" and "add a $500 grocery budget" and it has no tool to do either. *Not met while* it appears to succeed, or the database changed.

Items 2–5 are tests plus commands run on the real machine (the code does what is written). Item 8 and the review of the security table are the check that what was written was right. **Only 2 matters** (the read-only guarantee). It is proven twice: by the guard test, and by a person trying to break it from the MCP user's shell.

## Rulings

## Ruling 1 — The MCP is strictly read-only and exposes only fixed, typed tools
The tools are `get_safe_to_spend(scope)`, `list_transactions(scope, from, to, category, limit ≤ 200)`, `get_budgets(scope)`, `get_bills(scope)`, `get_goals`, `get_habits` (runway, streaks, freedom date once it exists) and `get_sync_status`. There is no raw-SQL tool and no tool that accepts a table, column, path or URL. `list_transactions` returns the effective category together with its source (`akahu | user | rule | claude`, prd-01 ruling 4), and every tool returns `data_as_of`. The handoff's "Claude Code owns budget creation and limits" and its write tools (`handoff.md:34`, `:50`) are explicitly deferred to a future PRD: the advisor proposes in chat and you apply it in the UI. Why: a read tool's worst case is a disclosure to your own Claude conversation; a write tool's worst case is silent damage to your money record. Extends to: any new tool is a new PRD amendment, not a code change.

## Ruling 2 — The MCP reads a scrubbed copy, as a user that cannot touch the live file
A refresh job (run as the web app's OS user, on a loop in the start script, every 5 minutes and after each sync) takes a copy of the live database with SQLite's backup API, drops every non-allowlisted table and column, masks account numbers to the last four digits, and replaces `/app/replica/divvy-ro.sqlite3` by atomic rename. The MCP process runs as OS user `divvy-mcp`, which has read access to the replica and no access to `/app/storage`. It opens the file read-only (`mode=ro`, `immutable=1`, reopened per call). Why: a URI flag stops a bug; a file the user cannot write stops an attack. The copy is built from the live file by backup API rather than `litestream restore` so no object-store credentials are involved in the refresh; Litestream stays prd-01's backup. Cost: answers can be up to 5 minutes behind, which is why every tool returns `data_as_of`. Allowlist: transaction date, description, amount, merchant name, effective category and source, status, account name; no `reference`, `particulars`, `code`, card suffix, or `other_account`.
  — Note (2026-10-26, #238): the live database is `/data/divvy.sqlite3` on the volume at `/data` (`server/db/knexfile.js:42`), so the exclusion is `/data`, not `/app/storage`. That also keeps `divvy-mcp` out of `/data/tailscale`, which holds the tailnet node key (`scripts/start.sh` `--statedir`, made mode 700).

## Ruling 3 — Transport is stdio over SSH; there is no HTTP endpoint
Claude desktop launches `ssh` into the Fly machine over Tailscale and runs the server on stdio. Preferred: Tailscale SSH with an ACL rule that lets only your devices log in as `divvy-mcp`. Fallback: `fly ssh console` running the server through `su` to `divvy-mcp` (access is then gated by your Fly login). Streamable HTTP bound to the Tailscale interface is allowed only if stdio-over-SSH proves unworkable in the wave 1 spike, and would need a new ruling. Only your devices are in the tailnet ACL. Why: no listening port is no attack surface (D4).

## Ruling 4 — Every call is logged, in a file only the MCP can write
Each call (tool, parameters, row count, outcome, duration, timestamp; never the returned data) is written to `/app/audit/advisor-audit.sqlite3`, owned by `divvy-mcp` and opened read-only by the web app for the Privacy screen's "Advisor reads". This is a separate file with a self-applied schema (`mcp/audit/schema.sql`), not a knex migration, because the main database is read-only to the MCP (Ruling 2). It is the only thing the MCP may write. The log is evidence, not prevention; a compromised MCP could alter it, which is why Ruling 2 carries the weight.

> Amended 2026-10-25 (#113): the audit file has a 50 MB size ceiling (implemented as 50 MiB, 52,428,800 bytes, a whole number of 4 KiB pages), enforced in the sink and failing closed — a record that would take `page_count * page_size` over it is rolled back and the call answers `audit_unavailable`; nothing is pruned or deleted (Hannah, 2026-10-25). Why: the caller controls how many rows are written, and a looping or prompt-injected client could otherwise fill the 1 GB Fly volume the file may share with the main database and Litestream. A rejected call's row is about 1.4 KB with ASCII parameters (#78's probe: 201 rows in 286,720 bytes) and about one 4 KiB page with non-ASCII ones, so 50 MiB is roughly 36,000 calls of headroom, or about 12,700 at worst, and about 5% of the volume. Each record also has a 10 s deadline from the call, twice the 5 s busy timeout, so a stalled filesystem fails calls with `audit_unavailable` instead of hanging them, and a write whose deadline passes before it commits rolls back, so it never lands after a later record.

## Ruling 5 — Categorisation and the in-app chat are not here
Background categorisation (D3: rules, then Haiku through the API, server-side) is a separate concern, now prd-04. The in-app Advisor chat needs an API key, which contradicts the handoff's "no third-party AI API"; that is an open question, not ruled. First iteration: Claude desktop is the chat surface. Tool results enter your Claude conversation and so leave your server; the Privacy screen must say that plainly, since the handoff's "local model" line (`handoff.md:58`) is not true for this design.

## Ruling 6 — The code lives in a top-level `mcp/`, in the same package, importing no `server/` code
`mcp/` has its own entry point and build, shares the repo's `package.json`, imports only `shared/` and its own modules, and a lint rule forbids importing `server/**`. Why: directory separation makes "this process cannot load the Akahu client or the writable connection" a checkable rule, whereas `server/mcp/` would put it one import away from `server/db/connection.ts` and the token code. Sharing one package keeps `shared/safe-to-spend.ts` importable, so the advisor's number cannot diverge from the Overview's (Done when 1).

## Security layers

| Layer | Control | Defeated only if |
|---|---|---|
| Network | Fly app has no public IP (prd-01 ruling 7); tailnet ACL lists only your devices | The ACL is widened, or a tailnet device is lost |
| Transport | stdio over Tailscale SSH as `divvy-mcp`; no listening port | A non-`divvy-mcp` login is allowed, or an HTTP listener is added |
| Process | Separate OS user; no Akahu or Fly secrets in its environment | The user is given a shell group or env var it should not have |
| File | Scrubbed replica, read-only, in a directory the user cannot write; live DB unreadable to it | Permissions or mounts are changed in the Dockerfile |
| Tool surface | Seven fixed, typed tools; `limit ≤ 200`; bounded dates; no raw SQL | A tool is added without an amendment; the guard test is edited, not run |
| Data | Column allowlist, masked account numbers, free-text fields beyond description dropped | A column is added to the allowlist; a transaction description carries hostile instructions that Claude follows (read-only caps the damage) |
| Audit | Every call logged and shown on the Privacy screen | The audit file is not read; or the MCP itself is compromised |

## Sequencing

Waves are **layers**: issues in a wave are fenced apart and built in parallel; one PR per wave.

**Wave 0 — operator acts (not dispatchable):**
- Confirm Tailscale is installed on your Mac and phone and list the devices that may be in the tailnet ACL.
- Add the ACL rule: only your devices may use Tailscale SSH to the Fly machine as `divvy-mcp`.
- Add the MCP entry to Claude desktop's config once wave 2 has shipped (you do this on your Mac).

**Wave 1 — the keystone (contract, additive):**
- `prd03 w1: the MCP tool list is fixed in a typed registry with a drift test` — creates `mcp/tools/registry.ts`, stub files for all seven tools, schemas, and the guard test (tool list, no `server/` import, env has no secrets).
- `prd03 w1: stdio over SSH from Claude desktop reaches a hello-world server` — a spike, run on the real machine; reports whether Tailscale SSH works with `divvy-mcp` and which fallback is needed.

**Wave 2 — the visible slice (parallel):**
- `prd03 w2: the replica is a scrubbed read-only copy refreshed every five minutes` — creates `mcp/replica/**`.
- `prd03 w2: every tool call is written to the advisor audit file` — creates `mcp/audit/**`.
- `prd03 w2: the MCP runs as its own OS user with no secrets and no live-file access` — modifies prd-01's `Dockerfile` and start script (the declared widening; recorded on the PR before the change).
- `prd03 w2: get_safe_to_spend returns the Overview's number and get_sync_status reports the copy's age` — fills two tool stubs; the thinnest slice.

**Wave 3 — the remaining tools and the surface (parallel):**
- `prd03 w3: list_transactions is bounded and returns the effective category and its source`
- `prd03 w3: get_budgets, get_bills and get_goals return in-scope rows`
- `prd03 w3: get_habits returns runway and streaks`
- `prd03 w3: the Privacy screen lists advisor reads` — one read-only server route and one Privacy-screen list (declared widening into prd-02's territory).

**Wave 4 — review:**
- `prd03 w4: the read-only guarantee has been attacked from the MCP user's shell and by prompt` — operator-assisted; walks Done-when 2–8.

Unfiled work implied, described not numbered: write tools PRD; background categorisation PRD; weekly report delivery; phone access.

## Open questions that block this

- Does Tailscale SSH work on the Fly machine in the mode prd-01 runs Tailscale in, and does Claude desktop's MCP launcher work through an `ssh` command? Wave 1 spike answers it; if not, `fly ssh` (needs `flyctl` on your Mac) or Streamable HTTP. Open, not ruled.
  — ANSWERED IN PART (#22, 2026-10-26): prd-01 runs Tailscale in userspace networking mode and `tailscale up` has no `--ssh` (`scripts/start.sh` steps 2 and 3), so Tailscale SSH is off and path A cannot be tested until a separate change enables it (docs/deploy.md section 9). Whether Tailscale SSH works in that mode, and whether the launcher works through `ssh`, are still unanswered. Open, not ruled.
- Which devices are in your tailnet, and is the ACL already restrictive? A people-shaped fact, not in the repo. Open, not ruled.
- Is stale-by-five-minutes acceptable for answers? Open, not ruled.

**Not blocking, deliberately open:**
- **In-app Advisor chat.** It needs an API key and contradicts the handoff's "no third-party AI API"; the first iteration is Claude desktop. Open, not ruled.
- **Weekly truth report delivery.** D5 says email; the MCP is read-only and Claude desktop has no scheduler. Options: a Claude Code scheduled routine on your Mac calling this MCP, or a server-side API call later. Open, not ruled.
- Whether Claude desktop is enough when you are away from your Mac.

## The one risk worth watching

The guarantee quietly eroding: a "just one write tool", a column added to the allowlist, a second reader added for convenience, the guard test edited to make it pass. Each is reasonable alone. Hold the tool list and permissions as a contract changed only by amending this PRD, and treat any change to the guard test as a finding.
