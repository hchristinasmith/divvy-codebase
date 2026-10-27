# Retro: #57 prd02 w4, the Habits screen (runway, computable streaks, worth-it verdicts)

## Retro summary (for the PR body)

#57 replaced the Habits stub with a real screen reading the habits route from #52: Runway, Streaks, "Worth it?" with verdict pills (PUT and clear), a Patterns card with an empty state and a `children` mount point for prd-04, and a Truth report card pointing to Claude desktop. There is no Freedom date. Gate green on the final tree: 153/153 files, 6067/6067 tests. One red gate on the first build (the route-table stub test), one review finding (a weak test), no wrong code reached the diff.

Gear 3 as stamped; no shift. Implementer on opus. No telemetry is stated here; the lane posts the narratives after `baseline finish`.

Seats run: implementer, reviewer (mutation-tested 7 behaviours, 6 caught), brand-checker (on-brand), test-guard (covered), docs-syncer (no doc falsified), this retro.

Commits: d55471a (route-table test, first), 57a7067 (build: `client/apis/habits.ts`, `client/screens/Habits/**`, 79 Habits tests), fcc4182 (review fix).

## What was built

- **Kind of code:** a client screen plus a client API module.
- **Pattern:** the route is the only source of money; the client formats and does no arithmetic, guarded by a `noMoneyArithmetic` tripwire test. Verdicts are written with PUT and cleared through the same pill. The Patterns card exposes `children` so prd-04 can mount into it without editing the screen.

## What went wrong

1. **The route-table test pins the stub list again (Missed-by: plan).** `routes.test.tsx` still expected Habits to be a stub, so the first build's gate was red on one out-of-fence test. The implementer surfaced it instead of absorbing it. The lane widened the fence by one filter term (`'habits'`) and committed it first as d55471a, following Bills #288. Cost: one red gate, one commit. Same cause as the #54 retro, item 1.
2. **The no-Freedom-date test was too weak (Missed-by: do, caught by review).** It matched only the word "freedom", so a "Projected date" card would have passed. Fixed in fcc4182 by pinning the exact list of regions. A REASONED gap remains: fake date text inside a real card is not caught.
3. **The handoff named the wrong issue (Missed-by: none of the seats).** It said `gh issue view 53` for #57; 53 is Budgets. The lane read 57 from the start and Hannah corrected the handoff mid-run. Cost: none that the record shows.
4. **Helper copies grow again.** `call` is copy 7 (#249), `installFetch` copy 6 (#249/#267), the `noMoneyArithmetic` tripwire copy 3 with no lift issue.
5. **Not done:** screenshots at 1040 and 390 px were not taken; that is Hannah's human check.

## Root causes

- **Plan covers the code that changes, not the code that pins it (item 1).** Same name as the #54, #230 and earlier retros. This is now at least the third screen to hit it. The `routes.test.tsx` edit is predictable and still not a fence item in the handoff.
- **Test asserts a word, not the behaviour (item 2).** Same family as "author's list versus the reach of the code" in #54: the first test pass proved the happy case and not that it would fail on the wrong thing. Mutation testing in review is what exposed it.
- **No shared home for test helpers (item 4).** Same as #54: each fence forbids lifting, so each lane copies. The tripwire has no lift issue at all.
- **Item 3:** a typo in the handoff; no deeper cause in the record.

## What worked, keep it

- **The implementer surfaced the out-of-fence test** instead of editing it quietly, and the lane widened the fence in a visible, separate first commit.
- **Reviewer mutation testing** (7 behaviours, 6 caught) found the weak test with a concrete counter-example, not an opinion.
- **Review fix as its own commit,** so the second reader sees only the response.
- **The `children` mount point** means prd-04 needs no edit to this screen.
- **Mid-run correction was cheap** because the lane had read the real issue number.

## Recommended changes

1. **Add `client/screens/__tests__/routes.test.tsx` (stub-filter term) to the standard fence for any screen-replaces-stub issue.** Put it in the issue slicing template or handoff so the red gate does not recur. High leverage; third occurrence, so now worth encoding. Artifact: the handoff/issue template the conductor uses for w4 screen issues.
2. **File a lift issue for the `noMoneyArithmetic` tripwire,** and add it to #249's scope with `call` and `installFetch`. Optional; the helper copy count is the cost.
3. **Reviewer checklist line:** for "must not show X" tests, mutate by adding a near-miss (a differently named card) and confirm the test fails. Optional.

## Highest-leverage next step

Put the `routes.test.tsx` stub-filter term into the w4 screen issue template as a named fence item, so the next screen (Overview, Settings leftovers) does not start with a red gate.
