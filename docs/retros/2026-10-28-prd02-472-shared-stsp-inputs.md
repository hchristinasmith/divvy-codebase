# Retro: #472, safe-to-spend input gathering moves into shared/

Gear 3, no shift. Implementer ran on opus/high. This file states no telemetry; the conductor posts the narratives to Baseline after `baseline finish`.

Seats run: implementer, reviewer, test-guard, this retro. Verify passed on the final state, after a clean rebase onto a moved main: 184 files, 6722 tests. I did not re-run it. Commits: 5fb06a6 (regression test), a06be82 (build), 437b760 (review fixes). Split from #80 by Hannah's Baseline decision 9509592c.

## What was built

- **Kind of code:** a pure function module, `shared/safe-to-spend-inputs.ts` (`gatherSafeToSpendInputs`, `safeToSpendWindowStart`, `drawingIdsFromCandidates`, `SafeToSpendInputError`), with 38 tests.
- **Pattern:** the server loads rows and hands them to the shared function. `overview.ts` calls it; `drawings.ts` gains `loadDrawingCandidates` and keeps `loadDrawingIds`' signature. No behaviour change. `mcp/` (#473) can now use the same function without importing `server/**`.

## What went wrong

1. **A setting-parse test gap survived the implementer's mutation check (Missed-by: do, caught by review).** Mutating the `WHOLE_NUMBER` regex to allow decimals broke no test. `'5.0'`, `'1e3'` and `' 5'` all pass `Number.isSafeInteger(Number(v))`, so the tests could not tell the regex from the number check. Fixed with 3 cases in 437b760.
2. **Two small behaviour differences from main (accepted, in the PR body).** Found by the reviewer, who ran main's and the new `overview.ts` on 27 scenarios. 26 matched.
   - `safeToSpendWindowStart` now runs `addDaysIso` before the null-balance check. With `now=0000-01-01T00:30Z`, payday 6 and a null-balance account, the error text differs ('safe-to-spend input invalid' vs 'an account has no balance'). Routes never pass `now`, so this cannot happen in production.
   - All rows now load first, so a failing DB query wins over an earlier data error.
3. **One unconfirmed flake.** The first full run had 1 failure in 6650 that was not captured. The rerun was green. Cause unknown.
4. **`guard()` now exists in 4 places** (`overview.ts`, `bills.ts`, `goals.ts`, the new shared file). `bills.ts` was left alone because of #425, an open question for Hannah.
5. **main moved mid-lane.** #335 and #371 rewrote `shared/nz-dates.ts` and `shared/safe-to-spend.ts`. The rebase was clean and the gate passed after it. Cost: one rebase, no rework.

## Root causes

- **Mutation check aimed at logic, not at the shape of the input check (item 1).** The implementer mutated behaviour branches. A regex and a numeric check that overlap were not tested against each other. Unclear whether this recurs, so no rule yet.
- **Refactor order changed an error path (item 2).** Moving the window computation ahead of a validation was a side effect of making the function pure. The 27-scenario comparison caught it, not the tests.
- **Flake: unknown.** The failing test was not captured, so there is no cause to name.
- **Copy of `guard()` (item 4).** The fence kept `bills.ts` out of scope, and a shared home for `guard()` doesn't exist yet.

## What worked, keep it

- **Regression test first (5fb06a6).** It covered the one uncovered branch, the window query's start edge. The implementer checked it fails under last-2 and last+0.
- **Reviewer's side-by-side run of main against the new code on 27 scenarios.** This is better evidence of "no behaviour change" than a green gate, and it found the one real difference.
- **Reviewer mutation check.** It found the regex gap that authoring missed.
- **Test-guard:** covered and gated, nothing above a suggestion.
- **Staying small:** the Hannah decision split kept this to a pure move.

## Recommended changes

1. **Housekeeping issue: lift `guard()` into one shared helper** and switch the 4 copies over: #479. It is blocked on the #425 answer for `bills.ts`.
2. **Find the flake if it shows again.** Capture the failing test name from the full run's output. Don't encode anything on one unconfirmed failure.
3. **No workflow change on first occurrence.** The retro README rule (write on first occurrence, change a runbook on the second) applies to items 1 to 3.

## Highest-leverage next step

For any "no behaviour change" refactor, have the reviewer keep running the old and new code side by side on a scenario list. This is already in use. If a second refactor lane shows it catching something the gate missed, write it into the reviewer agent's instructions in the Baseline workflow.

## Open items for the PR body

- Gear 3, no shift.
- The error-text difference and DB-query-order difference above, accepted.
- `guard()` duplication and the #425 question for `bills.ts`.
- One unconfirmed flake in the first full run.
