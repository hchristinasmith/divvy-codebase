# Retro: #80, MCP context wired to the replica and audit sink; get_sync_status (get_safe_to_spend split out)

Gear 4, no shift, no fence shift. Implementer ran on opus. This file states no telemetry; the conductor posts the narratives to Baseline after `baseline finish`.

Seats run: implementer, reviewer, security-auditor, test-guard, this retro. Verify passed on the final state: 176/176 files, 6580/6580 tests. I did not re-run it. Commit: 0c260d7 (build and review fix together).

## What was built

- **Kind of code:** MCP wiring and one tool handler. `mcp/context.ts` now calls `openReplica` and `createAuditSink` (placeholders removed). `get_sync_status` is new. Tests: 8 unit tests against a real small replica file, 2 e2e tests that spawn the entry.
- **Pattern:** the handler reads the scrubbed replica only (no `server/**` import, prd-03 Ruling 6) and reports `meta.last_sync_at` plus the latest sync run status.
- **Not built:** `get_safe_to_spend`. Split out, see below.

## What went wrong

1. **The issue could not be finished as sliced (Missed-by: plan).** #80's Done-when 2 says `get_safe_to_spend` must match the Overview. On reading `server/db/overview.ts` the lane found that the Overview's input gathering (`loadInputs`, `readSettings`, bill occurrences, the drawing overlay in `server/db/drawings.ts`) lives in `server/`. `mcp/` may not import it. The only other route was copying that logic, which would give two sources of truth for safe-to-spend and break prd-02 Ruling 1. The replica had every column needed, so the data was never the problem; the code location was. The slicing named this as a stop condition but never checked where input gathering lived before dispatch. Cost: the lane stopped on the tool, raised Baseline decision 9509592c (split / pause / widen), and waited about 72 minutes for Hannah, who chose "Split #80". Filed #472 (move input gathering into `shared/`, prd-02 work) and #473 (fill `get_safe_to_spend`), both `Spawned-by: #80`, `Missed-by: plan`.
2. **A latent bug in `get_sync_status` (Missed-by: do, caught by review).** `scrub.ts:97` converts a numeric `finished_at` to ISO for `meta.last_sync_at`. The query used `WHERE finished_at = ?` with that ISO value, so a numeric row never matched and `last_sync_status` came back null. Today's server writes ISO, so production does not hit it. Fixed: the query matches both forms (`IN (?, ?)`), with a test.
3. **One TS2353 excess-property error** on the implementer's first run, fixed with a local result interface. Minor.
4. **One unrelated flaky failure in the full run:** `client/components/Insights/__tests__/InsightBody.test.tsx:111`, a `<1000ms` timing assert. Not in the diff, passed on rerun and in the final gate.
5. **Review fix landed in the build commit, not a separate one.** The build and the fix were in the same uncommitted tree when review ran, so splitting them would have meant staging by hunk. The second reader cannot see the response to the finding in the history. Noted, not corrected.

## Root causes

- **Slice did not check where the inputs live.** Item 1. A "must match X" Done-when depends on whether X's inputs are reachable from the new code's side of an import boundary. The slicing wrote the stop condition but did not run the check that would have triggered it. Cost was a 72-minute block and a split, not wasted code: the stop condition worked, which is why the cost was small.
- **Two representations of one value, one query.** Item 2. The scrub normalises a timestamp on read, and the handler filtered on the normalised form against the raw column. Nothing in the unit tests used a numeric row until the reviewer did.

## What worked, keep it

- **The stop condition did its job.** The lane read the code, stopped, and raised a decision with a recommendation instead of copying the logic or widening the fence. No duplicate safe-to-spend exists.
- **Reviewer mutation check.** 12 deliberate code breaks, every one turned a test red. That is the evidence the tests are real, and the same pass found item 2.
- **Real replica file in the unit tests** (not a mock) is what made the numeric `finished_at` case cheap to write.
- Security-auditor: no Critical or Warning.
- Test-guard: covered.

## Left as is, noted

- **Out of fence, security-auditor suggestions:** `DIVVY_*` env paths could redirect the audit file if the launcher ever passes env (fix belongs to the launcher, `scripts/**`). The `mcp/audit` sink accepts a zero-byte file.
- **Stale comments in fenced files:** the `WAVE2_MODULES` JSDoc in `mcp/contracts.ts` and the header of `mcp/audit/index.ts` still describe the wiring as pending. Not edited.

## Recommended changes

1. **Add a slicing check for "must match X" Done-when lines:** before dispatch, name where X's inputs are gathered and whether the new code may import that location. If not, split at slicing time. File: the issue-slicing step/template in the Baseline workflow (and `docs/prds/` slicing notes if they exist). This is the first occurrence in this repo, so per the retro rule write it down here and encode it only if it recurs; the cheap version is a one-line prompt in the slicing step.
2. **Stale wave-2 comments:** fix `mcp/contracts.ts` and `mcp/audit/index.ts` in a housekeeping issue or fold into #473.
3. **Launcher env-path and zero-byte audit file:** file as housekeeping against `scripts/**` and `mcp/audit`.

## Highest-leverage next step

Do #472 (move input gathering into `shared/`). It unblocks #473 and removes the cause: once the Overview and the MCP tool share one gatherer, the "must match" check stops being a boundary problem.

## Open items for the PR body

- Gear 4, no shift; `get_safe_to_spend` split out by Hannah's decision (Baseline 9509592c), tracked as #472 and #473.
- Review fix (numeric `finished_at`) is inside the build commit.
- Stale comments in fenced files noticed, not edited.
- Unrelated flaky timing test in `InsightBody.test.tsx:111`, passed on rerun.
