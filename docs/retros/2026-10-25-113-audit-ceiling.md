# Retro: #113 prd03, the advisor audit file has a growth ceiling and a write deadline

Gear 2 as stamped; no shift. Every code change is inside `mcp/audit/` plus a two-line amendment in `docs/prds/prd-03-readonly-mcp-advisor.md`; this retro file is outside it. The issue said `model: haiku`; the conductor overrode it to opus under the CLAUDE.md gear table ("subtle rather than merely small"), and the implementer ran on opus (high). No architect (gear 2). Commits: c0ea187 (build), 29b7600 (review fixes). Verify passed on the final state: the lane's gate was 646/646 tests with `tsc` and lint clean; I re-ran only `mcp/audit/__tests__/sink.test.ts` for this retro (99/99 pass). This file states no telemetry (model, duration, tokens, tool calls); the conductor posts the four narratives after `baseline finish`.

Seats run: implementer, reviewer, test-guard, implementer again for the fixes, this retro. The reviewer's second-opinion seat failed (see What went wrong).

## What was built

- **Kind of code:** a behaviour change to one file, the audit sink `mcp/audit/sink.ts` (+151 lines in c0ea187), plus tests in `mcp/audit/__tests__/sink.test.ts` (the file is now 99 tests) and an amendment note under prd-03 Ruling 4. 561 lines added and 9 removed across 3 files against `bfc357f`.
- **Pattern:** two bounds on an open-per-record SQLite writer. The size ceiling is checked inside the write transaction, after the insert and before `COMMIT`, as `page_count * page_size`; a row that would cross it is rolled back and the call answers `audit_unavailable`. The 10 s deadline runs from the `record` call: the write races a timer, the queue tail follows that race, and an abort flag is read in the same synchronous step as `COMMIT` so an abandoned write rolls back instead of landing after a later record. Both bounds are injectable (`maxFileBytes`, `deadlineMs`) and validated at creation.
- **Why this approach:** Hannah chose option A (2026-10-25), a fail-closed ceiling in the sink at 50 MB, with nothing pruned or deleted, and kept the deadline Done-when as written. A probe in the build showed `page_count` counts uncommitted pages inside the transaction, which is what makes a check-before-commit possible.

## What happened

- **Build (c0ea187).** The implementer's probe settled where to check size (inside the transaction). The 10 s deadline, queue-tail race, abort flag and option validation went in together. 19 tests were red on the old code and green on the new. One early test ("a later record still rejects once the file is full") went green for the wrong reason: it used a small record that fitted in an existing page. The implementer caught it and repeated the full-size record.
- **Reviewer (before commit).** It wrote probes for 6 stall interleavings: 0 of 6 landed out of order, and the probe goes red on the no-abort-check mutant. It found 8 things.
  - Fixed: a redundant `written.catch` carrying a false comment, and a comment claiming "at most 1.4 KB" a row (non-ASCII rows take about one 4 KiB page, so the headroom was overstated about 3x, in the code comment and in the PRD note).
  - Flagged and resolved by the conductor: Hannah said 50 MB, and the code and PRD note said 50 MiB without saying so. Settled by writing "50 MB taken as 50 MiB, a whole number of 4 KiB pages" in both places.
  - Flagged: a comment claimed the deadline "only cuts off a stalled write". A write can also wait out the busy timeout at several lock steps, so ordinary contention past 10 s in total is cut off too. Reworded.
  - Known survivor accepted: the pre-turn abort check (the `if (attempt.aborted)` before the queued write opens the file).
  - The second-opinion seat failed: the OpenRouter key was invalid ("User not found"). That seat produced nothing.
- **test-guard.** PASS with 25 mutations, 2 known survivors accepted (the pre-turn abort check, `timer.unref`). It warned that the deadline tests were not robust on a slower runner: a 150 ms budget for a FULL-sync write, and fixed sleeps that could pass without the behaviour. It also noted a count written into a comment (house-shape rule 3).
- **Round 2 (29b7600).** The deadline tests now wait for the sink's connections to close through an exec/close spy instead of sleeping, with wider margins; `null` and the largest accepted bound are pinned; the redundant catch is gone; comments and the PRD note state the MiB reading and the non-ASCII headroom. After that, 21 tests were red on the old code, 5 of 5 runs were green, and the gate was 646/646.

## What went wrong

