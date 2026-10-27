# Retro: #233, the bill-date helpers move from `server/db/overview.ts` to `shared/nz-dates.ts`

Gear 3 as stamped (Housekeeping milestone); no shift. The work is a move plus one new exported file, so gear 3 fits: a new exported symbol set, no new behaviour. This file states no telemetry (model, duration, tokens, tool calls); the lane posts the four narratives after `baseline finish`.

Seats run, in order: implementer (opus, high; build), reviewer, implementer (review fixes), docs-syncer, test-guard, implementer (test-guard fix), this retro. No architect: the conductor fixed the design in the brief. `second-opinion` did not run (pre-commit, no PR yet). `schema-reviewer`, `brand-checker` and `security-auditor` do not apply (no migration, no UI, no route or hook). Verify passed on the final state: `npx tsc --noEmit` exit 0, `npm run lint` exit 0, `npx vitest run` 112 files / 4410 tests.

Commits (`git log --oneline origin/main..HEAD`): e485985 (build), 43010ba (review fixes, comments only), 7f34267 (test-guard fix, tests only). The three-dot diff (`git diff --stat origin/main...HEAD`) is five files, +408 / -264: `shared/nz-dates.ts` (167 new), `shared/__tests__/nz-dates.test.ts` (189 new), `server/db/overview.ts` (163 changed), `server/db/bills.ts` (42 changed), `server/db/__tests__/overview.test.ts` (111 removed, the pure tests that moved).

## What was built

- **Kind of code:** a pure-function module in `shared/` (no I/O, integer-free date math on civil dates) plus the two server files rewired to import it, and its pure test suite.
- **Pattern:** a move with a compatibility seam. `nzCalendarDate`, `billOccurrencesThrough`, `MAX_UNPAID_OCCURRENCES` and the civil-date helpers they need now live in `shared/nz-dates.ts`; `addDaysIso` is newly exported because overview's `windowStart` still uses it. `overview.ts` keeps a thin `nzCalendarDate` wrapper that converts the shared `RangeError('date is not a valid instant')` into `OverviewDataError('a transaction is incomplete')`, and re-exports `billOccurrencesThrough`.
- **Why this shape:** the wrapper keeps `drawings.ts`, `goals.ts`, `subscriptions.ts` and open PR #289's `spending.ts` byte-identical in behaviour while they sit outside the fence. The alternative, editing all of them to catch the new error class, would have widened the fence to four more files.

## What happened

- **Regression first, no new regression commit.** On the old code 6 suites / 492 tests were green, and the error behaviour the wrapper must preserve was already pinned at `overview.test.ts:50` and `:1358`. Nothing needed to be added before the move.
- **Implementer found a re-export the brief missed.** The conductor's brief named only the `nzCalendarDate` re-export. `server/db/__tests__/bills.test.ts:17` imports `billOccurrencesThrough` from `../overview.ts`, and that test file is outside the fence, so overview has to keep re-exporting it.
- **Implementer mutated its own work in a scratch copy:** 7 mutations, all killed.
- **Reviewer (0 blocking).** It ran a before/after parity probe (EXECUTED): error class and message for the overview wrapper, `listBills`, `listGoals`, `readOverview` with an invalid `now`, and `billOccurrencesThrough` with bad inputs. Output byte-identical. Three comment fixes landed in 43010ba: the wrapper's comment claimed #301 moves more than it does (it moves only `drawings.ts`), and the guard's copy notes now point every way (overview, bills, goals). It also found mutation M3: re-pointing `bills.ts` at the overview wrapper instead of the shared function leaves all 283 bills tests green, because no bills test passes an invalid `now`. Filed as #321.
- **Docs-syncer:** nothing needed. Only historical retros name the old location.
- **Test-guard: PASS with one Warning.** Eight mutations of the moved code survived: `padStart`, `parseIsoDate(through)`, the unknown-repeat throw, the year-range check, `day >= 1`, `month <= 12`, and the `^` and `$` anchors on `ISO_DATE`. All eight also survive at HEAD before the move, so these are pre-existing gaps the move carried, not regressions. Bills' whole `guard()` is also untested, again at HEAD as well. The implementer added 11 tests in 7f34267; each mutation is now killed by exactly the intended test.
- **Commits were split after the fact.** The reviewer's comment fixes landed in the working tree before the build commit existed, so the conductor reverted the three comment hunks temporarily to commit build and review separately, gating each.
- **Bills lost its copies.** `bills.ts` now imports from shared, dropped its copied 1000 limit and the "change both together" note from #49, and its guard dropped an `OverviewDataError` branch, since nothing borrowed from overview remains.

## What went wrong

