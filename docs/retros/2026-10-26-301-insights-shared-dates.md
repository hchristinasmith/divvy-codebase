# Retro: #301 (with #321), the insights agent reads NZ dates and drawing ids from shared code

Bundle of #301 (Housekeeping, no gear stamped; the conductor estimated gear 2) and #321 (Housekeeping, gear 1). Shifted 2 -> 3: dropping `queries.ts`'s own `parseIsoDate` copy needed `parseIsoDate` exported from `shared/nz-dates.ts`, a new exported symbol (house-shape rule 6). The record I was given does not say which seat first noticed it. This file states no telemetry (model, duration, tokens, tool calls); the lane posts the four narratives after `baseline finish`.

Seats run, in order: architect (plan), implementer (haiku; #321 regression test, mutation-checked in a scratch copy), implementer (opus; #301 regression tests, each case mutation-checked), implementer (haiku; #321 build), implementer (opus; #301 build), reviewer, test-guard, implementer (haiku; two tests for the test-guard survivors), this retro. `schema-reviewer`, `brand-checker` and `security-auditor` do not apply (no migration, no UI, no route or hook). Verify passed on the final state: `npx tsc --noEmit` exit 0, `npm run lint` exit 0, `npx vitest run` 112 files / 4474 tests.

Commits (`git log --oneline origin/main..HEAD`): 74a7d2d (#321 regression), 9162f09 (#301 regression), 4037f50 (#321 build), 1538e1c (#301 build), a3a5544 (#301 review fixes), d03974d (#301 test-guard fixes). The three-dot diff (`git diff --stat origin/main...HEAD`) is nine files, +136 / -164: `server/agents/insights/queries.ts` (167 changed, mostly deletions), `server/agents/insights/__tests__/queries.test.ts` (68), `server/db/drawings.ts` (14), `shared/nz-dates.ts` (15), `server/db/overview.ts` (11), `server/db/__tests__/bills.test.ts` (11), `server/db/__tests__/drawings.test.ts` (8), `server/db/__tests__/overview.test.ts` (4), `shared/__tests__/nz-dates.test.ts` (2).

## What was built

- **Kind of code:** a de-duplication refactor. No new behaviour, no route, no migration, no UI; two bundled housekeeping issues, plus tests.
- **Pattern:** one implementation per helper. `server/agents/insights/queries.ts` dropped its own `nzCalendarDate`, parse / format / add-days helpers and its `readDrawingIds` copy, and now imports the shared helpers from `shared/nz-dates.ts` and `loadDrawingIds` from `server/db/drawings.ts`. `drawings.ts` now takes `nzCalendarDate` from shared instead of `overview.ts`, which removes the import cycle between the two. `parseIsoDate` is newly exported from `shared/nz-dates.ts`. #321 pointed `bills.test.ts` at the shared `billOccurrencesThrough`, so `overview.ts` dropped its re-export, and pinned that `listBills` with an invalid `now` is `BillsDataError('bills input invalid')`.
- **Why this shape:** `shared/safe-to-spend.ts` keeps its own copies on purpose. It is money code (prd-02 Ruling 1) and the conductor fenced it out; its `parseDate` also echoes the value, where nz-dates' texts are fixed, so moving it needs a decision (#335).

## What happened

- **Regression first, in two commits.** 74a7d2d pins `listBills` with an invalid `now` (the #233 reviewer's mutation M3). 9162f09 pins the insights week and month dates, the invalid-date refusals and the unplaceable drawing candidates on the old code. The implementers mutated each new case in a scratch copy before it was committed.
- **Builds followed the regression tests.** #321's build (4037f50) is two lines. #301's build (1538e1c) removes the copies; `server/agents/__tests__/no-money-writes.test.ts` passed with no edit (109/109), which was the issue's "guard still passes untouched". Old-behaviour tests changed only in imports and comments: `queries.test.ts` (`nzCalendarDate` import re-pointed at shared), `drawings.test.ts` (the cycle comment removed, import re-pointed, import order), `overview.test.ts` (a comment), `bills.test.ts` (the `billOccurrencesThrough` import). No assertion weakened.
- **One behaviour test added at build time, not before.** `weekRange('9999-W52')` used to return `end: '10000-01-02'`, a five-digit year; it is now a RangeError from the shared parser. That cannot be a regression-first test, because it is red on the old code, so it ships in 1538e1c as a new pin. Other changes at year edges are the same kind: `loadLedger` at `0000-01-01`, or `to` of `9999-12-30` or `9999-12-31`, now throws, and the date refusal texts in insights are now the shared `a bill date ...` texts (error class unchanged; the tests pin the class only). No route or schedule calls `runInsightsAgent` yet, so only a hand-set period reaches any of this.
- **Reviewer (0 blocking, 1 medium, 4 low/info, 1 nit; fixed in a3a5544).** It ran an old-versus-new parity probe over about 60,000 date comparisons (EXECUTED). Identical on every valid input; the differences were only at year edges and in error text. It also found that the guard is non-transitive (see below).
- **The guard finding.** The premise in #47 and #301 was that the no-money-writes guard forbids agents importing `drawings.ts` because `drawings.ts` imports `overview.ts`. The reviewer showed, in a scratch copy (EXECUTED), that putting `import { nzCalendarDate } from './overview.ts'` back into `drawings.ts` leaves the guard green at 109/109: rule 1 refuses an agent import of a `server/db` module that itself writes, and never follows that module's own imports. So the premise was never enforced. `drawings.ts` now carries a comment saying it must stay write-free until #336.
- **Test-guard: PASS with two WARN survivors.** `parseIsoDate` with `day <= daysInMonth + 1` survived, and so did a changed constant for `loadLedger`'s upper day. d03974d adds a test that `parseIsoDate` refuses a day one past the month's end (via `addDaysIso`: `2026-02-29`, `2026-04-31`) and one that `loadLedger` refuses a bad `to`.
- **Commits kept separate by snapshot and replay.** The conductor saved the build diff before dispatching the reviewer, replayed each state (build, then review fixes, then test fixes) in a scratch git worktree, gated each, then moved the branch onto them with `git reset --soft`. No stash was used.

## What went wrong

1. **The issue's premise about the guard was never checked (Missed-by: none, as filed; caught by review).** Both #47 and #301 stated that the guard forbids the `drawings.ts` import because of its `overview.ts` import. Nobody ran the guard with that import in place until the reviewer did. #301's design stayed correct (the cycle is gone and the guard still passes), but the property it was meant to protect is held by a comment, not a check. Cost: one follow-up (#336) and a comment in `drawings.ts` that says so.
2. **The conductor's scratch copy for the first mutation agents copied too much (Missed-by: plan).** The `rsync` did not exclude `data/` or `.env*`. Only `.env.example` was copied (the copy was removed), and no `.sqlite3` was present, so nothing sensitive moved. Then the build implementer found that `data/` is source (`data/cats.js`), so excluding it breaks every suite. The first rule was too loose and the obvious fix was wrong. Cost: a corrected recipe mid-lane.
3. **The brief's scratch path was under a different session id than the lane's own scratchpad (Missed-by: plan).** The brief named a directory the lane's scratchpad did not match. Cost: agents had to be told the right path; no work lost. I cannot say from the record whether any agent wrote to the wrong place.
4. **The #321 haiku agent wrote a 170-column comment (Missed-by: do).** The conductor rewrapped it. Cost: one small edit by the conductor. The lane's lint did not catch it.
5. **Two boundary survivors in the date parser (Missed-by: do, caught by test-guard).** `day <= daysInMonth + 1` accepts `2026-02-29`. The `addDaysIso` refusal list in `nz-dates.test.ts` already had many malformed shapes, and #233's test-guard fix added more, but no case sat one day past the month's end. Cost: d03974d, two cases.
6. **A bundle that shifted gear after dispatch.** At dispatch both issues were gear 1 or 2, which the bundling table allows. After the shift to 3, the table says gear 3 (a new export) stays in its own lane. #321 is small and its files neighbour #301's, and I see no cost from it riding along in the record. I note it because the table's test was applied at dispatch and not re-applied at the shift.
7. **Year-edge behaviour is not consistent and is not fixed (Missed-by: none).** `weekRange('9999-W52')` changed from a malformed end date to a RangeError; `agent.ts:72` still claims `weekRange` throws naming the period; `monthsEnding('0000-01-01', 3)` formats `['00-1--1', '00-1-00', '0000-01']`, unchanged by this lane. Out of fence and unreachable today; filed as #337.

## Root causes

- **Author's list versus the reach of the code (items 5, and the guard parity in 1).** Same name as the #233 retro. There the implementer's seven mutations were all killed and test-guard still found eight; here each new regression case was mutation-checked and test-guard still found two, again in the shared date parser, again a boundary (`<= daysInMonth`, a ±1 on a range check). The mutations target the cases the author just wrote, not the range checks in the code they are newly depending on or exporting. This is the second occurrence.
- **Hazard recurs: review fixes land on an uncommitted build (item 6 in #233; avoided here).** In #233 the conductor reverted three comment hunks to commit build and review separately. Here the conductor snapshotted the build diff before dispatching the reviewer, so nothing needed reverting. The cause (the pipeline says review before commit, the commit table says build and review fixes separately) is unchanged; only the workaround is better. Second occurrence of the hazard.
- **A property stated in an issue is a claim, not a fact (item 1).** The guard "forbids" something it does not. The way to have found it was to run the guard with the import put back, which took one scratch edit. Single occurrence in this corpus; no name from earlier retros fits, so I do not give it one.
- **No shared recipe for the scratch copy (items 2, 3).** The `rsync` and the path were composed by hand for each dispatch. I can point to two defects in one dispatch and nothing else; I cannot say the pattern is wider.
- **Item 4 and item 6 (gear shift against the bundle table):** no deeper cause that I can point at in the record.

## What worked, keep it

- **Regression tests first, mutation-checked, in their own commits.** 74a7d2d and 9162f09 are green on the old behaviour, which is what let the reviewer's old-versus-new probe and the build commits be judged as "no behaviour change except at the edges".
- **Pinning the one intentional change as its own named test.** `weekRange(9999-W52) is a RangeError` makes the year-edge change visible in the diff instead of buried.
- **The reviewer's executed probes.** The 60,000-comparison parity run showed the shared helpers identical on valid input. The guard probe falsified a claim two issues repeated. A read of the diff finds neither.
- **Test-guard as a separate seat, again.** Two survivors that the implementers' own mutations missed.
- **Snapshot-and-replay commits, no stash.** Build, review fixes and test fixes are three commits, each gated, and the stash stack stayed untouched.
- **Out-of-fence findings filed, not absorbed.** #335 (money code) and #336, #337 stayed out of the diff.

## Surfaced, not absorbed

- **#335** (Housekeeping, Spawned-by #301, Missed-by: none): `shared/safe-to-spend.ts` keeps its own `ISO_DATE`, `CivilDate`, `parseDate`, `formatDate`, `addDays`. Money code; needs a decision on which error shape its callers keep.
- **#336** (Housekeeping, Spawned-by #301, Missed-by: none): the no-money-writes guard does not follow a `server/db` module's own imports.
- **#337** (Housekeeping, Spawned-by #301, Missed-by: none): `weekRange` and `monthsEnding` at the year edges.
- **Copies still in the tree:** `shared/safe-to-spend.ts` (#335); `server/db/bills.ts`'s `ISO_DATE` and `isRealDate`; `overview.ts`'s `nzCalendarDate` wrapper for `goals.ts`, `subscriptions.ts` and `spending.ts` (#322). `queries.ts` keeps its insights-only week helpers (`civilInstant`, `dayIndex`, `isoWeekday`, `isoWeekOf`, `weekRange`, `pad`, `monthsEnding`, `lastCompleteWeek`), which have no shared equivalent.

## Recommended changes

1. **Add a line to the implementer's checklist: mutate the boundary (+1 / -1) of every range check in code the change newly imports or exports, not only the lines it writes.** Second occurrence with #233 (eight survivors there, two here, both in the shared date parser); encode now. Artifact: `~/.claude/agents/implementer.md`, then `pnpm import-workflow --name current`. High leverage; one line.
2. **When the build must be reviewed before it is committed, snapshot the build diff and replay the states in a scratch worktree; write the procedure down.** Second occurrence of the hazard; this lane's version worked. Artifact: the `parallel-agents` skill (the conductor's checklist), `~/.claude/skills/parallel-agents/SKILL.md`; I did not open that file, so I do not know what it already says about commit order. Optional; high value if it is not there.
3. **A scratch-copy helper instead of a hand-written `rsync`.** Exclude `node_modules`, `.git`, `.env*` and `*.sqlite3`; keep `data/` (it is source); print the destination path. Two defects in one dispatch; do not encode a wider rule. Artifact: a script, `scripts/scratch-copy.sh` in this repo. Optional.
4. **Before a refactor leans on "the guard forbids X", run the guard with X put back.** Single occurrence; do not encode. #336 is the real fix.
5. **Re-apply the bundling table at a gear shift.** Single occurrence; do not encode.

## Highest-leverage next step

Do recommendation 1: add the boundary-mutation line to `~/.claude/agents/implementer.md`. The same family of survivor (a ±1 on a date-parser range check) reached test-guard in two consecutive consolidation retros, #335 and #322 will move or touch more of the same code, and a mutation of `<=` to `<= +1` is one command to try.

## Open items for the PR body

- Bundle of #301 and #321; shifted 2 -> 3: `parseIsoDate` is a new export from `shared/nz-dates.ts`. Merge with `gh pr merge <N> --merge --delete-branch` (bundled PR; every commit carries its issue number); the merger closes #301 and #321 by hand.
- Fence: `shared/safe-to-spend.ts` not touched (#335); `goals.ts`, `subscriptions.ts`, `spending.ts` and `overview.ts`'s wrapper not touched (#322); the no-money-writes guard not edited (#336).
- Behaviour: identical on every valid input (reviewer's executed probe). Differences only at year edges (`weekRange('9999-W52')` now a RangeError; `loadLedger` at `0000-01-01` and `9999-12-30` / `9999-12-31` now throws) and in the text of insights' date refusals (now the shared `a bill date ...` texts; class unchanged). No route or schedule calls `runInsightsAgent` yet.
- Guard: `no-money-writes.test.ts` passed with no edit (109/109); the reviewer showed it does not follow a `server/db` module's imports, so `drawings.ts` carries a comment and #336.
- Test-guard: PASS, two WARN survivors, both closed in d03974d.
- Follow-ups: #335, #336, #337 (Housekeeping, Spawned-by #301).
- Gate on final HEAD: tsc 0, lint 0, vitest 112 files / 4474 tests.

## Baseline narratives

These four are the text for the retro POST (`narrative_code_type`, `narrative_built`, `narrative_how`, `narrative_wrong`).

### narrative_code_type

A de-duplication refactor with no new behaviour: the insights agent stops carrying its own copies of the NZ civil-date helpers and the drawing-id read, and uses the shared and db versions instead. Two bundled Housekeeping issues (#301 and #321) with tests. No migration, no route, no UI. Shifted from gear 2 to 3 because `parseIsoDate` became a new export from `shared/nz-dates.ts`.

### narrative_built

`server/agents/insights/queries.ts` dropped its own `nzCalendarDate`, parse, format and add-days helpers and its `readDrawingIds` copy; it now imports the date helpers from `shared/nz-dates.ts` and `loadDrawingIds` from `server/db/drawings.ts`. `drawings.ts` takes `nzCalendarDate` from shared, so the import cycle with `overview.ts` is gone. `parseIsoDate` is newly exported from `shared/nz-dates.ts`. For #321, `bills.test.ts` imports `billOccurrencesThrough` from shared, `overview.ts` drops its re-export, and a new test pins that `listBills` with an invalid `now` is `BillsDataError('bills input invalid')`. `shared/safe-to-spend.ts` keeps its own copies on purpose (money code, #335). Gate: tsc and lint clean, vitest 112 files / 4474 tests.

### narrative_how

Regression tests came first in their own commits: one for #321 and one for #301 (11 cases) covering the week and month dates, invalid-date refusals and unplaceable drawing candidates, each mutation-checked in a scratch copy. Then two builds, the guard test passing with no edit. The reviewer found no blocking issue, ran an old-versus-new probe over about 60,000 date comparisons (identical on every valid input; differences only at year edges and in error text), and showed that the no-money-writes guard does not follow a db module's own imports. Test-guard passed with two surviving mutants, both in the date parser or ledger, and a small implementer added tests that kill them. Build, review fixes and test fixes are three separate commits, each gated, made by saving the build diff before review and replaying the states in a scratch worktree, so no stash was used. Out-of-fence findings became #335, #336 and #337.

### narrative_wrong

The premise in #47 and #301 that the guard forbids agents importing `drawings.ts` because it imports `overview.ts` was never true; nobody ran the guard with that import in place until the reviewer did, and `drawings.ts` now holds the rule by a comment until #336. Year-edge behaviour changed (`weekRange('9999-W52')` now throws) and `monthsEnding` still formats malformed months near year 0, left for #337. The conductor's scratch copy for the first mutation agents did not exclude `data/` or `.env*` (no secret moved), and the build implementer then found `data/` is source, so the recipe needed correcting mid-lane; the brief's scratch path also did not match the lane's own. The #321 haiku agent wrote a 170-column comment that was rewrapped. Test-guard found two boundary survivors in the shared date parser and the ledger, the same family as #233's survivors. The bundle shifted to gear 3 after dispatch while the bundling table keeps a new export in its own lane.
