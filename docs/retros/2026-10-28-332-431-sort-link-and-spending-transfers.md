# Retro: #332 + #431 (bundled lane), the Sort link on the phone and spending that leaves out own-account transfers

#332 gear 1 (haiku implementer). #431 sliced gear 2, shifted 2 → 3: a new export, `transferLegIdsInView` in `shared/spending.ts`, so a second caller could reuse it. Commits: `c2feb50` (#332), `9df17f1` (#431). No telemetry is stated here.

## What was built

- **#332:** `MoreLinks.tsx` lists Sort; the Overview test pins the full link list; the `nav.ts` comment and the `App.test.tsx` describe name were updated.
- **#431:** spending by category leaves out own-account transfers by reusing `findOwnTransfers` from `shared/habits.ts` (the #52 pair match). `server/db/spending.ts` now reads inflows and widens its stored-date range by `TRANSFER_WINDOW_DAYS`; `routes/spending.ts` takes `parseScope` from `server/http.ts`. The transaction list uses the same exclusion function as the bar.

## Retro summary

Shipped. Gate: tsc 0, lint 0, vitest 156 files / 6138 tests. Biggest issue: #431 was sliced before #433 existed, so it did not know a second caller of `countsAsSpending` was coming. Biggest strength: the reviewer's executed mutation pass found boundary gaps the implementer's tests missed.

## What went wrong

1. **The issue did not know about the second caller (planning gap).** The conductor reported mid-lane that #433 (Spending screen) was about to merge and had added `listSpendingTransactions` in `server/db/transactions.ts`, a second caller of `countsAsSpending`. Without a change, the list and the bar would have disagreed on transfers. Cost: the lane had the in-flight implementer export the exclusion as one function, waited for #433, merged origin/main, and ran a second implementer to wire the list.
2. **A merge conflict on `App.test.tsx`.** The one-line rename from #332 collided with #433. Avoided without stash: set the rename aside, merged, reapplied.
3. **Four boundary mutants survived the implementer's tests:** both JS window lines in `transferLegIdsInView` and both SQL range bounds. The implementer's mutation evidence for the first #431 pass was REASONED; only the reviewer's was EXECUTED. A new shared test and a strengthened db test killed all four.
4. **Other reviewer findings:** the `nav.ts` comment omitted Subscriptions (the implementer saw the gap and left it as out of scope); the Personal → Strawb scope split was untested. All fixed; no code changed.
5. **Board and network:** neither issue was on Project #3, so the lane added both before moving them to In progress. `gh` had two transient network timeouts.

Noted, unchanged: the bar now refuses on a broken inflow row within 2 days of the month; the list reads all in-scope history.

## Root causes

- **Slicing predates the code it depends on (item 1).** #431 was written before #433, and nothing at dispatch compared the two. The conductor caught it by hand, mid-lane.
- **Reasoned, not executed, mutation evidence (item 3).** The first pass claimed boundary coverage without running mutants, so off-by-one window bounds went unseen until review.

## What worked, keep it

- The conductor's mid-lane heads-up, and the lane's response: one exclusion function, so bar and list cannot disagree.
- Avoiding stash on the conflict, as the project rule requires.
- The reviewer's executed mutation pass.
- The implementer flagging the Subscriptions gap itself, even though it stayed out of scope.

## Recommended changes

1. **At dispatch, when an open PR touches a function the issue changes, name that PR in the handoff.** First occurrence, so not encoded yet; if it recurs, add the line to the lane handoff template.
2. Not encoding the REASONED-vs-EXECUTED mutation gap: one occurrence, and the reviewer already catches it.

## Highest-leverage next step

If another issue is sliced ahead of a PR that adds a caller to the same function, add a "callers in open PRs" check to the handoff template. Until then, no change.
