# Retro: #44, the overview route (GET /api/v1/overview?scope= and POST /api/v1/overview/alerts/:id/dismiss)

## Retro summary (for the PR body)

#44 replaced the 501 placeholder with the real overview: safe-to-spend with its budget lines, account cards, recent activity, a `dataAsOf` time and derived alerts, per scope, plus a dismiss route for alerts. Nothing wrong reached main. The lane's cost was not in the build. It was that the lane's own tests were weaker than they looked, four separate times, and a second seat had to show it each time: three mutation survivors for the reviewer, one tie-break test for test-guard that could not go red even after the lane specified an example for it. The fixtures agreed with the bug. That is the one cause worth changing something for.

The researcher's up-front list of sharp edges (see below) is why none of the data-shape traps (timestamp versus date, unstored accounts, string settings) became a late rewrite. That part worked and should be kept as is.

Gear 4 as stamped; no shift. The implementer ran on opus per the CLAUDE.md model table. This retro states no telemetry (model, duration, tokens, tool calls); the lane posts the four narratives after `baseline finish`.

Seats run, in order: researcher, architect (resumed once with a conductor ruling), implementer (3 build commits, resumed once for a review fix), reviewer and security-auditor in parallel, test-guard (fix applied by the implementer), docs-syncer, this retro. `schema-reviewer` does not apply (no migration).

Verify passed on the final state: `npx tsc --noEmit` exit 0, `npm run lint` exit 0, `npx vitest run` 64 files / 1841 tests passed, after the last commit (b30505d).

Commits (`git log --oneline origin/main..HEAD`): c564bfd (bill occurrences, NZ dates, the data error), d922481 (`readOverview` and `dismissAlert`), 0f2bae5 (the route), 99f20f2 (review fixes), b30505d (test-guard fix). The three-dot diff (`git diff origin/main...HEAD --stat`) is five files, 3553 insertions and 8 deletions: `server/db/overview.ts` (706), `server/db/__tests__/overview.test.ts` (1490), `server/routes/overview.ts` (118 changed), `server/routes/__tests__/overview.test.ts` (1243), and 4 lines in `server/routes/__tests__/barrel.test.ts`. Tests are about three times the size of the code.

## What was built

- **Kind of code:** two endpoints, a read-and-derive module (`server/db/overview.ts`) and two large test suites. No migration, no write to money state; the dismiss route writes one `alert_dismissals` row.
- **Pattern:** the route reads stored rows, normalises them into the inputs the pure `safeToSpend` already takes, calls it once on the server (prd-02 Ruling 1), and derives alerts from the same rows. Dates are Pacific/Auckland calendar dates (`nzCalendarDate`); repeating bills are expanded into occurrences (`billOccurrencesThrough`, capped at 1000 per bill and refused rather than truncated past it). Bad stored data is an `OverviewDataError` that the route turns into a fixed-text 500; it is never defaulted.
- **Why this shape:** two contested choices. Alert ids carry their week or due date (`over_budget:<id>:<lastPayday>`, `bill_overdue|bill_due_soon:<billId>:<dueDate>`), so a new week is a new alert and scope isolation rides on the row id because `alert_dismissals` has no scope column. And dismiss only accepts an id that is currently derived (404 otherwise), shape-checked before any query.

## What happened