1. **The brief named one re-export and the code needed two (Missed-by: plan).** The conductor's plan listed the `nzCalendarDate` wrapper and missed that `bills.test.ts` imports `billOccurrencesThrough` from overview. The implementer found it by running the suite. Cost: none beyond a deviation to report; the plan was corrected before any wrong code was committed. It is also the reason overview now carries a re-export that exists only for an out-of-fence test (#321).
2. **The fence excluded the one test that would pin bills' guard (Missed-by: plan).** `server/db/__tests__/bills.test.ts` is outside this issue's fence, so mutation M3 (and the untested `guard()` as a whole) could not be closed here. This is the same fence-versus-reach pattern recorded in the #49 retro, item 5: the files a move touches by import are predictable, and the fence listed the source and the destination but not the importers. Cost: one follow-up (#321) instead of a closed gap.
3. **A wrapper was needed because three callers sit outside the fence (Missed-by: plan, but accepted).** The shared function throws `RangeError`; `drawings.ts`, `goals.ts`, `subscriptions.ts` and `spending.ts` expect `OverviewDataError`. The wrapper is the cheapest correct answer now. It is also a second layer to retire: #322.
4. **Review caught a comment that overstated scope (Missed-by: do).** The wrapper's comment said #301 would move more than it does. Comments only, no behaviour. Cost: one review-fix commit. A comment that names another issue's scope was written from the brief, not checked against that issue.
5. **Pre-existing test gaps came along with the code (Missed-by: do, caught by test-guard).** Eight survivors in the moved date code and an untested bills `guard()`. All eight were already survivors on the old code, so the move did not cause them; the move is simply the first time a seat mutated this code in a file of its own. Cost: one commit (7f34267), 11 tests. I cannot tell from the record whether the original #44 suite was ever mutation-checked at these sites.
6. **Commit order had to be reconstructed (Missed-by: do).** Review fixes were applied before the build was committed, so the "build, then review fixes, separately" rule needed a temporary revert of three comment hunks. Cost: a few minutes of conductor time and one extra gate run on a partial tree. Nothing shipped wrong.

## Root causes

- **Plan covers the code that moves, not the code that imports it (items 1, 2, 3).** Same family as the #49 retro ("plan covers the code that changes, not the code that reads, pins or constrains it"). Here the readers were a test file importing a re-export and four callers relying on an error class. The brief named the source and destination and the first re-export, and nobody ran `rg` for the importers of each moved symbol. That check is mechanical and would have listed `bills.test.ts:17` and the four wrapper callers up front.
- **Author's list versus the reach of the code (items 4, 5).** The implementer's own 7 mutations were all killed, and test-guard still found 8 survivors in the same code. A move is where this bites: the author trusts the old tests, which passed, and the old tests never covered the error branches. Nothing new to add to the earlier retros' wording.
- **Item 6:** an ordering slip between review and commit. No deeper cause that I can point at in the record.

## What worked, keep it

- **Regression suite green before moving, with the error behaviour already pinned.** The wrapper's contract was checkable from existing tests (`overview.test.ts:50`, `:1358`), so no regression commit was needed and the move could be judged by parity.
- **A thin compatibility wrapper instead of widening the fence.** Four out-of-fence callers behave identically, and the PR can say "not needed, not touched" for each.
- **The reviewer's executed parity probe.** Byte-identical error class and message across five entry points is direct evidence the move changed no behaviour. It also surfaced M3 by mutation, which a read of the diff would not.
- **Test-guard as a separate seat.** Eight survivors that the implementer's own seven mutations did not reach, and the check that each is also present at HEAD kept the Warning honest: the findings were gaps carried, not regressions caused.
- **Review fixes and test-guard fixes in their own commits** (43010ba, 7f34267), each gated, so the second reader sees only the response.
- **Out-of-fence findings filed, not absorbed:** #321 and #322, both Housekeeping, both `Missed-by: plan`.

## Surfaced, not absorbed

- **#321** (Housekeeping, Spawned-by #233, Missed-by: plan): bills tests pin an invalid `now`, import `billOccurrencesThrough` from shared; overview then drops its re-export.
- **#322** (Housekeeping, Spawned-by #233, Missed-by: plan): `goals.ts` and `subscriptions.ts` import `nzCalendarDate` from shared, which retires overview's wrapper.
- **Copies left for #301 (house-shape rule 1):** `nzCalendarDate` now has two implementations, `shared/nz-dates.ts:46` and `server/agents/insights/queries.ts:115`. `shared/safe-to-spend.ts` holds its own `ISO_DATE` (:135), `CivilDate` (:137), `parseDate` (:143, echoes the value), `formatDate` (:163) and `addDays` (:210). `server/db/bills.ts` keeps its own `ISO_DATE` (:114) and `isRealDate` (:118). I did not diff these against the shared versions beyond locating them, so I do not say they behave the same.

