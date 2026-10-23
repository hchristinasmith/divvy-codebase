# Retro: #117 a test fails when build:mcp stops shipping the audit schema

Gear 2 as stamped, test-only; no shift. Spawned by #106 (PR #118), `Missed-by: plan`: #106's fence allowed only `package.json`, so its proof of the `cp` fix was an out-of-tree probe that nothing re-runs. Two commits, both adding or touching one file, `mcp/audit/__tests__/bundled-schema.test.ts`: 32a92e3 (build) and 52946cf (review fix). The implementer ran on haiku per the lane's model table. Baseline run `f868a724-bce6-4993-a713-4bcec4f82533`. This file states no telemetry (model, duration, tokens, tool calls); the lane posts the four narratives after `baseline finish`. This retro file sits outside the issue's fence, as the lane handoff directs.

## What was built

- **Kind of code:** one vitest file. No production code changed.
- **Pattern:** the test reads `scripts['build:mcp']` from `package.json` at test time, rewrites `dist/mcp/` to a `mkdtemp` directory and runs it, so the shipped command itself is what is exercised. It then bundles `mcp/audit/index.ts` with the same esbuild flags beside it, symlinks `node_modules` and writes `{"type":"module"}` so the bundle can resolve sqlite3, and runs the bundled sink in a plain `node` child. It asserts one `advisor_audit` row, a pinned key set, and the recorded values.
- **Why this shape:** the alternative was a copy of the build command in the test, which would keep passing after `package.json` changed. Reading the real script is what makes it go red.

## What happened

- **Red proof, EXECUTED:** removing `&& cp mcp/audit/schema.sql dist/mcp/schema.sql` from `build:mcp` gave ENOENT on `<tmp>/schema.sql` and exit 1. Restored, `git diff --exit-code package.json` returned 0 and the test was green.
- **Build (implementer, haiku):** done in one pass. Deviations, all sound: `spawnSync` for readable stderr, a package.json in the probe dir so the bundle runs as ESM, and `split`/`join` instead of `replaceAll` because the target is es2020. Test time 56-77 ms. Whole suite 42 files, 607 tests, green.
- **Review:** the reviewer ran 6 mutations and all behaved, including a wrong-name copy, a wrong source file, and a stale `dist/` planted in the repo. It raised two findings, below.
- **Test-guard:** covered and gated, no findings.

## What went wrong

- **Finding 1, fixed (52946cf): the child processes had no timeout.** The test used synchronous spawns, and vitest's hook timeout cannot interrupt a sync spawn. The reviewer proved it: a 2 s hook timeout around a 12 s sleep, and the test passed. A hung build or sink would have hung the whole gate with no failure. Fix: a 30 s timeout on each spawn. Cost: one fix round. Nobody on the build side asked what happens if the child hangs; the implementer chose `spawnSync` for good reasons (readable stderr) and the consequence was not checked.
- **Finding 2, left on purpose: the test is coupled to the exact shape of `build:mcp`.** Only `dist/mcp/` with a trailing slash is rewritten, and esbuild must come first. A correct reordering such as `mkdir -p dist/mcp && cp ... && esbuild ...` goes red. It fails safe (a false red, not a false green), and loosening the match would weaken the test.
- **#106's proof lived in a probe nobody re-runs.** That is why this issue exists. See root cause 1.

## Known gaps left on purpose

- **The probe bundles `mcp/audit/index.ts`, not `dist/mcp/index.js`.** That closes when #80 wires the sink into the MCP entry (prd-03 Done-when 6).
- **The read-only sqlite helper is now copy 2** (also in `sink.test.ts`). Lifting it into a shared file needs a path outside this fence, so it stays duplicated.
- **The `server/` bundle has no equivalent test.** The `public/` asset beside `dist/server.js` is unchecked. This rests on the implementer's reading of a `vite.config.js` comment and is unverified. I did not find an issue for it in the record I was given.
- **A pre-existing esbuild `@ljharb/tsconfig` warning** comes from a tsconfig above the repo. Not caused by this change and not acted on.

## Root causes

- **Fence drawn around the fix, not around its proof (variant of "fence written without checking the build and test config", seen in #68 and the audit-sink retro).** #106 changed one line in `package.json`, and the fence allowed exactly that. A proof that survives needs a committed test, and a test needs a file the fence did not name. The plan drew the boundary around the diff and did not ask where the evidence would live. Not the same miss as before (earlier ones missed config files; this one missed the test file), but the same habit of fencing the change and not what checks it. Count it as related, not identical, until a retro says otherwise.
- **A sync call chosen for readable output, with no bound (Finding 1).** The choice was reasonable; the missing question was what stops it if the child hangs. The reviewer's executed probe is what found it. First occurrence.
- **Test coupled to the shape of the thing it protects (Finding 2).** Inherent in running the real script. First occurrence, and it fails safe.

## What worked, keep it

- **Run the real script, not a copy.** The red proof is meaningful because removing the `cp` from `package.json` is exactly what turns it red.
- **Mutation pass by the reviewer with a planted stale `dist/`.** It checked the one way the test could pass for the wrong reason (the repo's own `dist/` being picked up). Six mutations, all behaved.
- **The reviewer proved the timeout gap instead of asserting it.** A 2 s timeout around a 12 s sleep passing is a result nobody can argue with.
- **Red proof recorded in the run, and `package.json` checked clean afterwards.** The red-then-restored sequence ended with `git diff --exit-code package.json` at 0.
- **Fence held.** One new file; the shared helper and the `server/` asset went to notes, not into the diff.

## Recommended changes

1. **Optional, first occurrence of the sync-timeout miss:** do not encode yet. If a second test spawns children synchronously without a bound, add one line to `docs/testing.md` under assertion rules: every `spawnSync`/`execSync` in a test passes `timeout`, because a hook timeout cannot interrupt it.
2. **Plan template, when a fix's only evidence is out of tree:** the fence names the test file that will keep the proof, or the issue says the proof is deliberately a probe. Artifact: the architect brief. Not yet: one related occurrence, and the earlier retros' version of this cause has not produced a template change either.
3. **Optional:** file an issue for a `server/` bundle asset test once someone has verified the `public/` claim. A decision for Hannah; unverified today.

## Highest-leverage next step

Do #80 so the probe can bundle `dist/mcp/index.js` and not `mcp/audit/index.ts`. Until then the test proves the shipped `cp` and the sink agree, not that the MCP entry loads the schema.

## PR paragraph

This adds `mcp/audit/__tests__/bundled-schema.test.ts`, which reads the real `build:mcp` script, runs it into a temp dir, bundles the audit sink beside it, and runs the bundle in a plain `node` child to assert it writes one `advisor_audit` row. Removing `&& cp mcp/audit/schema.sql dist/mcp/schema.sql` from `package.json` makes it fail with ENOENT on `schema.sql`; restored, `package.json` is unchanged and the test is green. The review added a 30 s timeout on the child processes, because vitest's hook timeout cannot interrupt a synchronous spawn (proved with a 2 s timeout around a 12 s sleep that still passed). Left on purpose: the test fails if `build:mcp` is reordered (fails safe), and it bundles `mcp/audit/index.ts` until #80 wires the sink. Gate green at 42 files, 607 tests. Gear 2, no shift. Spawned-by #106, Missed-by plan.
