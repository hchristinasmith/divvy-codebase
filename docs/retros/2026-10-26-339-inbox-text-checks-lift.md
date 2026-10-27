# Retro: #339, the two inbox writers share one copy of the blank and length checks

#339 (Housekeeping, gear 3). No gear shift appears in the record I was given. This file states no telemetry (model, duration, tokens, tool calls); the lane posts the four narratives after `baseline finish`.

Seats run, in order: architect (plan), implementer (opus, high; build), reviewer, test-guard, implementer (second dispatch, for the test-guard survivor), this retro. `schema-reviewer`, `brand-checker` and `security-auditor` do not apply (no migration, no UI, no route or hook). Verify passed on the final tree: `npx tsc --noEmit` clean, `npm run lint` clean, `npx vitest run` 113 files / 4742 tests passed.

Commits (`git log --oneline origin/main..HEAD`): 1380a32 (the lift, its tests and the guard allow-list line), f3eacf7 (test-guard survivor). The first commit is five files, +133 / -33: new `server/agents/db/text-checks.ts` (31) and `server/agents/db/__tests__/text-checks.test.ts` (94), `insights.ts` and `proposals.ts` (the private copies removed, an import added), and one line in `proposals.test.ts`. The second adds five lines to `text-checks.test.ts`.

## What was built

- **Kind of code:** a de-duplication refactor with its own test file. No new behaviour, no route, no migration, no UI.
- **Pattern:** one implementation per check, in an import-free module (the shape of `server/agents/db/scrubbed.ts`). `notBlank` and `atMostLength` moved out of the private copies in `server/agents/db/insights.ts` and `proposals.ts` into `server/agents/db/text-checks.ts`; both writers import it. The bodies are byte-identical: the reviewer diffed `origin/main`'s bodies against the module and the diff was empty.
- **Why this shape:** the module sits beside the two writers and takes no table, so the db guard can treat it like `scrubbed.ts`. `checkText` in `models/insights.ts` is a different rule, so it is fenced out and left.

## What went wrong

