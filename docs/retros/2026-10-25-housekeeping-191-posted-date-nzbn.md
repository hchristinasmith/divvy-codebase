# Retro: #191 housekeeping, sync drops Akahu's `posted_date` and `merchant.nzbn` because the table has no column for them

Gear 4 as stamped; no shift. The implementer ran on opus at effort high. Housekeeping milestone, `Spawned-by: #155`, `Missed-by: plan`. Three files were added to the fence mid-run on a Baseline decision (7a07660e, below). This retro file is in the fence (`docs/retros/`, added by the handoff). It states no telemetry (model, duration, tokens, tool calls); the lane posts the four narratives after `baseline finish`.

Seats run, in order: researcher, architect (in parallel with the pending decision), implementer (two commits), reviewer + schema-reviewer + security-auditor (in parallel), a review-fix commit, test-guard, docs-syncer (report-only), this retro. Verify passed on the final state: the gate ran after the rebase onto origin/main 6f66891. `npx tsc --noEmit` exit 0, `npm run lint` exit 0, `npx vitest run` 62 files / 1707 tests passed.

Commits (`git log --oneline origin/main..HEAD`): ca69349 (migration and tests), 724818d (sync stores `posted_date` and `merchant.nzbn`), ab25c29 (review fixes: three comments corrected, index hazard noted in `down`).

## What was built

- **Kind of code:** one additive migration (`20261025140000_transactions_posted_date_nzbn.js`, 59 lines), a four-line mapping change in `server/sync/upsert.ts`, two lines in the `TRANSACTION_COLUMNS` pin, and two test files: the migration test (239 lines) and `full-fields.test.ts` (215 lines). 8 files, 551 insertions and 10 deletions across the whole diff.
- **Pattern:** two nullable text columns on `transactions`. `posted_date` is stored as Akahu sends it (full ISO-8601 UTC text, like `date`) on settled rows and is NULL on pending rows. `merchant_nzbn` rides the existing `detailFields()` helper from #155, so it is written on settled and pending rows and cleared when Akahu stops sending it. `up` uses knex `addColumn`; `down` uses native `ALTER TABLE ?? DROP COLUMN ??`.
- **Why `down` is native SQL:** knex 2.5.1's `dropColumn` on SQLite rebuilds the whole table, and inside a migration transaction that cascades away `category_corrections` (the child table with a foreign key to `transactions`). SQLite 3.44.2 can drop a column natively. Precedent: migration 20261024100003. This was settled by reading the record and running it; it did not need a decision from Hannah.

## What happened

- **The researcher ran the change on a scratch copy before anyone planned it.** It found four tests in three files outside the fence that break:
  - `server/db/__tests__/prd01-schema.test.ts:322-338` and `prd02-tables.test.ts:324,938-944`: whole-row `toStrictEqual` across `migrate.latest()`. These break on any added `transactions` column.
  - `server/sync/__tests__/run.test.ts:93-139,168-189`: whole-row expected objects. The fixtures already carried `nzbn` and `posted_date`, so storing them changes every expected row.
