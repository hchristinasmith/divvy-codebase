# Retro: #58 prd04 w3, agents run after each completed sync, insights weekly and on demand (scheduler, run route, tests)

Gear 4 as stamped; no shift. The implementer ran on opus. Fence: `server/agents/**`, plus one start call in `server/index.ts` (declared widening). This file states no telemetry (model, duration, tokens, tool calls); the conductor posts the four narratives to Baseline after `baseline finish`.

Seats run: implementer (build), reviewer, test-guard, security-auditor (warning raised on the stale-run close), this retro. Verify passed on the final state: tsc 0, lint 0, vitest 165 files / 6276 tests passed. I did not re-run it for this retro.

Commit: ab40552 (build and review fixes together, 6 files, +1270 -1).

## What was built

- **Kind of code:** a polling scheduler (`server/agents/scheduler.ts`), an on-demand route (`POST /api/v1/agents/run`) and their tests. No migration.
- **Pattern:** a single-flight poller. It reads `sync_runs` for successful runs no successful category run has processed and runs one category batch per tick. Insights run weekly per scope from Wednesday NZ. State lives in `agent_runs`, and stale `running` rows are closed at start. The route shares the same single-flight guard.
- **Why this shape:** no table links a transaction to a sync run, so the category agent sweeps by cursor instead of by run.

## What happened

- **Implementer** built the scheduler, route and tests.
- **Reviewer** found 7 issues and 6 were fixed inside the fence:
  - The stale-run close read the whole `agent_runs` table (security-auditor warning).
  - Three error paths had no test (test-guard).
  - A scope could be skipped for a week when its call threw before a row was logged. Fixed by the scheduler logging a failed weekly run itself.
  - A retry of last week's pass that crossed Wednesday midnight could count as this week's pass. Fixed by re-checking the due day before each scope.
- **Choices taken without a decision round:**
  - No kill switch, 503 or budget, because there is no model path yet (#429, #430).
  - No `transactionIds` per sync run, for the reason above. The cursor sweep reaches new rows; changed rows below the cursor wait.
  - The weekly pass treats both scopes together, because `agent_runs` has no scope column.
  - The route waits and answers 200/400/409/500, with the cursor in the 200 body.

## What went wrong

1. **A scope could be skipped for a week (Missed-by: do).** Cost: a real scheduling bug caught only by review. Cause: the plan leaned on `agent_runs` to say what had run per scope, but the table has no scope column.
2. **Wednesday-midnight retry counted as this week's pass (Missed-by: do).** Found by review, fixed by re-checking the due day before each scope.
3. **Stale-run close read the whole table (Missed-by: do).** It was flagged as a security-auditor warning and fixed in the fence.
4. **Three error paths untested (Missed-by: do).** Test-guard found them. The gate would not have, since coverage is not gated.
5. **Review fixes landed in the build commit (Missed-by: process).** They were made in the uncommitted working tree, so the "review fixes separate" commit point was missed. Cost: the second reader cannot see the review response on its own.
6. **Header comments in `category/agent.ts` and `insights/agent.ts` still say nothing schedules them.** They are now false and were left alone because they are outside the fence.

## Root causes

- **`agent_runs` has no scope column (items 1 and 2).** Per-scope state was inferred from a table that cannot hold it, and the scheduler had to patch around it twice. This is the one real design cause, and it is a follow-up.
- **Review fixes uncommitted (item 5).** The build was not committed before review ran, so the fixes had no earlier commit to separate from. Same shape as #62.
- **Items 3, 4 and 6:** unclear beyond being written alongside the build. The record shows no deeper cause.

## What worked, keep it

- **Taking the small choices without a decision round.** Each had a recorded reason (no model path yet, no link table, no scope column) and none was a fork with rework cost.
- **Review in a separate seat.** It found 6 fixable issues, including two scheduling bugs the gate could not see.
- **Fixing inside the fence and surfacing the root.** The scope column went to a follow-up, not into a migration.
- **One declared widening.** `server/index.ts` changed by a single start call.

## Surfaced, not absorbed (follow-ups to file)

- A `scope` column on `agent_runs` (root of the skipped-scope bug).
- `index.test.ts` does not mock `agentScheduler`.
- No rate gap on manual runs.
- Schedulers are not stopped on SIGTERM.
- Changed rows below the cursor wait.
- Stale header comments in `category/agent.ts` and `insights/agent.ts`.

## Recommended changes

1. **Commit the build before dispatching review**, so review fixes land as their own commit. This is the second lane (#62 and now #58) where the fixes merged into the build commit. By the first-occurrence rule it is now the second occurrence, so encode it. Add the step to the lane handoff and the pipeline in `~/.claude/CLAUDE.md` (step 5 says review before commit; the table in step 7 wants fixes separate, and these two conflict). The conductor decides the wording.
2. **Do not encode a rule for the scope bug.** The fix is the column (follow-up).

## Highest-leverage next step

Add `scope` to `agent_runs` in its own gear-3 lane. Both scheduling bugs came from inferring per-scope state without it.

## Open items for the PR body

- Gear 4 as stamped; no shift. One declared widening (`server/index.ts`).
- Reviewer: 7 findings, 6 fixed in the fence; the scope-column root goes to a follow-up.
- No kill switch, 503 or budget (no model path yet, #429, #430).
- Gate: tsc 0, lint 0, vitest 165 files / 6276 tests passed.

## Baseline narratives

### narrative_code_type

A polling scheduler and an on-demand run route with tests, in `server/agents/`, plus one start call in `server/index.ts`. No migration; gear 4.

### narrative_built

`scheduler.ts` polls `sync_runs` for successful runs no successful category run has processed and runs one category batch per tick. Insights run weekly per scope from Wednesday NZ, once per week. One pass runs at a time, state lives in `agent_runs`, and stale `running` rows are closed at start. `POST /api/v1/agents/run` runs either agent on demand through the same guard and answers 200, 400, 409 or 500. 6 files, +1270 -1; 165 test files and 6276 tests at the end.

### narrative_how

The implementer on opus built the scheduler, route and tests inside `server/agents/**` with one declared widening in `server/index.ts`. Small choices were taken without a decision round: no kill switch or budget because no model path exists yet (#429, #430), no per-sync transaction ids because nothing links a transaction to a sync run, and both scopes treated together in the weekly pass because `agent_runs` has no scope column. The reviewer found 7 issues and 6 were fixed in the fence. Review fixes were made in the uncommitted tree and landed in the build commit.

### narrative_wrong

A scope could be skipped for a week when its call threw before a row was logged, and a retry of last week's pass crossing Wednesday midnight could count as this week's. Both were caught by review, not the gate, and both trace to `agent_runs` having no scope column (follow-up). The stale-run close read the whole table, and three error paths had no tests. Review fixes went in the build commit, so the separate review-fix commit was missed. The header comments in `category/agent.ts` and `insights/agent.ts` are now stale. Changed rows below the cursor wait, and manual runs have no rate gap.