- **Researcher first, and it found the traps before any code.** Findings that shaped the build: `transactions.date` is a full ISO timestamp but `safeToSpend` takes `YYYY-MM-DD` and throws on a timestamp; transactions join accounts through `akahu_id` with no foreign key and may name accounts that are not stored (which would also make `safeToSpend` throw); `alert_dismissals` has no scope column; `settings` has no unique key and holds string values; no code anywhere expanded repeating bills; pending rows store `category` NULL, so pending spend never reaches a budget (filed #221, not absorbed); and the contract comment names the dismiss route `/api/v1/alerts/:id/dismiss` while the barrel was fenced, so it is served at `/api/v1/overview/alerts/:id/dismiss` (filed #220).
- **#151 landed mid-plan.** Hannah ruled that every unpaid occurrence of an overdue repeating bill counts. The conductor relayed it while the architect was planning, and the architect resumed with it. The architect also added a paid occurrence to the weekly fixture, so the test proves the paid one is excluded (96000 against 76000 in the fixture) instead of passing on a fixture with nothing to exclude. The PRD note landed on main separately (05947ce).
- **Implementer found two bugs in the plan's route tests** while writing them. A "Groceries" token was expected to be absent from strawb output but legitimately appears there, because one strawb row uses that category. And a settings id tie was decided by text order (`'s-profit' > 'bad'`), so the good row won by accident. Both were fixed in the test, not the code.
- **Reviewer, 43 mutations, 3 survivors** (fixed in 99f20f2):
  - The `dataAsOf` shape filter: a junk `started_at` makes `julianday()` return NULL, which ranks last anyway, so the test passed with the filter removed.
  - Two window-refusal paths: every fixture made the incomplete row also the newest activity row, so removing either refusal changed nothing the test looked at.
- **Test-guard, one finding** (fixed in b30505d). The alert sort's id tie-break was untested, and it compared ids as text (bill 10 before bill 9). The lane asked for a subject tie-break and gave an example (9 "Water", 10 "Power"). That example could never go red, because the text order of the ids and the order of the subjects agreed. The implementer caught it before committing and swapped the names.
- **Rebase onto #67.** `origin/main` gained #67 mid-lane and the rebase conflicted on `barrel.test.ts` (both lanes edited the PLACEHOLDERS/EXISTING lines). During `git rebase --continue` with `GIT_EDITOR=true`, git dropped the commit message as empty, because the subject starts with `#`, git's comment character. Fixed with `git commit -C <sha>`.
- **Security-auditor:** no blocking finding. Pre-existing issues it found were filed (#223). Dismissal pruning is #224.

## What went wrong

1. **Three mutation survivors in tests the author wrote and believed were done.** Each test passed with the guard it claimed to cover deleted. Cost: one reviewer pass to find them and one implementer round (99f20f2) to fix them. No wrong behaviour shipped.
2. **A lane-specified test example that could not fail.** The lane wrote the tie-break example for the implementer, and it was wrong in the same way as item 1. The implementer saw it; the lane did not. Cost: small, because it was caught before the commit, but it is the same fault coming from the lane, not the implementer.
3. **Two bugs in the plan's own route-test fixtures** (the "Groceries" token, the settings id tie). Caught at the first run by the implementer. Cost: a plan correction, no rework in the code.
4. **One unidentified failure in the first full vitest run, before commit 1.** The implementer did not reproduce it in three more runs; reviewer and test-guard ran about nine more full runs between them and none failed. It was not root-caused. Cost: about twelve extra full-suite runs spent watching for it, and a failure of unknown origin that may still exist.
5. **The rebase dropped a commit message.** Caught and repaired with `-C`. Cost: minutes. It will recur in any lane whose subject starts with `#`, which is every lane here.
6. **Duplication left by the fence.** Copy 2 of `fromThisSite` (#218), copy 2 of the `lastSuccessAt` query and a copied test fixture (#222). Filed, not fixed, because removing them needs files outside the fence.

## Root causes

- **`fixture-agrees-with-the-bug`** (items 1 and 2; also the same fault, reversed, in item 3). In every case the test's data was built from the happy-path shape, so the guarded and unguarded behaviours gave the same answer: junk `started_at` ranks last whether or not it is filtered; the incomplete row is also the newest row; text id order matches subject order; the good settings row wins a tie either way. The author's sense that a test "covers" a guard comes from the guard being visible in the test name, not from the fixture being able to tell the two behaviours apart. The weekly-fixture paid occurrence is the counter-example: the architect built a fixture in which the wrong behaviour gives 96000 and the right one 76000, and that test is not on any survivor list. This is a close relative of `author-blind-spot-on-own-mutants` (named in the prd-02 safe-to-spend retros, still a recurrence here), but narrower and checkable: the blind spot is a fixture property, and it can be asked about before any mutation run.
- **Plan covers the code that changes, not the code that pins or reads it** (item 6, and the route-name mismatch #220). Same family as the #25, #39 and #67 retros. The contract comment names one route path and the fence allowed a different mount, so the shipped path differs from the documented one. Here the researcher caught it before any code, which is the seat working; the slice still did not check it.
- **The first-run failure (item 4): unclear from the record.** No output of the failing run was kept, so there is nothing to name a cause from. I will not guess between a time-dependent test, a shared in-memory database or an order dependence.
- **Item 5 has no cause beyond git's comment-character default plus this repo's `#N:` commit convention.** A tool default and a house convention collide; neither is a decision to blame.

## What worked, keep it

- **Researcher before architect on a gear 4 build.** The list of sharp edges was specific, checkable against the code, and each one became either a design decision or a filed follow-up (#220, #221) rather than a surprise.
- **Out-of-fence findings filed, not absorbed:** #218, #220, #221, #222, #223, #224. The fence held, and the PR can say "not needed, not touched" for each.
- **Reviewer's mutation sweep (43) by a seat that did not write the code.** Again the non-author seat found weaknesses the author's own checking missed (the prd-02 safe-to-spend retros record the same). Keep it required.
- **Test-guard as a separate seat from the reviewer.** It found the tie-break gap, which the reviewer's 43 mutations did not reach.
- **A fixture that includes the thing to exclude** (the paid occurrence, 96000 against 76000). Keep it as the pattern.
- **Refusing instead of defaulting:** a NULL balance on an Akahu account is a fixed-text 500, never a fabricated 0; bad stored settings are a 500; occurrences past the cap are refused, not truncated. These were decided up front, so no test had to retro-fit them.
- **Review fixes in their own commits** (99f20f2, b30505d), so the second reader saw only the response.
- **The conductor relaying Hannah's #151 ruling into a live planning seat** rather than letting the plan finish on the old reading.

## Recommended changes

1. **Add a fixture rule to the assertion rules in `docs/testing.md`: every test for a guard, filter, refusal or tie-break names the one value in its fixture that gives a different answer with the guard removed, and the author removes the guard and sees the test go red before committing.** Why: all three survivors and the lane's bad example fail this one check, and it is a thing the implementer can do with no other seat. Each of the four would have been caught at authoring time. Artifact: `docs/testing.md`, assertion rules. High leverage. This is not the first occurrence of the underlying cause (`author-blind-spot-on-own-mutants`), so it is time to encode it.
2. **Have the lane write tie-break and ordering examples as "A is first under the correct rule and second under the likely-wrong rule", and check that sentence against both rules before sending the example.** Why: the Water/Power example was a one-line check away. Artifact: the dispatch template the lane uses for implementer briefs (the `implementer` handoff section in `~/.claude/agents/implementer.md`, then `pnpm import-workflow --name current`). Optional; fold into recommendation 1 if that lands in `docs/testing.md` and the brief just points at it.
3. **Keep the output of the first red full run.** Run the full suite as `npx vitest run 2>&1 | tee <scratchpad>/vitest-run.txt` (or equivalent), so a once-only failure has a record to name a cause from. Why: item 4 spent about twelve runs and still has no cause, because nothing was kept from the one that failed. Do not encode in a skill yet: one occurrence in this lane, and I cannot show from the record that it is a flaky test and not a one-off environment fault. Revisit if it recurs.
4. **Rebase conflicts: do not finish with `GIT_EDITOR=true git rebase --continue` on a `#N:` subject; use `git commit -C <sha>` for the picked commit and check `git log -1` after.** Why: the subject starting with `#` is stripped as a comment. Artifact: a one-line note in the worktree and rebase guidance in `CLAUDE.md` (Worktrees and lanes). Optional, cheap; the first occurrence was caught, but the convention that triggers it is permanent.
5. **When a contract comment names a route path, the slice checks the barrel's mount list for it.** Same family as the #67 recommendation (the architect's slicing step); no new artifact. I am recording the recurrence (#220), not proposing a second change.

## Highest-leverage next step

Do recommendation 1: add the "name the fixture value that differs when the guard is removed, and see it go red" rule to the assertion rules in `docs/testing.md`. It would have killed all four test-strength findings in this lane at the seat that wrote them, before the reviewer's mutation sweep and test-guard had to find them, and it costs the author one deletion per guard.

## Open items for the PR body

- Route path: the dismiss route is served at `/api/v1/overview/alerts/:id/dismiss`; the contract comment says `/api/v1/alerts/:id/dismiss` (#220).
- Pending spend never reaches a budget because pending rows store `category` NULL (#221).
- Duplication left by the fence: `fromThisSite` copy 2 (#218); `lastSuccessAt` query copy 2 and a copied test fixture (#222).
- Security-auditor's pre-existing findings: #223. Dismissal pruning: #224.
- One unidentified failure in the implementer's first full vitest run; not reproduced in about twelve later runs; not root-caused.
- Gear 4 as stamped; no shift.
- Gate: `npx tsc --noEmit` exit 0, `npm run lint` exit 0, `npx vitest run` 64 files / 1841 tests passed, after b30505d.

## Baseline narratives

These four are the text for the retro POST (`narrative_code_type`, `narrative_built`, `narrative_how`, `narrative_wrong`).

### narrative_code_type

Two Express endpoints and a read-and-derive module over existing SQLite tables, with two large test suites and no migration. Gear 4, imported by the overview screen and the later alert and bill work.

### narrative_built

`GET /api/v1/overview?scope=` returns safe-to-spend (computed once on the server by the existing pure function) with its budget lines, account cards, recent activity, a `dataAsOf` time and derived alerts for one scope. `POST /api/v1/overview/alerts/:id/dismiss` dismisses an alert that is currently derived and returns 404 for any other id. Dates are Pacific/Auckland calendar dates, repeating bills are expanded into occurrences (capped at 1000 per bill, refused past it), and bad stored data or a NULL Akahu balance is a fixed-text 500, never a defaulted value. Alert ids carry their week or due date, so a new week is a new alert and scope isolation rides on the id. Files: `server/db/overview.ts`, `server/routes/overview.ts`, and the two test suites. The suite is 64 files and 1841 tests.

### narrative_how

The researcher ran first and listed the data traps (timestamp versus date, unstored accounts, no scope on dismissals, string settings, no bill expansion, the route name mismatch) before any code. The architect planned, was resumed once to carry Hannah's #151 ruling, and the implementer on opus built in three commits. The reviewer ran 43 mutations and found 3 survivors; the security-auditor found nothing blocking; test-guard found an untested alert tie-break. Fixes went in 99f20f2 and b30505d, separate from the build. Out-of-fence findings were filed (#218, #220, #221, #222, #223, #224), not absorbed. The gate after the last commit was tsc 0, lint 0, vitest 1841 passed.

### narrative_wrong

Four tests were weaker than they looked because their fixtures gave the same answer with or without the guard: a `dataAsOf` filter, two window refusals, and a tie-break whose lane-written example could not go red. Reviewer and test-guard found them; the author did not. Two of the plan's own route-test fixtures were also wrong and were fixed by the implementer. One full vitest run failed once before the first commit and was never reproduced in about twelve later runs, and no output was kept, so the cause is unknown. A rebase onto #67 dropped a commit message because the subject starts with `#`, git's comment character; fixed with `git commit -C`. The fence left duplicated code (#218, #222) and the contract's route name does not match the mount (#220).
