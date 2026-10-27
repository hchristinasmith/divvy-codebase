# Retro: #428 prd04 Ruling 9, contracts and tables allow claude proposals and logged API usage

## Retro summary (for the PR body)

#428 made the contracts and tables ready for Ruling 9: `category_proposals` allows origin `claude`, `agent_runs` allows status `blocked` and logs model usage, `AgentConfig` carries the model-path fields, `finishRun` records blocked runs and usage, and the PRD carries the amendment. Gate green at each commit: tsc 0, lint 0, vitest 127 files, 5395 then 5402 tests.

Gear 4, implementer on opus. Three commits: `29f2f91` migration (with the minimal type and test pins to stay green), `c631c80` review fix, `584319f` contracts, `finishRun`, headers and PRD. The shape was right from the start. The cost was one decision round that a better fence would have avoided, and a migration whose safety claim was false until review.

## What was built

- **Kind of code:** a SQLite table-rebuild migration, plus contract changes (value lists, `AgentRun` fields, optional `AgentConfig` fields) and a `finishRun` change.
- **Pattern:** the rebuild copies with `INSERT...SELECT` under `PRAGMA defer_foreign_keys`, then compares `PRAGMA foreign_key_check` before and after, so it throws only on a violation it did not inherit.

## What went wrong

1. **A decision round for a fence gap.** Adding columns to `agent_runs` broke a hard-coded `RUN_KEYS` list in `server/agents/category/__tests__/agent.test.ts`, which is inside the negative fence. The lane stopped and raised Baseline decision `28d5cf38`; the conductor chose "this lane adds the four names" in about 2 minutes. Four test files outside the declared fence had to change (category, insights, `contracts.test`, `migration.test`). Missed-by: plan.
2. **"Migration before the code that uses it" could not be migration-only.** Existing tests pin the contract lists and the `AgentRun` key set to the latest schema, so the first commit had to carry the value lists, `AgentRun` fields and test pins to stay green.
3. **First rebuild failed 59 route tests.** A test leaves an orphaned proposal with keys off, and the rebuild's `INSERT...SELECT` refused it. Fixed with `PRAGMA defer_foreign_keys`.
4. **The header's safety claim was false.** The reviewer showed, with raw SQLite and a mutation, that switching the deferral back OFF silently discards counted violations. Fixed in `c631c80` by comparing `foreign_key_check` before and after.
5. **Phase B review fixes landed inside the build commit.** The reviewer found an untested header claim (blocked runs not counted as processed) and a header that contradicted a test (blocked "before any call" against a blocked run with usage). Both were fixed in the working tree, so they landed in `584319f` and not as a separate review-fix commit. That breaks the "review fixes separate" rule.
6. **`AgentConfig` fields are optional, not required,** because the fenced category agent builds `AgentConfig` literals. This is a design concession to the fence. A later lane can tighten it.
7. **Out-of-scope finding.** The security auditor found the accept route records claude proposals as source `rule`. Filed as #432 (Spawned-by #428, Missed-by plan).
8. **A Co-Authored-By line** was on the first commit against Hannah's rule. Amended before push.

## Root causes

- **The fence named contract files and not the tests that pin the contract's key set (items 1, 2).** Nobody grepped for `Record<keyof X` or hard-coded key lists when the issue was sliced. This produced the decision round and the oversized first commit.
- **A safety claim was written before it was tested (item 4).** The header asserted what the code could not do. Only a mutation exposed it.
- **Item 8:** the harness's attribution reminder asks for a Co-Authored-By trailer, and the lane followed it without checking it against `~/.claude/CLAUDE.md` ("never Claude as co-author"), which wins. Caught by a reread before push.
- **Item 5:** the reviewer edited the same files as the uncommitted build, and the pre-fix text was not kept, so the two could not be split after the fact. Committing the build before dispatching review would have kept them apart.

## What worked, keep it

- **The lane stopped and raised the fence conflict** instead of editing a fenced test quietly. It cost 2 minutes.
- **Reviewers ran mutations,** which is how items 4 and 5 were found as demonstrations, not opinions. `test-guard` was not run, to keep the lane small; the reviewers' mutation checks covered that ground. `second-opinion` was not run (no PR yet).
- **The security auditor's finding left the lane as an issue** (#432) and not as folded-in scope.
- **The gate was green at every commit,** so each is bisectable.

## Recommended changes

1. **When an issue changes a contract's shape, its fence names the tests that pin that shape.** The slicer greps for `Record<keyof X` and hard-coded key lists and lists the files. This would have removed the decision round. Second family hit across retros (a fence written without opening the code it fences, as in #51), so encode it. Artifact: the issue-slicing checklist, or the `architect` brief in the workflow import (Baseline side, via `pnpm import-workflow`).
2. **A comment claiming a safety property names the test that proves it (do not encode yet).** First occurrence. Optional.
3. **Review fixes are committed before the next build step (do not encode yet).** First occurrence of fixes merging into the build commit.

## Highest-leverage next step

Add the contract-pinning-tests grep to the issue-slicing step (change 1), so the fence lists the pinning test files when a contract's shape changes.
