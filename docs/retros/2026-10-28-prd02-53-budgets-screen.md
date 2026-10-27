# Retro: #53 prd02 w4, the Budgets screen shows budgets for the chosen scope and edits them (client screen, budgets API module, step and create/delete writes)

Gear 3 as stamped; no shift. The implementer ran on opus at effort high. The architect was skipped: the handoff said to keep the lane small and the Bills and Goals screens were the plan. Fence: `client/screens/Budgets/**` and `client/apis/budgets.ts`, widened by one filter term in `client/screens/__tests__/routes.test.tsx` (see item 1). This file states no telemetry (model, duration, tokens, tool calls); the conductor posts the four narratives to Baseline after `baseline finish`.

Seats run: implementer (build), reviewer, implementer (review fix), brand-checker, test-guard, this retro. Verify passed on the final state: tsc 0, lint 0, vitest 151 files / 5893 tests passed. I did not re-run it for this retro.

Commits (`git log --oneline main..HEAD`): 4534652 (route table test, made by the conductor), 6cb7f10 (build, 14 files, +2036 / -4), 72c0d04 (review fix, 2 files, +25).

## What was built

- **Kind of code:** a React screen (`client/screens/Budgets/`), a typed API module (`client/apis/budgets.ts`) and its test suite. No server change, no migration.
- **Pattern:** a display-only client over the budgets route, copied from Bills and Goals. Each card's left, amber or over status comes from the route's `overCents`; the client does no money arithmetic, and a tripwire test scans the screen source for arithmetic and allow-lists two named helpers. A plus or minus $10 step sends a PATCH with a $10 floor. Create and delete are on the screen. The subtitle's days-left comes from the overview's `daysToPayday`. Loading, empty and error states are all drawn.
- **Why this shape:** no real alternative; the Bills and Goals screens were the template.

## What happened

- **Implementer** built the screen, the API module and the tests, and stopped at the stub route test rather than editing it (item 1).
- **Reviewer:** 0 defects, 8 of 8 mutations caught, 3 judgement calls. One was taken as review fix 72c0d04: a refused delete now re-reads the list, so the card does not stay on screen after the server said no. Two were left for the PR: same-category cards cannot be told apart in the All view, and a step error lingers after a later success.
- **Brand-checker:** pass, checking tokens and type roles only.
- **Test-guard** reported `Budgets.test.tsx` flaky: 4 failures, then 1. This was a false alarm (item 2).
- **Copy counts flagged:** the request, call and send fetch helper is now copy 7 across `client/apis/*`, and the `installFetch` fixture is copy 6. Both need a file outside the fence to lift.

## What went wrong

1. **The shared stub test is outside every screen issue's fence (Missed-by: plan).** Replacing the Budgets stub broke `routes.test.tsx`, which still expected `/budgets` to be a stub. Bills hit the same break in #288 and made the same one-term edit. The implementer stopped and surfaced it instead of absorbing it, which was right. The conductor made the edit as its own commit (4534652). Cost: one stop and one hand-off for a known, one-term edit. Cause: each w4 screen issue was sliced with a fence that leaves out the one shared test that replacing a stub always breaks.
2. **A concurrent mutating reviewer made test-guard report a flaky test (Missed-by: none).** The reviewer ran its mutation tests on the same working tree while test-guard ran the suite. The two tests that failed were exactly the ones the reviewer's mutations M5 (subtitle) and M8 (step error) break; the first run showed 4 failures and the next 1 as mutations were reverted. Three full runs with nothing else running gave 5892 of 5892 each. Cost: a flaky-test report that had to be disproved by re-running three times. No bad code was committed. This is the same cause as the #56 retro, "Two mutating seats on one working tree"; here the second party was test-guard, as in #50.
3. **Two reviewer judgement calls shipped unfixed.** Same-category cards cannot be told apart in All, and a step error lingers after a later success. Both are left for the PR and are not defects the gate can see. Cause: unclear; the record does not show whether the plan considered the All view.

## Root causes

