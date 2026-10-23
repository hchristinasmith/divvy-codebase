# Retro: #78 prd03 w2, every tool call is written to the advisor audit file

Gear 4 as stamped; no shift. Every changed file is inside the declared fence (the four `mcp/audit/` files); this retro file is outside it, as with #68. The issue said `model: sonnet`; Divvy's gear table supersedes that, so the implementer ran on opus. Baseline run `95a5150f-5573-47e2-97c6-a52cdc6de6dd`. This file states no telemetry (model, duration, tokens, tool calls); the lane posts the four narratives after `baseline finish`.

Seats run: architect, implementer (4 commits), reviewer, then test-guard, security-auditor and schema-reviewer in parallel, implementer again for review fixes (2 commits), docs-syncer (nothing stale), this retro. Verify passed on the final state: re-run on the clean tree at 86bab7e (based on origin/main a032ded) gives tsc 0, lint 0, vitest 41 files / 604 tests (76 of them in `mcp/audit/__tests__/sink.test.ts`).

## What was built

- **Kind of code:** the write half of the advisor's audit log: one table, a SQLite sink and its tests. Files: `mcp/audit/schema.sql` (a single `CREATE TABLE IF NOT EXISTS advisor_audit` with CHECKs, including `json_valid` on `params_json`), `mcp/audit/sink.ts`, `mcp/audit/index.ts` (exports `createAuditSink`), `mcp/audit/__tests__/sink.test.ts`. 1103 lines added across 4 files.
- **Pattern:** open-per-record. Each `record` opens the file, checks it is ours, sets `journal_mode=DELETE` and `synchronous=FULL`, runs `BEGIN IMMEDIATE`, applies the schema, inserts, stamps `application_id` `DVAU`, commits, closes, and only then resolves. Records go through a FIFO queue that does not stick after a failure. Nothing is held open between calls, so a failed record leaves no state to poison the next one.
- **Bounds:** validation runs before the disk is touched and names the field, never the value. Parameters are written as JSON with every control and format character as a `\uXXXX` escape, capped at `MAX_AUDIT_PARAMS_LENGTH` (1024 escaped characters). Over-long or unserialisable parameters are replaced by a small marker, not cut, so `params_json` is always valid JSON.
- **Tests:** drive the real `dispatchToolCall` from #68 (ok, rejected and handler-throws each leave exactly one row; a sentinel returned by a handler is found nowhere in the file; an unwritable path returns no data).
- **Why replace rather than truncate:** the issue said "stored truncated" at a proposed 2000 characters. The dispatcher already bounds rejected params at `MAX_REJECTED_PARAMS_LENGTH` = 1024, so the sink uses 1024. It defines its own constant and a test pins equality, so the sink never imports the registry (the issue says the sink imports nothing it should not).

## What happened

Architect first, then the implementer in four commits: schema (c1875c2), a durable row per record (00c9889), validation and bounded params (bd2541a), fail-closed and rollback journal (fbba1a1). Two fix commits followed review: cc74724 (far-future `at` refused before the file is opened; busy-timeout and read-only-file tests) and 86bab7e (the sink refuses a foreign database; control characters escaped). Main moved by 5 PRs during the lane; the rebase was clean and the gate was green afterwards.

What each reviewing seat caught that authoring missed:

- **reviewer:** a test whose comment said it guarded the busy timeout could not fail, because node-sqlite3 already defaults `busyTimeout` to 1000 ms. A far-future `+010000-…` `at` passed the sink's validation and was refused by the schema only after the file had been opened.
- **test-guard:** calendar-invalid `at` values and "the queue still works after a failed record" were untested. Two clauses (`file:` and `:memory:` paths) were dead code.
- **security-auditor:** the sink would take over any SQLite file it was pointed at. EXECUTED: it converted a WAL database holding an `accounts` table out of WAL and added a table to it. Bidi and zero-width characters were stored raw in `params_json`. The file has no growth ceiling. The file mode depends on the launcher's umask (EXECUTED: under `umask 077` the file is 0600 and the web user cannot open it).
- **schema-reviewer, architect and implementer, independently:** the bundled MCP cannot find `schema.sql`. The sink reads it with `readFileSync(new URL('./schema.sql', import.meta.url))`, which works under tsx and vitest. `build:mcp` bundles into `dist/mcp/index.js` and copies nothing, so the lookup would be `dist/mcp/schema.sql`, which does not exist. `--loader:.sql=text` is on the `build:mcp` line but nothing imports a `.sql` file.

