# Retro: #56 prd02 w4, the Goals screen shows goals and records contributions (client screen, goals API module, form, guarded writes)

Gear 3 as stamped; no shift. The issue said `model: sonnet`; the CLAUDE.md table maps that to opus, and the implementer ran on opus at effort high. Fence: `client/screens/Goals/**` and `client/apis/goals.ts`. Nothing outside it was touched (`git diff --stat origin/main...HEAD` lists 17 files, all under those two paths). This file states no telemetry (model, duration, tokens, tool calls); the lane posts the four narratives to Baseline after `baseline finish`.

Seats run, in order: researcher, architect, implementer (build), reviewer, implementer (review fixes), brand-checker, implementer (brand fixes), docs-syncer, test-guard, implementer (test-guard gaps), this retro. `schema-reviewer` does not apply (no migration). Verify passed on the final state: the dispatch reports the gate (`npx tsc --noEmit`, `npm run lint`, `npx vitest run`) green before each of the five commits, ending at 114 files and 4317 tests. I did not re-run it for this retro.

Commits (`git log --oneline origin/main..HEAD`): 820d8f2 (build), 8afd6cc and 562bc1f (review fixes), 927ddbd (brand fixes), a80a7fb (test-guard gaps), then this retro. The three-dot diff is 17 files, +2146 / -5.

## What was built

- **Kind of code:** a React screen (`client/screens/Goals/`), a typed API module (`client/apis/goals.ts`) and its test suite. No server change, no migration.
- **Pattern:** a display-only client over the goals route. Saved, target, pace and months come from the server and the client does no money arithmetic; a test scans the screen source for arithmetic to keep it that way. A contribution (+$50 / +$200) is a record of a transfer Hannah makes herself (prd-02 Ruling 5), so it refetches the goals list only, never the Overview. Writes are guarded against double-submit through one pending flag shared by the +$ buttons and Save. New-goal creation is a form on the grid.
- **Why this shape:** no goal-to-account link exists in the data, so the prototype's "Personal · Savings" footer and subtitle are omitted rather than invented.

## What happened