1. **Literal invisible characters in the first test file (Missed-by: do, caught by the lane's byte scan).** The implementer's `text-checks.test.ts` held 7 literal invisible characters (U+3164, U+200B, U+FE0F) although the brief said to write them as `\u` escapes. The lane's byte scan found them; the reviewer replaced them with escapes. Because the file was new, the fix went into the build commit (1380a32) and does not show as a separate round. Cost: a review fix and a scan, no rework of logic.
2. **The same thing again in the survivor fix (Missed-by: do, caught by the implementer's own byte scan).** In f3eacf7 the Edit tool wrote the four new values (U+00A0, U+2003, U+3000, U+2028) as literal characters. The implementer scanned its own edit, found them and converted them before the gate. Cost: one detour. Nothing reached a commit.
3. **The brief said the writer tests pass "unedited", and they could not (Missed-by: plan).** `proposals.test.ts` has a db guard that pins an exact import list for `server/agents/db/`, so any new module there needs one allow-list line. The line is `'./text-checks.ts'` in `IMPORTS['.']`. The architect and the reviewer both confirmed it; removing the line turns 2 guard tests red (EXECUTED). Cost: none beyond two seats re-deriving it, and a one-line edit to a test file the brief had fenced as untouched.
4. **`\s` could be narrowed to ASCII and every test stayed green (Missed-by: do, caught by test-guard).** The new file and both writer test files (209 tests) passed with `\s` replaced by an ASCII-only class, because tab and newline are also control characters (`\p{Cc}`), so only an ASCII space actually depended on `\s`. Cost: f3eacf7. The gap predates this diff: the old private copies were tested the same way.
5. **The first mutation script double-escaped its backslashes (Missed-by: do, caught by the implementer).** Shell quoting turned the patterns into something other than the intended mutants. The implementer discarded those results and re-ran them. Cost: one re-run; no wrong result was relied on.
6. **The db guard does not enforce "imports nothing" for `scrubbed.ts` or `text-checks.ts` (Missed-by: none; filed as #358).** The reviewer found that the guard checks a directory-wide import allow-list, not a per-file one. Adding an import to `text-checks.ts` in a scratch copy left the guard green, 90/90 (EXECUTED). The header comment says the module imports nothing, and nothing checks it. Left, not fixed: it is the guard's design, out of this lane's fence.

## Root causes

- **A `\u` instruction does not survive a hand-off (items 1, 2).** `docs/retros/2026-10-26-prd04-47-insights-agent.md` item 6 recorded the Write tool turning `\uXXXX` escapes into literal invisible characters; commit bbc69a0 on `main` ("invisible characters in tests written as \u escapes") is a review fix of what looks like the same thing, though I cannot tell from the record that it has the same cause. Here the first occurrence was in a newly written file and the second came through the Edit tool, so it is not specific to Write. The architect's plan text also showed literal characters where the escapes were meant, which points at the escape being rendered somewhere between a prompt or plan and the file. Which hop does it, I cannot say from the record. What the record does show is that an instruction in the brief did not prevent it twice in one lane and a byte scan caught it both times. #47's retro said "if another lane hits it, encode"; this is that lane.
- **Author's list versus the reach of the code (item 4).** Same name as #233, #301 and the family before them. The author trusts old tests that pass, and a move is exactly where that bites: the old tests had a `\s` pin that looked real, because the whitespace rows in the table were also control characters. The mutation that finds it is "replace the Unicode class with its ASCII subset", and it was test-guard that ran it, not the author. This lane's implementer ran its own mutations and 22/26 died against the new file; the `\s` narrowing was in the remainder.
- **A claim in the brief was not run (item 3).** Same family as `issue-premise-unchecked` and as #301's guard premise: "the writer tests pass unedited" was stated as a requirement and was falsifiable with one scratch edit. The architect checked it, which is why the cost was small.
- **A guard that checks a directory, not a file (item 6).** The cause is in the guard's design, not this diff. Single occurrence in the retros I read.
- **Item 5:** a tool or quoting slip, caught by the implementer's own habit of reading mutation results before relying on them. No deeper cause that I can point at in the record.

## What worked, keep it

- **A byte scan as a lane step.** It caught the literal characters in the first file; the implementer ran its own on the survivor fix and caught the same thing before the gate. It does not depend on the author remembering the rule.
- **The reviewer diffing the old bodies against the new module.** An empty diff is a stronger claim than "bodies unchanged" in a commit message, and it is why the lift can be read as a pure move.
- **The reviewer executing a probe on the guard, both ways.** Removing the allow-list line turned 2 tests red (the line is needed); adding an import to `text-checks.ts` left the guard green (the guard does not check what it says). Neither is visible from reading the diff.
- **Test-guard as a separate seat.** It killed 22/26 mutations against the new file, the NFKC-count mutant was killed by the writers' tests, and it found the `\s` narrowing. After f3eacf7 each narrowing fails exactly those 4 rows (EXECUTED in a scratch copy).
- **Keeping the fence.** `checkText` in `models/insights.ts` was left; the guard's weakness became #358 instead of an edit to the guard.
- **The survivor fix is small and its own commit** (five lines, f3eacf7), so the second reader sees only the response.

## Surfaced, not absorbed

- **#358** (Housekeeping, Spawned-by #339, Missed-by: review): the db guard does not enforce a per-file "imports nothing" for `scrubbed.ts` or `text-checks.ts`. EXECUTED in scratch: an added import left the guard at 90/90. The reviewer found it; I list `Missed-by: review` because that is the seat that found it, though the record does not say any earlier seat was in a position to.
- **`insertProposal` has no production caller yet.** Tracked by #42 (the category agent). Not a follow-up. `insertInsight` is reached from `server/agents/insights/agent.ts`.
- **Three literal invisible or irregular characters remain in tracked source (outside this diff).** A read-only scan of tracked `.ts`, `.tsx` and `.js` files for default-ignorable and non-ASCII space characters found one line in each of `mcp/audit/__tests__/sink.test.ts` (U+202E), `server/agents/db/__tests__/insights.test.ts` (U+202E) and `server/agents/insights/__tests__/queries.test.ts` (U+200B): 3 of 330 files. I do not know whether they are deliberate. Not filed: it needs a decision on whether to convert them, and any scan that fails on them needs them converted first. The two files this lane wrote are clean.

## Recommended changes

1. **Hostile-text fixtures are written as `\u` escapes, and the lane runs a byte scan on every test file it writes or edits (encode now; second occurrence after #47).** Add two lines to `docs/testing.md` under Assertions: (a) a fixture holding an invisible, bidi or non-ASCII-space character is written as a `\uXXXX` escape; (b) before the gate, scan the changed files for those characters. State outright that a brief or plan may render the escape as the literal character, so the scan, not the instruction, is the check. High leverage, two lines. Artifact: `/Users/hannahchristinasmith/Library/Mobile Documents/com~apple~CloudDocs/Desktop/Other Shit/RTR/div/divvy-codebase__worktrees/339-inbox-text-checks-lift/docs/testing.md`.
2. **Make the scan a command rather than a paragraph.** A script under `scripts/` that takes file paths (default: changed files against `origin/main`) and prints the file, line and code point of any default-ignorable or non-ASCII-space character. Do not wire it into `npm run lint` until the three existing lines above are converted or allow-listed, or it fails on a clean tree. Optional, higher leverage than the prose if the lane keeps hitting this. Artifact: `scripts/scan-invisible.sh`.
3. **When code moves, mutate the class the old tests never needed (encode with the #233 / #301 line).** "Replace a Unicode class with its ASCII subset" is one more mutation for the implementer's checklist beside the boundary plus-or-minus one already recommended in #301's retro. Not a new file; the same line in the same place. Artifact: `~/.claude/agents/implementer.md`, then `pnpm import-workflow --name current`.
4. **A brief that says a test file stays unedited names the guard test that would otherwise force an edit, or is checked first (do not encode).** A brief's claim about a guard is falsifiable with one scratch edit, but this cost nothing here. Watch it with the `issue-premise-unchecked` family.
5. **#358 is the real fix for item 6.** Make the db guard check a per-file import list for the import-free modules. No new artifact; the issue exists.

## Highest-leverage next step

Do change 1: add the two lines to `docs/testing.md` under Assertions. Both #47 and this lane lost a seat's attention to the same tool behaviour, the instruction in the brief did not prevent it either time, and the check that worked both times (a byte scan) is not written down anywhere a lane would read it. The next prd-04 issue with hostile-text fixtures will hit it again.

## Open items for the PR body

- #339, gear 3, no shift reported. Single-issue PR: squash.
- Diff: `server/agents/db/text-checks.ts` new; `insights.ts` and `proposals.ts` import it with the private copies removed, bodies byte-identical (reviewer's diff against `origin/main`: empty); `text-checks.test.ts` new; one line in `proposals.test.ts`.
- The conductor's brief said the writer tests pass "unedited". The db guard pins an exact directory import list, so the lift cannot land without `'./text-checks.ts'` in `IMPORTS['.']`; architect and reviewer confirmed, and removing the line turns 2 guard tests red (EXECUTED).
- Fence: `checkText` in `models/insights.ts` is a different rule, left. The guard itself is not edited (#358).
- Reviewer: 0 blocking; 1 finding fixed (literal invisible characters in the test file), 1 left and filed (#358).
- Test-guard: 22/26 mutations killed by the new file; the NFKC-count mutant killed by the writers' tests; the `\s` narrowing survived and is closed in f3eacf7 (EXECUTED: each narrowing now fails exactly those 4 rows).
- Surfaced: `insertProposal` has no production caller yet (#42).
- Follow-up: #358 (Housekeeping, Spawned-by #339, Missed-by: review).
- Gate on final tree: tsc clean, lint clean, vitest 113 files / 4742 tests.

## Retro narratives

These four are the text for the retro POST.

### narrative_code_type

A de-duplication refactor with its own test file and no new behaviour. The two agent inbox writers each carried a private copy of the blank check and the length check; both now import one copy from a new import-free module. Housekeeping, gear 3. No migration, no route, no UI.

### narrative_built

`notBlank` and `atMostLength` moved out of `server/agents/db/insights.ts` and `proposals.ts` into `server/agents/db/text-checks.ts`, the shape of `scrubbed.ts`; both writers import it and the bodies are byte-identical (the reviewer's diff against `origin/main` was empty). A new `text-checks.test.ts` pins each check with case tables. The db guard's import allow-list in `proposals.test.ts` gains `./text-checks.ts`, one line, because the guard pins an exact directory import list. `checkText` in `models/insights.ts` is a different rule and was left. Gate: tsc and lint clean, vitest 113 files / 4742 tests.

### narrative_how

Architect, then an opus implementer for the build, then the reviewer, then test-guard, then the implementer again for one survivor. The reviewer found no blocking issue, diffed the old bodies against the module, fixed literal invisible characters in the test file, and ran the guard both ways: removing the allow-list line turned 2 tests red; adding an import to the new module left the guard green at 90/90, which became #358. Test-guard killed 22/26 mutations against the new file; the one that survived narrowed `\s` to ASCII, and four non-ASCII whitespace rows (U+00A0, U+2003, U+3000, U+2028) now fail each narrowing, checked in a scratch copy. Two commits, each gated; no stash.

### narrative_wrong

Literal invisible characters reached the test file twice, once in the first draft (7 of them, caught by the lane's byte scan, fixed by the reviewer) and once in the survivor fix through the Edit tool (caught by the implementer's own scan), although the brief said to use `\u` escapes; the architect's plan also showed the literal characters, so an escape instruction does not survive a hand-off and only the scan catches it. #47's retro said to encode this on a second occurrence, and this is it. The brief said the writer tests would pass unedited, which the guard's exact import list makes impossible. `\s` could be narrowed to ASCII with every test green, a gap older than this diff. The implementer's first mutation script double-escaped its backslashes and was re-run. #358: the db guard does not check that `text-checks.ts` or `scrubbed.ts` import nothing.
