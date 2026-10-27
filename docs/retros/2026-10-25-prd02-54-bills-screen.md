# Retro: #54 prd02 w4, the Bills screen (bills for the chosen scope, Mark paid, add and edit)

## Retro summary (for the PR body)

#54 replaced the Bills stub with a real screen: summary tiles, the bills list for the chosen scope, Mark paid, and an add/edit form, all reading and writing through the bills routes from #49. Nothing wrong reached main, and the gate is green on the final tree (`tsc` 0, lint 0, vitest 98 files / 3579 tests). The plan missed three things that a read of the repo shows: the route-table test still expected Bills to be a stub (red gate, fence widened by one filter term), the edit form needs the bill's account but `BillResponse` carries none (filed as #287), and the shared test helpers keep getting copied instead of lifted (`call` is now copy 3, `installFetch` copy 3). The reviewer found a real bug (Mark paid fired twice on a fast double click), brand-checker and test-guard each added a small fix commit. One process slip is mine: I ran test-guard, which edits files, in parallel with the reviewer, so the reviewer read a moving tree; I re-ran the gate on a quiet tree afterwards and it was green.

Gear 3 as stamped; no shift reported to me. The implementer ran on opus (gear 3 in the CLAUDE.md model table). This retro states no telemetry (model, duration, tokens, tool calls); the lane posts the four narratives after `baseline finish`.

Seats run, in order: researcher, architect (plan), implementer (build), reviewer (on the working diff), brand-checker, test-guard, docs-syncer (no doc falsified, no edits), this retro. Every seat the gear 3 table lists ran, plus brand-checker because the diff is UI. Baseline did not record the docs-syncer step: the SubagentStop hook said the transcript "was still being written" and the last message carried `stop_reason tool_use` (the known hand-back bug). I cannot tell from the record whether another seat was dropped the same way, and nothing was hand-stated to fill it.

Commits (`git log --oneline origin/main..HEAD`): f6b3ca8 (route-table test, committed first), 74e8171 (build), 1579307 (review fixes), 692f120 (brand and test-guard fixes), then this retro. The diff against the merge base (`git diff origin/main...HEAD`) is 18 files, +2905 / -7, most of it tests: `Bills.test.tsx` 898 lines, `billsApi.test.ts` 344, `fields.test.ts` 165, `fixtures.ts` 145.

## What was built

- **Kind of code:** a client screen (`client/screens/Bills/`: summary tiles, list, row, add/edit form), a client API module (`client/apis/bills.ts`), a field-parsing module (`fields.ts`), and a mutation hook (`useBillActions.ts`).
- **Pattern:** the bills routes are the only source of money. The client formats route fields and does no arithmetic, and `noMoneyArithmetic.test.ts` scans the directory for sums and rounding, the same tripwire as Subscriptions. Scope comes from the shared scope context and is part of the query key. Writes go through one hook with one shared mutation key, and Mark paid is held while any write on that key is pending.
- **Why in `client/screens/`:** unlike #230, the screen sits where the Shell style guard's roots reach, so no guard copy was needed.

## What happened

