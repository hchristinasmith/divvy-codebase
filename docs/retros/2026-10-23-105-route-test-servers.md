# Retro: #105 route tests serve on 127.0.0.1

Gear 3 as stamped (a new exported helper and type); no shift. Three commits: e28e05f (helper plus the transactions test), 12fa1fc (server, barrel, categories and akahu tests), 9b4b657 (`docs/testing.md` example). Each was gated green at 39 files, 524 tests. The implementer ran on opus per the lane's model table, overriding the issue's `model: sonnet`. The run is recorded in Baseline (run 3f32a0b6-60ef-4f47-90f4-cb270f90af03); this retro is posted there after `baseline finish`. Rebase onto `origin/main` is still to come: main has moved (another lane deleted `mcp/spike` and edited `.prettierignore`, and a Housekeeping lane is editing other parts of `docs/testing.md`).

## What was built

- **Kind of code:** a shared test helper plus a mechanical migration of five route test files. No production code changed.
- **Pattern:** `serveOnLoopback(httpApp)` in `server/test-utils/app.ts` creates one `http.createServer` per test, listening on `127.0.0.1` port 0, and returns `{ api, close }`. `api` is `request(httpServer)`, so every call goes to the already-listening server. `close()` drops keep-alive sockets, then closes, and does nothing if the server is not listening. The helper does not touch the database. Each test file keeps `served` and `api` in module scope, builds them in `beforeEach`, and calls `served?.close()` in `afterEach`.
- **Why this shape:** the alternative was copying #97's inline `createServer` into each file. One helper was chosen so new route tests start from the safe pattern; `docs/testing.md` now shows it. That is why the issue is gear 3.

## What happened

- **Plan (architect):** one DB-agnostic helper, variable name `api`, three commits, and two temporary breaks (A: bind `'::'`, B: no-op `close()`) to prove the helper does something.
- **Baseline soak on unmodified code:** 30 runs per file while two `npx vitest run` loops ran concurrently. 150/150 file runs passed and 60/60 loop runs passed. **The race did not reproduce on the old code.**
- **Build (implementer, opus, high):** the three commits above. `grep -rn "request(server)\|request(app)" server` returns nothing.
- **Review:** the reviewer found 0 new findings, re-ran the gate green and re-ran the mutations. Test-guard confirmed no `it` or `expect` was dropped in any file and the gate was green. Docs-syncer made no edits.
- **Final soak on the new code:** 150/150 file runs and 58/58 loop runs passed.
- **Exit criteria:** the grep is empty and each of the five files passed 30 consecutive runs under two concurrent loops. Both are met, but see the first item below on what the soak proves.

## What went wrong

- **The soak cannot show the fix works.** 150/150 on the old code and 150/150 on the new code is "no regression", not "fixed". The #97 retro saw 3/100 failures on the old file at 6 concurrent suites; this soak ran at 2 and saw none. The fix rests on one fact the reviewer read in supertest 6.3.4 `lib/test.js`: it only calls `listen(0)` when `app.address()` is null, so a server that is already listening is used as is. That is a code reading, not an observed result in this run. The issue's exit criterion (30 runs under two loops) was too weak to tell fixed from lucky, and the plan inherited it.
- **Breaks A and B turned nothing red.** The architect's temporary breaks were meant to show the helper's two properties are tested. Binding `'::'` and a no-op `close()` both left every test green: supertest always dials `http://127.0.0.1:<port>`, so the route tests cannot see the bind address, and vitest exits with leaked servers. Either regression would reopen the #97 / #105 race without a failing test. The check did its job by finding the gap, but the gap shipped. The helper's own test file, `server/test-utils/__tests__/app.test.ts`, was outside the issue's fence, so it was filed as #114 (Housekeeping, gear 1, `Missed-by: plan`: the slice's fence omitted the helper's own test file).
- **The first step-1 commit was gated on the wrong tree.** The lane parks the other files so the gate sees only what the commit contains. The park loop used an unquoted `$REST` file list, and zsh does not word-split an unquoted variable, so the loop silently did nothing and the gate ran on the whole working tree. It was caught from the error output, not by a check. The lane then re-gated the exact commit-1 tree (HEAD) green using a zsh array. The commit's content was correct throughout, so the cost was one gate re-run, but for a while "gated green" on commit 1 was not true of that commit.
- **"Regression-proof first" produced no commit.** The pipeline asks for regression tests before the change. Here HEAD was already the green baseline and the work is test-only, so there was nothing to commit; it was recorded as the baseline soak instead. That is a reasonable reading, but it means commit 1 does not show the old behaviour green on its own.

