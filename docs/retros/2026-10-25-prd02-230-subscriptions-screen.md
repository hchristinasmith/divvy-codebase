# Retro: #230 prd02 w4, the Subscriptions screen (regular charges, totals, "Is this a subscription?", cancel)

Gear 3 as stamped; no shift. Seats run: researcher, architect, implementer (opus, build, one commit), reviewer (6 findings, 2 fixed in one commit), brand-checker (12 mismatches, all applied in one commit), test-guard, test-writer (7 tests, one commit), docs-syncer, this retro. Every seat the gear 3 table lists ran, plus brand-checker because the diff is UI. Verify passed on the final state: 91 files, 3154 tests. This file states no telemetry (model, duration, tokens, tool calls); the lane posts the four narratives after `baseline finish`.

Commits (`git log --oneline origin/main..HEAD`): e9d0bcc (build), a24aaa2 (review fixes), 2ba84e8 (brand fixes), e0bea34 (test-guard gaps). The diff is 22 files, +2143 / -5, most of it tests (`Subscriptions.test.tsx` 877 lines, `subscriptions.test.ts` 251, `fixtures.ts` 157).

## What was built

- **Kind of code:** a client screen (`client/components/Subscriptions/`: summary tiles, regular-charges list, questions card, not-subscriptions card, advisor banner), a client API module (`client/apis/subscriptions.ts`), one route-table entry, one sidebar icon, and a local copy of the style guard.
- **Pattern:** the server's subscriptions routes are the only source of money. The client formats route fields with `formatCents` and does no arithmetic; a guard test scans the directory for sums, rounding and cents operators. Scope comes from the shared scope context and is the query key, and mutations go through `useSubscriptionActions`.
- **Why a plain `claude://` link in the advisor banner:** importing from Advisor would couple this screen to #60. "Mark any merchant" is limited to what the route returns (#237). Both were constraints from the issue, not choices.

## What happened

- **Fence put the screen in the wrong directory for its guards.** The fence named `client/components/Subscriptions/`, not `client/screens/`. The Shell `noHardcodedStyle` guard's roots do not reach it and this issue could not edit that guard. The build added a local copy (`client/components/Subscriptions/__tests__/noHardcodedStyle.test.ts`, which says in its header that the follow-up deletes it) and, with it, more copies of house-shape helpers: `call` copy 3, `formatDay` copy 2, styles copy 2/3, `installFetch` copy 2. Filed as #267 ("move to client/screens and lift the helpers #230 copied").
- **One route-table entry, three pinned-list tests.** `client/screens/routes.tsx` gained one entry; `routes.test.tsx`, `ShellSidebar.test.tsx` and `nav.test.tsx` each pin the list of screens and went from eight to nine. These edits were small and expected; the route table is meant to take them.
- **Stale comments outside the fence.** `MoreLinks` and `nav.ts` still describe Subscriptions as unbuilt. They are outside the fence and were left; filed as #266.
- **Review found 6 things; 2 were fixed in a24aaa2.** The totals test could not catch the client computing the year: the year fixture was exactly 12 times the month, so a client doing `month * 12` passed. The route-table comment was stale (it said every screen replaces a stub; this one has none). The record I was given does not say what became of the other four findings.
- **brand-checker had 12 mismatches against handoff update 2** (row and tile spacing, dividers, pill buttons). All were applied in 2ba84e8.
- **test-guard ran 52 mutations; 44 killed, 8 survived.** Three were real holes, one minor:
  1. A row that is both detected and marked had no test.
  2. `key={scope}` on the list drops a refused write's alert on a scope switch, and nothing pinned that.
  3. Unmark, Yes, No and Undo were not tested as held while a request is pending.
  4. Minor: a cancelled row must carry no monthly figure ("counts as" text).

  test-writer added 7 tests in e0bea34. Each went red on its mutation, and I re-ran the `key={scope}` one myself. The record does not break down the other four survivors.
