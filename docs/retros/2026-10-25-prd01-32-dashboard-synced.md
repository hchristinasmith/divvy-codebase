# Retro: #32 prd01 w3, the Dashboard reads synced data and shows when it last synced

## Retro summary (for the PR body)

#32 replaced the live Akahu proxy (`server/routes/akahu.ts`, which spent the owner's bank token on every request) with two database-backed routes, `GET /accounts` and `GET /accounts/transactions`, that keep the Akahu envelope so the Dashboard needed no data change. It also added a "Last synced" element fed by `GET /sync/status`, and a text "Pending" marker in `Txs.tsx`. The final gate is green: tsc and lint clean, vitest 1542 tests (1474 on main at the start of the lane). The build was clean. The costs were all in the slice: the issue's fence named a file the mount had left (`server/server.ts`), and its Done-when 3 named a transaction list that nothing renders. The researcher seat found both before any code was written, which is why neither became rework. Two test gaps the fence forbade were filed rather than absorbed (#197, #198).

Gear 4 as stamped; no shift. The implementer ran on opus per CLAUDE.md's table (the issue said `model: sonnet`). This retro states no telemetry; the lane posts the four narratives after `baseline finish`.

Seats run, in order: researcher, architect, implementer (4 commits), brand-checker, security-auditor, reviewer, test-guard, docs-syncer, this retro. All ran. Verify passed on the final state with the review fixes and gap tests in. `origin/main` moved twice during the lane (#187, then #189 and #190); there were no conflicts.

Commits (`git log --oneline origin/main..HEAD`): d91e7a1 (`server/db/synced.ts`), cee1550 (the routes, the proxy deleted, barrel test reconciled), 108c58e (`LastSynced`), 2f79813 (Dashboard placement and Txs marker), f5bc41e (review: the token guard widened), f48970b (test-guard gaps). The diff is 14 files, 1967 insertions and 231 deletions, of which 599 insertions and 108 deletions are outside `__tests__/`.

## What was built

- **Kind of code:** two read-only Express routes over a small DB read module (`server/db/synced.ts`), one React component (`LastSynced.tsx`) on TanStack Query, and a deletion of the live proxy and its tests.
- **Pattern:** the DB layer returns integer-cent rows with an explicit column list that never touches the legacy `category_*` or `akahu_category_*` columns. Cents become dollars once, at the envelope edge in `accounts.ts` (prd-01 Ruling 3), through a digit-parse `centsToDollars` rather than `cents / 100`. The effective `category` string is rebuilt into the Akahu object shape (`{ name, groups.personal_finance.name }`, group looked up from the name) because `SpendingBreakdown` reads that shape. Pending transactions get `pending: true` and an ephemeral `_id` of `pending-<row id>`.
- **Why this shape:** the contested choice was the envelope. Keeping Akahu's shape meant no change to the Dashboard's two readers, at the cost of a string-to-object conversion on the server.

## What happened

- **The researcher ran first and found five things the issue did not say** (record: `researcher.md`):
  1. The `akahu` mount lives in `server/routes/index.ts`, not `server/server.ts`. #27 moved routes into the barrel; lane #177 was editing `server.ts`. The conductor corrected the fence before the build: the swap went in `index.ts`, and `barrel.test.ts` (which pins the mount table and the old 500 "Missing Akahu credentials" behaviour) was reconciled.
  2. The effective `category` is a plain string, but `SpendingBreakdown` reads Akahu's category object. A string envelope would have shown every row as "Uncategorized".
  3. "Exactly two decimals" cannot hold for a JSON number: 1250 cents is `12.5`.
  4. `Txs.tsx` is dead code, never imported. The Dashboard renders no transaction rows, so "the Dashboard's existing transaction list marks pending" has nothing to attach to.
  5. `useSyncPill` already queries `/sync/status` under `['syncStatus']` with a queryFn that returns a number. A second query on the same key with a different queryFn would collide in the cache.
- **The architect resolved each from issue and PRD text**, not by choice: an object-shaped category with the group from `data/cats.js`-style name lookup; an amount that is a number equal to cents/100; the marker placed in `Txs.tsx` without mounting it; a local `[...syncStatus.all, 'full']` key. It also asked for two extra test files, `Dashboard.test.tsx` and `Txs.test.tsx`. The lane refused them as outside the fence, and #198 carries them.
- **The implementer** built in four commits and mutation-checked its own tests: breaking the filter, the `/100`, the legacy column read, the pending flag, the 500 swallow and the query key each turned a named test red. It also built the client and confirmed the bundle contains no `express`, `knex` or `AKAHU_`.
- **brand-checker:** no violations. One non-blocking note: `text-danger` is about 4.2:1 contrast at 13px.
- **security-auditor:** 0 critical, 0 warnings. S2, a token guard that was too narrow (it did not cover `.js`, `mcp/` or every Akahu credential), was fixed in f5bc41e. S1 (stale docs, #201) and S3 (`transactions.ts` logs whole error objects, pre-existing, #200) were filed. S4 was intentional. S5, an unbounded `accountIds` count, was measured by the reviewer: Node's header size limit bites first, so it was left.
- **reviewer:** re-ran every mutation and proved the digit-parse conversion exact over 4,000,001 values. It found the `-0` guard unreachable (left in place) and that `ActualVTarget` shows $0.00 on every target, which was already true before this lane (#196).
- **test-guard:** gated with warnings. There was no contract test of the real client for `grabTransactions` or `grabSyncStatus` (out of fence, #197). The corrupt-row and shape guards were untested, and the "never cents/100" comment overclaimed, since `/100` is bit-identical to the digit parse. The guard tests landed in f48970b. Two guards cannot be tested: the NULL `amount_cents` guard cannot be isolated by mutation, and the NULL account `akahu_id` guard is unreachable behind a schema CHECK.
- **docs-syncer:** nothing in CLAUDE.md's reference table was falsified. The stale README, `.env.example` and prd-03 lines were already in #201.

## What went wrong

1. **The issue's fence was stale on the mount (Missed-by: plan).** It named `server/server.ts`; #27, a blocker the issue itself lists, had moved the mounts into the barrel. The issue's own "Blocked by" line says #27 "lands its `server/server.ts` mount first", which is the claim that went out of date. Cost: none in rework, because the researcher caught it and the conductor corrected the fence before the build. Had the lane built to the letter, it would have edited a file lane #177 was editing.
2. **Done-when 3 names a transaction list that does not render (Missed-by: plan).** The issue says "the Dashboard's existing transaction list" and cites `Dashboard.tsx` line numbers, but `Txs.tsx` is imported by nothing. The criterion can only be met in a component no one sees. Cost: the criterion is met in code and unverifiable on screen, and Hannah has to decide the file's fate (#198). Nobody running the Dashboard sees a pending marker.
3. **Fence omitted the tests the change required (Missed-by: plan).** The architect's two test files and the real-client contract test were all outside the fence. The lane held the fence, correctly, but the result is that the user-facing parts (LastSynced placement, the Txs marker, the client's two new calls) have no test through the real path. Filed as #197 and #198.
4. **"Exactly two decimals" was written for a JSON number.** It is unsatisfiable as worded; the architect re-read it as "equal to stored cents / 100". The wording cost nothing here, but a literal reading would have forced a string amount and broken `amount.toFixed(2)` in the client.
5. **The lane's own comment overclaimed.** It said the conversion is "never cents/100", but the two are bit-identical; test-guard and the reviewer measured it. It is a small error that cost a review finding, not code; f48970b reworded it to claim only the single integer-only conversion point.
6. **Scope the issue invited, left alone.** The Dashboard totals now cover the whole synced history because `selectedDays` is never applied. That follows from a data-source switch and is surfaced below, not fixed.

## Root causes

- **Issue text slices against code as it was when written, not as it is when dispatched (items 1, 2).** The mount had moved; the list was never mounted. In both cases a one-line `rg` at slicing time would have settled it: the importers of `Txs.tsx`, and where `router.use('/accounts'` lives. This is the same family as "fence written without checking the consumers of the thing being changed" named in the #39 and #25 retros; here it is the consumers of the thing the issue *names*, not of the thing it changes. By the #25 retro's count this is the sixth occurrence, though the earlier ones were about tests pinning a change, and this one is about a named component's reachability. Same root: the slice did not look.
- **The fence lists files to edit and not the test files a client API change needs (item 3).** A new `apiClient` call has a contract test file (`client/apis/__tests__/apiClient.test.ts`) that nobody put in the fence. This is a recurring shape: the fence is drawn around production files. First occurrence for a client-API change; not yet encoded.
- **Unsatisfiable wording in a Done-when (item 4).** "Exactly two decimals" mixes a display rule with a transport type. Only the researcher's reading of the client made this visible. Cause beyond that: unclear.
- **The comment overclaim (item 5) has no cause I can show in the record.** The lane wrote a claim and did not measure it; test-guard did.

## What worked, keep it

- **The researcher ran first at gear 4.** The #25 lane skipped the seat and recorded it as a gap; here it found five things, three of which changed the plan (the mount, the category shape, the dead list). This is the strongest evidence in the corpus that the seat earns its place when the issue touches code someone else has just moved.
- **The conductor corrected the fence before the build.** One message, no Baseline decision, no wait.
- **The architect resolved findings from issue and PRD text and said so.** It made no design choices that Hannah owns, and it asked for out-of-fence tests rather than quietly adding them.
- **The lane held the fence when the architect asked to cross it.** The refused test files became #198 with a clear reason, not an absorbed diff.
- **Mutation checks by the implementer, again by the reviewer.** Each named mutation (filter, `/100`, legacy column, pending flag, 500 swallow, query key) turned a named test red. The reviewer's 4,000,001-value proof closed the conversion question by evidence.
- **Pinning key sets and literals.** Tests assert `Object.keys(x).sort()` and literal expected amounts (`12.5`, `0.07`) instead of recomputing with `/100`, which is why the overclaim was found rather than hidden.
- **Four commits in dependency order**, so the data layer, routes, component and placement can each be read alone.

## Surfaced, not absorbed (for Hannah)

- **Dashboard totals now cover the whole synced history** (up to 730 days). `selectedDays` is never applied. Prd-02 replaces the screen.
- **Done-when 3's "existing transaction list" is met only in a component nothing renders** (`Txs.tsx`). Decide whether it is mounted or deleted (#198).
- **`LastSynced` also shows in the empty-accounts state.**
- **`parseAccountIds` runs outside the `try`.** It cannot throw today; if it ever did, the request would hang.
- **Follow-ups, all Housekeeping:** #196 `ActualVTarget` shows $0.00 on every target (Missed-by: none), #197 contract test for `grabTransactions` and `grabSyncStatus` (Missed-by: plan), #198 `LastSynced` placement and `Txs` marker tests (Missed-by: plan), #199 fold the local copies into `shared/` and `models/` (Missed-by: none), #200 `transactions.ts` logs whole error objects (pre-existing, Missed-by: none), #201 docs still describe the deleted proxy (Missed-by: plan).

## Recommended changes

1. **Slicing check: before an issue names a component as "the existing X" or a file in its fence, grep for who imports it and where the thing lives now.** Two commands: `rg "from.*<Component>" client/` for importers, and `rg "router.use\('/<path>'" server/` for mounts. This lane's two slicing misses would each have been caught in seconds. Sixth occurrence of the consumers family, so encode. Artifact: the issue-slicing step wherever it lives (the architect or planner agent file, e.g. `~/.claude/agents/architect.md`, then `pnpm import-workflow --name current`). The exact location of the slicing procedure is not in the record I read. High leverage.
2. **Fence rule for client API changes: when an issue adds or changes a call in `client/apis/apiClient.ts`, put `client/apis/__tests__/apiClient.test.ts` in the fence.** First occurrence for this exact gap, so do not encode yet; if it recurs, add it to the same slicing step as item 1. Artifact if it recurs: the same file as item 1.
3. **Done-when wording: a number format on a JSON field is a client display rule, not a response property.** One occurrence; do not encode.
4. **Gear 4 keeps the researcher seat first, and this lane is the evidence.** Keep the table row as it is. Artifact: `~/.claude/CLAUDE.md` gear table, unchanged; the #25 retro raised the question and this one answers it for issues that touch recently-moved code.

## Highest-leverage next step

Do Recommendation 1: add the two-command importer-and-mount check to the issue-slicing step, so a slice cannot name a component as "the existing list" or a file as the mount without a grep result behind it. The researcher caught both here, but only because it ran; the cheaper fix is for the slicer not to write them.

## Open items for the PR body

- Fence corrected by the conductor: the mount swap went in `server/routes/index.ts`, not `server/server.ts`.
- Architect's `Dashboard.test.tsx` and `Txs.test.tsx` refused as out of fence (#198); no real-client contract test (#197).
- Pending marker is in `Txs.tsx`, which nothing renders. LastSynced is mounted in `Dashboard.tsx`, not tested there.
- Dashboard totals cover all synced history; `selectedDays` unused.
- Follow-ups #196 to #201, all Housekeeping.
- Gate: tsc 0, lint 0, vitest 1542 tests; client bundle has no `express`, `knex` or `AKAHU_`.

## Baseline narratives

These four are the text for the retro POST (`narrative_code_type`, `narrative_built`, `narrative_how`, `narrative_wrong`).

### narrative_code_type

An API route swap with a small client addition: two read-only Express routes over a SQLite read module, deletion of the live token-spending Akahu proxy, and one React status component. Gear 4, a contract (the Akahu-shaped envelope) that the Dashboard and later PRDs rely on.

### narrative_built

`GET /accounts` and `GET /accounts/transactions` now serve the synced database in the Akahu envelope, with cents converted to dollars once at the edge, the effective category rebuilt into Akahu's object shape, pending rows flagged, and `?accountIds=` filtering applied. `server/routes/akahu.ts` and its tests are deleted. The Dashboard has a `LastSynced` element fed by `/sync/status`, and `Txs.tsx` has a text pending marker. Gate: tsc and lint clean, vitest 1542 tests.

### narrative_how

The researcher ran first and the architect resolved its findings from the issue and PRD text. The implementer on opus built four commits and mutation-checked its own tests. brand-checker, security-auditor, reviewer, test-guard and docs-syncer then ran. Review widened a token guard and added tests for the corrupt-row and shape guards, and the reviewer proved the digit-parse conversion exact over 4,000,001 values. Six Housekeeping follow-ups (#196 to #201) were filed.

### narrative_wrong

The issue's fence named `server/server.ts`, but #27 had moved the mounts into `server/routes/index.ts`, and its Done-when 3 named a transaction list that nothing renders (`Txs.tsx` is dead code); both are Missed-by: plan, and the researcher caught them before the build, so no rework resulted. The architect's two extra test files and a real-client contract test were outside the fence, so the new client calls and the pending marker have no test through the real path (#197, #198). A code comment claiming "never cents/100" overclaimed, since the two are bit-identical, and test-guard caught it.