- **A mutating seat shared a working tree with another seat (item 2).** Third occurrence of this cause (#50, #56, now #53). The #56 retro already recommended encoding the scratch-copy rule and the recommendation did not land before this lane ran; the record does not show whether it was imported. Check `~/.claude/agents/reviewer.md` before dispatching again.
- **A shared test sits outside every screen fence (item 1).** Second occurrence, Bills (#288) then Budgets. It is a slicing gap, not an implementer miss.
- **Item 3 has no shown cause.**

## What worked, keep it

- **Stopping at the fence.** The implementer surfaced the stub test instead of editing it, and the conductor's own commit kept the change reviewable.
- **Copying the Bills and Goals patterns instead of re-planning.** Skipping the architect cost nothing visible: the reviewer found 0 defects.
- **The reviewer's mutation run.** 8 of 8 caught means the tests fail when the behaviour breaks.
- **The arithmetic tripwire with a short named allow-list.** The screen stays display-only and the exceptions are visible.
- **Review fix in its own commit (72c0d04).** The second reader sees only the response.
- **Re-running three times quietly before believing a flaky report.** It separated a real flake from interference.
- **Copy counts reported, not lifted.** Helpers outside the fence were flagged for another lane.

## Surfaced, not absorbed

- **Copy 7** of the request, call and send fetch helper across `client/apis/*`, and **copy 6** of the `installFetch` fixture. Both need a file outside the fence; counts go to the existing copy-count issue.
- **Left unfixed:** same-category cards indistinguishable in All; a step error lingers after a later success.
- I did not read any follow-up issue bodies, so no `Spawned-by` or `Priority:` lines are restated here.

## Recommended changes

1. **Add `client/screens/__tests__/routes.test.tsx` to the fence of each remaining w4 screen issue.** Second occurrence (Bills, Budgets), so encode now. Artifact: the slicing template or the issue bodies for the remaining w4 screens; the exact file for the template is not shown in the record, so the conductor should name it. High leverage, mechanical.
2. **Do not run a mutating reviewer and test-guard on the same tree at once; break in a scratch copy.** Third occurrence. The #56 retro's recommendation 2 already covers it. Paths: `~/.claude/agents/reviewer.md`, `~/.claude/agents/test-guard.md`, `~/.claude/skills/parallel-agents/SKILL.md`; then `pnpm import-workflow --name current`. High leverage.
3. **Do not encode** anything for the two reviewer judgement calls; first occurrence and both are screen-specific.

## Highest-leverage next step

Land the scratch-copy rule from the #56 retro in the reviewer and test-guard agent files and the `parallel-agents` skill, then import it. It has now cost a corrupted commit (#56) and a false flaky report (#53), and the fix has been written down twice.

## Open items for the PR body

- Gear 3 as stamped; no shift. Fence held except one filter term in `client/screens/__tests__/routes.test.tsx`, committed by the conductor (4534652).
- Reviewer: 0 defects, 8 of 8 mutations caught; two judgement calls left (All-view duplicates, lingering step error).
- Test-guard's flaky report was interference from the concurrent reviewer; three quiet runs gave 5892 of 5892.
- Copy 7 (fetch helper) and copy 6 (`installFetch`) flagged.
- Gate: tsc 0, lint 0, vitest 151 files / 5893 tests passed.

## Baseline narratives

### narrative_code_type

A React screen with a typed client API module and its test suite, in `client/screens/Budgets/` and `client/apis/budgets.ts`. No server change and no migration; gear 3.

### narrative_built

The Budgets screen shows budget cards for the chosen scope with left, amber or over status taken from the route's `overCents`, a plus or minus $10 step with a $10 floor, create and delete, and a subtitle with days left from the overview's `daysToPayday`. It has loading, empty and error states, and a tripwire test that keeps money arithmetic out of the screen apart from two named helpers. 14 files in the build commit; 151 test files and 5893 tests at the end.

### narrative_how

The implementer on opus at effort high copied the Bills and Goals patterns with no architect, and stopped at the stub route test, which the conductor fixed as its own commit. The reviewer found 0 defects and caught 8 of 8 mutations; its one judgement call taken as a fix made a refused delete re-read the list (72c0d04). Brand-checker passed on tokens and type roles. Fetch-helper copy 7 and `installFetch` copy 6 were flagged, not lifted.

### narrative_wrong

The stub route test sat outside the fence, as it did for Bills in #288, because screen issues omit it; the implementer stopped, and the conductor made the one-term edit. Test-guard reported `Budgets.test.tsx` flaky with 4 failures then 1, but the reviewer was running mutations on the same tree, and the failures were exactly the tests its mutations M5 and M8 break; three quiet runs gave 5892 of 5892. The cause is a mutating seat sharing a working tree with another seat, now seen in #50, #56 and #53.
