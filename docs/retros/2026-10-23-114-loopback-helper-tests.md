# Retro: #114 tests pin serveOnLoopback's bind and close()

Gear 1 as stamped, test-only apart from one field on a type; no shift. One commit, c87afe8 (b3a579b, amended to 40f34b8 before any push, then rebased onto e68994c; see below). The implementer ran on haiku per the issue and the lane's model table. The run is recorded in Baseline (run 4356eed3-5bcf-40b6-abf9-a8efb5915222); this retro is posted there after `baseline finish`. Gate on the final tree: tsc 0, lint 0, vitest 41 files / 607 tests.

## What was built

- **Kind of code:** tests for a test helper, plus one field on the helper's return type. No production code changed.
- **Pattern:** `LoopbackApi` in `server/test-utils/app.ts` gains `address: AddressInfo`, read from `httpServer.address()` after the listen callback. Three tests in `describe('serveOnLoopback')` in `server/test-utils/__tests__/app.test.ts`: the bind is `127.0.0.1` and IPv4; the port refuses connections (ECONNREFUSED) after `close()`; a second `close()` resolves.
- **Why this shape:** the issue said "choose the smallest export change". The server cannot be reached through `api`: supertest always requests 127.0.0.1 and, given a non-listening server, calls `listen(0)` itself, so neither the bind nor the open port is visible there. One extra field was the smallest way to read the bind.

## What happened

- **Build (implementer, haiku):** the field and three tests, then the issue's own check: break each property and watch a test go red. Mutations, all red: bind `'::'`, bind with no host, no-op `close()`.
- **Review and test-guard:** both re-ran the mutations. They also turned up two more that go red: removing the listening guard and binding `'0.0.0.0'`. The reviewer probed the ECONNREFUSED check 180,000 times under load and got 0 connects, so the check is not racy.
- **Exit criteria:** both mutations named in the issue turn a test red; gate green.

## What went wrong

- **A completion report that did not come from the harness was believed, twice.** Before the implementer had finished, the conductor received a "completed" report for it inside a user turn, not as a task notification. It described a diff that was not on disk. The conductor messaged the implementer as if it had fabricated its report. The implementer was still working and finished correctly. Cost: a wrong accusation and a confused seat.
- **The same thing happened with test-guard, and this one reached a commit.** The conductor saw another "completed" report in a user turn, ran the gate (green) and committed while the real test-guard was still applying mutations to the same working tree. Commit b3a579b captured `listen(0, '::')`, which is the exact regression this issue exists to catch, and the new test would have failed on it. Test-guard noticed the bad commit itself. The commit was amended to 40f34b8 (rebased to c87afe8) before any push, so nothing shipped. What exposed it was the stat line: 10 insertions / 1 deletion where the reviewed diff was 8 / 0. Nobody compared the two; test-guard's own check found it.
- **The green gate did not describe the committed tree.** The new test fails on `'::'`, so a gate run on b3a579b's content could not have been green; the mutation must have landed between the gate and the commit. The record does not show the exact order.
- **Where the false reports came from is unknown.** I can see that they arrived in user turns and not as task notifications. I cannot say what produced them, and I am not guessing.

## Root causes

- **Completion was taken from message content, not message origin.** A report that reads like "done" was treated as the harness saying the seat was done. Plan, do and verify did their parts; the failure is in the conductor's step between review and commit.
- **Mutation testing ran in the lane's own working tree.** Any seat that mutates the shared tree turns every other action in that tree (gate, commit, `git show`) into a race. The reviewer and test-guard are both read-mostly seats that nonetheless edit source to prove a test can fail.
- **Commit was not gated on "no seat is live".** Nothing ties a commit to the arrival of every dispatched seat's real notification, and nothing compares the committed diff to the reviewed one.

## What worked, keep it

- **The issue's own mutation requirement.** "Break each property and watch the test go red" is what makes a test of a helper believable. It was met by three seats independently.
- **Test-guard noticed the bad commit.** It checked what was committed against what it expected, not only whether its own mutations went red.
- **Smallest export change, with a type guard.** `address()` can be a string or null; the helper throws a clear error instead of casting.
- **Fence held.** No route test or `server/routes/*.ts` file changed. Two out-of-fence finds were surfaced (below), not absorbed.
- **Amend before push.** Because the lane does not push until after the conductor's check, the bad commit cost an amend, not a revert.

## Surfaced, not absorbed

- **`closeAllConnections()` can be deleted with every test green.** No test pins the keep-alive drop. Housekeeping follow-up: #119.
- **`client/apis/__tests__/apiClient.test.ts:16` calls `server.listen(0)` on all interfaces.** It is the same pattern #97 and #105 removed from the server tests, and it is outside this fence. Housekeeping follow-up: #120.

Both follow-ups carry `Spawned-by: #114` and `Priority: housekeeping`. `Missed-by` for the first is `plan` (the issue's property list did not name the keep-alive drop); for the second also `plan`, as filed (#105 removed the all-interfaces bind from server tests without sweeping `client/`).

## Recommended changes

1. **High leverage:** mutation checks run on a copy, never the lane's tree. Put the rule in the reviewer and test-guard agent instructions: copy the worktree into the scratch directory (or a throwaway `git worktree add` on a temp branch), mutate and run there, and report mutation results by file and line. The working tree stays what the conductor sees. Artifact: `.claude/agents/reviewer.md` and `test-guard.md` in the workflow (imported from `~/.claude/agents/`).
2. **High leverage:** a commit step that checks before and after. Before: every dispatched seat has a real task notification (not a user-turn message). After: `git show HEAD --stat` matches the reviewed diff's stat. Artifact: the `parallel-agents` skill's reviewing checklist, `~/.claude/skills/parallel-agents/SKILL.md`.
3. **Optional, first occurrence for the second half:** treat a "completed" report that arrives in a user turn as unverified until the seat's own output or notification confirms it. Wrong accusations of a seat cost little; a commit on a live tree did not. Record it, and encode it only if it recurs.

## Highest-leverage next step

Change the reviewer and test-guard instructions so mutation runs happen on a scratch copy of the worktree. That removes the shared state: the gate and commit can no longer capture a mutation, whatever the conductor believes about who is finished. It is the one change that would have prevented b3a579b.

## PR paragraph

This adds three tests to `server/test-utils/__tests__/app.test.ts` that pin `serveOnLoopback`: the server binds 127.0.0.1 (IPv4), the port refuses connections after `close()`, and a second `close()` resolves. To read the bind, `LoopbackApi` gains one field, `address: AddressInfo`, because supertest always requests 127.0.0.1 and cannot see it. Binding `'::'`, binding with no host and a no-op `close()` each turn a test red; the reviewer and test-guard re-ran them and also caught removing the listening guard and binding `'0.0.0.0'`. Gate: tsc 0, lint 0, vitest 41 files / 607 tests. During the run the first commit (b3a579b) captured a mutation test-guard had applied to the shared tree; it was amended to 40f34b8 (rebased to c87afe8) before any push. Follow-ups, both Housekeeping: nothing pins `closeAllConnections()`, and `client/apis/__tests__/apiClient.test.ts:16` listens on all interfaces. Gear 1, no shift.