## What went wrong

1. **The bundled MCP could not have worked, and plan did not say so.** The sink loads a file from disk next to its source. Every test ran under vitest, where that works. The break only shows in the build output, and the fence (four files, none of them `package.json`) made the fix someone else's job. Three seats found it separately. It fails closed, so nothing leaks, but once wired every audited call would answer `audit_unavailable`. Filed as #106 (`Missed-by: plan`, phase, for Done-when 6).
2. **The sink trusted the path it was given.** First build opened whatever `DIVVY_AUDIT_PATH` pointed at and set the journal mode on it. A mistyped path would have rewritten someone else's database. Neither the author nor the reviewer attacked that assumption; the security-auditor did, with a working reproduction. Fixed in 86bab7e with an ownership check (no tables but `advisor_audit` and `sqlite_sequence`; `application_id` unset or `DVAU`) before anything is changed.
3. **A test that could not fail.** The busy-timeout test's comment said it guarded the setting, but with node-sqlite3's 1000 ms default a lock shorter than that passes with or without the code. The implementer's own mutation pass showed that mutant surviving and reported it, but left the test's comment claiming the guard; the reviewer re-ran the mutant (green 15 of 15) and fixed it. Fixed in cc74724 by holding the lock past the default and setting the test connection's timeout explicitly.
4. **Validation ran in the wrong order for one input.** A far-future `at` passed the sink's own checks, and the file was opened before the schema's CHECK refused it. Fail-closed held, but the file was touched for a record that could have been refused up front. Fixed in cc74724.
5. **Stored text could carry bidi and zero-width characters** into `params_json`. #68's retro had named this and left it for the wave-3 reader. The sink fixed it at write time, so the reader no longer has to.
6. **Handoff named the wrong wiring lane.** The brief said #81 wires the sink. #81 is the OS-user/container lane; #80 owns `mcp/context.ts` and its Done-when says it wires `createAuditSink()`. The umask and reader notes still belong on #81, so they went there. No work was done against the wrong lane; the cost is only that the error had to be caught and routed.
7. **The issue's 2000-character figure disagreed with the dispatcher's 1024.** The issue proposed a number without reading the dispatcher. Settled in the sink (see above); no rework.

## Root causes

- **Author's list vs the attacker's reach (2, 5; second occurrence).** Same cause as #68 item 5. The author tested what the author thought of; the reviewer checked tests against that; only the security-auditor's adversarial pass questioned the premise (that the path is ours, that param text is safe to store). In #68 the premise was a scanner's deny-list; here it was "the file is ours". The reviewer-then-parallel ordering is unchanged since #68, so the same cost recurred: one more fix round after the auditor.
- **Fence written without checking the build and test config (1; second occurrence).** Same cause as #68 item 2. There the fence missed `vitest.config.ts`; here it missed `build:mcp` in `package.json`. Both times the plan checked the code, not what turns the code into the thing that runs. Here the leftover `--loader:.sql=text` was a visible hint that #68 had intended an import and not finished it.
- **A surviving mutant reported but not acted on (3).** The implementer, reviewer and test-guard each ran a mutation pass (18, 20 and 29 mutants). The implementer's pass showed the busy-timeout mutant surviving and said so, yet the test comment claiming the guard stayed; a survivor was treated as a note rather than a red test to write or a comment to correct. First occurrence.
- **Validation placed after the open (4).** The schema CHECK was relied on as a validator, so `at` limits were checked by the database rather than by the sink before touching disk. Single-input slip, first occurrence.
- **Handoff written from memory of the issue map (6).** Unclear why #81 was named; the issue bodies say otherwise. First occurrence.
- **Unclear:** whether the 2000 vs 1024 mismatch is a slicing habit (numbers proposed before reading the code they bound) or a one-off.

