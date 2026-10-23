# Retro: #97 flaky transactions route test

Gear 1 as stamped, test-only; no shift. Both commits (ed66053 build, 81bc9eb review fix) touch only `server/routes/__tests__/transactions.test.ts`. Nothing was added to `server/test-utils/app.ts`, which avoided a new exported symbol (that would have been gear 3). The implementer ran on haiku per the lane's model table, overriding the issue's `model: sonnet`. The run is recorded in Baseline (run 5f097a07-3839-418f-94b2-9918cac95c2e); this retro is posted there after `baseline finish`.

## What was built

- **Kind of code:** a fix to a supertest route test suite. No production code changed.
- **Pattern:** one real HTTP server per test. `beforeEach` does `createServer(server).listen(0, '127.0.0.1')`, `afterEach` closes it, and every `request(server)` call goes through a local `api` helper. The category loop collects rejected names (`expect(rejected).toEqual([])`) so a failure names the category, and has a 20 s timeout.
- **Why this shape:** the alternative was a shared helper in `server/test-utils`. That is a new exported symbol, so it was left to follow-up #105.

## What happened

The issue guessed "timing under parallel load". The evidence said otherwise.

- **Baseline soak:** 30 runs of the file while 2 full suites looped gave 29/30. The one failure was `socket hang up` / ECONNRESET at `Socket.socketOnEnd` in the category-loop test. The slowest loop run was 640 ms against a 5 s timeout, so it was not a timeout. 2 of the background full-suite runs failed the same way, one in `barrel.test.ts`, outside the fence.
- **Cause:** supertest 6.3.4 given a bare Express app does `http.createServer(app).listen(0)` on all interfaces for every request, 178 times in the category loop. On macOS another process can bind the more specific `127.0.0.1:<same port>`, and the client always dials 127.0.0.1. The request then lands on a foreign server. The reviewer EXECUTED a two-process bind test that confirmed this, and saw a `401 Unauthorized` in the old file's soak. Divvy has no auth, so that 401 can only have come from someone else's server.
- **Ruled out early:** keep-alive pool reuse. Superagent's `agent:false` excludes it.
- **Build:** the fix above. The implementer's break-check was EXECUTED: a bogus 'Groceries' category went red and the failure named it.
- **Review:** the reviewer ran a 100-run soak with 6 concurrent suites. The old file failed 3/100, the new file 0/100. A listener probe found 25 listeners for 25 tests and 0 left open. It also found that `afterEach` threw a misleading TypeError when `beforeEach` failed; 81bc9eb fixes that by skipping teardown when the server never started. Test-guard reported covered and gated, 0 critical, 0 warning.
- **Exit criterion, EXECUTED on the final file:** 30/30 passed while 2 full suites looped (54 background runs, all exit 0), at load average up to about 111.

## What went wrong

- **The issue's diagnosis was wrong.** "Timing under parallel load" would have led to a longer timeout. The 20 s timeout added here is not what fixed the flake. It is only headroom. The reviewer's soak shows this: old file 3/100 failed, new file 0/100.
- **A shared scratch file was overwritten.** The reviewer's scratch `soak.sh` replaced the lane's own harness of the same name in the shared scratch dir. The lane rewrote it as `exit-criterion.sh`. Cost: one rewrite.
- **The reviewer's soak took about 28 minutes of wall clock, and the lane waited on it.** No other work was queued behind it.
- **Test-guard's "covered" had no mutation behind it.** It is read-only and ran none. The mutation evidence came from the implementer and the reviewer, so the claim is true but not from that seat.

## Known gaps left on purpose

- **Same pattern elsewhere.** `server.test`, `barrel.test`, the categories tests and the akahu tests all use bare `request(app)`. Filed as #105. A shared helper in test-utils plus a `docs/testing.md` update makes it gear 3. Seen in the soak: one background failure was in `barrel.test.ts`.
- **The listen has no `'error'` handler.** The reviewer left it, as an error on loopback with port 0 is near-impossible.

## Root causes

- **Library default meets a shared host.** supertest's per-request all-interface listen is the cause, with macOS allowing a more specific bind on the same port. Not a decision and not a tool misuse. The test file was written the standard way.
- **Diagnosis guessed from the symptom.** The issue named a cause before anyone had measured the failure. The soak with the stack trace and the 640 ms timing is what separated misrouting from a timeout.
- **Shared scratch dir with unqualified filenames.** Two seats chose the same script name.

## What worked, keep it

- **Measure first.** A baseline soak under load with the real error text killed the timeout theory before any code was written.
- **Reproduce the mechanism, not only the symptom.** The reviewer's two-process bind test showed that the foreign-server explanation is possible, and the 401 showed it happened.
- **Soak the old and the new file the same way.** 3/100 against 0/100 under identical load is a comparison, not an anecdote.
- **Fence held.** The helper stayed out of test-utils, the other affected files went to #105, and nothing was absorbed.
- **Break-check by the implementer, probes by the reviewer.** The review found a real defect (the misleading TypeError) that the build missed.

## Recommended changes

1. **Optional, first occurrence:** do not encode yet. If a second test file flakes the same way, #105 is where the shared helper and the `docs/testing.md` note go (`server/test-utils/`, `docs/testing.md`).
2. **Lane brief / parallel-agents skill:** tell seats to name scratch scripts with their seat prefix (`reviewer-soak.sh`). Also first occurrence, so record it and change the template only on a repeat.

## Highest-leverage next step

Do #105: put the 127.0.0.1 per-test server in one helper in `server/test-utils/` and add the rule to `docs/testing.md`, so the other four files stop sharing the flake and new route tests start from the safe pattern. It is gear 3, so it needs its own architect pass.

## PR paragraph

This makes `server/routes/__tests__/transactions.test.ts` start one server per test on 127.0.0.1 (`createServer(server).listen(0, '127.0.0.1')` in `beforeEach`, closed in `afterEach`), instead of letting supertest open an all-interfaces listener for each of 178 requests in the category loop. The flake was misrouting, not timing: another process could bind `127.0.0.1:<same port>` while the client dialled 127.0.0.1. Under load the old file failed 3/100 and the new file 0/100; the exit criterion held at 30/30 with 2 full suites looping. Test only, gear 1, no shift. Follow-up #105 covers the same pattern in four other test files. Recorded in Baseline as run 5f097a07-3839-418f-94b2-9918cac95c2e.
