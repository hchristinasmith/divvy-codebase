# Retro: #177 fixed-text JSON error handler for /api, with #173 bundled (one copy of the schema-info test helpers)

Bundle of two housekeeping issues in one lane, one PR. #177 carried no gear line (treated as gear 1-2); #173 was stamped gear 1. Reported shift, #173: `shifted 1 -> 3: new exported symbols` (the literal trigger; see "What went wrong"). No architect, per the handoff. Implementers ran in parallel in one worktree, #177 on opus and #173 on haiku, with disjoint fences and no collision. Reviewer found 2 things, both fixed. security-auditor: 0 critical, 2 warnings, both filed. test-guard ran 19 mutations. No stash. Commits: 4179b5d (#177 build), d0d2601 (#173 build), 10ea225 (#177 review fix), 766444c (#173 review fix). Merge with `gh pr merge <N> --merge --delete-branch` so the per-issue commits survive; the merger closes #177 and #173 by hand. origin/main moved after the cut (#182, scheduler); the rebase happens after this retro. This file states no Baseline telemetry. I did not re-run the gate; the dispatch says it passed on the final state and at every commit (tsc 0, lint 0, vitest 53 files, 1278 passed, 3 skipped).

## What was built

- **#177, kind of code:** one Express error-handling middleware in `server/server.ts`, mounted at `/api`, last. `entity.parse.failed` answers 400 `{ error: 'Bad request' }`; anything else answers 500 `{ error: 'Internal server error' }` and logs only `err.stack`, never the error object (body-parser keeps the raw request text in `err.body`). Other paths keep Express's default. Before this, a malformed JSON body got an HTML page with the stack and absolute paths.
- **#177, test pattern:** `server/__tests__/errors.test.ts` wraps the route barrel with `vi.mock`, adding two stand-in routes that fail on purpose (one throws, one calls `next(err)`), so a route error can be provoked and no router file changed.
- **#173:** `server/db/__tests__/schemaInfo.ts` exports `columns`, `sequence`, `count` and `notNullColumns`, each taking `db`. `prd01-schema.test.ts` and `prd02-tables.test.ts` import them instead of carrying inline copies. Test-only; net -50 lines in those two files.

## What happened

1. **Parallel build, one worktree.** The two issues touched disjoint files, so both implementers ran at once. Neither touched the other's files. The dispatch reports the gate green at every commit.
2. **The "same test names and counts" check for #173.** The handoff suggested a plain diff of verbose reporter output before and after. Reporter output order is nondeterministic, so that diff was non-empty on unchanged code. A sorted comparison was identical (130 = 130). No time lost beyond one confusing run, but the suggested check would have raised a false alarm on every future run.
3. **Implementer surfaced an async-rejection gap in #177.** Express 4 does not route a rejected promise from an async handler to the error middleware. Not absorbed; filed as #186.
4. **Reviewer F1 on #177 (EXECUTED).** See below.
5. **Reviewer F2 on #173.** See below.
6. **security-auditor.** W1: `akahu.ts` sends the raw `err.message` in a response. Pre-existing and outside the fence; filed as #184. W2: 413 (body too large), 415 (unsupported media type) and a `URIError` all become a 500 plus a logged stack. That is what the issue's text asked for ("otherwise 500"), so the code is right and the spec is thin; filed as #185.
7. **test-guard.** 19 mutations. Survivors: one equivalent mutant (mounting by regex instead of `'/api'` behaves the same) and the `headersSent` branch, which was already known to be untested (nothing in the stand-in routes writes headers before failing). Nothing to fix.

## What went wrong

- **F1: a comment promised something no test checked.** The handler's comment says the log carries the stack "never the error object". The first test only asserted that the *response* held no secret and that `console.error` was called once. The reviewer mutated the log call to `console.error(err)` and the suite stayed green. That is the exact leak the comment promises against, since `err.body` holds raw request text. Also, the stand-in route put the secret in `body` as the same string as the message, so even a test that inspected the log could not have told the two apart. Fixed in 10ea225: a separate `FIELD_SECRET` carried only in `err.body`, asserted absent from the response and from `inspect(errorLog.mock.calls)`. Cost: one review round, 9 lines.
- **F2: the exit grep could pass with a copy left behind.** #173's exit check grepped for `function sequence`. `migration-guards.test.ts` read `sqlite_sequence` inline, in the body of a differently named function, so the grep found nothing and the copy was a fifth one. The reviewer found it by reading for the body, not the declaration. Fixed in 766444c (`survivors()` now calls `sequence()`). Cost: one review round, 2 lines. #173 is itself the follow-up to F2 of the #165/#166 retro (duplicate helpers in the same test dir), so this is the second time a helper-copy cleanup was incomplete the first time.
- **The gear trigger fired on a test-only helper file.** "A new exported symbol" lifted #173 from 1 to 3. The four exports are exactly what the issue required, they follow the same pattern as `omit.ts` and `migrateToJustBefore.ts` in #165/#166, and nothing production imports them. The shift was reported as the list says, but the trigger describes risk (a public contract) and here there is none. Second lane to hit it (#165/#166 reported the same shift for `omit.ts`).
- **W2 was a plan-stage miss.** The issue's "otherwise 500" was taken literally and nobody asked what else reaches the handler: payload too large, wrong content type, a bad percent-encoding. All three are client errors that now answer 500 and log a stack. The implementation is correct against the text; the text was never tested against what body-parser actually throws.