## What worked, keep it

- **Fail-closed by construction.** Open-per-record means there is no connection to leak and no shared state a failure can leave behind. The queue-after-failure test proves the next record still works.
- **Driving the real dispatcher in the tests.** The "exactly one row" and "sentinel found nowhere" claims are about `dispatchToolCall` plus the real sink, not about the sink alone.
- **The equality pin** between `MAX_AUDIT_PARAMS_LENGTH` and the dispatcher's constant: no import of the registry, and drift is a red test.
- **Executed findings, not asserted ones.** The auditor converted a real WAL database; the umask and growth findings were run. That is why #113 and the note on #81 carry numbers (201 rows into 286,720 bytes, about 917 rows per second as a ceiling).
- **Three seats finding the schema path independently** is a strong signal, but note the cost: the same discovery was paid three times.
- **A surfaced item from #68 was picked up correctly** (bidi/control characters) and closed at the layer that can enforce it.
- **Follow-ups named their origin** (`Spawned-by`, `Missed-by`) and passed the phase test: #106 phase, #113 housekeeping, the umask/reader note as a comment on #81 rather than a new issue.
- **Clean fence.** Nothing outside `mcp/audit/` was touched, though #106's fix needed `package.json`; it was surfaced rather than absorbed.

## Surfaced, not absorbed

- **#106** bundled MCP finds the audit schema (`build:mcp` copy step or a `.sql` import; one copy of the DDL).
- **#113** growth ceiling and write deadline (housekeeping). A looping client can fill a shared volume; a stalled filesystem hangs later records (fail-closed, availability only).
- **Comment on #81:** the launcher should `umask 022` (re-asserting 0644 at boot does not cover a file created later). With `journal_mode=DELETE` the wave-3 reader sees SQLITE_BUSY during a commit and cannot roll back a hot journal from a killed MCP, so it needs a busy timeout and an error state, not an empty list.
- **Wiring:** `createContext()` in `mcp/context.ts` is #80's. The sink is not yet used by anything outside tests.

## Recommended changes

1. **Second occurrence, encode now: the architect's fence checklist must include the build and test config.** For any new file, name the config that collects it (vitest include, tsconfig include, ESLint) and what ships it in the built artifact (`build:mcp`). If the code reads a file at runtime, the plan must say how the bundle gets it and require one test that runs the bundled entry. Belongs in the architect agent's fence checklist (`~/.claude/agents/architect.md`, imported to Baseline). This is #68's recommendation 3 widened from "test runner glob" to "build output", which is why it was not enough on its own.
2. **Second occurrence, encode now: for gear 4, brief the security-auditor with the attack surface up front, and run it before the reviewer's fixes are committed.** Specifically anything that opens a path from env or config, or stores caller-controlled text, gets an auditor brief that says "attack the premise, not my tests". Belongs in the gear-4 note under pipeline step 5 of `~/.claude/CLAUDE.md`. #68's recommendation 2 already proposed this; it was not applied, and the same shape recurred.
3. **Single occurrence, do not encode yet:** a surviving mutant reported but left with a test comment that claims the guard. If it recurs, add to the `implementer` agent: every surviving mutant ends as a new red test, a removed guard, or a corrected comment — never only a line in the report.
4. **Single occurrence, do not encode yet:** the handoff naming the wrong lane for wiring, and a number proposed in an issue (2000) that disagrees with the code it bounds.

## Highest-leverage next step

Add the build-artifact check to the architect's fence checklist (`~/.claude/agents/architect.md`): for every file the plan creates, name what ships it in `dist/`, and for every runtime file read, require a test that runs the bundled entry. Two lanes in a row planned correctly for the source and missed what runs.

## PR paragraph

