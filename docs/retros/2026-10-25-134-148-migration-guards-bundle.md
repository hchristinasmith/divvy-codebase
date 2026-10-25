# Retro: #134 migration-rebuild guard, with #148 bundled (both test-only, `server/db/__tests__/`)

Bundle of two issues in one lane, one PR. #134 gear 1-2 as stamped, #148 gear 1; no shift. Both are test-only: no file under `server/db/migrations/**` was touched (negative fence), and every migration mutation was run in a scratch copy. Implementer ran twice on opus, reviewer twice, test-guard twice, then this retro. No architect, no stash. Commits: a9b181d (#134 build), a7e5829 (#134 review fix), 6b46f1a (#148). Merge with `gh pr merge <N> --merge --delete-branch` so the per-issue commits survive; the merger closes #134 and #148 by hand. This file states no Baseline telemetry (model, duration, tokens, tool calls). I did not re-run the gate for this retro; the dispatch says verify passed on the final state.

## What was built

- **Kind of code:** a regression guard over the migration stack (#134) and a tightened schema assertion (#148). Both are vitest files; no production code changed.
- **#134 pattern:** new `server/db/__tests__/migration-guards.test.ts`. The guard migrates to the schema `20261024100004` leaves, seeds a `category_corrections` row, runs `migrate:latest`, and asserts the correction, its transaction and the `transactions` AUTOINCREMENT counter are unchanged. A permanent canary adds a rebuild migration in the test through a custom `migrationSource` and expects the guard's shared check to fail, so the guard cannot go quiet. A third test pins the canary's migration list equal to knex's directory source.
- **Why a test and not the lint rule:** the issue offered either. The test catches every rebuild route (`dropColumn`, `.alter()`, anything that recreates the table), where a lint rule sees only the calls it names, and the eslint config lives in `package.json`, outside the fence.
- **#148 pattern:** `prd01-schema.test.ts` now leaves `source` out of the insert through a local `omit(row, column)` instead of `source: undefined`, and the one check is split into explicit-null and left-out, each matched with an anchored regex.

## What happened

1. **Cascade confirmed, not assumed.** The implementer reproduced the hazard on knex 2.5.1: after a rebuild the corrections went to `[]` and the `transactions` sequence went 2 to 1. The guard rests on a measured failure.
2. **One build snag.** Loading the migration files through a `file://` URL failed in vite, because the repo path has encoded characters (`%20`, `%7E`). A plain absolute-path import works. Cost: a few minutes.
3. **Reviewer on #134** found one gap. The canary built its migration list from a `.js`-only filter, while knex's directory source also loads `.ts` and `.cjs`; a migration in either extension would have skipped the canary silently. Fixed in a7e5829 with the third test. The reviewer also showed the counter check catches a rebuild even under `transaction: false`, where there is no cascade, so the sequence assertion is not redundant with the row assertions.
4. **Test-guard on #134:** 4 mutations, each red for the titled reason. Warned that `migrateThroughCorrections` is copy 2 of the step-up loop in `migrateToJustBefore.ts`.
5. **#148.** Mutation `.defaultTo('user')` on `category_corrections.source` in a scratch copy: the new test goes red, the HEAD version stays green. That is the whole claim of the issue, shown rather than argued. Reviewer: 0 findings. Test-guard: each assertion fails for its own mutation.

## What went wrong

- **The canary's own list could drift from knex's.** The first build shipped a guard whose safety net had a hole of the kind it exists to close. A reviewer found it, the implementer did not; the canary was only checked against the extensions the repo uses today.
- **Review fix and build shared one untracked file.** `migration-guards.test.ts` was new, so the review fix landed in the same file as the build and `git add -p` had nothing to split. The conductor produced the two commits by restoring the implementer's pre-red-demo scratch copy. That worked only because the implementer happened to save one; nothing in the handoff asked for it.
- **A reviewer wrote outside its scratch dir.** The #134 reviewer put a temp file at `/private/tmp/claude-501/vt.out` and deleted it afterwards. No harm, but the reviewer prompt names no scratch location.
- **Two helpers now exist twice.** `omit` (here and in `prd02-tables.test.ts`) and the step-up loop (here and in `migrateToJustBefore.ts`). Each lane did the narrow thing inside its fence; the duplication is the price. Filed as #166.

## Root causes

- **A second source of truth inside a guard (#134).** The canary re-derived "the list of migrations" instead of reading knex's. Any test that restates what a tool decides can drift from it. The reviewer caught it; a plan seat would not have, at gear 1-2.
- **Test-only files that start life uncommitted have no checkpoint.** The convention snapshots files only when someone thinks to. The earlier safe-to-spend bundle retro had the implementer snapshot after each issue; here that was luck, not instruction. This is a recurrence of the same cause with a different file.
- **Fence beats consistency.** Both duplications come from the fences: lifting a helper meant touching a file the other issue owned. That is the rule working, not a miss.
- **The path-encoding failure** was the environment (a repo path with spaces and `~` in a synced folder), not a decision. No change in the repo can fix it; a comment in the test records the workaround.

## What worked, keep it

- **Test over lint, chosen on a stated reason.** The "every rebuild route" argument is the reason the guard also catches `.alter()` and hand-written recreates.
- **A permanent canary.** Rather than a one-off red demo, the proof that the guard fails is a test that runs forever.
- **Mutations in scratch copies only.** Every migration mutation stayed out of `server/db/migrations/**`, so the fence was checkable by `git diff --stat`.
- **Red-for-its-own-reason checks.** Test-guard's mutation results (4 for #134, one per assertion for #148) tie each assertion to a failure, not just to a green run.
- **Follow-ups filed with origin, not absorbed.** #165 (same guard for the `accounts`, `bills`, `goals` and `users` children; `Spawned-by: #134`, `Missed-by: none`) and #166 (`Spawned-by: #148`, `Missed-by: none`). Both are `Priority: housekeeping`.

## Recommended changes

1. **Tell implementers to snapshot a new test file before the red demo and after each review round.** First occurrence in this form (the safe-to-spend bundle snapshotted per issue, not per review round), so record only; encode on the second. Candidate file: the lane handoff template under the conductor's control.
2. **Name the scratch directory in the reviewer and test-guard prompts** ("write only under the session scratchpad"). One slip, harmless. Optional; record only.
3. **#166 lifts the duplicated helpers.** Its fence is `server/db/__tests__/**`, which fits. Do it before #165 adds a third copy of the step-up loop.

## Highest-leverage next step

Land #166 before #165: #165 extends `migration-guards.test.ts` with four more parents, and each will want the step-up helper. One copy, imported, is cheaper than a third.

## Open items for the PR body

- Follow-ups filed: #165, #166 (above). No gear shift to report.
- #134's guard covers `category_corrections` only; the other parents are #165.
- Merge with `--merge`; close #134 and #148 by hand with a reason.

## For Baseline (four fields)

**code type:** test-only regression guards for the SQLite migration stack, plus a tightened schema assertion. Gear 1-2, two issues bundled in one lane.

**built:** `server/db/__tests__/migration-guards.test.ts` (#134) migrates to the schema `20261024100004` leaves, seeds a category correction, runs `migrate:latest`, and asserts the correction, its transaction and the `transactions` AUTOINCREMENT counter are unchanged. A permanent canary adds a table-rebuilding migration through a custom `migrationSource` and expects the guard's check to fail, and a third test pins the canary's migration list to knex's directory source. #148 replaces `source: undefined` in `prd01-schema.test.ts` with an `omit` helper and splits the check into explicit-null and left-out.

**how:** the test option was chosen over the lint option because it catches every rebuild route and the eslint config sits outside the fence. The cascade was reproduced first on knex 2.5.1 (corrections to `[]`, sequence 2 to 1). All migration mutations ran in scratch copies, never in `server/db/migrations/**`. Opus implementer, reviewer and test-guard ran twice each; test-guard mutations were red for the titled reason, and a `.defaultTo('user')` mutation turned the new #148 test red while the old one stayed green.

**wrong:** the first #134 build had a canary with its own `.js`-only migration list that could silently diverge from knex's (which also loads `.ts` and `.cjs`); the reviewer caught it and the fix is a pinning test. The review fix landed in the same untracked file as the build, so the two commits were split by restoring the implementer's pre-red-demo scratch copy, which worked only because the implementer happened to save one. The #134 reviewer wrote a temp file outside the scratch dir and deleted it. `omit` and the step-up loop now exist twice each; #166 lifts them, and #165 covers the other parent tables.
