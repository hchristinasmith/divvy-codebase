# Retro: #68 prd03 w1, the MCP tool list is fixed in a typed registry with a drift test

Gear 4 as stamped; no shift. One file outside the declared fence: `vitest.config.ts` (widened so vitest collects `mcp/`; approved by the conductor). Lane ran off the record (Baseline does not know this project yet), so there is no run id, nothing was posted, and no telemetry (model, duration, tokens, tool calls) is stated here.

## What was built

- **Kind of code:** a typed tool registry and auditing dispatcher for the read-only MCP advisor, an environment guard, a stdio entry, an ESLint boundary rule, and two test suites. Dependencies added: `@modelcontextprotocol/sdk` 1.32.1 and `zod` 4.6.7.
- **Contract:** `mcp/contracts.ts` holds the types the wave-2 lanes implement (replica reader, audit sink), the `staticSql` tag, `ToolDefinition`, `HandlerOutcome` / `HandlerErrorCode` and `READ_ONLY_ANNOTATIONS`. `mcp/tools/common.ts` holds the shared schema pieces. Seven tool stubs (`get_safe_to_spend`, `list_transactions`, `get_budgets`, `get_bills`, `get_goals`, `get_habits`, `get_sync_status`) each return a typed `not_implemented`.
- **Dispatch:** `mcp/tools/registry.ts` exports a frozen `TOOLS`, `dispatchToolCall` and `createToolServer`. The dispatcher validates with the tool's strict schema, runs the handler, awaits `audit.record` for every outcome (ok, rejected, error) and only then answers. If the sink fails it fails closed with `audit_unavailable` and returns no data. `mcp/context.ts` is a fail-closed placeholder until wave 2.
- **Boundary:** `mcp/guard-env.ts` refuses secret-shaped and code-loading env names (names only, never values). `mcp/index.ts` is the stdio entry. `build:mcp` bundles it with esbuild into `dist/mcp/index.js`. An ESLint override in `package.json` `eslintConfig` forbids `mcp/` importing `server/`.
- **Why the low-level SDK `Server`:** the high-level `McpServer` validates and answers unknown tools inside the SDK before user code runs, so those calls cannot be audited. The low-level class is marked deprecated; the trade is deliberate (see gaps).
- **Tests:** `mcp/tools/__tests__/registry.test.ts` (57) and `mcp/__tests__/guard.test.ts` (21). `MAX_RANGE_DAYS` is 366, `MAX_LIMIT` is 200; recorded on the PR as the issue asked.

## What happened

Researcher (SDK stdio API), then architect, then a build in logical commits: dependencies (74dce22), contracts and shared schema (2a801e5), tool stubs, registry and dispatcher (1489cf1), relock (1eaf849), entry, env guard and `build:mcp` (1ab7db8), lint rule and guard test (18b4ef7). The reviewer then found 3 things, fixed in a9593b5: the tests pinned the w1 placeholder context (so wave 2 could not replace it without editing test files), the `KEY` env pattern had no case only it catches, and the network scanner missed `globalThis.fetch`. Test-guard and security-auditor then ran in parallel; their in-fence findings were fixed in b11be13.

Gate at b11be13: tsc 0, lint 0, vitest 17 files / 238 tests passing (160 were on main).

Mutation testing was executed, not asserted: 30 + 16 mutations on the first build, 23 on the final fixes, all red. Two survivors turned up mid-build and were closed with new cases: the `data_as_of` check was masked by `Date.parse` accepting the value anyway, and one mutation was malformed so it proved nothing.

## What went wrong