This adds the advisor's audit sink under `mcp/audit/`: one idempotent `CREATE TABLE IF NOT EXISTS advisor_audit`, and `createAuditSink()`, which opens the file per record, refuses any database that is not its own, keeps a rollback journal (`journal_mode=DELETE`, `synchronous=FULL`), validates before touching disk, stores parameters as escaped JSON bounded at 1024 characters (replaced by a marker, never cut), and fails closed so the dispatcher answers with no data. Tests drive the real `dispatchToolCall`: ok, rejected and handler-throws each leave one row, and a returned sentinel is found nowhere in the file. Gate is green on the final tree: tsc 0, lint 0, vitest 41 files / 604 tests. Review fixes: reviewer, test-guard and security-auditor findings are in cc74724 and 86bab7e, including the sink taking over a foreign database (reproduced), raw bidi characters in stored params, and a busy-timeout test that could not fail. Known gaps filed: #106 (the bundled MCP cannot find `schema.sql`, `Missed-by: plan`), #113 (no growth ceiling or write deadline), and a note on #81 (launcher `umask 022`; the wave-3 reader needs a busy timeout and an error state). The sink is not wired into `createContext` here; that is #80. The 2000-character figure in the issue is superseded by the dispatcher's 1024.

## Baseline narratives

These four are the text for the retro POST (`narrative_code_type`, `narrative_built`, `narrative_how`, `narrative_wrong`).

### narrative_code_type

A durable audit sink: a SQLite writer with an idempotent schema file and a validation layer, plus its test suite. Gear 4, security-critical, in the read-only MCP advisor (prd-03 Ruling 4).

### narrative_built

`mcp/audit/schema.sql` (one `CREATE TABLE IF NOT EXISTS advisor_audit` with CHECK constraints including `json_valid`), `mcp/audit/sink.ts` and `mcp/audit/index.ts` exporting `createAuditSink`, and 76 tests that drive the real `dispatchToolCall`. Each record opens the file, checks it is an audit file, sets `journal_mode=DELETE` and `synchronous=FULL`, runs `BEGIN IMMEDIATE`, applies the schema, inserts, stamps `application_id` `DVAU`, commits and closes, through a FIFO queue that does not stick after a failure. Validation runs before the disk is touched, and parameters are stored as escaped JSON bounded at 1024 characters, replaced by a marker rather than cut. Returned data is never stored. Gate green: tsc 0, lint 0, vitest 41 files / 604 tests.

### narrative_how

Architect, then the implementer on opus (the issue's `model: sonnet` was superseded by Divvy's model table) in four commits, then the reviewer, then test-guard, security-auditor and schema-reviewer in parallel, then the implementer again for two review-fix commits, then docs-syncer (nothing stale). The issue's 2000-character truncation was superseded by the dispatcher's 1024 limit, and a test pins the sink's constant equal to it so the sink does not import the registry. Main moved by 5 PRs during the lane; the rebase was clean and the gate stayed green. Follow-ups were filed with origin lines: #106, #113, and a note on #81.

### narrative_wrong

The plan missed that the bundled MCP cannot find `schema.sql`: it is read at runtime from beside the source, `build:mcp` copies nothing, and every test ran under vitest where it works. Three seats found this independently; filed as #106, `Missed-by: plan`. The first build opened whatever path it was given and would have converted and altered a foreign database (the security-auditor reproduced it with a WAL database holding an `accounts` table); fixed with an ownership check. Bidi and zero-width characters were stored raw. A busy-timeout test could not fail because node-sqlite3 already defaults to 1000 ms; the implementer's mutation pass reported that survivor but left the test's claim standing. A far-future `at` reached the schema CHECK after the file was opened. The lane handoff named #81 as the wiring lane when #80 owns `mcp/context.ts`. Root causes: the plan checked the source but not what ships (second occurrence, same as #68), and the author's list was only attacked by the security-auditor (second occurrence, same as #68). Not fixed here: no growth ceiling or write deadline (#113), and the launcher umask (#81).
