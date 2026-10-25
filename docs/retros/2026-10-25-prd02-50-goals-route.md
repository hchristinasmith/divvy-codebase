# Retro: #50 prd02 w3, goals can be created and given contributions (goals data module, pure pace math in shared/, goals routes, contract widening)

Gear 4 as stamped; no shift. Gear 4 maps to opus in the CLAUDE.md table, and the implementer ran on opus at effort high. This file states no telemetry (model, duration, tokens, tool calls); the dispatching session posts the four narratives to Baseline.

Seats run, in order: researcher, one Baseline decision (answered by Hannah), architect, implementer (build, one commit), reviewer, security-auditor and test-guard, implementer (review fixes, one commit), docs-syncer (report-only), this retro. `schema-reviewer` does not apply (no migration) and `brand-checker` does not apply (no UI). Verify passed on the final state: `npx tsc --noEmit` exit 0, `npm run lint` exit 0, `npx vitest run` 92 files / 3541 tests. The gate was green at every point it ran.

Commits (`git log --oneline origin/main..HEAD`): 1bdfc2d (build), 1ff2c3b (review fixes). The three-dot diff (`git diff --stat origin/main...HEAD`) is seven files, +2025 / -9: `server/db/goals.ts` (500), `server/routes/goals.ts` (205 changed, replacing the 501 placeholder), `server/routes/__tests__/goals.test.ts` (1020), `shared/goals.ts` (104), `shared/__tests__/goals.test.ts` (177), 24 lines in `shared/contracts.ts`, and 4 lines in `server/routes/__tests__/barrel.test.ts`. Tests are about 2.7 times the size of the route and data code. The two-dot diff against `origin/main` shows client files that landed on main after this branch was cut; the three-dot form is the one that matches the lane's work.

## What was built

- **Kind of code:** a money-state write route (`GET`/`POST`/`PATCH`/`DELETE /api/v1/goals`, `POST /api/v1/goals/:id/contributions`), a data module under it (`server/db/goals.ts`), a pure money-math module (`shared/goals.ts`), an additive widening of `GoalResponse` in `shared/contracts.ts`, and three test files. No migration; the tables already existed.
- **Pattern:** a contribution is an appended record and nothing else (prd-02 Ruling 5): it never moves money, never touches settings, and never changes safe-to-spend. Pace is computed from the saved amount, the target and the by-date, in integer cents with one round-up at the end, in `shared/goals.ts` so client and server share one definition. The response carries `paceCents` and `monthsToGo`, both null with no by-date.
- **Why this shape:** the PRD never defined pace. The prototype used a stored per-goal `monthly` field that the schema does not have. Hannah chose "needed per month to hit the by-date" over storing a figure (decision 0d881e4c, option A), which is why pace is derived and no column was added. The pure math went to `shared/` because CLAUDE.md says money math lives there; the issue's fence did not list it.

## What happened

- **Researcher and plan-stage finds.**
  1. `barrel.test.ts` pinned `goals` as a 501 placeholder, so the real route would fail an existing test. That file was outside the issue's fence, the same thing #49 hit.
  2. `GoalResponse` already existed in `shared/contracts.ts` but had no pace fields.
  3. The PRD does not define pace, and the only source was the prototype's stored `monthly` field, which the schema lacks.