- **Plan:** the researcher and architect ran first. The architect's plan file did not exist when I told the implementer it did; I wrote it immediately after and sent a message. Cost: one correction message, no rework.
- **Red gate on the first build (item 1 below).** `routes.test.tsx` still expected Bills to be a stub. I committed the test fix first as f6b3ca8, widening the stub filter by one term (`'bills'`), so the old-behaviour test is shown separately from the build. The commit message records the widened fence.
- **Overview broke on an eager reference.** `Overview.test.tsx` strictly mocks `settings.ts`. Bills used `queryFn: grabSettingsAccounts` (a bare reference), which evaluates the import at module load and broke that test. The fix was a lazy `() => grabSettingsAccounts()`. Found by the gate, fixed in the build.
- **Review (1579307).** The reviewer, on the working diff, found that Mark paid fired twice on a fast double click, so a bill could be paid twice. Fixed with a `client.isMutating({ mutationKey: BILL_WRITES })` guard in `useBillActions.ts` on the shared key. It also found the edit refetch untested; a test was added.
- **brand-checker and test-guard (692f120).** Bills-local borderless inputs per handoff update 2, right-aligned amounts at wide widths, and a shorter tax-pot caption (brand). Empty edit sends no PATCH, and id encoding are now tested (test-guard).
- **Screenshots** at 390, 1040 and 1600 px with invented data through Playwright route mocks: 0 px horizontal overflow at all three. The first run used the wrong Chromium path and had to be redone.
- **Edit cannot choose an account (item 3).** `BillResponse` has no `accountId`, so the form can only offer "Keep current (name)" for the account. Filed as #287.
- **Duplication filed, not fixed.** `call` (the request helper) is now copy 3 (comment on #249), the `installFetch` fixture copy 3, the no-money-arithmetic tripwire copy 2, the `Field` wrapper copy 2 (comment on #267). Settings inputs still carry the pre-update-2 border and an undefined `rounded-button` token; #249 covers them.

## What went wrong

1. **The fence did not include the test that pins the list of stubs (Missed-by: plan).** `client/screens/__tests__/routes.test.tsx` filters built screens out of its "every stub says it is not built" loop by key. A screen that replaces a stub must add its key. #230 made the same edit and its retro called it "small and expected; the route table is meant to take them", but it did not become a fence item, so this issue's fence still did not name it. Cost: a red gate on the first build, one test file outside the fence, one extra commit. No wrong code.
2. **A conductor ordering mistake: file-mutating seat in parallel with the reviewer (my miss, process).** test-guard edits tests, and I ran it at the same time as the reviewer. The reviewer read a tree that changed under it. The pipeline already says review first, then test-guard; I did not follow it. Cost: a gate re-run on a quiet tree (green) and some doubt about which tree the review findings describe. The findings still matched the code as committed, but I cannot show that for every one.
3. **The edit form needs data the response does not carry (Missed-by: plan).** The plan did not compare the add/edit form's fields with `BillResponse`. The form cannot show or change the account of an existing bill. Cost: a degraded edit ("Keep current (name)") and #287. The fix belongs to the bills route (#49), which this issue could not touch.
4. **A double-click paid a bill twice (Missed-by: do, caught by review).** The record does not show why the first build allowed the second click through; the fix was a `client.isMutating` guard on the shared mutation key. Cost: one review-fix commit. The same shape (a rule around the action that the happy-path test does not exercise) appears in the #230 retro: the pending hold on four actions.
5. **Two tests-only gaps found after the build (Missed-by: do, caught by review and test-guard).** The edit refetch, empty edit sending no PATCH, and id encoding had no test. Cost: small additions in 1579307 and 692f120.
6. **Eager `queryFn` reference broke another screen's strict mock (Missed-by: do, caught by verify).** Cost: a gate run and a one-line fix.
7. **Helper copies keep growing (Missed-by: plan, partly).** `call` copy 3, `installFetch` copy 3, tripwire copy 2, `Field` copy 2. Each lane's fence forbids editing the original, so each copies. Cost: more to delete in #249 and #267. Not a bug, but the size of that work rises each lane.
8. **Tooling slips, small.** A shell `cat > file` with no heredoc hung on stdin; I killed it and redid it. The first Playwright run used the wrong Chromium path. Each cost a few minutes.
9. **The Baseline hand-back bug dropped the docs-syncer step.** The seat ran and found nothing stale; the record does not show it. Known bug, not caused by the diff.

## Root causes

- **Plan covers the code that changes, not the code that pins it (items 1 and 3).** Same name as the #25, #39, #46, #67, #45 and #230 retros. Item 1 is a test that pins which screens are stubs. Item 3 is the same slip one step over: the plan did not check the form against the response model it reads. Both are one `rg` or one read of `models/` away. I have not recounted earlier retros, so I do not give an ordinal.
- **Author's list versus the reach of the code (items 4 and 5).** Same name as #230 items 3 and 4. The first test pass covered the actions and not the rule around them (double click, empty edit, id encoding). The reviewer and test-guard found them. I did not see a single cause beyond that.
- **No shared home for test helpers (item 7).** The helpers have no lifted version a lane may import, and each fence forbids creating one. This is a slicing choice, not a one-off: three lanes in a row made the same trade.
- **Conductor did not follow a written order (item 2).** The rule exists (review, then test-guard). Nothing in the dispatch made the ordering a checked step. That is a decision of mine, not a tool failure; I do not have a recorded reason for it.
- **Items 6 and 8:** no deeper cause visible in the record. Item 8's Chromium path matches the earlier "bundled browser missing" problem in #230.
- **Item 9:** the hand-back bug named in the SubagentStop message; not this lane's.

## What worked, keep it

- **The old-behaviour test went in as its own first commit.** f6b3ca8 shows the stub test fixed before the build, so the build commit has no unexplained test edit.
- **The reviewer on the working diff found a real money bug** (a bill paid twice) before commit.
- **A guard test enforces "no client arithmetic".** Same pattern as Subscriptions, now copy 2; it is cheap to carry and fails loudly.
- **Review fixes and brand/test-guard fixes as separate commits** (1579307, 692f120): the second reader sees only the response.
- **Screenshots at three widths with invented data and a measured overflow (0 px).** A number, not "looks fine".
- **Duplication was commented on its owning issues (#249, #267), not lifted in this diff.** Scope held.
- **Re-running the gate on a quiet tree after my ordering slip,** instead of trusting a run made while files were changing.

## Surfaced, not absorbed

- **#287** (Housekeeping): `BillResponse` has no `accountId`, so edit cannot choose or show the account. `Spawned-by: #54`, `Missed-by: plan`.
- **#249** (comment): `call` copy 3, `installFetch` copy 3; Settings inputs still use the pre-update-2 border and an undefined `rounded-button` token.
- **#267** (comment): `Field` wrapper copy 2.
- **Remaining stubs.** By the filter's own list, five screens still go through the stub loop (budgets, habits, advisor, sync, privacy); each will hit item 1 unless the fence names the filter.

## Recommended changes

1. **Screens that replace a stub: the stub filter in `client/screens/__tests__/routes.test.tsx` is part of the fence.** It happened in #230 (called "expected") and here (red gate). Five stubs remain, so five more lanes will meet it. Two ways: (a) add the file to the fence template for screen issues; (b) make the test detect a built screen by what it renders (no "not built yet" text) so no key list needs editing, as the test's own header comment ("a later screen replaces only its own directory") says it should. (b) removes the problem; (a) is the cheap stopgap. Artifacts: the slicing step in `~/.claude/agents/architect.md` for (a), then `pnpm import-workflow --name current`; `client/screens/__tests__/routes.test.tsx` for (b), as a Housekeeping issue. High leverage.
2. **Form versus response check in the plan.** Do not encode yet; first occurrence. If a second form screen (Budgets, Goals, Habits) finds a field its response does not carry, add a line to the architect step: list each editable field and the response field that fills it. Artifact if it recurs: `~/.claude/agents/architect.md`.
3. **Lift the shared test helpers before the next screen lane.** The count (`call` 3, `installFetch` 3, tripwire 2, `Field` 2) is past waiting. Concretely: make #249 and #267 one lane that lifts `call`, `installFetch`, the arithmetic tripwire and `Field` to one importable place, and make the next screen's fence import from it. Artifact: the issue bodies of #249 and #267, then `docs/testing.md` for where the helpers live.
4. **Screenshots: second occurrence, so encode.** #230 hit a missing bundled browser; this lane hit the wrong Chromium path. Commit the working shot script (browser path, viewports 390/1040/1600, hide dev overlays, measure `scrollWidth`) in `scripts/` and point `docs/testing.md` at it. Artifact: a script in `scripts/` plus one line in `docs/testing.md`. Medium leverage.
5. **File-mutating seats run after the reviewer, serially.** Do not encode a new rule; the order is already written in `~/.claude/CLAUDE.md` pipeline step 5. If it happens again, add "test-guard and test-writer edit files; never in parallel with the reviewer" to the `parallel-agents` skill. Artifact if it recurs: that skill's SKILL.md.
6. **Do not encode:** the `cat > file` hang and the plan-file-before-write message (one-offs); the Baseline hand-back bug is already known.

## Highest-leverage next step

Do recommendation 1: stop the stub list from needing an edit per screen. Cheapest is to put `client/screens/__tests__/routes.test.tsx` into the fence of every remaining screen issue now; the durable fix is to change that test so a built screen does not need its key added. Five screens remain, and each would otherwise trip the same red gate.

## Open items for the PR body

- Fence widened by one term: `'bills'` in the stub filter of `client/screens/__tests__/routes.test.tsx` (f6b3ca8, committed first).
- Follow-up #287 (`Spawned-by: #54`, `Missed-by: plan`, Housekeeping): `BillResponse` has no `accountId`; edit shows "Keep current (name)".
- Duplication comments on #249 and #267; nothing lifted in this diff.
- Baseline did not record the docs-syncer step (SubagentStop "transcript was still being written"); nothing was hand-stated.
- test-guard ran in parallel with the reviewer; the gate was re-run on a quiet tree and is green.
- Screenshots at 390, 1040 and 1600 px, invented data, 0 px horizontal overflow.
- Gate: `npx tsc --noEmit` exit 0, `npm run lint` exit 0, `npx vitest run` 98 files / 3579 tests passed.

## Baseline narratives

These four are the text for the retro POST (`narrative_code_type`, `narrative_built`, `narrative_how`, `narrative_wrong`).

### narrative_code_type

A React screen with a client API module: the Bills screen (summary tiles, bills list, Mark paid, add and edit form) reading and writing through the existing bills routes. Gear 3.

### narrative_built

The Bills screen shows the chosen scope's bills with summary tiles, marks a bill paid once, and adds or edits a bill. The server is the only source of money; the client formats route fields and a guard test forbids arithmetic. It adds a client API module, a field-parsing module and a mutation hook with a shared mutation key, and replaces the Bills stub. Gate: 98 files, 3579 tests.

### narrative_how

Researcher, architect, then the implementer on opus. The first commit fixed the route-table test that still expected a Bills stub. The reviewer on the working diff found that Mark paid fired twice on a fast double click, fixed with a pending-mutation guard, and an untested edit refetch. brand-checker and test-guard added borderless fields, right-aligned amounts, a shorter caption, and tests for empty edit and id encoding. docs-syncer found nothing stale. Screenshots at three widths, 0 px overflow.

### narrative_wrong

The plan missed that the route-table test pins which screens are stubs (red gate, fence widened by one term) and that the bill response has no account id, so edit cannot choose an account (#287, Missed-by: plan). The first build let a double click pay a bill twice; review caught it. An eager query function broke another screen's strict mock. Shared test helpers were copied again (`call` and `installFetch` are copy 3). I ran test-guard in parallel with the reviewer, so the review read a moving tree; the gate was re-run clean. Baseline missed the docs-syncer step because of the known hand-back bug.