- **Researcher** found three things before any code: no goal-to-account link in the data (footer and subtitle omitted); `queryKeys.goals.all` already exists; `routes.test.tsx` already mocks Goals and needed no change. The third is a file that would have been a fence question, answered by reading.
- **Architect** plan accepted. Four open points were taken on its recommendation, all small and none a fork with different consequences: the funded check compares saved >= target; the dashed-border colour; 6px buttons per CHANGES-2; the scope toggle stays.
- **Implementer** built 17 files and broke 10 guards on purpose, each seen red before the commit.
- **Reviewer, 8 findings.**
  - Fixed in 8afd6cc: the Save double-click guard was missing, and its test passed only by accident (a `setErrors({})` re-render happened to hide it); no test for `encodeURIComponent` on the goal id; no test that the form stays open until the refetch lands.
  - Fixed in 562bc1f: focus was lost when the form opened or closed; every card's +$ buttons had the same accessible name.
  - Left, on purpose: a stale contribution error after a create; `barPercent` rounds 99.99% to a full bar (the function is outside the fence, filed as #308); edge-case focus while busy.
  - The OpenRouter second-opinion key was rejected ("User not found"), so the review is one reader only.
- **Brand-checker:** on-brand, with three mismatches, fixed in 927ddbd: the new-goal dash was `border-blush-hover` and became `border-pink/60`; fields padded `py-3`; fields turn white on focus (`focus:bg-surface`).
- **Docs-syncer:** prd-02 Done-when 3 is falsified by Ruling 5 and by the screen (filed as #307; `docs/prds/**` belongs to another lane). `docs/design/handoff.md` lines the PRD overrides are expected, per CLAUDE.md.
- **Test-guard, 54 mutants.** Survivors, all then covered by new tests shown red first (a80a7fb): the Save guard, a hidden note, the `Server error (status)` fallback, a hard-coded bar width. Minor survivors left: the arithmetic regex can be evaded with aliases; keying by name versus id; the Name input's disabled state.
- **Other findings.** The Shell `noHardcodedStyle` scan matches the word after `--dv-` in the offset-colour variable, so the prototype's dash colour cannot be written as the prototype wrote it, and it reads "#288" in a comment as a hex colour (filed as #309). Copy counts were added to #249. The missing undo or edit of goals and contributions was filed as #310, a decision for Hannah. Screenshots at 390, 1040 and 1600 showed 0px horizontal overflow and were published as a private artifact for Hannah to check.

## What went wrong

1. **The build was committed while the reviewer was live in the same worktree (Missed-by: do, the lane's sequencing).** The reviewer was breaking `GoalForm.tsx` in place for a mutation check (`setErrors({})` replaced by a comment). The lane's commit captured the break. The lane had hashed the tree before and after the gate and both hashes matched; the break landed after the second hash and before `git add`. It was caught only because the lane had also tarred a snapshot of the gated files and compared HEAD to it once the reviewer reported. The commit was amended, unpushed, back to the gated snapshot (17 of 17 files identical). Cost: one amend and a hand comparison. Nothing wrong reached the branch or a push, but the check that caught it was a snapshot that happened to exist, not a step anyone required. Had the lane relied on the hashes alone, the committed build would have shipped a form with its error reset removed, with a green gate on a different tree.
2. **The first Save guard did not exist and its test did not notice (Missed-by: do).** The build shipped without a Save guard, so none of the implementer's 10 guard breaks could have been on it. The test that looked like it covered double-submit passed only because a `setErrors({})` re-render masked the gap. The reviewer found it and 8afd6cc added the guard; test-guard later found the guard still had no test that failed without it, and a80a7fb added one. This is the same pattern as the #67 retro's item 3: a guarantee asserted by something that could pass for another reason, found by a break and not by the author.
3. **Accessibility gaps reached review (Missed-by: do).** Focus was lost on open and close of the form, and every card's +$ buttons shared one accessible name. I did not see either named in the plan as the dispatch reports it. Cost: one fix commit (562bc1f). The likely cause is that the plan and the prototype describe what the screen looks like, not how it is operated by keyboard or a screen reader; I cannot confirm that from the record.
4. **The brand token the prototype used could not be written (Missed-by: none).** The Shell scan rejects the offset-colour variable and a "#288" in a comment. The lane filed #309 instead of editing the scan, which is outside the fence. The dash went in as `border-blush-hover`, and brand-checker had it changed to `border-pink/60` (927ddbd). Cost: one brand-fix round. Not a miss of any seat; the scan has two false positives.
5. **Two follow-ups trace to the plan.** #307 (prd-02 Done-when 3 contradicts Ruling 5) and #310 (no undo, edit or delete for goals or contributions; the PRD and the issue do not say whether that is intended) are both Missed-by: plan. #308 (`barPercent` rounding) is Missed-by: review, since the reviewer saw it and the function is outside the fence.

## Root causes

- **A mutating seat shared a working tree with a committing seat (item 1).** Second occurrence of the cause named in the #50 retro, "Two mutating seats on one working tree". #50 saw reviewer and test-guard overlap and recommended, without encoding, a rule that edit-and-revert seats not overlap or work from an export. The agent files have no such rule (`grep` for "scratch" and "archive" in `~/.claude/agents/reviewer.md`, `test-guard.md` and `skills/parallel-agents/SKILL.md` returns nothing). The reviewer broke files in place again. This time the second party was the lane's own `git add`, not another seat. The deeper cause is the same: break-testing is done by editing the real tree, and nothing tells the seat or the conductor not to.
- **A guard checked before the commit, not on the commit (item 1).** The hashes compared the tree before `git add`. The commit is what ships. The comparison that caught the break, HEAD against the gated snapshot, is the one that should have been the check.
- **Tests that pass for the wrong reason survive until a break is run (item 2).** Same family as #67 item 3. Here it is a guard whose test was satisfied by an unrelated re-render.
- **The plan may describe appearance, not operation (item 3).** First occurrence, and the cause is a guess from the record, not shown.
- **Item 4 has no cause in the lane.** It is the scan's two false positives.

## What worked, keep it

- **Researcher first, again.** All three facts were read, not asked; none cost a decision.
- **A snapshot of the gated files, compared to HEAD after the commit.** It caught the break the hashes missed. It was improvised, and it is the part to keep and make standard.
- **Later seats ran their breaks in a scratch copy.** After the incident, the reviewer, implementer and test-guard seats used one, and no further contamination appeared.
- **Review fixes in their own commits (8afd6cc, 562bc1f), then brand and test-guard fixes (927ddbd, a80a7fb).** The second reader of each saw only the response.
- **Every new test shown red before it was trusted.** The guard tests added after review and test-guard each went red first.
- **Fence held, findings routed.** Four follow-ups and a comment on #249 went to the right place instead of into the diff. The reviewer's `barPercent` finding was filed, not fixed in place.
- **Taking small plan points on recommendation, and only those.** Four open points were taken without a decision; none was a fork, and none came back.
- **Omitting what the data cannot support.** No footer rather than an invented account.

## Surfaced, not absorbed

- **#307** prd-02 Done-when 3 contradicted by Ruling 5 and the screen (Spawned-by #56, Missed-by: plan).
- **#308** `barPercent` rounds 99.99% to a full bar (Spawned-by #56, Missed-by: review).
- **#309** the offset-colour token and the scan's false positives (Spawned-by #56, Missed-by: none).
- **#310** undo, edit and delete for goals and contributions, a decision for Hannah (Spawned-by #56, Missed-by: plan).
- **Comment on #249** with this lane's copy counts.
- **Left unfixed:** a stale contribution error after a create; edge-case focus while busy; minor test-guard survivors (arithmetic regex aliases, name versus id keying, the Name input's disabled state).
- **Review is one reader.** The second-opinion key was rejected, so nothing independent checked the reviewer's findings.
- **Screenshots** at 390, 1040 and 1600 are for Hannah to check; the lane's own measurement was 0px horizontal overflow.
- I did not read the bodies of #307 to #310 beyond the dispatch's description, so the `Priority:` lines are not restated here.

## Recommended changes

1. **Never commit while an editing seat is running, and compare the commit, not the tree.** Second occurrence of "mutating seats sharing a working tree", so by the #50 retro's own rule, encode now. Two parts. (a) The lane's commit step: take a snapshot of the gated files, commit, then compare the committed tree to the snapshot and amend or stop on any difference; the check runs after `git commit`, not before `git add`. (b) Do not start a commit while a reviewer, test-guard or brand-checker is live. Artifacts: the `parallel-agents` skill (`~/.claude/skills/parallel-agents/SKILL.md`) for the sequencing rule, and the lane handoff text in `~/.claude/CLAUDE.md` pipeline step 6/7 for the post-commit comparison; then `pnpm import-workflow --name current`. High leverage.
2. **Tell every break-testing seat to run its breaks in a scratch copy, not the working tree.** Same recurrence. Put it in the agent files for `reviewer`, `test-guard`, `brand-checker` and the `implementer` break step: copy the tree (or `git archive` export) to the scratchpad, break and run there, never edit the lane's files. `~/.claude/agents/reviewer.md`, `test-guard.md`, `implementer.md`. This removes the cause for both items in the #50 retro and this one. High leverage, mechanical.
3. **Ask the architect for an operability line on any interactive UI: focus on open and close, accessible names for repeated controls.** First occurrence. Do not encode yet. If it recurs, add to the architect's plan template and `docs/design/handoff.md` reading notes. Artifact if encoded: `~/.claude/agents/architect.md`.
4. **Fix the Shell `noHardcodedStyle` scan (#309).** Not a workflow change; the scan reads the offset-colour variable and "#288" in a comment as violations. It is already filed and belongs to another lane.
5. **Guard tests: a double-submit test must fail when the guard is removed.** Second sighting of a test that passes for another reason (#67 item 3 and this one). Not a new rule: the existing practice of seeing each guard red before the commit already covers it, and the implementer's 10 breaks missed only the one the reviewer found. If a third appears, add "each guard in the diff appears in the break list" to `docs/testing.md` under assertion rules.

## Highest-leverage next step

Do recommendations 1 and 2 together as one edit to the `parallel-agents` skill and the three agent files: break-testing seats work in a scratch copy, and a lane never commits while one is live and always compares HEAD to the gated snapshot after committing. This is the second time a seat editing the real tree has corrupted another seat's view, the first time it reached a commit, and the safeguard that caught it was an improvised tar.

## Open items for the PR body

- Gear 3 as stamped; no shift; fence held (`client/screens/Goals/**`, `client/apis/goals.ts`).
- Follow-ups filed: #307 (Missed-by: plan), #308 (Missed-by: review), #309 (Missed-by: none), #310 (Missed-by: plan, a decision for Hannah); comment on #249.
- The build commit was amended once, unpushed, to match the gated snapshot after the reviewer's in-place break landed in it; HEAD 820d8f2 matches the gated files 17 of 17.
- The OpenRouter second-opinion key was rejected; the review is a single reader.
- Hannah to check the 390, 1040 and 1600 screenshots (private artifact).
- Gate: `npx tsc --noEmit`, `npm run lint`, `npx vitest run` green before each commit, ending at 114 files and 4317 tests (as reported by the lane).

## Baseline narratives

These four are the text for the retro POST (`narrative_code_type`, `narrative_built`, `narrative_how`, `narrative_wrong`).

### narrative_code_type

A React screen with a typed client API module and its test suite, inside `client/screens/Goals/` and `client/apis/goals.ts`. No server change and no migration; gear 3.

### narrative_built

The Goals screen lists goals with saved, target, pace and months from the server, records +$50 and +$200 contributions as records of a transfer Hannah makes herself (prd-02 Ruling 5), and creates goals through a form. The client does no money arithmetic, a contribution refetches the goals list only, and every write is guarded against double-submit. The "Personal · Savings" footer is omitted because the data has no goal-to-account link. 17 files, 114 test files and 4317 tests at the end.

### narrative_how

The researcher found the missing account link and two files that needed no change, and the architect's four small open points were taken on recommendation. The implementer on opus built the screen and broke 10 guards, each seen red. The reviewer's 8 findings, the brand-checker's 3 mismatches and test-guard's 4 surviving mutants of 54 were each fixed in their own commit with a new test shown red first. Four follow-ups (#307 to #310) and a comment on #249 took everything outside the fence.

### narrative_wrong

The lane committed the build while the reviewer was breaking `GoalForm.tsx` in place, so the commit captured the break; the before-and-after tree hashes matched because the break landed after the second hash and before `git add`. It was caught by comparing HEAD to a tarred snapshot of the gated files and amended before any push, 17 of 17 files identical. The cause is committing while an editing seat is live and checking the tree instead of the commit, the second case of a seat editing the real tree after #50. The Save double-click guard was also missing and its test passed by accident, and focus and accessible-name gaps reached review.
