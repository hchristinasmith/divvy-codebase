# Retro: #438, one fetch helper in client/apis/http.ts replaces the copies of `call`

Stamped gear 1, shifted 1 to 3: the lift adds new exported symbols (`request`, `call`), which trips the 3-or-higher row. The implementer reported the shift. Implementer ran on haiku. This file states no telemetry; the conductor posts the narratives to Baseline after `baseline finish`.

Seats run: implementer, reviewer, this retro. Verify passed on the final state: tsc 0, lint 0, vitest 168 files / 6368 tests. I did not re-run it. Commits: 3b25507 (lift), ab2a17b (tests).

## What was built

- **Kind of code:** a shared module (`client/apis/http.ts`) exporting `request` and `call`, plus its test file. Nine api modules and `useProposals.ts` now import it. 10 files, +54 -265.
- **Pattern:** one fetch wrapper with a guard that turns a non-JSON 200 into a fixed message (#324), and a 204 path.
- **Why this shape:** two variants existed, with and without the guard. The conductor gave every caller the guard rather than keep two helpers. It is a behaviour change, stated in the commit.

## What happened

- The implementer lifted the copies in one pass. The gate was green first time (tsc 0, lint 0, 167 files / 6361 tests).
- The reviewer found that the four newly guarded callers (goals, categorise, habits, useProposals) had no non-JSON-200 test. It added `http.test.ts` (7 tests) and mutation-checked each. It caught one of its own assertions (`bodyUsed === false` on a 204) that could never fail, and removed it.

## What went wrong

1. **The issue's copy count was wrong both ways (Missed-by: plan).** It listed `settings.ts`, which uses superagent `send` and is not a copy (#249 owns it). It missed `habits.ts`, a tenth copy. Cost: the implementer had to find the real set itself.
2. **A behaviour change inside a gear-1 "lift" (Missed-by: plan).** The issue did not say the variants differed, so the choice came up mid-work. It went to the conductor and was recorded, which is the right route. It was not in the slice.
3. **The green gate did not cover the changed behaviour (Missed-by: do).** Four callers gained the guard with no test. Tsc, lint and the existing suite all passed. Only the reviewer found the gap.
4. **One vacuous assertion** (`bodyUsed === false`) was written and then removed by the reviewer. No cost beyond that.

## Root causes

- **Fetch helper copied per module.** Same cause as #62 and #53. #62's fence barred `client/apis/` edits, so each lane copied rather than lifted. The copy comments chained ("a copy of X, itself a copy of Y"), so nothing in the code pointed to a single source. The count was then taken from a list in an issue and not from the code.
- **Issue list built by hand, not by search.** Items 1 and 2 both come from this. Whether a grep was run when the issue was filed is not in the record.
- **Item 4:** unclear beyond the assertion being written without a mutation.

## What worked, keep it

- **The conductor made the one-helper call.** One helper is simpler, and the guard now applies everywhere.
- **Stating the behaviour change in the commit message.**
- **The reviewer's mutation check.** It found the untested path and removed an assertion that could never fail.
- **The implementer reported its own gear shift** instead of absorbing it.

## Recommended changes

1. **Before filing a "lift N copies" issue, derive the list from the code.** One grep for the copied function's signature. This is the first occurrence of an inaccurate list, so write it down and do not encode it. If a second consolidation issue miscounts, add the grep to the slicing template. I did not see the template's path.
2. **No rule for the chained copy-comments.** The lift removes them. The fix was the shared module.
3. **Do not encode the vacuous-assertion catch.** One occurrence, and the reviewer already caught it.

## Highest-leverage next step

Merge #438 so new api modules import `client/apis/http.ts`. A lane adding a tenth copy is now a review finding.

## Open items for the PR body

- Gear 1 shifted to 3: new exported symbols.
- Behaviour change: goals, categorise, habits and useProposals now refuse a non-JSON 200 with the #324 message.
- `settings.ts` untouched (#249). `habits.ts` was a copy the issue missed.
- Gate: tsc 0, lint 0, vitest 168 files / 6368 tests.

## Baseline narratives

### narrative_code_type

A shared fetch helper module (`client/apis/http.ts`, exporting `request` and `call`) with a test file, used by nine api modules and `useProposals.ts`. Gear 1 shifted to 3 for the new exports.

### narrative_built

One fetch helper replaces nine copies of `call` (plus `request` in bills and budgets). All callers now refuse a non-JSON 200 with the fixed #324 message. 10 files, +54 -265, plus `http.test.ts` with 7 tests. Gate at the end: tsc 0, lint 0, 168 files / 6368 tests.

### narrative_how

The implementer (haiku) did the lift in one pass and the gate was green first time. Two variants existed, one with the non-JSON guard and one without. The conductor gave every caller the guard and stated the behaviour change in the commit. The reviewer found no test for the four newly guarded callers and added 7 tests, mutation-checking each. It also removed one of its own assertions (`bodyUsed === false` on a 204) that could never fail.

### narrative_wrong

The issue's list was wrong both ways. It named `settings.ts`, which uses superagent `send` and belongs to #249, and it missed `habits.ts`, a tenth copy. The variants differing was not in the slice, so a behaviour change turned up inside a gear-1 lift. The green gate did not cover the four newly guarded callers; only the reviewer found that. The copies spread because #62's fence barred `client/apis/`, and the copy comments chained, with no single source named.