## Recommended changes

1. **Plan checklist for a move: list the importers of each moved symbol before writing the brief.** `rg -n "<symbol>" --glob '!node_modules'` per moved export, and put every importer outside the fence into the brief as "re-export needed" or "fence widened". Second occurrence of "plan covers what changes, not what reads it" within two retros, plus the barrel-move instance in #49; encode now. Artifact: the architect's fence checklist, `~/.claude/agents/architect.md` (then `pnpm import-workflow --name current`), the same edit proposed in the #49 retro. High leverage, one `rg` per symbol.
2. **When a move leaves an out-of-fence test importing through a re-export, file the cleanup in the same breath as the move.** Done here (#321, #322). Single occurrence; do not encode.
3. **Mutate the code a move relocates, not only the lines it edits.** A move creates a new file that test-guard will treat as new code. Single occurrence; do not encode. If it recurs, add a line to the implementer's checklist at `~/.claude/agents/implementer.md`.
4. **Commit the build before applying review fixes.** Single occurrence; do not encode. The existing commit-order table in `~/.claude/CLAUDE.md` already says it.

## Highest-leverage next step

Do recommendation 1: add "run `rg` for each moved export and list every importer outside the fence" to the architect's fence checklist in `~/.claude/agents/architect.md`. The brief missed one re-export and left the fence without the one test file that would have pinned bills' guard; both are importers of moved symbols, both findable in seconds, and #301 (the next consolidation) will move the same kind of helpers.

## Open items for the PR body

- Gear 3 as stamped; no shift. Fence: five files, `server/db/__tests__/bills.test.ts` and the three other wrapper callers (`drawings.ts`, `goals.ts`, `subscriptions.ts`) not touched; `spending.ts` is in open PR #289 and not touched.
- Behaviour parity: reviewer's executed probe, byte-identical error class and message across the overview wrapper, `listBills`, `listGoals`, `readOverview` with an invalid `now`, and `billOccurrencesThrough` bad inputs.
- Test-guard Warning: eight survivors, all also present at HEAD before the move; closed with 11 tests in 7f34267. Bills' `guard()` remains untested (also before the move) and is #321.
- Follow-ups: #321, #322 (both Housekeeping, Missed-by: plan). Copies left for #301 listed above.
- Gate after 7f34267: tsc 0, lint 0, vitest 112 files / 4410 tests.

## Baseline narratives

These four are the text for the retro POST (`narrative_code_type`, `narrative_built`, `narrative_how`, `narrative_wrong`).

### narrative_code_type

A refactor that moves pure date and bill-occurrence functions from a server data module into `shared/`, with a compatibility wrapper and a re-export left behind, and the pure tests moved with them. No migration, no route, no UI. Gear 3 (a new exported module), Housekeeping.

### narrative_built

`nzCalendarDate`, `billOccurrencesThrough`, `MAX_UNPAID_OCCURRENCES` and the civil-date helpers they need now live in `shared/nz-dates.ts`, with `addDaysIso` exported because overview still uses it. `server/db/overview.ts` and `server/db/bills.ts` import from there. Bills lost its copied 1000 limit and note and one unreachable error branch. Overview keeps a thin `nzCalendarDate` wrapper that turns the shared `RangeError` into `OverviewDataError`, so four callers outside the fence behave the same, and it re-exports `billOccurrencesThrough` for an out-of-fence test. Gate: tsc and lint clean, vitest 112 files / 4410 tests.

### narrative_how

Existing tests were green first (6 suites / 492 tests) and already pinned the error behaviour, so no regression commit was needed. The implementer (opus) built the move and mutated it in a scratch copy, 7 mutations all killed. The reviewer found no blocking issue, ran a before/after probe that came back byte-identical across five entry points, fixed three comments, and found that re-pointing bills at the overview wrapper leaves all 283 bills tests green. Test-guard passed with a Warning for eight surviving mutants that were also present before the move; the implementer added 11 tests that kill each. Build, review fixes and test fixes are three separate commits, each gated. Out-of-fence findings became #321 and #322.

### narrative_wrong

The conductor's brief named one re-export and the code needed two; the implementer found the second (`bills.test.ts` imports `billOccurrencesThrough` from overview) by running the suite. The fence left out that test file, so the one test that would pin bills' guard could not be written here and went to #321. A wrapper and a re-export remain in overview only because four callers and one test sit outside the fence (#322, #321). Review caught a comment that overstated what #301 moves. Test-guard found eight surviving mutants and an untested bills guard, all of which already existed before the move. The review fixes were applied before the build was committed, so three comment hunks had to be reverted temporarily to commit them separately.