1. **Shared-stash incident (cross-lane damage).** My gate script ran `git stash push --keep-index` then `git stash pop`. `refs/stash` is shared by every worktree of a repo, so it crossed with the parallel prd02-w1-shell lane. Their pop took my stash: 10 `mcp/` files landed in their index. My pop took their `useSyncPill.ts` change. I recovered mine with `git rm --cached` plus a scratchpad backup, reported, and stopped. The conductor sorted the other lane. Cost: a stop, a recovery, and a second lane's index briefly holding another lane's work.
2. **Fence shift.** `vitest.config.ts` was not in the declared fence, but vitest would not collect `mcp/` without a one-line widening. Approved by the conductor. `docs/testing.md` is now stale (it describes where vitest looks); listed below, not edited.
3. **Rebase friction.** Main moved twice. 18e8bcf dropped `cors` as a direct dependency, and after rebase `npm ci` failed with `Missing: cors@2.8.6` (a transitive of the SDK's HTTP transports, which `mcp/` never imports); relocked in its own commit 1eaf849. Then 8200298 added `shared` to the `tsconfig.json` include, a one-line conflict resolved to all seven entries. An empty untracked `mcp/__tests__/` directory also vanished in the rebase.
4. **The SDK choice leaves an audit hole.** The low-level `Server` audits unknown tools, but malformed `tools/call` envelopes (no `name`, non-object `arguments`, a `task` field) are rejected by the SDK before the dispatcher and leave no audit row. Known, named in the registry header (W5), not closed.
5. **The first build had real holes that review did not find; the security-auditor did.**
   - `staticSql` was forgeable by passing a hand-built array.
   - Handler messages were returned to the client verbatim.
   - Rejected params were recorded unbounded, and an unknown tool name could carry control and bidi characters into an audit row.
   - `NODE_OPTIONS=--inspect` passed the env guard.
   - The import and network scanner could be evaded with `getBuiltinModule`, `createRequire`, `worker_threads`, `hono`, bare `Function`, indirect `eval` and `.js` to `.ts` resolution.
6. **Flaky supertest `socket hang up` (ECONNRESET)** in `server/routes` tests under load. Outside the diff; surfaced, not fixed.
7. **Pre-existing vitest warning** `Cannot find base config file @ljharb/tsconfig`. Also on main; not touched.

## Root causes

- **Stash treated as worktree-local (1).** It is repo-global. The gate script was written as if each lane had its own stack. This is a wrong assumption about a tool, not a flaw in the lane model.
- **The first scanner was a deny-list of what I thought of, not of what Node offers (5).** Network and code-loading reach in Node has many doors (`process.getBuiltinModule`, `module.createRequire`, workers, `Function`, `eval`). Enumerating the ones I remembered produced a guard that passed its own tests and still leaked. The reviewer checked my tests against my list; only an adversarial pass attacked the list itself. The env guard shared the same shape (a pattern list; `NODE_OPTIONS` is not secret-shaped but loads code).
- **Fence written without checking the test runner's include glob (2).** The issue fenced `tsconfig.json` but not `vitest.config.ts`; both gate `mcp/` equally. A plan-time check would have put it in the fence.
- **SDK convenience layer sits in front of user code (4).** An audit-everything requirement is incompatible with a framework that answers before your code runs. The envelope gap is the residue of that, and it is unresolved rather than hidden.
- **Rebase friction (3):** not a mistake; two concurrent lanes editing `package.json`, lockfile and `tsconfig.json`. Unclear whether the missing `cors` lock entry could have been foreseen.

## What worked, keep it

- **Fail-closed audit ordering.** Record settles before any answer, and a failed record returns no data. The test drives the real tools through a fake refusing sink, so it pins behaviour, not stub output.
- **Tests that survive wave 2.** After the reviewer's fix, the registry test pins names and schemas only, and spawned entries get scratch `DIVVY_REPLICA_PATH` / `DIVVY_AUDIT_PATH`, so the wiring lane can replace the placeholder context without editing either test file (the issue's "not met while" condition).
- **Mutation testing as the measure of the tests.** 69 mutations across three passes, all red at the end, and the two mid-build survivors were found by the method and fixed by new cases, not by judgement.
- **Parallel test-guard and security-auditor after the reviewer.** Different seats found different things: the auditor found what neither author nor reviewer did.
- **Stopping and reporting on the stash incident** instead of quietly patching the other lane's index.
- **Names-only env guard.** The refusal names the variable and never prints the value; the clean-env positive control pins that the entry exits once stdin closes.

## Surfaced, not absorbed

- **Env allow-list instead of a deny-list.** A design choice (what does the advisor process legitimately need?), not a fix; needs a decision.
- **Restrict DB drivers** (`better-sqlite3` and similar) to `mcp/replica` and `mcp/audit` with a lint rule.
- **Lint ban on calling `staticSql` outside `mcp/replica` handlers.**
- **`_cents` naming convention.** #80, #82 and #83 must name money fields `*_cents` or the dispatcher's integer check will not see them.
- **Phantom `cors` / `hono` / `express` in `node_modules`** via the SDK's HTTP transports. Not imported by `mcp/`; the scanner and bundle must keep it that way.
- **Bidi / control-character stripping of recorded param string values** on the Privacy screen (wave 3). The dispatcher strips them from the tool name only.
- **The envelope audit gap** (item 4 above).
- **Flaky ECONNRESET** in `server/routes` tests (item 6).
- **`docs/testing.md` is stale** about what vitest collects.
- **`docs/retros/` and this file are outside the issue's fence**, as with #43; created because the lane brief asked for a retro file.

## Recommended changes

1. **High leverage: never `git stash` in a lane; gate the working tree directly.** A gate that needs a clean index should run on the tree as it is, or on a `git worktree add` copy. Put it in the lane handoff template and the gate runbook (the lane brief / `parallel-agents` skill). This is the first occurrence, but the cost landed on a different lane, which is why it is encoded now rather than waiting for a second.
2. **Run `security-auditor` before the reviewer's fixes are committed, or at least brief anything that scans imports, network or env for an adversarial pass from the start.** A scanner is judged against what an attacker can reach, not against the author's list. Belongs in the gear-4 section of the pipeline (`~/.claude/CLAUDE.md`, step 5) as an ordering note.
3. **At plan time, check the fence against the test runner's include glob** (`vitest.config.ts`), tsconfig include and ESLint config for any new top-level directory. Belongs in the architect agent's fence checklist.
4. **Single occurrence, do not encode yet:** rebase friction from a transitive dependency (`cors`). If it recurs, add `npm ci` to the post-rebase step.

## Highest-leverage next step

Add the "no `git stash` in a lane; gate the working tree directly" line to the lane handoff template and gate runbook, since a repeat damages a second lane rather than this one.

## PR paragraph

This adds the advisor's whole contract under `mcp/`: a frozen registry of exactly seven tools with strict zod schemas, a dispatcher that audits every outcome (ok, rejected, error) before it answers and fails closed with `audit_unavailable` when the sink fails, the replica and audit types wave 2 implements, an environment guard that refuses secret-shaped and code-loading env names without printing values, a stdio entry, `build:mcp`, and an ESLint rule forbidding `mcp/` from importing `server/`. Gate is green: tsc 0, lint 0, vitest 17 files / 238 tests (160 on main), and 69 mutations across three passes all went red. Review caught 3 issues (a9593b5); test-guard and security-auditor findings, including a forgeable `staticSql`, verbatim handler messages and several scanner evasions, were fixed in b11be13. Known gaps: malformed `tools/call` envelopes are rejected by the SDK before the dispatcher and leave no audit row, and `vitest.config.ts` was widened outside the fence with conductor approval, leaving `docs/testing.md` stale. A shared-stash collision with the prd02-w1-shell lane occurred and was reported and sorted by the conductor; the lane now gates the working tree without stash. This lane ran off the record because Baseline does not know this project yet.
