# Retro: #271 prd02, the Overview "Spending by category" card (shared aggregate, spending route, card)

## Retro summary (for the PR body)

#271 adds a "Spending by category" card to the Overview: a segmented bar and a list of the top five categories, then Other, then Uncategorised, for a month and a scope. The sums are made in `shared/spending.ts` (a pure aggregate), loaded by `server/db/spending.ts` and served by `GET /api/v1/spending/categories`; the card computes nothing and sizes each segment by `flexGrow: cents`. Only Drawings are left out of spending today. The own-account transfer rule is open on #52 (Baseline decision 0a37d21b), so the card's totals are overstated until it rules: card repayments and pot moves count as spending. That is deliberate and is held behind one seam, `countsAsSpending`. The final gate is green (tsc 0, lint 0, vitest 113 files / 4192 tests). The costs worth fixing: the reviewer's in-place fixes landed before the first build commit, so "review fixes separate from the build" did not hold for that seat (fourth retro to say so); test-guard still found 3 survivors after the implementer's pass; and the lane added three more copies of helpers that #236 has been meant to lift for a week.

Gear stamped 3, shifted 3 → 4 (adds an API route; new exports). The PR body carries that line. Implementer on opus (the CLAUDE.md table, gears 3 and 4). This file states no telemetry (model, duration, tokens, tool calls); the lane posts the four narratives after `baseline finish`.

