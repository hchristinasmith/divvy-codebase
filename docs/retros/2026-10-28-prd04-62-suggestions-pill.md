# Retro: #62 prd04 w3, the Overview shows a suggestions pill with accept and reject (client hook, pill component, tests)

Gear 3 as stamped; no shift. The implementer ran on opus at effort high. Fence: `client/components/Insights/**` plus a two-line mount in `client/screens/Overview/ActivityCard.tsx` (import and mount only). `server/**` and `client/apis/` were fenced out. This file states no telemetry (model, duration, tokens, tool calls); the conductor posts the four narratives to Baseline after `baseline finish`.

Seats run: implementer (build), reviewer, test-guard, brand-checker, this retro. Verify passed on the final state: tsc 0, lint 0, vitest 163 files / 6240 tests passed. I did not re-run it for this retro.

Commit: c5746fd (build and review fixes together, 4 files, +519). The review fixes were not split out because the test file was new and untracked, so there was no earlier commit to separate them from.

## What was built

- **Kind of code:** a React hook (`useProposals.ts`), a pill component (`SuggestionsPill.tsx`) and its test file, in `client/components/Insights/`. No server change, no migration.
- **Pattern:** a TanStack Query hook over the proposals route, with a pill on the Overview activity card that shows the pending count and accepts or rejects a proposal. A ref guard stops a double tap from sending twice. The route returns no merchant or amount, so the pill looks them up from the card's own rows and falls back to "Transaction #id".
- **Why this shape:** the fence barred `server/**`, so the lookup on the client was the only way to show a merchant at all.

## What happened

- **Implementer** built the hook, pill and tests and mounted the pill in two lines.
- **Reviewer:** 0 source defects.
- **Test-guard** found two test gaps: markup was only tested inside `reason`, and there was no 1 to 0 pill test (pill disappears when the last proposal is handled). The reviewer confirmed each by mutation (M5 and M6 stayed green before) and added 2 tests, 9 to 11.
- **Test-guard's REASONED claim** that the double-tap test could not tell the ref guard from its absence was wrong. The reviewer's EXECUTED mutation, removing only the ref, turns the test red. This was run twice.
- **Brand-checker:** on-brand, no violations.

## What went wrong

1. **The slice listed merchant and amount without checking the route carried them (Missed-by: plan).** The proposals route returns neither. With `server/**` fenced out, the pill has to look them up from the card's rows and shows "Transaction #id" when the row is not there. Cost: a weaker pill than the issue described, and follow-up #439. Cause: the issue was sliced from the design, not from the route's response shape.
2. **Ninth copy of the `call` fetch helper (Missed-by: none).** `client/apis/` was fenced out, so the hook carries its own copy. Counted and surfaced as follow-up #438, not lifted.
3. **Two test gaps got past the author (Missed-by: do).** Markup was only tested in `reason`, and the 1 to 0 case had no test. Test-guard found them and the reviewer's mutations proved the tests were blind (M5, M6 green). No bad code shipped; the gate alone would not have caught either.
4. **A REASONED claim from test-guard was false.** Cost: a double-check by mutation, run twice. Without it, a correct test could have been rewritten or a guard judged untested.
5. **Pill ignores scope.** The route is unscoped, so the pill shows proposals for both personal and strawb. Noted, not acted on.

## Root causes

- **Slicing from the design instead of the route (item 1).** Issue text named fields the endpoint does not return, and nobody opened the route before fencing the server out. Fence and data need were checked separately.
- **Fetch helper copied per module (item 2).** Same cause as the copy 7 in #53: the helper lives nowhere shared and each fenced lane copies it.
- **Items 3 and 4:** unclear beyond the test being written alongside the code; the record shows no deeper cause.

## What worked, keep it

- **Surfacing the route gap instead of editing `server/**`.** The fallback keeps the pill honest and the gap became #439.
- **Mutation to settle a disagreement.** Reviewer's EXECUTED mutation beat test-guard's REASONED claim, both ways: it proved the two gaps and refuted the ref-guard claim.
- **Two-line mount.** The shared card changed by import and mount only, which keeps the diff easy to read.
- **Copy counts reported, not lifted.**

## Surfaced, not absorbed

- **#439** (Missed-by: plan): the proposals route returns no merchant or amount.
- **#438**: the 9th copy of the `call` fetch helper; needs `client/apis/`.
- **Pill ignores scope**, because the route is unscoped. No issue filed; mention in the PR.

## Recommended changes

1. **Before fencing out `server/**`, open the route and list the fields it returns against the fields the issue shows.** First occurrence in this form, so write it down but do not encode yet; if a second slice lists fields its route lacks, add the check to the slicing template. The template's path is not shown in the record.
2. **Do not encode the fetch helper.** It is already tracked (#438, earlier copy counts); the fix is the shared module, not a rule.
3. **Review fixes in the build commit** is a one-off: the test file was untracked. If it recurs, commit the build's tests first.

## Highest-leverage next step

Lift the fetch helper into one shared module under `client/apis/` (#438). Nine copies is the longest-running recurring cost in the record, and every fenced lane adds another.

## Open items for the PR body

- Gear 3 as stamped; no shift. Fence held.
- Reviewer: 0 source defects; 2 test gaps found by test-guard, confirmed by mutation, 2 tests added (9 to 11).
- Pill shows "Transaction #id" when the card has no matching row (#439). Pill ignores scope.
- `call` helper copy 9 (#438).
- Gate: tsc 0, lint 0, vitest 163 files / 6240 tests passed.

## Baseline narratives

### narrative_code_type

A React hook and pill component with a test file, in `client/components/Insights/`, mounted in the Overview activity card. No server change and no migration; gear 3.

### narrative_built

The Overview shows a suggestions pill with accept and reject for pending category proposals. `useProposals.ts` wraps the proposals route, and a ref guard stops a double tap from sending twice. The route returns no merchant or amount, so the pill reads them from the card's rows and falls back to "Transaction #id". The card changed by two lines. 4 files, +519; 163 test files and 6240 tests at the end.

### narrative_how

The implementer on opus at effort high built the hook, pill and tests inside a fence that barred `server/**` and `client/apis/`. The reviewer found 0 source defects. Test-guard found two test gaps, and the reviewer confirmed each by mutation and added 2 tests (9 to 11). Test-guard's claim that the double-tap test could not tell the ref guard was refuted by removing only the ref, which turns it red, run twice. Brand-checker found no violations. Review fixes went in the build commit because the test file was untracked.

### narrative_wrong

The slice listed merchant and amount without checking that the proposals route returns them; it does not, so the pill falls back to "Transaction #id" (follow-up #439, Missed-by: plan). The `call` fetch helper is copied a ninth time because `client/apis/` was fenced out (#438). Two test gaps, markup outside `reason` and the 1 to 0 pill case, got past the author and were caught only by test-guard and mutation. The pill also ignores scope because the route is unscoped; noted, not acted on.