- **Screenshots.** Playwright's bundled browser was missing, so shots used a cached headless shell. The first shots showed the TanStack devtools button and the phone tab bar sitting mid-page; both were fixed in the shot script, not the screen. Hannah looked at them on 2026-10-25: "looks good".
- **Tooling:** `gh issue view --comments` printed nothing; `--json` worked. Cost: one retry.
- **Dropped per Hannah:** usage chips and the "Barely used" tile.

## What went wrong

1. **The fence chose a directory the shared guards do not cover (Missed-by: plan).** The issue fixed the path; nobody checked what already watches `client/screens/` and does not watch `client/components/<Name>/`. Cost: one copied guard, four more helper copies (#267), and a follow-up to move the screen. The plan seat is the one that could see it; the fence was written before any code existed.
2. **Stale comments outside the fence (Missed-by: plan).** A screen going from "unbuilt" to "built" falsifies comments in the nav code; one `rg subscriptions` over the repo finds them. Cost: #266, low.
3. **A totals test that could not fail (Missed-by: do, caught by review).** The year fixture was exactly 12 times the month, so the client could compute it and pass. This is the design rule (prd-02 Ruling 1, the server computes) with a test that did not enforce it. Cost: one review-fix commit.
4. **Three behaviours with no test, found only by mutation (Missed-by: do, caught by test-guard).** The detected+marked row, the scope key dropping a refused write, and the pending hold on four actions. The first test pass covered the happy path of each action and not the rule around it. Cost: one commit of 131 lines of tests. The two review findings and the three test-guard holes are the same shape: the tests agreed with the author's picture of the code.
5. **A stale route-table comment (Missed-by: do, caught by review).** The build added an entry and left the comment above it describing the old rule. Cost: three lines in the review-fix commit.
6. **Screenshot setup (tooling, not code).** Missing browser plus two overlays that are not the app. Cost: a few minutes and one script fix.

## Root causes

- **Plan covers the code that changes, not the code that pins it (items 1 and 2).** Same name as #25, #39, #46, #67 and #45. Here it shows up in a new way: the fence is a path, and the guards and comments that watch neighbouring paths are not in it. The fence was set from where the screen goes, not from what already guards where screens go. I have not re-read every earlier retro to count occurrences.
- **Author's list versus the reach of the code (items 3 and 4).** Same name as #45 item 3, #46 item 4 and #39 item 2. The implementer's fixtures and cases came from the same picture of the code as the code; a 12-times fixture is one a client-side `* 12` agrees with. Only a seat that mutates the code (test-guard) or reads it cold (the reviewer) shows it.
- **Item 5:** unclear. The record shows the stale comment and its fix, not why the build left it.
- **Item 6:** the sandbox had no bundled Playwright browser, and the script did not hide the dev overlays. No deeper cause is visible.

## What worked, keep it

- **Server owns the money, and a guard test enforces it.** The `ARITHMETIC` patterns in the local guard, plus the totals test once it was tightened, make "no client arithmetic" a failing test rather than a review comment.
- **Mutation testing on a screen that already had 877 lines of tests.** 8 of 52 survived; three were real. Coverage numbers would not have shown any of them. test-writer's tests each went red on their mutation, and I re-ran one myself rather than taking the report.
- **Review fixes, brand fixes and test gaps as separate commits.** Four commits, each with one reason; the second reader saw only the response.
- **The local guard copy was honest about itself.** Its header says why it exists and what deletes it, and #267 carries that deletion. A copy with a named exit is cheaper than an edit outside the fence.
- **Constraints held:** no import from Advisor (#60), "mark any merchant" limited to the route (#237), usage chips and "Barely used" dropped as Hannah said.
- **Hannah's visual check on the real screenshots** before the PR, not after.

## Surfaced, not absorbed

- **#267** move the screen to `client/screens/`, lift the helpers `#230` copied (`call`, `formatDay`, styles, `installFetch`), delete the local guard and add the directory to the Shell guard's roots. `Spawned-by: #230`, `Missed-by: plan`.
- **#266** stale comments in `MoreLinks` and `nav.ts` that still call Subscriptions unbuilt. `Spawned-by: #230`, `Missed-by: plan`.
- Priority lines and milestones on both are the filer's; I did not re-read them.

## Recommended changes

1. **Fixture rule for derived figures: no fixture value may equal what a client-side recompute would give.** For every total the server returns (year, per-day, shortfall), the test fixture must make the recompute differ from the server's number, for example a year that is not 12 times the month. This is the fourth retro naming "tests that could not fail" (#39, #46, #45, #230), so it is past the point of waiting. File: `~/.claude/agents/implementer.md` and `~/.claude/agents/test-writer.md`, one line each. High leverage.
2. **Run test-guard on the first test pass, not only after review.** The three real holes were found last and cost a fourth commit. Do not encode: one occurrence of that ordering. If the next screen's test-guard also finds the rule-around-the-action holes (pending hold, scope key), move it before review in `~/.claude/agents/test-guard.md`'s dispatch note.
3. **Architect step: when the fence places code in a directory, list the guards whose roots cover the sibling directories and say whether this one is covered.** This is the existing "plan covers the code that pins it" family, now with a second shape. Check `~/.claude/agents/architect.md` for the earlier recommendation (from #46 and #45) before adding a line; if it is there as a literal step, this occurrence says the step does not reach guards, only tests and stubs. High leverage if #45's recommendation already landed.
4. **Screenshots: hide dev overlays and phone-size the viewport in the shot script.** Do not encode; first occurrence, small cost. If a second lane hits it, put the script flags in `docs/testing.md`.
5. **Deleting the local guard and the helper copies is #267's job, not a rule.** No change to a skill.

## Highest-leverage next step

Add the fixture rule (recommendation 1) as a literal line in `~/.claude/agents/implementer.md` and `~/.claude/agents/test-writer.md`: "for each figure the server returns that a client could compute, choose fixture values so the recompute differs from the server's figure, and say which assertion would fail under the recompute". Then `pnpm import-workflow --name current`. It would have caught the review's totals finding in the build, and the same miss is in at least three earlier retros.

## Open items for the PR body

- Gear 3, no shift. One route-table entry and one icon added; three pinned-list tests changed from eight to nine screens.
- Follow-ups: #267 (move to `client/screens/`, lift copied helpers; `Missed-by: plan`), #266 (stale comments in `MoreLinks` and `nav.ts`; `Missed-by: plan`).
- Local copy of the Shell style guard in `client/components/Subscriptions/__tests__/`; #267 deletes it.
- Dropped per Hannah: usage chips, the "Barely used" tile. "Mark any merchant" limited to the route (#237).
- Hannah checked the screenshots: "looks good" (2026-10-25).
- Gate: 91 files, 3154 tests green.

## Baseline narratives

These four are the text for the retro POST (`narrative_code_type`, `narrative_built`, `narrative_how`, `narrative_wrong`).

### narrative_code_type

A React screen with a client API module: the Subscriptions screen (tiles, regular charges, "Is this a subscription?", cancel) reading the server's subscriptions routes. Gear 3.

### narrative_built

The Subscriptions screen shows the chosen scope's regular charges, totals, a questions card and a not-subscriptions card, and lets the user mark, unmark and cancel. The server is the only source of money; the client formats route fields and a guard test forbids arithmetic. It adds one route-table entry and one icon, plus a local copy of the style guard. Gate: 91 files, 3154 tests.

### narrative_how

Researcher, architect, then the implementer on opus in one build commit. The reviewer found 6 things and 2 were fixed. brand-checker found 12 mismatches against handoff update 2, all applied. test-guard ran 52 mutations, 44 killed, and test-writer added 7 tests for the real survivors, each red on its mutation. Hannah checked the screenshots.

### narrative_wrong

The fence put the screen outside the directory the shared style guard covers, so a guard copy and four more helper copies were added (#267, plan missed it); stale nav comments sit outside the fence (#266). The totals test used a year fixture of exactly 12 times the month, so client arithmetic passed it; review caught it. Mutation testing then found three behaviours with no test: the detected+marked row, the scope key dropping a refused write, and the pending hold on four actions. Screenshots needed a cached browser and two overlays removed.
