# Retro: #206, one helper ranks `sync_runs` by `started_at` for every reader

Gear 3 as stamped (a new exported symbol, `rankByStartedAt`). No gear shift. This file states no telemetry (model, duration, tokens, tool calls); the lane posts the four narratives after `baseline finish`.

Seats run: architect, implementer (opus, several resumes), reviewer (two passes), test-guard (two passes), this retro. `schema-reviewer`, `brand-checker` and `security-auditor` do not apply (no migration, no UI, no route added or hook). Verify passed on the final state (ff21e6b): `npx tsc --noEmit` exit 0, `npm run lint` exit 0, `npx vitest run` 114 files / 4911 tests. Load reached 140 during one run; nothing failed under it.

Commits (`git log --oneline origin/main..HEAD`): 1799d37 build, b814dd7 reviewer fix, 318544d test-guard gaps, 29ad013 option B (overview), 86eeae0 reviewer fix, ff21e6b test-guard gap. The three-dot diff is seven files, +248 / -39.

## What was built

- **Kind of code:** a de-duplication refactor of a SQL ranking, plus tests. No new behaviour, no migration, no route added.
- **Pattern:** `server/sync/ranked-runs.ts` exports `rankByStartedAt(query)`. It applies the exact-`toISOString()` `strftime` filter, then `julianday(started_at) DESC`, then `id` desc. The claim step in `server/sync/run.ts`, both queries in `GET /sync/status` (`server/routes/sync.ts`) and the `dataAsOf` read in `server/db/overview.ts` all go through it. The helper takes and returns a Knex query builder, so each caller keeps its own `where` and select.
- **Guard:** `ranked-runs.test.ts` holds a static test that reads every `.ts` and `.js` file under `server/` and fails if the filter or the ordering appears outside the helper. Behaviour is pinned by the caller tests.
- **New edge:** `server/db` now imports from `server/sync`. It is a type-only knex import in the helper, so there is no cycle, and lint has no rule against the edge.

## What went wrong

1. **A fourth copy was missed at slicing (Missed-by: plan).** The handoff named three copies: the claim step and two queries in `GET /sync/status`. The architect found a fourth in `server/db/overview.ts` (`dataAsOf`), which was fenced to another lane. The lane stopped, as the fence rule requires, and raised Baseline decision f729eec8. Hannah picked option B and widened the fence to `overview.ts`, the `dataAsOf` query only. Cost: a decision round-trip and a late widening of the helper's scope and of the guard; the build and tests that did not depend on the answer ran while it waited, so the wait was not idle. #188 and #206 were both written from the `run.ts` / route pair, and nobody grepped `server/` for the filter text when slicing.
2. **The first decision raise was refused.** `fence` must be an object, not a string. One retry; the cause is the decision file's schema, which the lane wrote from memory of its shape. Cost: minutes.
3. **The static guard matched one exact spelling (Missed-by: do, caught by review).** An unspaced copy of the filter, or a copy of the ordering alone, stayed green. Fixed in b814dd7 so a reformatted copy or an ordering-only copy is found.
4. **The guard then ignored `.js` (Missed-by: do, caught by review).** `knexfile`, migrations and seeds are `.js` under `server/`. Fixed in 86eeae0. Same shape as item 3: the guard was written to the copies in view, not to the ways a copy can be written.
5. **Caller tests were written to the strings that come to mind (Missed-by: do, caught by test-guard).** The existing #169 and #188 `'not-a-timestamp'` cases never exercised the filter: `julianday` of it is NULL and NULL sorts last under `DESC`, so it ranks last with or without the filter. Only `'now'` and the no-milliseconds ISO (`'2999-01-01T00:00:00Z'`) do. The claim step had no test for the no-milliseconds start, and no test split same-second milliseconds from the `id` tie-break (fixed in 318544d). The same gap then recurred at the new caller: `dataAsOf` ordering was unpinned, because the existing fixtures were in the same order by id, start and finish (fixed in ff21e6b, and a no-milliseconds start test added in 29ad013).
6. **Pre-existing, not touched:** `run.ts` and `run.test.ts` fail `prettier --check` at HEAD; lint passes. Left alone as out of scope.

## Root causes

