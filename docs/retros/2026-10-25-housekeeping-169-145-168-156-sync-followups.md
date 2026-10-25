# Retro: #169 #145 #168 #156 Housekeeping, sync follow-ups (unparseable start, survival test, 730-day wording, stale-run docs)

Bundled lane, branch `fix/169-sync-followups`. All four issues gear 1 to 2 as stamped, all `Priority: housekeeping`; no gear shift. Implementers ran haiku per the gear 1-2 rows of the model table. Commits: `98a3dfe` (#169), `ba2c163` (#145), `f4e2913` (#156), `0a7faa4` (#168), `b5114a9` (review fixes for #169 #145 #156). One commit per issue; review fixes in their own commit. #156 was committed before #168, the opposite of the handoff's order, because #168 waited on a decision. Gate green at every commit; final vitest 1274 passed, 3 skipped, 52 files. Filed as a file, not posted as an issue comment.

## What was built

- **Kind of code:** one behaviour fix in the sync claim step (#169: `server/sync/run.ts`), one test-only proof (#145: `server/sync/__tests__/run.test.ts` plus a comment in a migration), and two doc corrections (#156: `docs/akahu-pending-semantics.md`, `models/sync.ts`, `20261024100002_sync_runs.js` comments; #168: `docs/prds/prd-01-real-data-private-server.md`).
- **#169 pattern:** the "last successful run" query now admits a `started_at` only when it is the exact `toISOString()` form, tested in SQL as `strftime('%Y-%m-%dT%H:%M:%fZ', started_at) = started_at`, then orders by `julianday(started_at) DESC`, then `id`. Anything else is skipped, so `windowFor` never gets a start it cannot parse. The first version used `julianday(started_at) IS NOT NULL` alone; see below for why that was not enough.
- **#145 pattern:** a three-run survival test (run 1 syncs, run 2 updates, run 3 has Akahu drop the card) asserting that user-set account roles and bill links persist. A never-rebuild note in `20261024100001_accounts.js` cites the migration guard (`migration-guards.test.ts`, #165).
- **#168 pattern:** strike through in place plus dated notes. Nothing in the PRD is deleted.

## What happened

- **#169 build.** The claim step ranked `sync_runs.started_at` as text, so `'not-a-timestamp'` sorted after every ISO time, stayed the latest success, and every later run took the first-run window (full history, which #139 had made unbounded). The haiku implementer added `julianday(started_at) IS NOT NULL` with `ORDER BY julianday DESC`. Regression test red before, green after, break-checked.
- **#169 review.** The reviewer found that `julianday()` accepts `'now'`, bare Julian numbers and space-separated times that `Date.parse` rejects (EXECUTED in sqlite3 and node). So the first fix was the same bug under another spelling: a `'now'` start passed the filter and `windowFor` still could not use it. Fixed by admitting only the exact ISO form. New `'now'` test, red on the julianday-only filter. The conductor independently ran 7 strings through the filter: only the 2 exact-ISO ones pass.
- **#145 build.** The implementer added the three-run test and the migration note.
- **#145 review.** The conductor noticed, and the reviewer confirmed by mutation, that runs 2 and 3 never asserted the run's outcome was success. A failed run is rolled back, and rolled-back state still satisfies "roles survive", so a failing sync passed vacuously. Feeding Akahu a `'not json'` accounts body stayed green. The reviewer added outcome asserts. It also replaced a `JSON.parse`/`stringify` fixture edit with a text cut, per the `docs/testing.md` rule. The parse was not a live bug.
- **#168 decision.** The handoff said PRD edits are append-only notes and never rewrite a ruling. The issue's Done-when said no line may still say 730 days. Both could not hold. The lane raised it with `baseline decide --block` (decision `0d763091`) and stopped on it. Hannah picked option B: strike through in place plus dated notes, nothing deleted. #168 was built while the #156 implementer worked in parallel on other files.
- **#156.** Four stale sentences fixed: stale-run recovery happens at claim time, not at boot; the pending replace is across accounts, not per account; no consent-date column. The implementer corrected one proposed wording further: "saying it was interrupted" was also wrong, since the abandoned message is fixed.
- **test-guard.** 12 mutations, 9 red, 3 equivalent survivors: the julianday ordering is redundant once the exact-ISO filter is in, and the id tie-break is unobservable. Two suggestions left open: simplify the ordering or reword its comment; and the `'now'` test depends on the wall clock being later than the fixture `NOW`.

## What went sideways

1. **#169's first fix was incomplete.** The filter accepted strings the consumer rejects. Cost: one review round and a second edit to the same query. No bad code shipped.
2. **#145's test could not fail.** Two of three runs asserted survival without asserting success. Cost: the test looked like proof and was not, until the conductor and reviewer checked. Caught before commit of the review fixes, not before the first commit.
3. **A handoff/issue conflict (#168).** The two instructions were incompatible, and nothing in slicing noticed. Cost: a blocked wait on a decision and a reordered commit sequence. The decision mechanism itself worked.
4. **Parallel implementers in one worktree could not see each other.** The #156 implementer found the in-progress #168 PRD edit in the tree and flagged it as an unknown change. No harm, since the files were disjoint, but it spent attention on a change it did not make and could not identify.
5. **Two small process slips.** Two implementers wrote gate logs to `/tmp/x`, `/tmp/y`, `/tmp/z` instead of the scratchpad. The #168 implementer sent two PRD paragraphs to GitHub's markdown API to check strikethrough rendering; the repo is public, so that text left the machine. Both are low impact (the PRD text was headed for a public repo anyway, and the logs held gate output), but neither was asked for.

## Root causes

- **Validator matched a neighbour, not the consumer** (`validator-matches-neighbour-not-consumer`, first occurrence). The filter was written against "what SQLite will parse" when the real requirement was "what `windowFor` will parse". Those sets differ, and the implementer chose the first because it was one function call. Seat: do (implementer). Caught by review. The reviewer tested the filter against the other parser; the author did not.
- **Authors do not mutate their own tests** (`author-blind-spot-on-own-mutants`, recurrence; named in the 2026-10-23 retro and last seen in the prd01-129 retro as its fourth sighting, so this is at least the fifth). Both #169's gap and #145's vacuous pass were invisible to the seat that wrote them and found by seats that did not. #145 is the sharper case: the missing assertion was on the outcome, the one thing that distinguishes "state survived a good sync" from "state is untouched because the sync rolled back". Seat: do, caught by review (and noticed first by the conductor).
- **Guard tests check the property but not that the run happened** (`survival-test-without-liveness`, first occurrence). A test of the form "X is unchanged after a run" passes when the run does nothing. The same shape as the vacuous-guard concern in the #165 retro, which solved it for migrations with `it.skipIf` and a live canary. Record only.
- **Handoff text contradicted the issue's Done-when** (`handoff-contradicts-done-when`, first occurrence; `Missed-by: plan`). The handoff's "append-only" rule was a general PRD-edit rule applied to an issue whose acceptance criterion needs a rewrite. Nobody compared them before dispatch. Not a lane mistake; the lane caught it and escalated, which is the right outcome.
- **Parallel seats share a worktree** (`parallel-seats-share-worktree`, recurrence of the #139/#153 retro, where it was a mutating test-guard under a reviewer). This time it was two implementers on disjoint files. The cost is lower (an unexplained diff, not a false red) but the cause is the same: seats in one tree cannot see each other's work, and nothing in the dispatch tells each what the other owns.

## What worked well, keep it

- **Review caught the incomplete fix, and the conductor's independent check confirmed it.** The 7-string check is cheap and settled the question without trusting the reviewer's word or the implementer's.
- **Mutation, not reading, found the vacuous test.** Both the conductor's suspicion and the reviewer's confirmation ran the `'not json'` body rather than reasoning about it.
- **Raising the #168 conflict to Baseline instead of picking.** The lane stopped, Hannah chose, and the work followed the answer. No rework, and the choice is recorded.
- **Reordering around the blocked issue.** #156 went first so the lane did not idle on the decision.
- **One commit per issue, review fixes separate.** The review commit reads as the response to the build.
- **Surfacing, not absorbing** (below).
- **An implementer correcting its own proposed wording** on #156 rather than shipping a sentence that was still wrong.

## Surfaced, not absorbed

Left alone because they are outside the fence, or outside the issues' named sentences; report so someone can file them:

- `server/routes/sync.ts` (merged by #27 while this lane ran) ranks `started_at` as text for `lastRun` and `lastSuccessAt`: the same defect as #169, display only. Filed as #188 (Spawned-by: #169, Missed-by: review).
- `docs/akahu-pending-semantics.md`, the bullet at roughly lines 79-82 names the set by `account_id` while the replace is across accounts. In the fence, but not one of #156's four sentences.
- `docs/prds/prd-01-real-data-private-server.md` lines 43 and 81 still say "per account". The Ruling 1 note corrects it, but the sentences remain.
- The prd-02 migration header says sync uses `INSERT ... ON CONFLICT`, while `upsert.ts` reads then updates. Same effect, different mechanism.

## Recommended changes

1. **Liveness assert in survival tests (medium leverage, first occurrence, so record only).** A test that claims state survives a run must first assert the run succeeded. Encode if `survival-test-without-liveness` recurs. Artifact: `docs/testing.md`, under the assertion rules.
2. **Boundary-input checklist: name the consumer (second-plus occurrence of the family, so encode).** Add to the checklist already recommended in earlier retros: when filtering or validating input in SQL for a value parsed later in TypeScript, test the filter against the consumer's parser with the strings SQLite accepts and the consumer rejects (`'now'`, bare numbers, space-separated times). Artifact: `docs/testing.md`. This extends a recommendation that already exists, so it is warranted now.
3. **Dispatch text for parallel implementers states the other's files (first occurrence of this form, record only).** One line in each implementer's prompt: "another implementer is editing X in this tree; changes there are not yours." Artifact: the conductor's lane-handoff text. Encode with the `parallel-seats-share-worktree` fix if it recurs a third time.
4. **Compare handoff constraints with each issue's Done-when at dispatch (first occurrence, record only).** A general rule that an acceptance criterion contradicts should surface before the lane starts, not inside it. Artifact: the conductor's handoff checklist; the repo has none, so this is a note to the conductor.
5. **Scratch output goes to the scratchpad; no repo text to external services (first occurrence, record only).** Implementer prompts should name the scratchpad for logs and say not to send repo content to external APIs for rendering checks. Artifact: the implementer agent file (outside this repo).
6. **test-guard suggestions.** Either simplify the ordering in `claim` to `ORDER BY started_at DESC` (once the filter admits only fixed-width ISO, text order equals time order) or reword its comment; and make the `'now'` test independent of the wall clock. Optional; tracked here, not filed.

## Highest-leverage next step

Change 2: add the "test the filter against the consumer's parser" line to the boundary-input checklist in `docs/testing.md`. It targets the one defect that shipped a wrong first fix and cost a review round, it extends a recommendation made in earlier retros rather than starting a new one, and it is a single line a future implementer or reviewer can apply mechanically.

## Baseline narrative

- **code_type:** A sync-layer fix (#169, last-success selection in `server/sync/run.ts`), a test-only proof (#145, a three-run survival test), and two doc corrections (#156, #168), with regression tests.

- **built:** #169: the claim step's last-success query admits a `started_at` only in the exact `toISOString()` form (`strftime('%Y-%m-%dT%H:%M:%fZ', started_at) = started_at`), ordered by `julianday` then `id`, so an unparseable start can no longer pin every run to the first-run window. #145: a three-run test proving account roles and bill links survive update and an Akahu drop, plus a never-rebuild note in the accounts migration. #156: four stale sentences fixed (recovery at claim time; pending replace across accounts). #168: prd-01's 730-day wording struck through in place with dated notes. Five commits; final vitest 1274 passed, 3 skipped.

- **how:** Gear 1-2 bundle, haiku implementers, one commit per issue and review fixes in their own commit. #168 hit a conflict between the handoff (append-only PRD notes) and the issue's Done-when (no 730 days left); it was raised through `baseline decide --block` and Hannah picked strike-through in place, so #156 was built and committed first. Reviewer and test-guard ran on the diff; test-guard ran 12 mutations, 9 red and 3 equivalent survivors. The conductor independently checked 7 timestamp strings against the #169 filter.

- **wrong:** (1) #169's first fix used `julianday() IS NOT NULL`, which accepts `'now'`, bare numbers and space-separated times that `Date.parse` rejects, so it was the same bug in another spelling; found by the reviewer, fixed with the exact-ISO filter (Missed-by: do). (2) #145's survival test never asserted that runs 2 and 3 succeeded, so a rolled-back run passed vacuously; noticed by the conductor, confirmed by the reviewer by mutation (Missed-by: do). Both are `author-blind-spot-on-own-mutants`. (3) The handoff and #168's Done-when contradicted each other (Missed-by: plan). (4) Parallel implementers in one worktree could not see each other's edits. (5) Two implementers logged to `/tmp` and one sent PRD text to GitHub's markdown API. Highest-leverage fix: add "test the filter against the consumer's parser" to the boundary-input checklist in `docs/testing.md`.