## Root causes

- **The check the issue named could pass without the property being true (F1, F2, and in a weaker form the sorted-diff note).** F1: "the response does not leak" was checked, "the log does not leak" was only promised. F2: "no `function sequence` left" was checked, "no copy of sequence left" was the goal. The handoff's unsorted diff is a third version: the named check could fail without the property being false. All three are a proxy standing in for the property, and in the same place each time: the issue or handoff author wrote the verification as a command or assertion, and the implementer ran it as written. The reviewer's mutation (F1) and body-read (F2) are what caught them. The record does not show either implementer asking whether their check could be fooled.
- **Spec written from the happy case (W2).** "Malformed JSON -> 400, otherwise 500" names the one error the author was thinking about and a catch-all for the rest. The catch-all is where the real traffic is. No seat before the build was asked about it; the security-auditor found it afterwards. The gear-1/2 path has no architect by design, and this was not obviously an architect-sized problem, so the right fix is in the issue template, not a new seat.
- **Gear trigger is blind to test-only code.** The "new exported symbol" row of the shift table cannot tell a public contract from a helper imported by two test files. Cause: the table was written for production exports; the repo's `__tests__/` helpers fall under it by wording only.

## What worked, keep it

- **Parallel implementers on disjoint fences.** Both built at once, no collision, one combined gate. Fences were stated before dispatch and held.
- **Mocking the barrel to provoke errors.** No router file changed, so #177 stayed inside its fence and the test is the only thing that knows about the failing routes.
- **Reviewer verified by mutation, not by reading.** F1 was found by changing the code and watching the suite stay green; test-guard's 19 mutations confirm the rest, and its two survivors are named and explained.
- **Follow-ups filed with the origin and not absorbed:** #184 (outside the fence), #185 (spec gap), #186 (async rejection). The implementer surfaced #186 and stopped instead of folding in an `express-async-errors`-style fix.
- **Checking the count claim by sorted comparison** instead of trusting the unsorted diff or assuming a pass.

## Recommended changes

1. **Make exit checks property checks, in the handoff and issue template.** When the exit criterion is "no more copies of X", the handoff names a grep for the *body* (here `sqlite_sequence`), and the implementer reports what the grep matched. When the criterion is "does not leak", the handoff says which channels (response, log, thrown value) and the test asserts each. Artifact: the conductor's lane handoff template and the issue template under `.github/ISSUE_TEMPLATE/` if one exists (check; otherwise the template used by the slicing session). Second named occurrence of the cause, so this is the point to encode it, in a sentence and not a procedure.
2. **Sort before diffing test names.** Replace the suggested check with `vitest run --reporter=verbose | sort > file` on both sides. Artifact: the handoff template's "same test names and counts" line. Optional, tiny.
3. **State what else reaches a catch-all in the issue.** For an error-handler or fallback issue, the issue lists the other things that arrive there and what each should do. Here that was 413, 415, `URIError`. Artifact: the same issue template as 1. Optional; first occurrence.
4. **Exempt `server/**/__tests__/**` helpers from the "new exported symbol" row**, or say in the table that a symbol imported only by tests does not shift the gear. Second lane to report it, so this is the point to encode it. Artifact: `~/.claude/CLAUDE.md`, "Gears", and via `pnpm import-workflow` the project's copy. A change to a workflow file, so it owes a pre-test and a marker in `~/.claude/workflow-changes.md`: the marker is the count of test-only shifts reported in PR bodies over the next 10 lanes. Not done in this lane.

## Highest-leverage next step

Add one line to the lane handoff template: "an exit check must fail if the property is false and pass only if it is true; for 'no copy of X', grep for X's body, and report what the grep matched." It would have turned both reviewer findings into implementer-time catches, and it applies to every cleanup and every "does not leak" issue, not just this pair.

## Open items for the PR body

- Gear shift, one line: `shifted 1 -> 3: #173 adds new exported symbols (columns, sequence, count, notNullColumns), test-only`.
- Follow-ups filed: #184 (akahu.ts raw err.message), #185 (413/415/URIError become 500), #186 (async rejection gap). Each needs `Spawned-by` and `Missed-by` lines: #184 `Missed-by: none` (pre-existing, outside the fence), #185 `Missed-by: plan`, #186 `Missed-by: none`. Check they are on the issues.
- Surviving mutants from test-guard: regex mount (equivalent) and the `headersSent` branch (known, untested).
- Rebase on origin/main (moved by #182) before the PR.
- Merge with `--merge`; close #177 and #173 by hand with a reason.