1. **The first deadline tests leaned on real-timer budgets and fixed sleeps (Missed-by: do).** A 150 ms budget for a write that does a FULL-sync commit, and sleeps standing in for "the abandoned write has finished", would pass or fail on machine speed. The implementer's own mutation pass did not find it, because it passes on this machine. Only test-guard, reasoning about a slower runner, caught it. Cost: one fix round that rewrote most of the deadline tests (29b7600: +158/-95 in a file that was +354 in the build).
2. **The unit was translated silently.** Hannah said 50 MB. The build took it as 50 MiB (a whole number of 4 KiB pages: 12,800; decimal 50,000,000 is 12,207.03 pages) and said so nowhere in the code or the PRD note. The reviewer flagged it, and the conductor wrote it down. No behaviour was wrong; a reader of the PRD note would have believed the file stops at 50,000,000 bytes.
3. **The headroom arithmetic assumed ASCII.** "At most 1.4 KB a row" (from #78's probe: 201 rows in 286,720 bytes) is true for ASCII parameters only. Non-ASCII rows take about one 4 KiB page, so the 36,000-call headroom is about 12,700 at worst, an overstatement of about 3x. It sat in a code comment and in the PRD note; the reviewer found it.
4. **A comment overclaimed what the deadline does.** It said the deadline only cuts off a stalled write. It also cuts off a write that waits on locks at several steps. Same kind of slip as 3: a sentence that was true of the case the author pictured.
5. **The second-opinion seat was dead.** The OpenRouter key returned "User not found". The review ran on one reader plus the probes. Cost: unknown; nothing in the record says what a second reader would have found. Cause is the key, outside the repo.
6. **The issue's model line was wrong for the work.** `model: haiku` was stamped for gear 2; the work is a concurrency and fail-closed change where the interleavings are the whole risk. Caught at dispatch by the conductor, so no haiku run happened and nothing was lost.

## Root causes

- **A test that cannot fail reliably (1; second occurrence).** Same family as #78 item 3 (a busy-timeout test that passed with or without the code). There the green came from a default value; here from the speed of one machine and sleeps standing in for events. In both, the implementer's mutation pass ran on one machine and one run and could not see it; a different reader (reviewer there, test-guard here) did. #113's implementer did catch one instance itself (the small-record "later record rejects" test), so the habit exists for value-shaped false greens and not for time-shaped ones.
- **Numbers and claims written from the case the author pictured (2, 3, 4; second occurrence).** Same cause as #78 item 7 (2000 characters proposed before reading the dispatcher's 1024). The figure, the headroom and the "only" each held for the ASCII, uncontended, single-lock case and were written down as general. The unit slip (2) is the same shape with a different input: Hannah's wording was accepted without checking what it meant in pages. No step in the lane makes the author put units and worst-case inputs next to a number they write into a PRD.
- **The model line is a per-gear default, not a judgment (6).** The CLAUDE.md table says gear 2 is `haiku` unless the change is subtle; the slicer stamps the default and the conductor applies the judgment at dispatch. Here that worked. First occurrence of this exact line; #78 was a similar override but of `sonnet`, which the table had already superseded.
- **The dead second-opinion seat (5): unclear beyond the invalid key.** Nothing in the record says when it broke or whether other lanes are affected.

## What worked, keep it

- **Decision before code.** Hannah's option A (ceiling, fail closed, nothing pruned) and the unchanged deadline Done-when were fixed before the build, so the lane never had to guess between pruning and rejecting.
- **A probe before the design.** Measuring that `page_count` counts uncommitted pages decided where the check goes, instead of assuming it.
- **Race-safety argued and then probed.** The reviewer's 6 stall interleavings (0 out of order) and a probe that goes red on the no-abort-check mutant mean the "never lands after a later record" claim is tested, not asserted.
- **Tests shown red on the old code.** 19 red at the build, 21 red after round 2, so the tests detect the original gap and not just the new shape.
- **The implementer caught its own false green** (the small record that fitted in an existing page) before review.
- **test-guard's mutation count and its timing warning.** 25 mutations with the 2 survivors named and accepted, plus the slower-runner warning, are what produced the event-based waits. 5 of 5 green runs after the fix is the check that mattered.
- **Surfacing, not absorbing.** The four items below were noted and left alone.
- **Separate review-fix commit** (29b7600), so the second reader sees only the response.

## Surfaced, not absorbed

- **(a) Handles pile up under a sustained filesystem stall.** Abandoned writes keep their connections open and can tie up libuv's 4 threads. Calls still answer at the deadline. A blocked syscall cannot be cancelled, so this is inherent.
- **(b) The log can over-record.** A row can land for a call that answered `audit_unavailable`, if the deadline fires after `COMMIT` was issued. It never under-records.
- **(c) Replica reads probably have no deadline either.** `mcp/tools/**` is outside the fence and was not checked.
- **(d) The default-ceiling test relies on sparse files.** It will not hold on a filesystem that does not make them.

## Recommended changes

1. **Second occurrence of the false-green test family (#78 item 3, #113 item 1), so encode it. High leverage:** in the implementer's checklist add: "a test whose result depends on elapsed time waits on an observable event (a spy, a callback), never a fixed sleep; its margin is at least 3x what the machine needs; run the file 5 times before handing off." Artifact: the `implementer` agent file under `~/.claude/agents/`, then `pnpm import-workflow --name current` (the lane's copy comes from Baseline, not `~/.claude`). The conductor owns this edit.
2. **Second occurrence of claims written from the pictured case (#78 item 7, #113 items 2 to 4), encode as a review prompt. Optional:** the reviewer already found all three; make it a named checklist line so it is found every time: "every number, unit and 'only' in a comment or PRD note: state the worst-case input and the unit it came from." Artifact: the `reviewer` agent file. The cheaper, earlier fix is a line in the lane handoff template: when the issue gives a size or time, restate it in the lane's own words with the unit in pages or ms and have the conductor confirm.
3. **Fix the OpenRouter key and say which seat uses it.** Not a repo change: the second-opinion seat produced nothing this run. Whoever owns the key should check whether other lanes' reviews ran without it. First occurrence; do not encode anything yet.
4. **Housekeeping follow-ups, each owning its own issue and phase test:** (c) replica-read deadlines in `mcp/tools/**` (check first; "probably" is not a finding), and (a) the libuv thread pile-up. Both need `Spawned-by: #113` and `Missed-by: none` or `plan` as the conductor judges. Not this lane.
5. **Do not encode** the haiku model line or the dead key; both are first occurrences.

## Highest-leverage next step

Add the event-not-sleep timing-test line, with the 5-run check, to the `implementer` agent's checklist (item 1).

## Open items for the PR body

- The ceiling is 50 MiB (52,428,800 bytes), Hannah's 50 MB taken as a whole number of 4 KiB pages; stated in the code and the PRD note.
- Known survivors accepted: the pre-turn abort check and `timer.unref`.
- Surfaced items (a) to (d) above are not fixed here. (b) means the log can hold a row for a call that answered `audit_unavailable`.
- The reviewer's second-opinion seat did not run (invalid OpenRouter key).

## For Baseline (four fields)

- **narrative_code_type:** a behaviour change to the advisor audit sink in `mcp/audit/`: a fail-closed size ceiling and a per-record write deadline, with tests and a PRD amendment.
- **narrative_built:** `createAuditSink` now rejects a record that would take the audit file past 50 MiB (50 MB taken as 52,428,800 bytes, a whole number of 4 KiB pages), checked inside the write transaction after the insert and before `COMMIT`, and rejects any record not settled 10 s after the `record` call, so the call answers `audit_unavailable` instead of hanging or filling the volume. Nothing is pruned or deleted. An abandoned write checks an abort flag right before `COMMIT`, so it never lands after a later record. Both bounds are injectable for tests and validated at creation. prd-03 Ruling 4 carries the amendment. The sink test file is 99 tests, and the gate was 646/646 with `tsc` and lint clean.
- **narrative_how:** Hannah chose a fail-closed ceiling (option A) before the build and kept the deadline Done-when as written. Gear 2; the issue said haiku and the conductor overrode it to opus for subtlety. The implementer (opus, high) probed that `page_count` counts uncommitted pages, then built the ceiling and deadline with 19 tests red on the old code. The reviewer probed 6 stall interleavings (0 out of order, red on the no-abort-check mutant) and found 8 things. test-guard passed it with 25 mutations and 2 accepted survivors, and warned about timing flakiness. A second round replaced sleeps with events and widened margins, giving 21 red on the old code, 5 of 5 green runs, and 646/646.
- **narrative_wrong:** the first deadline tests relied on real-timer budgets and fixed sleeps that only test-guard caught, costing a round that rewrote most of them. The MB to MiB unit was translated silently and the headroom arithmetic assumed ASCII rows (about 3x too generous, in a comment and the PRD note); the reviewer caught both. A comment overclaimed that the deadline only cuts off a stalled write. The second-opinion review seat failed on an invalid OpenRouter key. The issue's haiku model line was wrong for the work. Surfaced and not fixed: abandoned writes pile up handles under a sustained stall, the log can hold a row for a call that answered `audit_unavailable`, replica reads probably have no deadline, and the default-ceiling test relies on sparse files.