- **Decision 7a07660e.** The lane raised it with the architect running in parallel. Hannah picked A: widen the fence to those three files, and make the prd01 and prd02 tests compare only the columns that existed before the migration. Her reason: the next add-column migration should not raise this again, and the `TRANSACTION_COLUMNS` pin still catches column changes. The prd01/prd02 change is therefore a fix to the test, not a patch for this column.
- **The handoff described `posted_date` as a bare calendar date. Akahu sends full ISO-8601 UTC text** (e.g. `2026-10-21T00:00:00.000Z`). Stored verbatim, like `date`. Found in the fixtures and the client type, before any code was written.
- **The architect's break-it check was wrong, and the implementer caught it.** The plan said that changing the mapping to `posted_date?.slice(0,10)` would turn the second-run (idempotence) test red. It does not: the slice applies to both the stored and the compared value, so the second run sees no change. The implementer ran it, saw green, and added a digit-only-NZBN variant of the second-run test that can fail, proven with an integer-column mutation (a digit-only string coerces to an integer in a numeric-affinity column and never equals the incoming text). The reviewer confirmed this as its M7.
- **A one-off red gate with no code cause.** The reviewer's first gate run went red once in an unchanged test, `prd01-schema.test.ts:861` (`expected 52 to be 53`, a sequence check after rollback), at 17:35:14. It was 1 red of 17 full runs at HEAD and never reproduced. The schema-reviewer was running in the same worktree at the same time, and its own mutation (`down` changed to knex `dropColumn`) produces the identical failure message. So the red run was almost certainly two review seats mutating one working tree. This is REASONED from the timing and the identical message; no one re-created the overlap on purpose.
- Review and the other seats:
  - **reviewer:** 0 code defects. Four comment fixes, all in ab25c29: the migration header overstated what the second-run check catches; a note that native `DROP COLUMN` refuses indexed columns; the migration-test header claimed the index check catches a knex rebuild (it does not, because knex recreates the index); the prd02 comment named a pin that file does not import.
  - **schema-reviewer:** no critical findings, no warnings.
  - **security-auditor:** nothing new from this diff. Pre-existing `GET` and `PATCH /api/v1/transactions` return whole rows, which now include the two columns. Filed as #212 (housekeeping, `Missed-by: review`).
  - **test-guard:** break-it checks ran across the implementer, reviewer, schema-reviewer and test-guard. Every production change had at least one mutation that turned tests red.
  - **docs-syncer (report-only):** `docs/akahu-pending-semantics.md` section 6 (lines 256-257, written by #210) says these two fields are not stored, and goes stale on merge. Filed as #213 (housekeeping, `Missed-by: none`, blocked on this PR).

## What went wrong

1. **The fence missed three test files that pin the shape of a `transactions` row.** The issue's fence listed the new migration, `server/db/migrations/__tests__/`, `transactionColumns.ts`, `upsert.ts`, `server/sync/__tests__/` except `run.test.ts`, and fixtures. It excluded `run.test.ts` by name and did not mention `prd01-schema.test.ts` or `prd02-tables.test.ts`. Adding any column breaks the first two; storing the two fields breaks `run.test.ts`. Cost: one Baseline decision and a wait on Hannah, with the architect running in parallel so the build was not idle. Nothing reached main broken, because the researcher found all four tests on a scratch copy before the build.
2. **The same gap that #155's retro named.** #155's retro said fences miss readers and pinning tests, and that its recommended slicing grep had not landed. #191 was cut from #155 and repeated the pattern. Its `Missed-by: plan` is correct and was already on the issue.
3. **The architect's break-it prediction was wrong.** The `slice(0,10)` mutation was expected to fail the second-run test and does not. Had the implementer taken the plan's prediction on trust, the idempotence test would have shipped unable to fail on that class of change. Cost: small. The implementer ran the mutation, so the error was found in the same pass.
4. **Two review seats mutated one working tree in parallel and produced one red gate run.** 1 of 17 full runs at HEAD, never reproduced, no code cause. Cost: a failed gate the reviewer had to explain and re-run, and a finding that had to be traced to timing. Small this time, but a mutation seat that can turn another seat's gate red is a flaky gate by construction.
5. **The handoff's description of `posted_date` was wrong** (a bare calendar date; Akahu sends full ISO text). It was caught from the fixtures before it shaped any code, so it cost nothing beyond a correction. Recorded because the issue text and the wire format disagreed and only the wire format was right.

## Root causes

- **Fence written without checking the consumers of the thing being changed (items 1, 2; seventh occurrence by the retros' own count: #155 called itself the fifth, #67 the sixth).** The consumers this time were whole-row assertions over `transactions`, which is a different shape from #155's test that pinned a bug. The fence covered the files that change and not the files that assert the exact shape of what changes. #155's retro and #67's retro both asked for a slicing grep. `grep -n -i "grep\|fence\|consumer" ~/.claude/agents/architect.md` returns nothing but the tools line, so it has not landed in the architect's file. This lane found the problem anyway because the researcher seat simulated the change; that is a good catch by a seat, not by the slicing step it was supposed to back up.
- **A mechanical check exists and was not run at slicing time.** `rg` over `__tests__/` for whole-row `toStrictEqual` against `transactions`, plus every importer of `TRANSACTION_COLUMNS`, lists these three files in seconds. The cause is a missing step, not a missing tool.
- **A plan's break-it prediction was not executed before it was written down (item 3).** The architect reasoned about what `slice` does and was wrong; the implementer ran it. This is the "author's list versus the reach of the mutation" family from #155 and #39, here in a narrower form: the prediction itself was reasoned and not run. First time it has been the architect's prediction. Do not encode yet.
- **Parallel mutation seats share one worktree (item 4).** Cause: the dispatch ran reviewer, schema-reviewer and security-auditor at once, and two of them edit tracked files to prove a break. Evidence is the timing and the identical message (`expected 52 to be 53`), not a reproduction, so this is REASONED. If it is wrong, the other candidate is a real order-dependent test at `prd01-schema.test.ts:861`; 1 of 17 cannot rule that out.
- **A handoff written from memory of the wire format (item 5).** The handoff did not cite a fixture or the client type for the `posted_date` format. First occurrence.

## What worked, keep it

- **The researcher simulated the change on a scratch copy.** It turned a surprise in the gate into a decision raised before the build started. All four breaking tests were named with line numbers. Without it the first red gate would have found them after the implementer had built.
- **Raising the fork through Baseline, and Hannah choosing the future-proof option.** Option A changes the prd01 and prd02 tests to compare only pre-migration columns, so the next add-column migration should not raise this again. The `TRANSACTION_COLUMNS` pin still fails when a column is added without the pin being updated, so the safety net is not lost.
- **The architect ran in parallel with the pending decision.** The plan did not wait on the answer.
- **The implementer ran the architect's mutation instead of trusting it,** and built a test that can fail (the digit-only NZBN variant), then proved it with an integer-column mutation.
- **Break-it checks on every production change.** Across four seats, each production change had at least one mutation that turned tests red.
- **Reading the record for `down`.** Native `DROP COLUMN` with a named precedent (20261024100003) avoided a Baseline decision and avoided knex's table rebuild cascading away `category_corrections`.
- **Surfacing, not absorbing.** The items below went to a note or a follow-up and not into the diff. Security and docs findings became #212 and #213, each with an origin line.

## Surfaced, not absorbed

- `server/db/synced.ts`'s explicit column list omits the two new columns. That is correct for now: the client does not read them, and there is no client change.
- `models/transactions.ts` `Transaction` lacks the two columns. Out of the fence; the lag was there before this diff (the same lag #155 noted at #133 item 3).
- The migration-guards header says `migrate:latest` runs on every boot, but only `npm start` runs it.
- `GET` and `PATCH /api/v1/transactions` return whole rows (#212).
- `docs/akahu-pending-semantics.md` section 6 goes stale when this merges (#213).

## Recommended changes

1. **Architect fence step: before writing a fence for any issue that adds a column or changes what a row stores, run `rg` over `__tests__/` for whole-row `toStrictEqual` against that table, and for every importer of its column pin (`TRANSACTION_COLUMNS`), and put each hit in the fence or give it an owner.** Seventh occurrence of the consumers family; the retros for #155 and #67 both said "encode", and the architect's file has no such step today. Do it now and do not wait for an eighth. Artifacts: `~/.claude/agents/architect.md` (then `pnpm import-workflow --name current`), and the conductor's slicing checklist. High leverage.
2. **Review dispatch: seats that mutate tracked files (reviewer, schema-reviewer, test-guard) do not run in parallel in one worktree; either run them in sequence or have each mutate a scratch copy.** First occurrence, and the cause is REASONED. Do not encode yet. If a second unexplained red appears while two mutating seats overlap, add the rule to the `parallel-agents` skill's review step. Cheap check now: when a gate goes red once, compare its timestamp with the other seats' mutation windows before calling it flaky.
3. **A plan that predicts "mutation X turns test Y red" runs the mutation or marks the prediction REASONED.** First occurrence for an architect's prediction. Do not encode yet; if it recurs, add one line to `~/.claude/agents/architect.md`.
4. **A handoff that states a wire format cites the fixture or type it came from.** First occurrence. Do not encode yet.

## Highest-leverage next step

Do Recommendation 1: add the whole-row and column-pin grep to the architect's fence step in `~/.claude/agents/architect.md` and to the conductor's slicing checklist, then import it with `pnpm import-workflow --name current`. This is the seventh lane in which a fence missed a reader of the changed thing. This lane survived only because the researcher happened to simulate the change first. A step that finds the same three files in seconds should not depend on that.

## Open items for the PR body

- Three test files outside the issue's original fence changed, by Hannah's decision 7a07660e: `prd01-schema.test.ts` and `prd02-tables.test.ts` now compare only pre-migration columns, and `run.test.ts` has three added lines for the new fields.
- `down` uses native `DROP COLUMN`, not knex `dropColumn`; the migration header says why. Native `DROP COLUMN` refuses indexed columns, so adding an index to either column later needs a different `down`.
- Follow-ups: #212 (`GET`/`PATCH /api/v1/transactions` return whole rows, housekeeping, `Missed-by: review`) and #213 (`docs/akahu-pending-semantics.md` section 6, housekeeping, `Missed-by: none`, blocked on this PR).
- Fixture values are invented.

## For Baseline (four fields)

- **narrative_code_type:** an additive SQLite migration plus a small mapping change in the Akahu sync path (`server/sync/upsert.ts`), with a migration test and a sync test file.
- **narrative_built:** `transactions` gains two nullable text columns, `posted_date` and `merchant_nzbn`, and sync now stores Akahu's `posted_date` and `merchant.nzbn`. `posted_date` is Akahu's full ISO-8601 UTC text, stored verbatim like `date`, and is NULL on pending rows. The NZBN is written on settled and pending rows and cleared when Akahu stops sending it. A second run over unchanged data writes nothing, including for a digit-only NZBN. `down` drops the columns natively so it does not rebuild the table and cascade away `category_corrections`. The final gate is green: `tsc` and lint clean, 62 files and 1707 tests passing.
- **narrative_how:** a researcher simulated the change on a scratch copy first and found four tests in three files outside the fence that break. The lane raised Baseline decision 7a07660e and Hannah chose to widen the fence and make the prd01 and prd02 schema tests compare only pre-migration columns. The architect planned in parallel with the pending decision. The implementer built in two commits (migration with tests, then the mapping with tests) and proved each production change with a mutation. The reviewer, schema-reviewer and security-auditor ran in parallel and found no code defect; four comments were corrected in one review-fix commit. Test-guard and docs-syncer followed; the docs-syncer finding became follow-up #213 and the security note became #212.
- **narrative_wrong:** the issue's fence left out three test files that pin the whole shape of a `transactions` row, which cost a decision and a wait (`Missed-by: plan`). By the retros' own count this is the seventh fence that missed a reader of the changed thing, and the slicing grep that two earlier retros asked for is not in the architect's file. The architect's prediction that a `slice(0,10)` mutation would fail the second-run test was wrong, and the implementer caught it by running it. One gate run (1 of 17 at HEAD) went red in an unchanged test, almost certainly because the reviewer and schema-reviewer mutated the same worktree at the same time; that is reasoned from timing and an identical failure message, not reproduced. The handoff also described `posted_date` as a bare date when Akahu sends full ISO text, caught from the fixtures.