- **One decision raised, one answer.** The lane raised 0d881e4c instead of choosing a definition of pace. Hannah picked option A after about 9 minutes. No rework followed. Pace is a fork with different consequences (stored versus derived changes the schema and the contract), so raising it was right.
- **Architect** put the pure math in a new `shared/goals.ts` and its test, outside the declared fence. This was forced by the project rule on money math, not a choice, and no decision widened the fence.
- **Implementer** built in one commit and ran break-tests on its own work: every planned mutation was caught. One needed a second pass. The mutation "`addContribution` writes settings" first failed 4 tests through a unique-key 500, which only proved that something broke. It was re-run with a unique key to show that the Ruling 5 test is the test that catches it. The second run is the evidence; the first was not.
- **Reviewer** (3 low findings, 0 blocking). 15 mutations, 14 killed, 1 equivalent (`Math.ceil` against `ceilDiv` give identical results under the 1e9 cap). The 3 findings, all fixed in 1ff2c3b: a test title that printed the year through `%i`, a comment that named `overview.test.ts` for helpers that only exist in `bills.test.ts`, and one over-long comment line.
- **Test-guard: covered and gated.** One survivor: removing `ORDER BY id` is not caught, because SQLite's rowid order gives the same result. Noted as equivalent here. The goals route test file takes about 63 seconds under the full suite and about 5 seconds alone; that is a flake watch item, not a failure.
- **A process miss inside the review step.** The reviewer mutated source files in place while test-guard ran at the same time on the same working tree. Test-guard's first batch therefore read contaminated sources: it saw a `td >= d` edit and a `writableId` reorder that were the reviewer's mutations, not the code. It had to re-run from a `git archive` export. Cost: one wasted mutation batch and some confusion about which survivors were real. No wrong result reached the commit.
- **Security-auditor** (no critical). DNS rebinding passes `fromThisSite`; this is inherited from the copied helper and is tracked by #174. `urlencoded` and `text` bodies were probed and all answer 400, with a suggestion to add route tests for those body types.
- **Copy counts after this lane:** `fromThisSite` 5 copies, `errorClass` 6, `parseId`/`writableId` 2, `guard` 3. The list in #236 was written before bills and goals existed and is out of date.
- **Docs-syncer (report-only):** nothing stale in the docs this change touches. The README "What works today" section lags in general (not this lane's doing). `docs/design/handoff.md:40` words the contribution buttons loosely, at odds with Ruling 5; the PRD wins, per CLAUDE.md, so no edit.

## What went wrong

1. **The issue's fence did not list the files the work needed (Missed-by: plan).** `barrel.test.ts` (4 lines), the additive `GoalResponse` widening in `shared/contracts.ts`, and `shared/goals.ts` with its test. The barrel move is now the fourth time (#44, #46, #49, #50). The new part is `shared/goals.ts`: the fence assumed the pace math lived in the data module, but CLAUDE.md puts money math in `shared/`. The lane touched all four paths as forced consequences and reported them, but a fence that lists none of them makes "needed, touched" uncheckable.
2. **The PRD never defined pace (Missed-by: plan).** The prototype's `monthly` field was the only source and the schema has no such column. Cost: one decision and about 9 minutes of waiting. It is the right way to resolve it, but it is a gap that the PRD and the slice could have closed before dispatch.
3. **Two seats mutated one working tree at the same time (Missed-by: do, the conductor-side sequence).** Reviewer and test-guard both run break-tests by editing source in place. Run together, each sees the other's edits. Cost: one wasted test-guard batch and a re-run from `git archive`. The record shows no instruction anywhere that says mutating seats must not overlap, or must work on a scratch export.
4. **The implementer's first proof for the Ruling 5 test was weak.** A mutation that failed 4 tests through an unrelated unique-key 500 showed only that something broke. It was caught by the implementer itself and fixed in the same seat, so the cost was one extra run, not a defect in the commit.
5. **More copies of helpers the fence forbids lifting (Missed-by: plan).** `fromThisSite` is now in 5 places and `errorClass` in 6. #236 was the issue meant to lift them and its list is stale (it predates bills and goals). Budgets (#48) and habits (#52) will each add another unless #236 lands first. The #49 retro raised this and nothing about the dispatch order has changed in the record.

## Root causes

- **Plan covers the code that changes, not the code that reads, pins or constrains it (items 1, 2, 5).** Same family as #25, #39, #44, #46, #49 and #67, same name. Here: the test that pins the placeholder (barrel), the project rule that decides where money math lives (`shared/`), and a PRD that left a definition open. The slice was cut from the PRD and the issue text, and not checked against the repo's rules for where each kind of code must go.
- **A recommendation with no owner never lands (items 1 and 5).** Same name as the #49 retro. That retro recommended adding the barrel test and the module's test file to the architect's fence checklist, and proposed sequencing #236 before the three sibling lanes. The record shows neither done before #50 was cut. The barrel miss has now repeated after being written down once.
- **Two mutating seats on one working tree (item 3).** First occurrence. The cause is a missing rule, not a tool fault: the reviewer and test-guard both do the same kind of work (edit, run, revert) and nothing tells the conductor they conflict. `git archive` export, which the lane used to recover, works.
- **A PRD that leaves a figure undefined (item 2).** First occurrence. The cause is the PRD, not the lane. I cannot say from the record whether the PRD review looked for undefined derived figures.

## What worked, keep it

- **Raising the pace fork instead of picking.** One decision, one answer, no rework. The lane did not store a value the schema lacks, and did not absorb the choice.
- **Pure math in `shared/` with its own test, integer-cent fixtures.** Pace is a pure function with one rounding step, and the 1e9 cap makes `ceil` and `ceilDiv` agree, which is why the reviewer's one surviving mutant is equivalent.
- **Implementer break-tests before review.** Every planned mutation caught before anyone else looked. The follow-up run that distinguished "something broke" from "the right test broke" is the habit worth keeping.
- **The reviewer and test-guard as separate seats.** The reviewer found three low findings; test-guard found the `ORDER BY id` equivalent and the slow-file note. Both were different questions asked of the same diff.
- **Recovering from a contaminated batch by exporting.** Test-guard noticed the edits it did not make and re-ran from `git archive` instead of reporting the survivors it saw.
- **Review fixes in their own commit** (1ff2c3b), so the second reader saw only the response.
- **Appended contributions, never updates, and a test pinning that settings is untouched.** Ruling 5 is a checkable claim rather than a comment.

## Surfaced, not absorbed

- **#174** DNS rebinding passes `fromThisSite`; this lane adds one more copy of the helper that carries it.
- **#236** lift `fromThisSite`, `errorClass`, `parseId` and `writableId`, `guard` into one module. Its list needs updating to the counts above (5, 6, 2, 3).
- **Route tests for `urlencoded` and `text` bodies** (the security-auditor's suggestion). All probed bodies answer 400; no test pins it yet. No issue filed from this record.
- **Goals route test file speed:** about 63 seconds under the full suite against about 5 seconds alone. Watch it; if it starts failing under load it becomes a gate-blocking flake and so a phase item.
- **README "What works today"** lags generally; not this lane's change.
- **`docs/design/handoff.md:40`** contribution wording loosely at odds with Ruling 5. The PRD wins; no edit.
- I did not read the bodies of #174 and #236 beyond their titles, so I do not state their `Missed-by` lines.

## Recommended changes

1. **Architect fence checklist: when an issue turns a placeholder route into a real one, the fence lists `server/routes/__tests__/barrel.test.ts`, the module's own `__tests__` file and any additive `shared/contracts.ts` block; and when the work computes money, the fence lists the `shared/` module and its test.** Fourth occurrence of the barrel miss, second time this has been recommended. Encode now. Artifact: `~/.claude/agents/architect.md` (then `pnpm import-workflow --name current`), plus a short "Adding a route" note in `docs/testing.md`. High leverage; it is mechanical.
2. **Do not run two seats that edit source at the same time; run them one after the other, or require each to work from a `git archive` export.** First occurrence, so by the retro rule do not encode into a skill yet. The conductor can apply it now at no cost by dispatching test-guard after the reviewer. If it happens a second time, add one line to the `parallel-agents` skill and to the `reviewer` and `test-guard` agent files. Artifact if encoded: `~/.claude/skills/parallel-agents/SKILL.md`.
3. **Sequence #236 before #48 and #52 merge, and update its list to the counts above.** This repeats the #49 retro's recommendation 3, which is still open. Not a doc change; it is a dispatch order for the conductor. Worthless after the next two lanes merge.
4. **PRD review: before a PRD is blessed, list every derived figure a screen shows (pace, tax hold, safe-to-spend) and the ruling that defines it.** First occurrence (pace). Do not encode yet. If a second figure turns up undefined, add the check to the PRD template under `docs/prds/`.

## Highest-leverage next step

Do recommendation 1: add the barrel test, the module's own test file, any additive contract block, and the `shared/` module for money math to the architect's fence checklist. It is the fourth time the barrel move has been predictable and unlisted, it was already recommended once in the #49 retro without landing, and budgets (#48) and habits (#52) are about to make the same moves. Recommendation 3 costs the conductor one line of dispatch order and goes with it.

## Open items for the PR body

- Gear 4 as stamped; no shift. Out-of-fence touches, all forced: `shared/goals.ts` and its test (money math belongs in `shared/`), `shared/contracts.ts` (additive `paceCents`, `monthsToGo`, Ruling 5 comments), `server/routes/__tests__/barrel.test.ts` (goals from `PLACEHOLDERS` to `EXISTING`). No decision widened the fence.
- Decision 0d881e4c: pace is the amount needed per month to hit the by-date (option A), derived, not stored.
- Review: 15 mutations, 14 killed, 1 equivalent; 3 low findings fixed in 1ff2c3b. Security-auditor: no critical.
- Gate after 1ff2c3b: tsc 0, lint 0, vitest 92 files / 3541 tests.
- Follow-ups and watch items: #174, #236 (counts stale), `urlencoded`/`text` route tests, goals test file speed.
- Process note: reviewer and test-guard overlapped on one working tree; test-guard re-ran from an export.
