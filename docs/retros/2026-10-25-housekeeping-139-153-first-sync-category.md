# Retro: #139 and #153 Housekeeping, the first sync sends no window; TxnItem shows the effective category

Bundled lane, branch `fix/139-first-sync-bundle`. Both issues gear 2 as stamped; no shift. Both implementers ran haiku (per the issues; gear 2 row of the CLAUDE.md model table). Two implementers ran in parallel (disjoint files). Commits: `02cb8b2` (#139 build), `9ef6d3c` (#139 review fix, a comment), `c59ee4b` (#153 build), `ee9250f` (#153 review fixes). Gate green after each commit: tsc clean, lint clean, vitest 1229 then 1230 passed. This retro is filed as a file at the conductor's request; it is not posted as an issue comment.

## What was built

- **Kind of code:** a behaviour change in the sync layer (#139: `akahu-client.ts`, `run.ts`) and a UI component change (#153: `TxnItem.tsx`), both with tests.
- **#139 pattern:** optional bounds. `listTransactions` takes `{ start?: Date; end?: Date }`; `windowQuery` sends only the bounds given and still refuses invalid or reversed bounds before any request. `windowFor` returns `{}` when there is no successful run (or its start is unreadable), so the first sync sends neither bound. That is the only form `docs/akahu-pending-semantics.md` §3 documents as "all transactions accessible". The 730-day stopgap `FIRST_RUN_LOOKBACK_MS` (from #21) is removed. 5 client tests and 1 run test added; 3 run tests changed from the 730-day window to no window.
- **Why both bounds optional:** the issue left "end optional?" open. The conductor chose both-optional because the no-bounds form is the only documented one; an `end` alone is sent as given and the interface comment says it is undocumented.
- **#153 pattern:** a new Category cell in `TxnItem`: the effective `category` plus a group derived from the category name via a module-level `Map` built from `data/cats.js`. `formData.category` starts from `category ?? ''`.

## What happened

- **#139 build.** Straight to green. The one design question (end-optional) was settled by the conductor before build, from the doc, and the build followed it.
- **#139 review.** reviewer: 2 findings. One was the `listTransactions` comment, which did not say why a lone bound gets no default (fixed in `9ef6d3c`). One was informational: `MAX_PAGES` 500 x 100 caps a first run at 50,000 rows, which is now the real ceiling on the first sync since the window no longer limits it. Not changed. test-guard: full gate 1229 green; 10 mutations, 1 equivalent survivor.
- **#153: the issue's file facts were wrong.** It said `TransactionsPage.tsx` "reads `category_name`". The page renders no `TxnItem` (the usage is commented out), so it reads nothing, and it was left untouched. `TxnItem` had no Category cell at all: four cells under a five-column header. So the work was to add the cell, not to repoint one.
- **#153 build.** Effective `category` and group derived from the name; `formData.category` from `category ?? ''`.
- **#153 review.** reviewer: 4 findings, 3 fixed in `ee9250f`:
  - The save value was untested. It also showed that the old initial value, a group name, would 400 at PATCH, because `isKnownCategory('Food')` is false. That is why the init became `category ?? ''`.
  - The null test missed the legacy `category_name` path.
  - A stale `TODO(#9)` comment was rewritten.
  - The fourth (info) was left: `TransactionsPage.tsx` mounts no `TxnItem`, so the page still shows no rows. Wiring a data fetch is new work beyond a gear-2 issue, and #61 deletes the page.
- **#153 test-guard.** 2 surviving mutations: one equivalent, one the untested `useState` init, which the reviewer's first finding then covered. brand-checker: no violations. Note: the cell uses shadcn `text-xs text-muted-foreground`, not the handoff's `text-body-12 text-ink-muted`. Kept for consistency with the old page, which #61 deletes.
- **No test-writer seat.** Existing tests already covered the prior behaviour in both files, so there was nothing to write ahead of the change.

## What went sideways

1. **A false red from two seats on one worktree.** #153's test-guard mutated `TxnItem.tsx` in place while the #153 reviewer was running tests in the same worktree. The reviewer saw a failure ("Bakeries" under "Household") that was the mutation, not the code. The reviewer then moved its own mutations to a scratch detached worktree. Cost: a confusing red and a round of working out whose edit it was. No bad code shipped.
2. **Review edits mixed with the build.** Reviewer edits landed in the working tree alongside the build. The conductor had to reconstruct the pre-review state to keep the "review fixes separate from the build" commits (`c59ee4b` then `ee9250f`, `02cb8b2` then `9ef6d3c`). Cost: time, and a reconstruction step that could have gone wrong.
3. **The second-opinion seat could not run on #139.** The script needs a PR number and there was none yet. Sending the raw diff to OpenRouter instead was blocked by permissions, correctly. The seat produced nothing.
4. **Stale issue text on #153** (the page reads nothing; the row had no category cell). Found by the implementer on first read of the files.

## Root causes

- **Two seats on one file set, one of them mutating in place** (`parallel-seats-share-worktree`, first occurrence). The reviewer and test-guard were launched at the same time on the same files. test-guard's method is to edit source and run tests, which is only safe when nobody else is reading that tree. Nothing in the dispatch said so. This is a sequencing problem, not a tool problem.
- **Review seats run before the build is committed** (`review-before-commit-mixes-diffs`; recurrence of the #140/#141 note, where review fixes were folded into the build commit for the same reason). The project rule wants review fixes in their own commit, but the review runs on the uncommitted working tree and edits it. Either the build is committed first, or the reviewer's changes have to be separated by hand afterwards.
- **Issue premises not probed at slicing** (`issue-premise-unchecked`; recurrence, now the third retro that names it). #153's description of which file reads `category_name` and what the row contains was not checked against the code. One grep for `TxnItem` in `TransactionsPage.tsx` would have shown it. Seat: plan. Cost here was small: the implementer found it at once. Same shape as #135 and #140.
- **Second-opinion seat unreliable** (`second-opinion-seat-failed`; recurrence, but with a different cause each time: an invalid OpenRouter key before, a missing PR number plus a blocked raw-diff send now). The cause this time is that the seat's entry point assumes a PR exists and review runs before the PR. Whether the seat works at all in the lane's pre-commit position is unclear from the record; I did not look into the script.

## What worked well, keep it

- **A conductor decision on the open question before build.** End-optional was open in the issue. The conductor read the doc, picked both-optional and gave the reason, so the implementer had no fork to guess at.
- **Review found a real defect in a green diff.** The group-name init in `formData.category` would have failed at PATCH (400). Gate and implementer tests were green; the reviewer traced the value to `isKnownCategory`.
- **Mutation checking found test gaps cheaply.** test-guard's survivors on #139 (1 of 10, equivalent) and #153 (2, one equivalent, one real) were each named and either explained or covered.
- **Surfacing, not absorbing.** The two out-of-fence findings became issues rather than edits (below). `TransactionsPage.tsx` was not touched despite the issue's claim.
- **Separate review-fix commits.** Even with the cost in (2), the commits read as build then response, and the second reader sees only the response.
- **Parallel implementers on disjoint files** worked without incident.

## Surfaced and filed

- **#168** (Housekeeping): `docs/prds/prd-01` line 88 and Ruling 10 still say the first run reads 730 days. The PRD is outside the fence, and the PRD wins over code comments, so the code now cites a ruling whose text disagrees until #168 lands.
- **#169** (Housekeeping): an unparseable `started_at` sorts after ISO text, so it stays "latest success" and every later run fetches full history. Pre-existing; #139 makes it costlier, since "full history" is now unbounded rather than 730 days.
- Not filed: nothing else. The `MAX_PAGES` ceiling (50,000 rows) was reported by the reviewer as info and left as a known limit.

## Recommended changes

1. **Dispatch order: mutation-checking seats run alone on their file set (high leverage, first occurrence, so record only until it recurs).** Run test-guard after the reviewer has finished, or require test-guard to mutate only in a scratch copy (`git worktree add --detach`). Artifact: `~/.claude/agents/test-guard.md` (the in-place mutation instruction) and the dispatch checklist in the `parallel-agents` skill. Do not encode on one occurrence; record it here and encode on the second.
2. **Commit the build before dispatching review seats (medium leverage, second occurrence, so encode).** Then reviewer edits are the review-fix commit with no reconstruction. Artifact: the lane handoff text the conductor sends, and the project's CLAUDE.md pipeline step order if it differs. Alternative: reviewers report patches and do not edit. Pick one; the first is simpler.
3. **Issue template: file facts get a command (second-plus occurrence, so encode).** Any claim of the form "file X reads/renders Y" carries the grep that showed it. Artifact: the issue template used by the slicing seat (not in this repo; the conductor owns it). Same text as the earlier retro's change 1.
4. **Second-opinion seat: decide whether it belongs before the PR exists.** Either make the script take a branch or diff path, or drop the seat from pre-PR lanes. Artifact: the seat's script and the retro-recorded line in `~/.claude/workflow-changes.md`. Not encoded from this retro; flagged because it has now failed in several retros for different reasons.
5. **Follow #168.** Until the PRD text is changed, anyone reading prd-01 Ruling 10 gets 730 days. Tracked in #168.

## Highest-leverage next step

Change 2: commit the build before any review seat is dispatched, written into the lane handoff text. It removes the reconstruction step (cost 2) and also shrinks the window in which a mutating seat can corrupt the tree the reviewer reads (cost 1). The same mixing showed up in the #140/#141 bundle, where review fixes were folded into the build commit instead.

## Baseline narrative

- **code_type:** A sync-layer behaviour change (#139: optional `start`/`end` on `listTransactions`, first sync sends no window) and a UI component change (#153: Category cell in `TxnItem`), both with tests.

- **built:** #139: `listTransactions` takes `{ start?: Date; end?: Date }` and `windowQuery` sends only the bounds given, still refusing invalid or reversed bounds before any request; `windowFor` returns `{}` on the first run, so the first sync sends neither bound (the form `docs/akahu-pending-semantics.md` §3 documents as everything accessible); the 730-day `FIRST_RUN_LOOKBACK_MS` is removed. 5 client tests and 1 run test added, 3 run tests changed. #153: `TxnItem` gets a Category cell showing the effective category plus a group derived from its name through a `Map` over `data/cats.js`, with `formData.category` from `category ?? ''`. Four commits; tsc and lint clean, vitest 1229 then 1230 passed after each.

- **how:** Gear 2 for both. Two haiku implementers ran in parallel on disjoint files. The conductor settled #139's open question (end optional) as both-optional from the doc. Each issue then got reviewer and test-guard (#153 also brand-checker); review fixes went in their own commits, separate from the builds. #139 reviewer: 2 findings (1 comment fixed, 1 info about the 50,000-row `MAX_PAGES` cap on the first run). #153 reviewer: 4 findings, 3 fixed. test-guard: 10 mutations on #139 with 1 equivalent survivor; 2 survivors on #153, one equivalent and one the untested `useState` init, later covered. Filed #168 (PRD text still says 730 days) and #169 (an unparseable `started_at` stays "latest success", and every run then fetches full history).

- **wrong:** (1) #153's test-guard mutated `TxnItem.tsx` in place while the reviewer ran tests in the same worktree, giving the reviewer a false red; the reviewer moved to a scratch worktree. Cause: two seats launched in parallel on the same files, one mutating in place. (2) Reviewer edits were mixed with the build in the working tree, so the conductor had to reconstruct the pre-review state to keep review fixes in separate commits. (3) The #139 second-opinion seat could not run: the script needs a PR number and sending the raw diff to OpenRouter was blocked by permissions. (4) Issue #153 had inaccurate file facts (the page reads nothing; the row had no category cell; Missed-by: plan, a recurrence of `issue-premise-unchecked`). Highest-leverage fix: commit the build before dispatching review seats.
