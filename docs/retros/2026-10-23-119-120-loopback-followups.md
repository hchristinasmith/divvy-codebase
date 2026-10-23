# Retro: #119 and #120 loopback follow-ups, one bundled lane

Both issues gear 1 as stamped, test-only, Housekeeping, `Spawned-by: #114`; no shift. Three commits: b0d3930 (#119), 0d7184c (#120), 41ba6d5 (review fix on #120, committed separately). Two implementers ran in parallel on separate files, on haiku per the lane's model table. Baseline run `260b22ef-aea0-4b28-baab-0279a7cbf9f6`; this file states no telemetry (model, duration, tokens, tool calls), and the lane posts the four narratives after `baseline finish`. Gate green at every commit: tsc 0, lint 0, vitest 41 files / 608 tests. After rebasing onto #122: vitest 42 files / 611 tests. Seats run: implementer x2, reviewer, test-guard, retro-writer. This retro file sits outside the issues' fences, as the lane handoff directs.

## What was built

- **Kind of code:** two edits to existing test files. No production code changed; `server/test-utils/app.ts` is byte-identical to HEAD.
- **#119:** one test in `describe('serveOnLoopback')` in `server/test-utils/__tests__/app.test.ts`. A route takes a request and never answers it; the test calls `close()` and races it against a 1000 ms timer, then asserts the outcome is `'closed'` and the client sees `ECONNRESET`. This pins `closeAllConnections()` in the helper's `close()`.
- **#120:** `client/apis/__tests__/apiClient.test.ts` binds `listen(0, '127.0.0.1', cb)` and builds `baseURI` from the bound address. The listen is wrapped in a Promise that rejects on `'error'`, the same shape as `serveOnLoopback`.
- **Why #119 uses a request in flight:** the issue suggested an idle keep-alive socket. That test cannot go red; see below.

## What happened

- **#119, premise checked before building.** At dispatch the lane saw that on Node v22 `server.close()` already drops idle keep-alive sockets, so the issue's suggested test would stay green with `closeAllConnections()` deleted. It briefed the implementer to use a request in flight instead. The reviewer then EXECUTED a probe that confirmed it: the idle keep-alive case, without `closeAllConnections`, left `closed sockets left in agent: 1`: the idle socket was already closed by `close()`, so the mutation was invisible to that test.
- **#119, red proof.** With `closeAllConnections()` removed, the new test fails with `close() waited on the request in flight: expected 'still open' to be 'closed'`, 1 failed | 7 passed. The reviewer also swapped it for `closeIdleConnections()` and got red, which shows the test separates "drop idle" from "drop all". Stability: 20/20 sequential runs and 8/8 under CPU load, all green.
- **#120, build.** `listen(0)` became `listen(0, '127.0.0.1', cb)`. grep for `listen(` across `client server mcp shared`: 9 hits before, 8 after. The two test-side listens that remain, in `serveOnLoopback` and this file, both name 127.0.0.1.
- **#120, review finding F1, fixed in 41ba6d5.** The implementer's listen Promise never rejected on `'error'`. A failed bind (port in use, bad address) would give a 10 s hook timeout, then a misleading `TypeError` from `afterAll` calling `close()` on an undefined server. Fix: reject on `'error'`, remove the listener on success. Cost: one review round and one extra commit.
- **test-guard:** covered and gated.

## What went wrong

- **Issue #119 prescribed a test method that cannot fail on this runtime.** Built as written, it would have passed with `closeAllConnections()` deleted, which is the exact gap the issue exists to close. The lane caught it before dispatch, so the cost was a changed brief, not a wasted build. The method was not run against Node v22 when the follow-up was filed. `Missed-by: plan`, as with the property list in #114.
- **Finding 1: the #120 implementer left out error handling that the sibling helper already had.** `serveOnLoopback` rejects on `'error'`; the implementer's version, which the lane briefed to match it, did not. The `127.0.0.1` argument was copied and the handling around it was not. The lane's brief asked it to await the `'listening'` callback but did not name `'error'` handling. `Missed-by: do` (implementer); review caught it.
- **The #120 bind host cannot be tested.** The bind is not observable from a test in that file, so reverting to `listen(0)` stays green. The grep for `listen(` is the only enforcement, and nothing runs it. This is a limit of the change, stated here rather than fixed.

## Root causes

- **A follow-up filed with a method that nobody ran.** #119's suggested approach read plausibly and was wrong for the runtime. The follow-up inherited the shape of #114's finding ("no test pins the keep-alive drop") and added a method on top without the red proof the issue itself demands of every other test. First occurrence under this name.
- **Copy the line, not the pattern.** The brief for #120 pointed at a one-token change. The implementer did what the brief said, and the missing handling was never in the brief. Same family as "implementer works from the diff it was told to make, not from the neighbouring code that already solved it". First occurrence.
- **Underlying both: the red proof was run late.** In both cases the executed evidence (a mutation, a failed bind) came from the reviewer or the lane after the build, not from the issue or the implementer's own pass.

## What worked, keep it

- **Checking the issue's premise at dispatch.** The lane ran the suggestion against the real runtime before briefing, and changed the brief. This is what kept a test that cannot go red out of the repo.
- **The issue's mutation requirement, met by a second seat.** The implementer showed red with `closeAllConnections()` removed; the reviewer added `closeIdleConnections()`, a mutation the brief did not name, and it also went red.
- **Stability checked, not assumed.** The #119 test races a timer, so it was run 20 times sequentially and 8 times under CPU load before the lane trusted it. The failure message names what failed.
- **Review fix as its own commit.** 41ba6d5 shows the second reader only the response to F1.
- **Two implementers on separate files in parallel.** No conflicts; neither touched the other's file or `server/test-utils/app.ts`.
- **Fence held, surfaced not absorbed.** See below.

## Surfaced, not absorbed

- **`apiClient.test.ts` `afterAll` throws a secondary `TypeError` if `beforeAll` failed.** Pre-existing, not touched. F1's fix makes a failed bind reject quickly, but the secondary error still follows it.
- **No `engines` field or `.nvmrc`.** The comment on the #119 test says Node >= 19 already drops idle keep-alive sockets; nothing in the repo enforces that version. The test itself does not depend on it (a request in flight needs `closeAllConnections()` on any version), but the premise in the comment is unchecked. A decision for Hannah.
- **`server/index.ts:5` calls `server.listen(port, ...)` with no host.** Outside both fences, and a deploy question for D4 (tailnet only, no public IP) rather than a test question.

No issues are filed for these by this retro; the conductor decides. Any follow-up carries `Spawned-by` and `Missed-by` on their own lines.

## Recommended changes

1. **Optional, first occurrence of "issue prescribed a method that cannot fail":** do not encode yet. If it recurs, add one line to the issue template for test follow-ups: the issue states the mutation and either shows it red with the suggested method or says the method is untested. Artifact: the follow-up issue template (the conductor's filing checklist; no path in the record, so none is named here).
2. **Optional, first occurrence of "copied the argument, not the pattern":** when a brief says "match what helper X does", name the helper and say "including error handling". Cheaper and more reliable than review catching it every time. Not yet encoded; one occurrence.
3. **Worth checking, not asserted:** `apiClient.test.ts` receives an Express `server` and `serveOnLoopback(httpApp: Express)` takes one. The test may be able to call the helper and drop its own listen, which would remove the duplicated handling and the grep as the only guard. `server/server.ts` is the Express app `freshApp()` already returns, so the types fit; the `document.baseURI` setup and the extra supertest import were not checked. Artifact: a Housekeeping issue, not this lane.
4. **Optional, decision for Hannah:** an `engines`/`.nvmrc` pin for Node. Not needed by the tests; the premise comment is the only thing that leans on it.

## Highest-leverage next step

Check whether `apiClient.test.ts` can use `serveOnLoopback` instead of its own `listen` (item 3). It deletes the copy that F1 came from, puts the bind host under `app.test.ts`'s existing tests (the 127.0.0.1 bind test from #114), and makes the grep unnecessary. It is a Housekeeping issue for another lane.

## PR paragraph

This adds a test that `serveOnLoopback`'s `close()` ends a request still in flight (`server/test-utils/__tests__/app.test.ts`), and binds the `apiClient` test server to `127.0.0.1` (`client/apis/__tests__/apiClient.test.ts`). The issue for #119 suggested an idle keep-alive socket; on Node v22 `close()` already drops those, so that test would stay green with `closeAllConnections()` deleted (the reviewer ran a probe to confirm). The test uses a request in flight and races `close()` against a 1000 ms timer. Without `closeAllConnections()` it fails with `close() waited on the request in flight: expected 'still open' to be 'closed'`, and with `closeIdleConnections()` it also fails. It passed 20/20 sequential runs and 8/8 under CPU load. For #120, the review found the listen Promise never rejected on `'error'`; fixed in a separate commit. Limit: the bind host is not observable from a test, so only a grep of `listen(` enforces #120. Left alone: `afterAll` in `apiClient.test.ts` throws a secondary `TypeError` if `beforeAll` fails, there is no Node version pin, and `server/index.ts:5` listens with no host. Gate: tsc 0, lint 0, vitest 41 files / 608 tests. Gear 1 for both, no shift. Spawned-by #114.
