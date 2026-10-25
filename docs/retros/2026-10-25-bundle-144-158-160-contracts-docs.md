# Retro: #144, #158, #160, bill contract fields, what `(?:"|$)` is for, category-edit docs

Bundled lane, branch `fix/144-contracts-docs-bundle`. Gears as stamped (#144 gear 2, #158 and #160 gear 1); no shift. One implementer dispatch (haiku, effort high) built all three. Seats, in order: implementer, reviewer (on the working diff), test-guard. No architect (gear 1-2). Commits: `9d1fcb6` (#144), `b04353d` (#158 build), `b832a33` (#158 review fixes), `c80eb07` (#160). Gate green before every commit: tsc 0, lint 0, vitest 48 files / 1167 tests. 6 files, +56 / -30. No follow-ups filed. The lane commits this retro and posts the four Baseline fields after `baseline finish`. SHAs are post-rebase; vitest was 52 files / 1224 tests after rebasing on origin/main.

## What was built

- **Kind of code:** a type-only contract change (#144, `shared/contracts.ts`), a comment-and-test change on a regex tokenizer (#158, `shared/exact-json.ts` and its test), and doc corrections (#160, `README.md`, `docs/akahu-pending-semantics.md`, `docs/audit-2026-10-23.md`).
- **Pattern:**
  - #144: `CreateBillRequest` gains `repeat: BillRepeat` and its `dueDate` becomes `firstDueDate`; `BillResponse` gains `repeat` and `firstDueDate` beside the due occurrence. `BillRepeat` is a type-only import from `models/planning.ts`, a type-only cycle with precedent. No new export, no consumers yet.
  - #158: three timing rows and one correctness row, each red under the loosened pattern and green shipped, plus comments that claim only what was measured.
  - #160: docs say `PATCH` and that `setUserCategory` refuses a pending row (409). The audit's dated snapshot keeps its `PUT` rows under a superseded note.
- **Why the rename:** the date given on create is the anchor every occurrence is computed from, so the request names it `firstDueDate`. A judgement call; the issue did not say. See "What went wrong".

## What happened

- **#144.** Added `repeat` and `firstDueDate` to both contracts, dropped the stale "whether bills repeat is #35's answer" comment, replaced it with one that says what the route resolves. Nothing imports `CreateBillRequest` or `BillResponse` yet, so tsc cannot check the rename. #49 is the first consumer and must map `first_due_date` to `firstDueDate`.
- **#158, the issue was wrong, and the Done-when caught it.** The issue said changing `(?:"|$)` to `"` (call it mutant A) was harmless: the timing rows stayed green and "the result is SyntaxError either way". Its suggested outcome was to stop the comment claiming it. Its Done-when allowed "either find a body" for the claim. The implementer looked for one, executed:
  - **Correctness.** `["{\1]` throws shipped and parses to `['{"1']` under A. A fuzz comparing the two patterns gave 104 differences in 300k samples. The same fuzz against mutant B (an escape that needs a character after its backslash) gave 0.
  - **Timing.** A is exponential on a run of backslashes in an unterminated string: `{"a":"` plus 44 backslashes took about 4.2 to 4.8 s under A and 0 ms shipped.
  - **Coverage.** HEAD's `exact-json.test.ts` stayed 78/78 green under A. The correctness gap was unguarded and the old comment's stated reason (a rescan from every quote) was wrong, while the pattern was right for reasons nobody had written down.
  - **Mutant B was real.** The lone-backslash claim (a body ending in a lone backslash, about 6.4 to 8.2 s) was true and kept.
  - **Build.** The three escaped-quotes and backslash bodies became one `it.each` of three rows; `["{\1]` joined the not-JSON `it.each`. The header comment in `exact-json.ts` now gives the real reason for `(?:"|$)`.
- **#158 review.** The reviewer found two comment gaps and fixed them: the rewritten header no longer said why `\\[\s\S]?` may stop at its backslash, which invited someone to "fix" it into mutant B; and the test comment did not say what the escaped-quotes row is for. Both are in `b832a33`.
- **Review edited in place, before the build commit.** The reviewer fixed the files in the working tree, so build and review fixes were one diff. The lane rebuilt the pre-review files to get the two commits `b04353d` and `b832a33`, keeping "review fixes separate from the build" true.
- **test-guard.** Covered and gated, with two suggestions, both taken as decisions rather than changes: the type-only import is a cycle (conscious yes, precedent exists), and the escaped-quotes row kills only the combined mutant (A and B together), which the reviewer measured at 7189 ms. That row stays; it is the one that covers the combination.
- **#160.** Fixed `PUT` to `PATCH` and the stale "does not check `status` yet" in `akahu-pending-semantics.md`, and corrected a line reference (`transactions.ts:31` to `:34`). The Done-when's "no `PUT` left" cannot hold for `audit-2026-10-23.md`, which is a dated snapshot of the code before #9, #19 and #129; the issue allowed a superseded note, and that is what it got.

## What went wrong

- **#158's premise was false, and its prescribed fix was wrong.** Had the lane followed the suggested outcome, it would have deleted a correct justification for `(?:"|$)` and left a correctness hole (`["{\1]` parsing) unguarded. What stopped it was the Done-when's "or find a body" branch and an implementer that ran it. Cost: none in the diff; the risk was a worse change that passes the gate.
- **The comment rewrite dropped half of what was true.** The build removed the false "rescans from every quote" claim and, with it, the true reason an escape may stop at its backslash. A later seat had to put it back. Cost: one review finding and one commit.
- **Review edits landed in the build diff.** Cost: the lane rebuilt the pre-review files by hand. This is the same departure the #140/#141 retro recorded, there as a choice, here as a reviewer edit.
- **The 1000 ms limit is only about 4x from mutant A on this Mac.** A CI runner more than 4x faster would let A pass the timing row silently. That is a missed catch, not a flake. The 44-backslash length stays as the trade between that margin and test time; the correctness row (`["{\1]`) has no such margin and catches A on any machine.
- **#144's rename was not the issue's to decide and was not asked.** `dueDate` to `firstDueDate` on the request was a judgement call, made and reported in the commit. With no consumer in this lane, nothing checks it until #49 lands.
- **#144's process clause is still open.** Land before #49 or widen #49's fence: the conductor's call at merge.

## Root causes

- **Issue premises are not probed at slicing** (`issue-premise-unchecked`; third occurrence after #135 and #140). #158 said "harmless" and "SyntaxError either way". The record shows only the existing rows going green: the two bodies they use are escaped quotes, with and without a trailing backslash, and none ends in a bare run of backslashes or has a number after a backslash. A claim that a change is harmless was generalised from the inputs already in the test file. Seat: plan. Cost here was nil only because the Done-when left a way out.
- **`guard-tests-cannot-tell-weaker-guard`** (recurrence, #135 and #140): HEAD's tests could not tell `(?:"|$)` from `"`. Same family as #140's finding that the timing comment claimed a pin that was not there. Here the implementer closed it with a mutation per row, which is the fix those retros asked for, so this is a recurrence that was caught in the author seat.
- **A comment edit that removes a wrong claim removes the surrounding right one** (`comment-rewrite-drops-surviving-reason`, first occurrence). The author checked the new text against the mutations but not the old text for reasons that survive. Record only; encode if it recurs.
- **Review before commit collapses the review-fix commit** (`review-edits-fold-into-build`, second occurrence after #140/#141). The pipeline says review on the working diff before gate and commit, and also says review fixes get their own commit. With an in-place reviewer edit the two cannot both be true unless someone rebuilds. This is a workflow gap, not a reviewer mistake.
- **A contract with no consumer is checked by nothing** (first occurrence; context, not an error). #144 is correct by reading only until #49 imports it.
- **Unclear:** why #158's suggested outcome was "stop claiming it" rather than "find a body or pin it". The record does not say whether the probe behind "harmless" tried any other input.

## What worked well, keep it

- **An escape hatch in the Done-when.** "Either find a body" turned a false premise into an executed investigation instead of a deleted justification. Keep Done-whens for claims-in-comments in this form.
- **The implementer measured both the correctness and the timing difference and the fuzz did the work.** One fuzz run separated A (104/300k) from B (0/300k), which pointed each row at its own mutant.
- **Every new row was seen red under its mutant and green shipped, by three seats independently** (implementer, reviewer, test-guard). That is why the late "which mutant does this row kill" question had a measured answer (the combined mutant, 7189 ms).
- **Gate before every commit**, and a review that read the comment as a claim, not only the code. The reviewer's two findings were both about what a future reader would be invited to do.
- **Bundling three small issues in one dispatch** held at one build, one review, one test-guard. The bundle cost nothing visible; #144 and #158/#160 do not touch each other's files.
- **Superseded note instead of rewriting a dated audit.** The Done-when's allowance kept the snapshot honest.

## Recommended changes

1. **Slicing: a "harmless" or "equivalent" claim carries what was tried. Third occurrence, so encode (high leverage).** For an issue that says a change has no effect, the writer lists the input classes tried (for a regex: ending, quote, backslash run, digit after backslash) and runs a fuzz against the original, or marks the claim unverified and keeps a "find a body" Done-when. Artifact: the issue template used by the slicing seat (path not in this repo; the conductor owns it). #140's retro asked for a probe line there; I could not tell whether it landed.
2. **Review sequencing: commit the build first, review the commit. Second occurrence, so encode (high leverage).** The lane makes the build commit, then dispatches the reviewer on that commit; the reviewer's edits are the review-fix commit. No rebuild by hand. Artifact: the "Review" and "Commit" steps in `~/.claude/CLAUDE.md` and `~/.claude/agents/reviewer.md`, then `pnpm import-workflow --name current`. Keep the reviewer's no-land, no-push brief.
3. **Comments: when a comment is rewritten, list the reasons in the old text that still hold. First occurrence, optional.** One line in the `implementer` agent's checklist, `~/.claude/agents/implementer.md`, if it recurs.
4. **Timing rows state their margin.** Where a test pins a loosened guard by wall clock, the comment says the factor on the dev machine (here about 4x), so a faster runner is known to be a coverage risk. First occurrence, optional; `shared/__tests__/exact-json.test.ts` already carries the 1000 ms rationale. Not worth a rule.

## Highest-leverage next step

Add change 1 to the slicing seat's issue template: a "harmless" claim lists the inputs it was tried on, or the issue says it is unverified and keeps a "find a body" Done-when. It is the only item here where the false premise would have produced a wrong change that passed every gate.

## Open items for the PR body

- #144: nothing imports the changed contracts; #49 must map `first_due_date` to `firstDueDate`. Land #144 before #49, or widen #49's fence, at the conductor's call.
- #158: the 1000 ms limit is about 4x from mutant A on this Mac, so a CI runner more than 4x faster would pass A on timing alone. The `["{\1]` row catches A regardless.
- #160: `docs/audit-2026-10-23.md` still has `PUT` rows in its dated snapshot, covered by the superseded note.
- Process: reviewer edited in place; the lane rebuilt the commits so review fixes are separate.

## For Baseline (four fields)

- **narrative_code_type:** a type-only contract change in `shared/contracts.ts` (#144), tests and comments for a regex tokenizer in `shared/` (#158), and doc corrections (#160).

- **narrative_built:** `CreateBillRequest` gains `repeat: BillRepeat` and renames `dueDate` to `firstDueDate`; `BillResponse` gains `repeat` and `firstDueDate`; `BillRepeat` is a type-only import and nothing imports the contracts yet (#49 is the first consumer). `exact-json` gets a correctness row (`["{\1]` must throw) and a backslash-run timing row, and its comments now say what `(?:"|$)` is for. The category-edit docs say `PATCH` and that `setUserCategory` refuses pending rows. 6 files, +56 / -30; tsc, lint and vitest (48 files, 1167 tests) green at every commit.

- **narrative_how:** One haiku implementer at effort high built all three issues; the reviewer ran on the working diff, then test-guard, with no architect at gear 1-2. For #158 the implementer ran the "find a body" branch of the Done-when, executed: a fuzz of 300k samples and timed runs of the loosened pattern. Each new row was seen red under its mutant and green shipped by the implementer, reviewer and test-guard independently. The reviewer edited in place before the build commit, so the lane rebuilt the pre-review files to keep review fixes a separate commit.

- **narrative_wrong:** #158 said changing `(?:"|$)` to `"` was harmless and that the result is "SyntaxError either way". It is not: `["{\1]` parses to `['{"1']` under the change (104 differences in 300k fuzz samples), and a run of 44 backslashes in an unterminated string takes about 4.5 s where the shipped pattern takes 0 ms. HEAD's 78 tests stayed green under it. The issue's suggested outcome would have deleted a correct justification and left a hole; the Done-when's "find a body" branch caught it. The build also dropped the true reason an escape may stop at its backslash, which the reviewer restored. The 1000 ms limit is about 4x from the loosened pattern on this Mac, so a much faster CI runner could miss the timing row (the correctness row still catches it). Root causes: issue premise not probed at slicing (third occurrence), and review edits folding into the build diff (second).