- **Slicing from the pair in view, not from a search (item 1).** The copy was a literal string (`strftime('%Y-%m-%dT%H:%M:%fZ', started_at) = started_at`), and one `grep` over `server/` finds it. The issue was sliced from the two files the earlier fix touched. I cannot say from the record whether #188 also looked for other copies; its retro does not mention a search.
- **`proxy-check-passes-without-the-property`** (reused name; first in #177, second in #188). The `'not-a-timestamp'` test looks like it covers the filter and does not; only deleting the filter shows it. This lane did not repeat it in new tests, but it found the old tests repeating it at the claim step and had to add the inputs only the filter rejects.
- **`author-blind-spot-on-own-mutants`** (reused name; #188 and #233). The helper's author checked the cases the author thought of, and test-guard found what was left at each caller. The same happened to the guard test itself (items 3, 4): the author's list of ways to write a copy was shorter than the real list.
- **Static guards are syntactic.** A copy that qualifies the column (`julianday(sync_runs.started_at)`) would escape the guard. That is a property of the approach, not a bug in this one, and it is why behaviour is pinned by the caller tests and the guard is only a tripwire.

## What worked, keep it

- **Stopping on the fourth copy and raising a decision** instead of absorbing `overview.ts` into the diff. The fence held and Hannah chose with the options in front of her; the independent work ran during the wait.
- **Mutations run in scratch copies, never the worktree** (EXECUTED): filter removed, `julianday` ASC, id tie-break dropped or flipped, `julianday IS NOT NULL` in place of the filter, `%S` for `%f`, and an inline `LIKE` copy at each caller. All red except four equivalent survivors, which are named rather than hidden: text `started_at DESC` (fixed width once filtered), `.where` placed after the helper (same SQL), no tie-break at all (SQLite returns the higher id first on these ties anyway), and `connection` versus the passed `db` in overview (every test passes `connection`).
- **Option B was byte-identical SQL.** The `dataAsOf` change goes through the helper and `toString` shows the same SQL as before, so the existing overview tests were a fair regression check before the new ones.
- **Separate seats found separate things.** The reviewer found two guard holes; test-guard found three test gaps at the callers. None of the five was in the implementer's own list.

## Surfaced, not absorbed

- `run.ts` and `run.test.ts` fail `prettier --check` at HEAD. Not touched.
- The guard cannot see a copy that qualifies the column. Accepted; see Root causes.
- No follow-up issue is recorded here for either; I was not given an issue number for them, so the lane should file them if wanted (Housekeeping, `Spawned-by: #206`).

## Recommended changes

1. **Add to `docs/testing.md`'s assertion rules: a test for a new guard must be red with the guard deleted, on an input only the guard rejects (not NULL-sorted garbage, not a value the clock makes true by accident).** This is the third retro to name `proxy-check-passes-without-the-property` and the #188 retro already asked for this exact line; I find no such line in `docs/testing.md` at HEAD. Encode now. High leverage, one paragraph. Artifact: `docs/testing.md`.
2. **When slicing a de-duplication issue, grep the repo for the duplicated text and list every hit in the issue, each with its lane or fence.** Single occurrence in this corpus; the cost here was one decision round-trip, not a defect. Do not encode a rule yet; if it recurs, add it to the slicing checklist in the issue template. Artifact if it recurs: the issue-slicing step in the conductor's skill.
3. **When a static guard is written, list the ways to write the thing it forbids (spacing, line breaks, the ordering alone, other file extensions) in the test's own comment and test each.** Items 3 and 4 were the same miss twice in one lane. Single lane, so optional; the guard test now shows the shape to copy. Artifact: `server/sync/__tests__/ranked-runs.test.ts` as the example.

## Highest-leverage next step

Do recommendation 1: add the "red with the guard deleted, on an input only the guard rejects" rule to `docs/testing.md`. It has now been asked for and not written across three retros, and it would have caught the `'not-a-timestamp'` cases at the time #169 and #188 were written, instead of at test-guard in this lane.

## Open items for the PR body

- Gear 3 as stamped; no shift. Fence widened by Hannah's decision f729eec8 (option B) to `server/db/overview.ts`, the `dataAsOf` query only. Nothing else in `overview.ts` is touched.
- Behaviour: no change for valid starts. The SQL for `dataAsOf` is byte-identical through the helper.
- Gate on ff21e6b: tsc 0, lint 0, vitest 114 files / 4911 tests.
- Pre-existing and untouched: `prettier --check` fails on `run.ts` and `run.test.ts` at HEAD.
- Reviewer findings fixed (b814dd7, 86eeae0); test-guard Warnings closed by new tests (318544d, ff21e6b).

## Baseline narratives

These four are the text for the retro POST (`narrative_code_type`, `narrative_built`, `narrative_how`, `narrative_wrong`).

### narrative_code_type

A de-duplication refactor of a SQL ranking, with tests: one helper replaces four hand-copied orderings of `sync_runs` by start time. No new behaviour, no migration, no route. Gear 3 as stamped, for the new exported helper.

### narrative_built

`server/sync/ranked-runs.ts` exports `rankByStartedAt`, which keeps only starts in the exact `toISOString()` form, orders by `julianday(started_at)` descending, and breaks ties to the higher id. The claim step in `server/sync/run.ts`, both queries in `GET /sync/status` and the `dataAsOf` read in `server/db/overview.ts` now use it. A new `ranked-runs.test.ts` holds a static guard over all `.ts` and `.js` files under `server/` plus helper behaviour tests; caller tests were added for the claim step and the overview. Gate: tsc and lint clean, vitest 114 files / 4911 tests.

### narrative_how

The architect found a fourth copy in `overview.ts`, which another lane's fence covered. The lane stopped and raised Baseline decision f729eec8; the first raise was refused for a malformed `fence` field. Hannah chose option B and widened the fence to the `dataAsOf` query. Work that did not depend on the answer ran while it waited. The reviewer found the static guard matched one exact spelling, then that it ignored `.js` files; test-guard found missing tests at the claim step (no-milliseconds start, same-second milliseconds against id) and at `dataAsOf` (ordering unpinned). Each was fixed in its own commit. Mutations were run in scratch copies: all killed except four equivalent survivors, which are named.

### narrative_wrong

The handoff named three copies and the repo had four; nobody grepped `server/` for the filter text when #188 and #206 were sliced (Missed-by: plan), which cost a decision round-trip. The static guard was written to the copies in view and missed reformatted copies and `.js` files, caught by review. The old `'not-a-timestamp'` tests never exercised the filter (NULL sorts last), and the same kind of gap recurred at the new caller, caught by test-guard; this is `proxy-check-passes-without-the-property` and `author-blind-spot-on-own-mutants` again. A guard that is syntactic cannot see a copy that qualifies the column; behaviour is pinned by the caller tests. `run.ts` and `run.test.ts` fail `prettier --check` at HEAD, untouched.