Seats, in order: researcher, architect (plan posted on draft PR #289 before any build), implementer (build), reviewer (6 findings), security-auditor, implementer (brand fixes), brand-checker, implementer (test gaps), test-guard, docs-syncer, this retro. Every seat the gear 4 table lists ran, plus brand-checker because the diff is UI. Verify passed on the final state: tsc 0, lint 0, vitest 113 files / 4192 tests.

Commits (`git log --oneline origin/main..HEAD`): aa5cbf6 (draft PR for the plan), 5c3b423 (build, with the reviewer's fixes inside it), 2cb4c99 (prd-02 Ruling 1 note), 401269e (brand-checker fixes), 39170c6 (test-guard gaps). The diff is 17 files, +2451 / -4. About 1700 of those lines are tests; production code is `shared/spending.ts` (178), `server/db/spending.ts` (212), `server/routes/spending.ts` (96), `SpendingCard.tsx` (190) and a 38-line contract block.

## What was built

- **Kind of code:** a pure aggregate (`spendingByCategory`, `isYearMonth`, and the seam `countsAsSpending`) in `shared/`; a db loader; one read-only route; contract types; and an Overview card. One line mounts the route and a note under prd-02 Ruling 1 records where the sum is made.
- **Pattern:** the same server-computes, client-displays shape as the Overview. The loader takes Akahu rows on known accounts, lays Drawings over the effective category, picks the NZ month with a coarse SQL prefilter and an exact `nzCalendarDate` re-check, and refuses null dates and null amounts. The route returns the top N, Other and Uncategorised already ranked, so the card only maps rows to segments.
- **Why this shape:** the architect kept the sum in `shared/` rather than in the card because prd-02 Ruling 1 says money is computed once on the server. The route exists so #272 (the `/spending` screen) can reuse it. The own-account transfer rule is a predicate in one place so #52's ruling lands in one edit.

## What happened

- **Researcher, then architect.** The architect's plan went on draft PR #289 before any build, so the build started from a written plan. The researcher found no design reference for a spending card or a storage-style bar in handoff update 2, so the colours and the placement were presentation calls, made by the implementer and corrected by brand-checker.
- **Build (5c3b423).** One commit. The reviewer ran on the uncommitted working tree and fixed three findings in place, so the build commit contains them: the money-arithmetic guard could pass on lowercase `cents` and `+=`; rows with a null amount were silently dropped and are now refused, as the Overview does; and the card showed an outline when "Try again" had focus.
- **Reviewer's three reported findings.** Filed as follow-ups: #293 (an empty-string category) and #294 (malformed dates outside the window). The third, a category edit's "Saving…" now waiting for the spending refetch, is the accepted cost of the overview-prefix query key and was not filed.
- **Security-auditor.** No critical or warning findings. The Host check is already tracked as #174.
- **Brand-checker (401269e).** A doubled focus outline; rank 4 and Uncategorised colours near-identical, so Uncategorised moved to ink; off-scale `p-5.5` and `gap-0.5`; `BAR_TRACK` reused; `shrink-0` on amounts.
- **test-guard (39170c6).** About 55 of 58 mutants killed. The 3 survivors were closed with 4 tests: generic 500 text, a 0-cent row in a new category, an uncategorised-only month, and `top=05`.
- **docs-syncer.** Nothing stale. It flagged that the #52 citation could not be verified from GitHub; I confirmed it in Baseline: decision 0a37d21b is on issue 52, still open, "How should the Habits runway tell a transfer between your own accounts apart from real spending?".

## What went wrong

1. **Review fixes are inside the build commit (Missed-by: plan; fourth time).** The pipeline wants the reviewer on the working diff before commit; the commit table wants review fixes separate from the build. For this seat those two cannot both hold unless the build is committed first. The brand and test-guard fixes ran after the build commit and got their own commits; the reviewer's did not. Cost: the second reader of 5c3b423 cannot see what the reviewer changed, and three real findings (including a guard that could pass on a pattern miss) are invisible in the history.
2. **Survivors after the implementer's pass (Missed-by: do).** About 55 of 58 mutants were killed and 3 survived, in a status text, a 0-cent row and an uncategorised-only month. The reviewer had already found two more cases of the same kind (the arithmetic guard on lowercase `cents`, null amounts dropped). The survivors are all inputs the author did not picture. Cost: one test commit and one extra implementer dispatch.
3. **A default `fetch` that did not answer the new endpoint hung 23 Overview tests (Missed-by: plan).** `invalidateOverview` awaits every query under the overview prefix. The card's key sits under that prefix on purpose, so a category edit refreshes the card. A default `installFetch` that did not answer spending left those queries pending forever and 23 tests timed out. The fix is small (the default now answers spending). The lasting price is a real behaviour: a category edit's "Saving…" now waits for the spending refetch as well. I do not know from the record whether the plan named that price; the hang showed up when the tests ran.
4. **The issue's wording and the screen disagreed (Missed-by: plan).** The issue said scope `personal|strawb`; the Overview defaults to All. The route accepts `all` as well. Small, but it meant the contract was not what the issue stated, and the PR must say so.
5. **A `#271` in a screen-file comment tripped the hex-colour guard (`#[0-9a-f]{3,8}`).** Screen files write "issue 271" instead. Cost: one failed run and a rewrite of a comment. No cause beyond a guard that reads issue numbers as colours.
6. **Totals are overstated until #52 rules (known, not a miss).** Card repayments and pot moves count as spending today. This is deliberate; the card does not decide it. It is listed here so a reader of the card does not mistake it for a bug.
7. **More copies of helpers the fence forbids lifting (Missed-by: plan).** After this lane: `parseScope` 5 copies, `errorClass` 10, the ARITHMETIC patterns 2. #50's retro counted `errorClass` at 6. The lift is tracked by #236 and has not landed.
8. **No design reference for the card.** Handoff update 2 has none, so the card's colours, placement and bar style came from the implementer's judgement. Brand-checker then found five things. Cost: one fix commit. Not a mistake by any seat; it is a gap in the handoff.
9. **The fence overridden by the handoff.** The issue's fence said the route belongs to another lane; the handoff overrode it (one route that #272 reuses). That is correct, and it was named.

## Root causes

- **`review-before-commit-mixes-diffs` (item 1).** Same name as #139/#153, #140/#141 and #144/#158/#160; #46 avoided it by committing first. The cause is the rule order, not the seat: pipeline step 5 puts review before commit, the commit table puts review fixes after. It has now cost four lanes, and each retro has recommended the same fix. It has not landed because it has no owner, and it is not in the lane handoff text.
- **Author's list versus the reach of the code (items 2 and 1's guard finding).** Same name as #264, #229, #46 and #39. The survivors and the reviewer's guard finding are inputs the author did not picture: a lowercase variable, a null amount, a month with only one kind of row. `docs/testing.md` still has no list of the branch kinds a mutation pass must cover; #264's retro asked for it.
- **A shared hook with a wide reach (item 3).** `invalidateOverview` awaits everything under a prefix, and a new query joined that prefix. Name: **new member of an awaited prefix**. First occurrence under this name. The plan covered the code that changes (the card) and not the code that pins it (the default fetch in the Overview tests); this is also the "plan covers the code that changes, not the code that pins it" cause from #45, #25, #39, #46 and #67.
- **Helpers copied under a fence (item 7).** Same name as #49 and #50: **recommendation with no owner**. #236 was written before bills, goals and spending existed, and its list is stale again.
- **Items 4, 5, 8:** an issue written before the Overview's All default was settled; a guard pattern that reads issue numbers as colours; a handoff with no spending card in it. No deeper cause I can point at.

## What worked, keep it

- **The plan on a draft PR before the build (aa5cbf6, #289).** The reviewer and the implementer argued from a written plan, and the PR shows what was decided before code existed.
- **The seam.** `countsAsSpending` is one predicate with the open #52 question written beside it, so the decision does not touch the aggregate, the loader or the card. #295 is the next step: lift the same outflow rule into one predicate shared with `budgetSpentCents`.
- **The client computes nothing.** The route returns top N, Other and Uncategorised, and the card sizes segments by `flexGrow: cents`. So there is no arithmetic in the card to get wrong.
- **Refusing bad rows instead of dropping them.** Null dates and null amounts are refused like the Overview, so the total cannot be quietly short. The reviewer found the silent drop, and it is now consistent.
- **Fixed-text 400 and 500, class-only logging.** Tested (the generic 500 text is now pinned), and no money data reaches a log line.
- **Separate commits for brand fixes and test gaps.** The second reader saw only the response each time.
- **Tracking the unverifiable citation back to Baseline.** docs-syncer flagged #52 as unverifiable from GitHub and the check in Baseline confirmed it.

## Surfaced, not absorbed

Filed:

- **#293:** an empty-string category is not treated as uncategorised.
- **#294:** malformed dates outside the window are not caught.
- **#295:** lift the outflow rule into one predicate shared with `budgetSpentCents`.
- **#236 (existing):** its list is stale; counts are now `parseScope` 5, `errorClass` 10, ARITHMETIC patterns 2.

Left alone and named:

- Own-account transfers count as spending until #52 rules; the seam is `countsAsSpending`.
- The card links to `/spending`, which #272 builds; the link is dead until then.
- The Host check is #174.
- `Missed-by` lines as filed: #293 `plan`, #294 `none`, #295 `none`.

## Recommended changes

1. **Commit the build before any review seat is dispatched, in the lane handoff text.** Add one line to `CLAUDE.md` under "Worktrees and lanes": "Commit the build before dispatching the reviewer; the reviewer edits on top of it and its fixes are their own commit." Why: this is the fourth lane to lose the separation, and the cause is the rule order, so it needs a rule, not another reminder. Leverage: high, and one line. File: `CLAUDE.md` (project). This is past the first occurrence, so encode it now.
2. **Put the branch kinds a mutation pass must cover into `docs/testing.md`.** Same list as #264's recommendation 1 (every null or NaN filter on a loaded row, every `catch` that maps an error, every range guard, and every guard that is tested by pattern, with the lowercase and operator variants). Why: item 2 and the reviewer's guard finding are the same family again. Leverage: high. File: `docs/testing.md`. Not yet landed.
3. **Update #236 and sequence it ahead of the next route lane.** Counts to write: `parseScope` 5, `errorClass` 10, ARITHMETIC patterns 2. Why: a copy count that grows by 1 to 4 each lane is a debt with interest, and the fence rule means no lane can pay it. Leverage: medium. Artifact: the issue body of #236 and the order of the board.
4. **Write the awaited-prefix fact next to `invalidateOverview`.** One comment: "awaits every query under the overview prefix; a new query under it needs an answer in the default `installFetch`". Why: item 3 cost 23 hung tests. Leverage: optional. File: `client/apis/queryKeys.ts` or `client/apis/overview.ts`. First occurrence of this cause, so hold it; encode only if a second query joins the prefix and hangs a test.
5. **Do not encode** the `#271` guard collision (item 5) or the missing design reference (item 8). Single occurrences with no cost beyond minutes.

## Highest-leverage next step

Do Recommendation 1: add the line "commit the build before dispatching the reviewer" to the "Worktrees and lanes" section of the project `CLAUDE.md`. Four retros have named this cause and recommended the same change, and none has an owner. One line in the file every lane reads removes a recurring cost for nothing.

## Open items for the PR body

- Gear: shifted 3 → 4 (adds an API route; new exports). Fence: the issue said the route belongs to another lane; the handoff overrode it (one route that #272 reuses).
- Scope: the issue said `personal|strawb`; the route also accepts `all`, because the Overview defaults to All.
- Totals are overstated until #52 (decision 0a37d21b, open) rules on own-account transfers. Only Drawings are excluded today. `countsAsSpending` is the seam.
- The review fixes are inside the build commit 5c3b423; the brand and test-guard fixes are separate commits.
- Follow-ups: #293, #294, #295; #236 counts are stale.
- A category edit's "Saving…" now waits for the spending refetch, because the card's key is under the overview prefix on purpose.
- Gate: tsc 0, lint 0, vitest 113 files / 4192 tests.

## Baseline narratives

These four are the text for the retro POST (`narrative_code_type`, `narrative_built`, `narrative_how`, `narrative_wrong`).

### narrative_code_type

A pure aggregate in `shared/`, a db loader, one read-only route and an Overview card. The route is new, so the gear shifted 3 to 4. #272 (the spending screen) will reuse the route.

### narrative_built

A "Spending by category" card on the Overview: top five categories, Other and Uncategorised for a month and a scope (all, personal or strawb), served by `GET /api/v1/spending/categories`. The server ranks and sums in `shared/spending.ts`, and the card sizes segments by cents and computes nothing. Drawings are excluded; the own-account transfer rule is open on #52, so totals are overstated until it rules, held behind one predicate. Gate: tsc and lint clean, vitest 113 files / 4192 tests.

### narrative_how

Researcher, then an architect whose plan went on draft PR #289 before any build. The implementer on opus built in one commit; the reviewer ran on the uncommitted tree and its three fixes went into that commit. Security-auditor found nothing, brand-checker's fixes and test-guard's gaps each got their own commit, and docs-syncer found nothing stale. test-guard killed about 55 of 58 mutants and four tests closed the three survivors.

### narrative_wrong

The reviewer's fixes landed before the first build commit, so the build commit mixes both; this is the fourth lane with that cause. The implementer's mutation pass still left three survivors, and the reviewer had found two cases of the same kind (a guard that passed on lowercase `cents`, null amounts dropped silently). The default fetch in the Overview tests did not answer the new endpoint, which hung 23 tests because `invalidateOverview` awaits every query under its prefix, and a category edit's "Saving…" now waits for the spending refetch. There was no design reference for the card, so brand-checker found five presentation fixes, and three more copies of lift-pending helpers were added (#236).