## Known gaps left on purpose

- **Helper's bind and close are unpinned.** #114 (above).
- **`CLAUDE.md` line 29** ("Server route tests use supertest against the Express app...") could name `serveOnLoopback`. Docs-syncer noted it and left it, as it is outside the fence. I found no issue filed for it in the record I was given.

## Root causes

- **Plan fence drawn around the call sites, not around the new symbol.** The issue listed the files to migrate and the helper's file, but not the helper's test. A new exported helper owes its own test, and the plan ran break checks A and B without a place to keep their result. Not a tool problem; the slice was wrong, and the plan did not catch it.
- **Exit criterion carried over from #97 without asking if it could fail.** The criterion is "30 runs under two loops". #97's own soak needed a heavier load to see a failure. Here the old code was never seen to fail, so the criterion could not come back negative for the old code.
- **Gate snippet written ad hoc per lane (recurrence, third occurrence).** The names differ each time. The prd02-w1-barrel retro had a bash-only `PIPESTATUS` under zsh, prd02-w1-shell had a `| tail` pipe hiding the exit code, and this run had an unquoted file list under zsh. The cause is the same: the lane writes its own gate and park commands each time, and nothing makes them fail loudly or checks which tree they ran on. The prd02-w1-shell retro recommended `scripts/gate.sh`; `scripts/` does not exist in this worktree, so that recommendation has not landed.

## What worked, keep it

- **Soak the unmodified code first.** It cost one round of runs and gave an honest baseline: it showed the race is rare enough that this soak cannot be the proof, which then pointed the claim at the supertest source.
- **Break checks in the plan.** A and B were planned before the build, run by the implementer and re-run by the reviewer. They found a real gap (#114) that a green gate never would have.
- **A helper with a narrow job.** DB-agnostic, one `api` name everywhere, no change to `freshApp()`. Test-guard's per-file count of `it` and `expect` made the mechanical migration checkable, and nothing was dropped.
- **Fence held.** No `server/routes/*.ts` or `server/db/**` file changed. The out-of-fence finds went to #114 and a note, and were not absorbed.
- **`afterEach` guards a failed `beforeEach`** (`served?.close()`), which carries over the fix the #97 review made.

## Recommended changes

1. **High leverage, now earned (third occurrence):** add `scripts/gate.sh`, as the prd02-w1-shell retro asked: `set -euo pipefail`, one step per line, a printed exit status per step. Extend it with an optional ref argument that gates that commit's exact tree in a temporary detached worktree. That removes the hand-written park loop and answers "which tree did the gate run on?". Do not use `git stash` for it. Point the "Pre-commit checks" section of `CLAUDE.md` at it.
2. **Plan template:** when a slice adds an exported test helper, the fence names the helper's own test file, and the plan's break checks say where each is pinned. Optional until it recurs (first occurrence); the artifact is the architect brief.
3. **Exit criteria for flaky-test issues:** state the load at which the old code was seen to fail, and require the soak to run at that load. Optional; first occurrence for this specific shape. If it recurs, put it in the issue template.
4. **Optional:** have `CLAUDE.md` line 29 name `serveOnLoopback` once this merges. It is a one-line config edit through a branch and PR.

## Highest-leverage next step

Create `scripts/gate.sh` with the exit-code-safe steps and a ref-gating mode, and point `CLAUDE.md` "Pre-commit checks" at it. Three retros in a row have recorded the lane's gate command failing in a new way; this one is the first where a commit was reported gated while the gate saw a different tree.

## PR paragraph

This adds `serveOnLoopback(httpApp)` to `server/test-utils/app.ts`: one HTTP server per test, listening on 127.0.0.1, with supertest bound to it, so the route tests no longer let supertest open an all-interfaces listener per request that another process can shadow (#97). `transactions`, `server`, `barrel`, `categories` and `akahu` tests use it, and the `docs/testing.md` example shows it; `grep -rn "request(server)\|request(app)" server` is empty. Gate green at 39 files, 524 tests. The soak (30 runs per file under two concurrent suites) passed 150/150 on both old and new code. The race never reproduced on the old code, so it shows no regression, not that the fix works; the fix rests on supertest 6.3.4 only calling `listen(0)` when the app is not already listening. Temporary breaks (bind `'::'`, no-op `close()`) turned nothing red, because no test pins either; follow-up #114 (Housekeeping) adds those tests. Gear 3, no shift.
