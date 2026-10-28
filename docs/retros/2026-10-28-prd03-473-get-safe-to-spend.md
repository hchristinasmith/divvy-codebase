# Retro: #473, get_safe_to_spend returns the Overview's number from the replica

Gear 3, no shift. Implementer ran on opus. This file states no telemetry; the conductor posts the narratives to Baseline after `baseline finish`.

Seats run: implementer, reviewer, test-guard, security-auditor, this retro. Verify passed on the final state: tsc 0, lint 0, vitest 185 files / 6729 tests. I did not re-run it. Build commit: 5493a6f, which also carries the review fixes (item 3).

## What was built

- **Kind of code:** one MCP tool handler, `mcp/tools/get-safe-to-spend.ts`. Tests in `mcp/tools/__tests__/get-safe-to-spend.test.ts`; the slice e2e test was extended.
- **Pattern:** 8 `staticSql` queries against the scrubbed replica that mirror `server/db/overview.ts` (`loadInputs`, `listAccounts`, `loadDrawingCandidates`). The results go to `gatherSafeToSpendInputs` and `safeToSpend` from `shared/` (the #472 work). The output is snake_case `_cents` fields plus `data_as_of`. `now` is `ctx.clock.now()`. No allowlist change was needed; every column was already there.
- **Why this shape:** `mcp/` may not import `server/**` (prd-03 Ruling 6), so the queries are written twice. The alternative, a shared query layer, would break the boundary.

## What went wrong

1. **The implementer's unit test let 5 of 13 reviewer mutations through.** The surviving mutations: dropping `source = 'akahu'` on the window query, dropping it on the accounts query, dropping the settings key filter, taking `now` from `data_as_of`, and dropping `OR date IS NULL`. The last one matters most: the tool would give an answer where the Overview refuses. The gate was green on hand-back with all five holes open. The reviewer added two tests and moved `DATA_AS_OF`. Missed-by: do.
2. **Review scratch broke a parallel seat.** The reviewer's temporary parity test (`zz-review-parity.test.ts`) sat in the worktree while test-guard ran in parallel. Test-guard read it as a red gate: an mcp-to-server import-guard failure and 3 lint errors. The file was deleted afterwards. Cost: a false red to untangle.
3. **Review fixes could not be committed apart from the build.** They landed in the same uncommitted test file, so a separate "review fixes" commit would have meant staging by hunk. Same miss as #80 item 5. Noted, not corrected.
4. **The queries now exist twice.** Drift between `server/db/overview.ts` and the tool is held by a code comment, plus a parity check run once by hand. Nothing fails if the Overview's queries change.

## Root causes

- **Fixture copied from the pure-function table.** Item 1. The base fixture from `shared/__tests__/safe-to-spend.test.ts` holds only rows the queries keep, so a filter that is removed changes nothing. `data_as_of` also fell on the same NZ day as the clock, so reading `now` from the wrong place was invisible. A fixture built to test a calculation cannot test the query that feeds it; that needs rows the query must drop.
- **Parallel seats share one worktree** and review scratch went into the tree, not the scratchpad. Item 2.
- **Same root as #80:** review fixes and build live in one uncommitted tree when review runs. Item 3. Second occurrence.
- **Duplication is by design** (Ruling 6), so item 4 is a cost accepted, not a mistake. What is missing is a check that would catch drift.

## What worked, keep it

- **Reviewer mutation check.** 13 deliberate breaks found the 5 test holes, including the `OR date IS NULL` one that would have shipped.
- **Reviewer parity test.** A live DB built with the real migrations, then the server `readOverview` against the real scrub `buildReplica`, then the tool. All three scopes were strictly equal. This is the strongest evidence that the tool returns the Overview's number. It was deleted after use.
- **The #472 split paid off.** With input gathering in `shared/`, the tool is a thin mapper and `now` and the maths are not copied.
- Security-auditor: no critical issues, no warnings.
- Gear stayed 3; no fence shift.

## Flagged, not acted on

- **`leftOutBills` is dropped by the tool.** The advisor's number can miss a bill with no warning, while the Overview raises an alert. Filed as #482 (Missed-by: plan).
- **The replica reader opens the file per query,** so one call can straddle a refresh. This affects `get_sync_status` too. Filed as #483 (Missed-by: plan).
- **Security-auditor, optional:** use finite `maxRows` ceilings instead of `MAX_SAFE_INTEGER`. Not done.

## Recommended changes

1. **Keep the parity test as a committed test or script instead of a throwaway.** Item 4. A test that builds a live DB, runs `readOverview` and the tool through the real scrub, and asserts equality per scope would turn the drift comment into a failing test. High leverage. File: `mcp/tools/__tests__/` (it needs an explicit exception to the mcp-to-server import guard, so decide that with the lint config first).
2. **Fixture rule for tests of queries:** the base fixture must include rows the query should drop (other `source`, other settings keys, `date IS NULL`), and `data_as_of` must fall on a different NZ day from the clock. File: `docs/testing.md`. This is the first occurrence in this repo; the cheap version is one paragraph there.
3. **Reviewer scratch goes in the scratchpad, or runs after the parallel seats finish.** Second-order fix for item 2. File: the reviewer agent definition in the Baseline workflow. First occurrence, so note it and encode it only if it recurs.
4. **Review fixes in their own commit:** second occurrence (#80, #473). Have the implementer commit the build before dispatching review, so fixes land as a separate commit. File: the implementer step in the Baseline workflow.

## Highest-leverage next step

Commit the parity test (recommendation 1). It is the only thing that makes the "two copies of the queries" decision safe over time, and it is the check that already proved the tool correct once.

## Open items for the PR body

- Gear 3, no shift.
- Follow-ups filed: #482 (`leftOutBills` dropped by the tool), #483 (per-query replica open can straddle a refresh).
- Review added two tests and moved `DATA_AS_OF`; fixes are not in a separate commit.
- Optional, not done: finite `maxRows` ceilings.
