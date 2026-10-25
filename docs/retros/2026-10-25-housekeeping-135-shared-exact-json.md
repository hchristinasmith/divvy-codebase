# Retro: #135 Housekeeping, lift the exact-text JSON reader into shared/

Gear 3 as stamped; no shift. Implementer ran on opus for the build and haiku for the test-guard fix. This run has a `BASELINE_RUN_ID`, so the lane posts the four narrative fields below after `baseline finish`. Seats, in order: architect, implementer (opus), reviewer, test-guard, implementer (haiku, test-guard fix), docs-syncer. Commits: 9d3ea48 (shared module and its test), d369a41 (repoint both clients, delete the copies), e1bf673 (review fixes), 836748e (test-guard fix). Gate at the end: 45 files, 979 tests green. The existing client test files are byte-identical to main, and the 264 client tests pass before and after.

## What was built

- **Kind of code:** a shared pure module, `shared/exact-json.ts` (66 lines), with a 404-line test file. It exports the exact-text JSON reader and `exactAmountToCents(text): number | null`. `server/sync/akahu-client.ts` and `server/xero/client/json.ts` now call it, and `server/xero/client/money.ts` uses the strict amount reader. Net client change: 38 lines added, 111 deleted.
- **Pattern:** the regex tokenizer quotes every JSON number literal in the raw text before `JSON.parse`, so amounts never pass through a float. A strict amount regex then goes to `shared/money.ts`. Each client keeps its own error type and messages and maps the shared reader's `null` or throw onto them.
- **Why this shape:** Akahu's tokenizer and Xero's character scanner were two implementations of the same job. The architect measured both, kept the tokenizer and deleted the scanner (numbers under "What happened").

## What happened

- **The choice between the two readers was executed, not argued.** The architect ran 200,000 seeded documents (105,829 valid) against Node v22.22.2's `JSON.parse` reviver `context.source`. The tokenizer had 0 differences. The scanner had 2: it quoted a bare numeric key, so `{10:...}` parsed. All 15 recorded fixtures agree between the two. Speed on a 6.8 MB document was 153 ms for the tokenizer against 211 ms for the scanner. That settled it.
- **The issue's premise was wrong.** It said the two amount regexes were identical. They were not: `XERO_AMOUNT` accepted leading zeros. The lane unified on the strict one, which narrows Xero. Declared Xero narrowings:
  - quoted leading-zero amounts are now refused;
  - a bare numeric key is now `bad_response`;
  - (reviewer) a single JSON string over about 8.4M characters overflows V8's regex stack and becomes `bad_response` where the old scanner parsed it. Akahu always had this.
- **The lane changed the architect's API.** The architect proposed only an `isExactAmount` predicate, to avoid exporting a function nothing calls. The lane exported `exactAmountToCents` instead, so the Done-when's "strict amount-to-cents reader" is literally exported and both clients call it while keeping their own messages. This is a lane decision, not an architect one.
- **Reviewer: 4 findings, 3 fixed in e1bf673, 1 declared.**
  - The linear-scan test missed a body ending in a lone backslash. The mutant `\\[\s\S]` with `(?:"|$)` stayed green and ran 7,040 ms. The plan had said "`$` alone keeps it linear", from timings on one body shape, and that was wrong. The test now has the lone-backslash case.
  - The module header claimed nothing multiplies by 100. `shared/money.ts` does `whole*100`. Corrected.
  - The header said a number before `:` is left bare. Backtracking can quote a prefix. Corrected.
  - The 8.4M-character limit stays and is declared in the PR body.
- **test-guard:** gate green. Three wiring mutations survive in client code: Xero out-of-range swallowed or clamped, Xero back to the loose regex, and the Akahu non-string guard removed. They survive because the fence froze the client test files, so no test there could be changed to kill them. That is follow-up #140. Bare `.toThrow()` on the out-of-range assertions was tightened to `.toThrow(TypeError)` in 836748e.
- **docs-syncer** ran last. The alias `parseXeroJson` is kept because its caller `http.ts` is outside the fence. Removing it is follow-up #141.

## What went wrong

- **The issue stated a fact nobody checked.** "The two regexes are identical" was in the issue and went into the plan. A diff of the two lines would have shown the leading-zero difference. It was found during the build, so the cost was a changed scope (a declared Xero narrowing) rather than rework. Plan seat.
- **The plan's linearity claim was measured on one body and generalised, and it was wrong.** "`$` alone keeps the scan linear" was timed only on an unterminated `\"` string with no trailing backslash. The lone-backslash mutant then ran 7,040 ms and stayed green until the reviewer found it. Cost: one review fix and a test case. This is the same kind of error as #20, where test-guard's `|$` claim was also wrong.
- **The linear-scan test did not cover the case that mattered.** The implementer's own cases left a hole at the end-of-body lone backslash. The reviewer found it, not the author.
- **Two header claims were false.** "Nothing multiplies by 100" and "a number before `:` is left bare" were both stated without checking against `shared/money.ts` and the tokenizer's backtracking. Small, but both were comments that would have misled the next reader.
- **The fence made the wiring unprovable inside this PR.** The client test files were frozen, so the proof that the clients call the shared reader correctly (out-of-range handling, strict regex, non-string guard) cannot live here. Three mutations survive until #140. The unit tests on the shared module are strong; the wiring is only checked by the 264 untouched client tests, which did not go red under those three mutations.
- **A bare `.toThrow()` hid which error was thrown.** Cost: one haiku round and one commit (836748e).

## Root causes

