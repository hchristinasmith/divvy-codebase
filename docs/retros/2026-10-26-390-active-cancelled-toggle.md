# Retro: #390, an Active / Cancelled toggle on /subscriptions

#390 (Housekeeping), stamped gear 2 and `model: haiku`. Shifted 2 to 3 during the lane: a new exported symbol (`client/components/Shell/SegmentedControl.tsx`) and two Shell files outside the issue's fence (`ScreenHeader.tsx`, `ScopeToggle.tsx`), authorised by Baseline decision e5af6bc8 (Hannah picked option A). Under the project's gear table, gear 3 means the implementer runs opus, not the issue's haiku. This file states no telemetry (model, duration, tokens, tool calls); the lane posts the four narratives after `baseline finish`.

Seats run, in order: test-writer (regression pin of today's list and totals), test-writer (exact markup pin of the scope toggle and header), architect (plan), implementer (opus, high; build), reviewer, test-guard, brand-checker, docs-syncer, a review-fix commit, this retro. `schema-reviewer` and `security-auditor` do not apply (no migration, no route, no hook). Verify passed on the final tree: `npx tsc --noEmit` clean, `npm run lint` clean, `npx vitest run` 116 files / 4964 tests passed. Load on the machine spiked to about 40 during one run; no test failed.

Commits (`git log --oneline origin/main..HEAD`):

- 28e2bfb: pins today's subscriptions list and totals. One file, +70.
- 3608c13: pins the scope toggle's and the header's exact markup. Two test files, +160.
- 3a75e10: the build. Eight files, +499 / -55: new `SegmentedControl.tsx` (45) and its test (113), `ScopeToggle.tsx` reduced (-36 net of its own lines), `ScreenHeader.tsx` (+6, a `controls` slot), `Subscriptions/index.tsx`, `SubscriptionsList.tsx`, and test changes in `ScreenHeader.test.tsx` and `Subscriptions.test.tsx`.
- d990124: review fix, one line in `Subscriptions/index.tsx`.

## What was built

- **Kind of code:** a UI filter control on an existing screen, plus a lift of an existing component into a shared one.
- **Pattern:** the header's pill group (All / Personal / Strawb) was lifted into one `Shell/SegmentedControl` and `ScopeToggle` now renders it. `ScreenHeader` gained a `controls` slot, and `Subscriptions` puts an Active / Cancelled `SegmentedControl` in that slot beside the scope control. The list filters on status, defaults to Active, and the totals are untouched by the toggle.
- **Why this shape:** the issue assumed the scope control might sit in the Subscriptions route component. It does not; the shared header owns it. Copying the markup into Subscriptions would have made a second copy of a pill group, so Hannah picked the header slot plus one shared pill group (decision e5af6bc8, option A).

## What went wrong

1. **The issue was sliced without checking where the scope control lives (Missed-by: plan).** The fence said "`client/components/Subscriptions/**`, plus the Subscriptions route component if it holds the scope control". It does not: the shared `ScreenHeader` holds it, and `ScopeToggle` was wired to scope only, so it was not a reusable control. A toggle "beside the scope control" could not be built inside the fence. The lane stopped at the fence and raised a decision instead of absorbing Shell. Cost: the gear shift (2 to 3), a model change (haiku to opus), and about 11 minutes waiting for Hannah's answer. The wait was correct; the cost is that the slicing step did not look at one file.
2. **The first `baseline decide` call was refused with a 400 (Missed-by: do).** The lane put a file list into each option's `fence` field. That field is a visual (`{kind: mermaid | html-mockup, source}`), not a file fence. The lane re-raised with html mockups and the second call went through. Cost: one retry.
3. **The hex-colour guard matches issue references (Missed-by: none; surfaced, not fixed).** The regex `/#[0-9a-fA-F]{3,8}\b/` in `noHardcodedStyle.test.ts` matches "#390" in a comment, so three guards failed on the implementer's first run. The implementer wrote "issue 390" instead. Cost: one failed run and a reworded comment. The guard is not in the fence, so it was left, and no issue was filed for it: this is the first occurrence in the retros I read, and the wording workaround holds.
4. **Eight existing tests in `Subscriptions.test.tsx` changed (Missed-by: none; intended).** A cancelled row is hidden by default now, so each of those tests picks Cancelled first. One is an empty-string wording change, and the deliberate old-behaviour pin was rewritten. The reviewer and test-guard both compared each against HEAD and found none weakened. Listed because it is the part of the diff most likely to be read as weakening tests.
5. **A comment in the build claimed behaviour no test pinned (Missed-by: do, caught by test-guard).** The Subscriptions comment said the filter "resets on leaving the screen". Nothing asserts that. Test-guard suggested dropping the claim and d990124 did, as its own commit. Cost: one line.
6. **At 375px the two pill groups do not fit side by side (Missed-by: none; left for Hannah).** Brand-checker measured in headless Chrome: Status (169) plus Scope (212) is wider than the 343px column, so the header stacks three rows, about 46px taller. There is no overflow. Whether three rows is acceptable is a human check the issue already reserves for Hannah; I do not know her answer.

## Root causes

- **A claim in the issue about the code was not looked at before the issue was written (item 1).** Same family as `issue-premise-unchecked` in the earlier retros (#301, #339 and others). Here the premise sat inside the fence line: "if the route component holds the scope control". One read of `ScreenHeader` and `ScopeToggle` answers it. The lane's architect and implementer found it the first time they looked, so the check is cheap; it was not made at slicing time.
- **A gear stamped from the issue's wording, not from the files (item 1).** Gear 2 ("existing behaviour modified") described the user-visible change. The files needed, a new export and two out-of-fence Shell files, are exactly what the project's gear table says moves work to 3. The table did its job after the fact, and the shift is reported rather than absorbed.
- **A decision-file field read by its name (item 2).** The `fence` field name suggested a file fence. The cause is the field name against its type; I cannot say from the record whether the lane read the schema first. Single occurrence.
- **A guard whose pattern is wider than its purpose (item 3).** The hex regex was written to catch colours and also matches `#<digits>`. The code that is checked is fine; the pattern is the issue. Single occurrence.
- **Item 5:** an author comment stating more than the tests pin. The reviewer did not raise it; test-guard did, by asking what each claim in the new code was pinned by.

## What worked, keep it

- **Pin before lift, in two commits.** 28e2bfb pins the list and totals, 3608c13 pins the scope toggle's and header's exact markup, both green on the old code before 3a75e10 touched anything. Test-guard confirmed the pins pass against `origin/main`'s production code. The mutation counts back them: 14 scratch mutations red against the markup pins, 13 against the build.
- **Stopping at the fence with a visual decision.** The decision cost about 11 minutes and kept Shell out of a "small" Subscriptions diff by accident. Hannah's answer was a clear pick, and the lane carried it out as given.
- **Mutations in per-seat scratch copies.** The implementer ran 13, the reviewer 12, test-guard 23. Test-guard killed 22 of 23; the survivor is equivalent (`key={option.label}`, where changing the key changes no rendered output).
- **The build saved as a git tree (`git write-tree`).** Review fixes could then be a separate commit without a stash, which the project forbids in a lane.
- **Separate seats found separate things.** Reviewer: five findings, none blocking, no edits. Test-guard: the unpinned comment claim. Brand-checker: tokens and type roles pass, and the measured layout at phone width. Docs-syncer: nothing falsified, with two borderline lines noted (prd-02 line 83, "lists each regular charge"; `handoff.md:15`, the header's right side).

## Surfaced, not absorbed

- **#401** (Housekeeping, Spawned-by #390, Missed-by: none): Overview's `PILL_TRACK` / `pill()` and Settings' `SCOPE_TRACK` / `scopeOption()` are copies 2 and 3 of the pill group and have already drifted from `SegmentedControl` (`font-medium` instead of `font-semibold`; a `FOCUS` outline; `inline-flex`; `px-3 py-1`). They sit in `client/screens/**`, outside this fence.
- **No `focus-visible` outline on the header pills.** Brand-checker noted it. It is pre-existing and was kept byte-for-byte, because the pin in 3608c13 says so. #401 settles the question once for all three groups.
- **The hex regex matching issue references** (item 3). Not filed.

## Recommended changes

1. **Slicing checks the file that holds the thing the issue is "beside" or "next to" (encode now; `issue-premise-unchecked` is well past a second occurrence).** Add one line to the project's "Issues and the board" section: before an issue's fence is written, open the file that holds any control, component or value the issue names, and write which file it is; if it is not in the fence, the issue is gear 3 or the fence is wrong. High leverage, one line. Artifact: `/Users/hannahchristinasmith/Library/Mobile Documents/com~apple~CloudDocs/Desktop/Other Shit/RTR/div/divvy-codebase__worktrees/390-active-cancelled-toggle/CLAUDE.md`.
2. **When a lane raises a decision with option visuals, the option's visual field takes a `{kind, source}` object, not a file list (do not encode).** One occurrence, cost one retry. Watch for a second.
3. **Reword the hex regex in `noHardcodedStyle.test.ts` so a bare issue number is not a colour (do not encode in a runbook; file only if it bites again).** A fix needs the guard's own fence, and this lane's workaround ("issue 390") is cheap.
4. **#401 is the fix for the pill-group copies.** No new artifact; the issue exists.

## Highest-leverage next step

Do change 1: add the "name the file that holds it" line to the slicing rules in the project's `CLAUDE.md`. The whole cost of this lane that was not the work itself (a gear shift, a model change, a decision and its wait) came from one fence sentence that a single file read would have settled.

## Open items for the PR body

- #390, shifted 2 to 3: a new exported symbol (`Shell/SegmentedControl.tsx`) and two Shell files outside the issue's fence (`ScreenHeader.tsx`, `ScopeToggle.tsx`), authorised by Baseline decision e5af6bc8 (Hannah picked option A). Implementer ran opus per the gear table, not the issue's haiku. Single-issue PR: squash.
- Negative fence honoured: #392, #391, #393, `server/**` and #267 are untouched.
- Eight existing `Subscriptions.test.tsx` tests changed because cancelled rows are hidden by default; reviewer and test-guard compared each with HEAD, none weakened.
- Human check for Hannah: at 375px the Status and Scope pill groups stack to three header rows (about 46px taller, no overflow).
- Test-guard: PASS; 22 of 23 mutations killed, the survivor is equivalent. Brand-checker: PASS. Reviewer: 0 blocking. Docs-syncer: nothing falsified.
- Follow-up: #401 (Housekeeping, Spawned-by #390, Missed-by: none).
- Gate on final tree: tsc clean, lint clean, vitest 116 files / 4964 tests.

## Retro narratives

These four are the text for the retro POST.

### narrative_code_type

A UI filter control on an existing screen, built on a lift of an existing component into a shared one. Housekeeping, stamped gear 2, shifted to 3. No migration, no route, no server code.

### narrative_built

The header's pill group (All / Personal / Strawb) was lifted into `Shell/SegmentedControl`, and `ScopeToggle` now renders it. `ScreenHeader` gained a `controls` slot, and `/subscriptions` puts an Active / Cancelled `SegmentedControl` in it beside the scope control. The list defaults to Active and shows cancelled rows only under Cancelled; the totals do not change with the toggle. Two regression-pin commits (the list and totals; the exact scope-toggle and header markup) came first, green on the old code. Gate: tsc and lint clean, vitest 116 files / 4964 tests.

### narrative_how

Two test-writer seats pinned today's behaviour in separate commits, then the architect planned and an opus implementer built, with mutations run in scratch copies. The reviewer made no edits and found five issues, none blocking; test-guard passed and killed 22 of 23 mutations, the one survivor being equivalent; brand-checker passed tokens, type roles and a headless-Chrome layout measurement; docs-syncer found nothing falsified. One review-fix commit removed a comment claim no test pinned. The build was saved as a git tree so the fix could be its own commit without a stash.

### narrative_wrong

The issue's fence assumed the Subscriptions route component might hold the scope control; the shared `ScreenHeader` does, and `ScopeToggle` was wired to scope only. The lane stopped and raised a decision (Hannah chose a header `controls` slot and one shared pill group), which moved the work from gear 2 to 3 and from haiku to opus, and cost about 11 minutes of waiting. Missed-by: plan. The first `baseline decide` call was refused 400 because a file list went into the option `fence` field, which takes a visual; one retry. The hex-colour guard regex matches issue references like "#390", failing three guards on the first run; the comment was reworded and the guard left. Eight existing Subscriptions tests changed because cancelled rows are now hidden by default, and none was weakened. At 375px the two pill groups stack to three header rows, left for Hannah's check. #401 covers the two older copies of the pill group.