- **A guard whose tests cannot tell it from a looser one.** Fourth occurrence (#34 Xero float grep, #102 currency regex anchors, #20 several, now the lone-backslash linear-scan case and the bare `.toThrow()`). The implementer's cases follow the code it just wrote; the loosened guard is found by a later seat. I have not checked whether the rule proposed in the #20 retro (item 1, the implementer's "next-looser guard" case) landed; this finding is exactly its shape.
- **Plan claims about behaviour go past what was run.** Recurrence of the #20 cause: the architect's `01` split claim, test-guard's `|$` claim, and now the plan's `$` linearity claim. In this run both were executed, but the `$` claim generalised from one input shape; the reader comparison ran 200,000 shapes. The difference was the breadth of the input, not whether a command was run.
- **Issue premises are not checked at slicing.** "Identical regexes" was a statement about two files, and nobody opened both. Cause of the narrowing being found late.
- **The fence freezes the tests that would prove the wiring.** A lift that repoints callers needs the callers' tests to be allowed to change. Here the issue named the client files in the fence and left their tests out, so proof of the repoint is deferred by construction. This is new, one occurrence.
- **Duplicated infrastructure: resolved.** The #20 retro named the two copies of the exact-text reader as a cause. This issue removes the second copy. A fix to the scan now reaches both clients.

## What worked, keep it

- **Measuring the two candidates against Node's own reviver.** 200,000 seeded documents with a count of differences turned "which parser do we keep" into a number. It also found a real defect in the scanner (a bare numeric key parsed).
- **Declaring the narrowings.** Each Xero behaviour change is listed in the PR as a change, not buried in a diff.
- **Mutation by a seat that did not write the code.** The reviewer's lone-backslash mutant and test-guard's three wiring survivors were things the author's list did not hold.
- **Separate commits for build, review fixes and test-guard fix.** Each second reader saw only the response to their own findings.
- **Surfacing instead of absorbing.** #140 and #141 were filed as follow-ups rather than stretching the fence.
- **Leaving the client tests byte-identical.** 264 passing before and after is a real regression check on behaviour, even though it cannot check the wiring.

## Recommended changes

1. **Fourth occurrence of the weak-guard cause, so encode it, if it has not landed. High leverage:** `implementer` must write a case that fails under the next-looser version of every guard, with the mutation list built from the guard list (regex, bound, anchor, error type). Artifact: `~/.claude/agents/implementer.md`, then `pnpm import-workflow --name current`. The conductor owns this edit. Check first whether #20's item 1 already did it.
2. **Second occurrence of plan claims going past their evidence, so encode it.** In the `architect` agent: a claim about how a regex, parser or scan behaves ("linear", "splits", "identical") must carry the command that shows it, its result and the inputs it covered, or be labelled REASONED and kept out of the plan's acceptance criteria. Artifact: `~/.claude/agents/architect.md`. Conductor edit.
3. **Issue slicing:** a premise that says two things are the same must name the diff that shows it. Artifact: the issue template used by the slicing seat. First occurrence, optional.
4. **Fence rule for lifts:** when an issue repoints callers, the callers' test files go inside the fence, or the issue says up front that wiring proof moves to a named follow-up. Artifact: the fence/slicing section of the project handoff template. First occurrence, optional. #140 is the follow-up here.
5. **Follow-ups already filed:** #140 (client-side wiring tests for the three surviving mutations), #141 (remove the `parseXeroJson` alias and its use in `http.ts`). Both are housekeeping unless Hannah rules otherwise.

## Highest-leverage next step

Do #140. The three surviving mutations are the only place where this change can be broken without a test noticing, and each one is a client-side test that goes red under a named mutation. After that, add recommendation 2 to the `architect` agent file.

## Open items for the PR body

- Xero narrowings: quoted leading-zero amounts refused; bare numeric key is `bad_response`; a single JSON string over about 8.4M characters is `bad_response` (Akahu always had this).
- The issue's "identical regexes" claim was false; unified on the strict one.
- `exactAmountToCents` was exported instead of the architect's `isExactAmount` predicate.
- Follow-ups #140 and #141. Neither is absorbed here.

## For Baseline (four fields)

- **narrative_code_type:** a shared pure-function module (`shared/exact-json.ts`) for exact-text JSON reading and strict amount-to-cents, replacing two per-client copies.
- **narrative_built:** `shared/exact-json.ts` with a 404-line test file. It exports the exact-text JSON reader (a regex tokenizer that quotes number literals before `JSON.parse`) and `exactAmountToCents`. Akahu's client and Xero's `json.ts` and `money.ts` now call it; Xero's character scanner was deleted. Client diff is 38 lines added and 111 deleted. Existing client test files are unchanged and 264 client tests pass before and after. The gate is 45 files, 979 tests.
- **narrative_how:** architect, then an opus implementer, reviewer, test-guard, a haiku fix, and docs-syncer. The architect chose the tokenizer over the scanner by running 200,000 seeded documents against Node's `JSON.parse` reviver source text on Node v22.22.2: tokenizer 0 differences, scanner 2 (a bare numeric key parsed), and 153 ms against 211 ms on a 6.8 MB document. The lane exported `exactAmountToCents` where the architect proposed only a predicate. Four commits: module, repoint, review fixes, test-guard fix.
- **narrative_wrong:** the issue said the two amount regexes were identical and they were not (Xero accepted leading zeros), so Xero is narrowed. The plan said "`$` alone keeps the scan linear" from timings on one body shape; a lone-backslash mutant ran 7,040 ms and stayed green until the reviewer found it. Two header claims were false. The fence froze the client test files, so three wiring mutations survive (follow-up #140), and the `parseXeroJson` alias stays (follow-up #141). A string over about 8.4M characters now overflows V8's regex stack in Xero and returns `bad_response`. Root causes: weak-guard tests (fourth occurrence), plan claims generalised past their evidence (second), unchecked issue premise, and a fence that froze the wiring tests.
