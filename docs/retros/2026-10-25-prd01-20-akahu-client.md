# Retro: #20 prd01 w1, typed Akahu client returning cents

Gear 4 as stamped; no shift. Implementer ran on opus: the Divvy table supersedes the issue's `model: sonnet`. This run has a `BASELINE_RUN_ID`, so the lane posts the four narrative fields below after `baseline finish`. Seats, in order: researcher, architect, implementer (build), reviewer, implementer (review follow-ups), then test-guard, security-auditor and docs-syncer in parallel, then implementer (test-guard gaps). Commits: dcf712e (build), 5d344e5 (review fixes), 4cd3e54 (test-guard gaps), all under `server/sync/` (6 files). Gate at the end: `tsc` and lint clean, 759 tests in 43 files.

## What was built

- **Kind of code:** a typed Akahu API client in `server/sync/` returning accounts, settled transactions and pending transactions in integer cents, with fixtures and a 1.5k-line test file.
- **Pattern:** the same exact-text JSON approach as the Xero client. A regex tokenizer quotes every JSON number literal in the raw response text before `JSON.parse`. A strict amount regex then feeds `shared/money.ts` `parseDollars`. There is no `Math.round` anywhere. Credentials are parameters, and a missing one raises `missing_credentials` per call. Pagination follows the cursor with a `MAX_PAGES` of 500 and a repeated-cursor guard. Settled and pending are separate types (pending has no id), enforced with `@ts-expect-error`. Failures are `AkahuError` codes with no `cause`, and error bodies are cancelled unread.
- **Why this shape:** the float path is the thing Done-when 1 rules out, and Akahu sends dollar amounts as JSON numbers. The deviation from the issue's wording (no rounding at all) was deliberate; the five listed cases pass.

## What happened

- The architect's tokenizer used a loose `-?\d+` number pattern that would have accepted `01`. The architect's note also claimed `01` splits into two tokens, which is wrong. A careful read caught it before the build, and the lane used the strict JSON number grammar.
- Reviewer round: it fuzzed the tokenizer against Node's `JSON.parse` source-text reviver (200k documents, 0 differences). It then found two real problems:
  - The tokenizer was quadratic on an unterminated string of `\"` (80 KB took 1.1 s, 200 KB about 7 s). Fixed.
  - The secret-leak table had no missing-credential rows, so a leak mutation stayed green. Fixed.
- The reviewer left three lows, which the lane then had fixed: an invalid or reversed date window threw a native `RangeError` or resolved `[]` (now `invalid_range`), a quoted leading-zero amount `"0019.99"` was accepted (regex tightened), and unread error bodies (now cancelled).
- test-guard ran 111 mutations. Survivors, all closed with tests that go red under the mutation: empty key fields, empty description, an odd number of escaped quotes before digits, the 5xx upper bound, arrays accepted as records, non-text optional values, a missing settled `type`, and a weak fixture scrub.
- test-guard claimed that dropping `|$` from the tokenizer should slow the scan. That was wrong. The `?` in `\\[\s\S]?` is what keeps it linear, and the tokenizer comment was corrected to say so.
- security-auditor was clean on this diff. Its pre-existing suggestions on `server/routes/akahu.ts` (500 bodies echo `err.message`, an unauthenticated raw passthrough to retire when sync replaces it) are not this lane's.
- docs-syncer edited `docs/testing.md`, outside the issue's fence, though the sentence it changed was still true. The lane reverted it. It also surfaced four stale comments outside the fence: `shared/money.ts:3-5`, `shared/money.ts:30-34`, `models/akahu.ts:57-58` and `server/db/seeds/transactions.js:16-17`. They say Akahu becomes cents via `dollarsToCents` or "server/sync later".

## What went wrong

- **The plan carried a false claim about the tokenizer.** The loose number pattern and the "`01` splits" assertion were in the architect's plan. Nothing in the process tests an architect's claim about parser behaviour, so a careful read was the only defence. Cost: none, caught pre-build, but it was luck of attention.
- **Two review rounds each found tests that could not go red.** The reviewer found the leak table with no missing-credential rows. test-guard then found eight more survivors out of 111 mutations. The first implementer's own mutation runs, which it reported as clean, caught none of these. Cost: two extra implementer rounds and two commits.
- **The tokenizer was quadratic on adversarial input.** Found by the reviewer's fuzzing, not by any test. The input is a bank's response over a tailnet, so exposure is low, but a 200 KB body costing 7 s is a real stall.
- **Seat advice was wrong twice.** test-guard's `|$` claim was incorrect and would have led to a wrong comment. docs-syncer edited outside the fence. Both were caught by the lane, not by a gate.
- **The pending shape is unconfirmed.** The live pending endpoint returned 0 items, so the pending fixtures are invented from Akahu's docs. A real pending item may differ.
- **Done-when 2's grep is not satisfiable on main.** `server/db/migrations/20261023120000_money_as_cents.js` contains SQL `ROUND(x*100)`. An in-file source guard covers `server/sync/` instead. This is a spec problem found at the end, not at plan time.
- **A bare number in a text field becomes a string.** Because the tokenizer quotes every number, `"_id":12` arrives as `'12'`. This is surfaced, not fixed.

## Root causes

- **A guard whose tests cannot tell it from a looser one.** Third occurrence of this family (Xero float grep in #34, currency regex anchors in #102, now empty key fields, the escape-count parity, the 5xx bound, arrays-as-records). In every case the implementer's own mutation list missed it and a later seat found it. The implementer chooses mutations around the code it just wrote, which share its blind spots.
- **Duplicated infrastructure.** This is copy two of the exact-text JSON parser (Xero's `server/xero/client/json.ts` is the first). The fence blocked a lift into `shared/`, so each copy gets its own bugs and its own fixes. The quadratic-scan fix here does not reach the Xero copy.
- **Plan claims about behaviour are not executed.** The architect's `01` claim was reasoning, not a run. One `node -e` would have settled it.
- **Fence not applied to read-only helper seats.** docs-syncer's default is to edit docs. Its handoff did not say "report, do not edit outside the fence".
- **Unverified API facts remain.** Pending shape is the clearest. Only a live account with a pending item can close it.

## What worked, keep it

- **Fuzzing the tokenizer against Node's own source-text reviver.** 200k documents with 0 differences is a stronger statement than any hand-written table, and the same run exposed the quadratic case.
- **Mutation testing by a seat that did not write the code.** test-guard's 111 mutations found what the author's list could not, and each survivor became a test that goes red.
- **Separate commits for build, review fixes and test-guard gaps.** Each second reader saw only the response to their own findings.
- **Pending and settled as distinct types, enforced by `@ts-expect-error`.** The no-id rule for pending cannot be quietly broken.
- **Stopping at the fence.** The docs-syncer edit was reverted and the four stale comments were surfaced, not folded in.

## Recommended changes

1. **Third occurrence, so encode it. High leverage:** in the `implementer` agent file, require that every guard (regex, bound, key-presence, type check) has a case that fails under the next-looser version of that guard, and that the mutation list be written from the guard list, not from the code. Artifact: `~/.claude/agents/implementer.md`, then `pnpm import-workflow --name current`. The conductor owns this edit.
2. **Lift the exact-text JSON parser into `shared/` and have Xero and Akahu import it.** One copy gets one set of fixes. Needs its own issue (gear 3, new exported symbol, touches `server/xero/`). Artifact: new file under `shared/`, with Xero's `server/xero/client/json.ts` replaced.
3. **Handoff text for docs-syncer:** "report stale docs; do not edit anything outside the issue's fence". Artifact: the lane handoff template. First occurrence, optional.
4. **Architect plan:** a claim about how a parser or regex behaves should come with the one-line command that shows it. Artifact: the `architect` agent file. First occurrence, optional.
5. **Four stale comments** in `shared/money.ts`, `models/akahu.ts` and `server/db/seeds/transactions.js` should be fixed in a Housekeeping issue.

## Highest-leverage next step

Add the "next-looser guard" rule to the `implementer` agent's checklist (item 1). Three retros have now named the same cause.

## Open items for the PR body

- Done-when 1 reads as rounding; this client does not round at all. Done-when 2's literal grep already fails on main because of a SQL migration, and the source guard in `server/sync/` stands in for it.
- Pending endpoint returned 0 items live, so pending fixtures are invented from Akahu's docs.
- Bare numbers in text fields become strings (`"_id":12` becomes `'12'`).
- `docs/testing.md` was touched by docs-syncer and reverted. Four stale comments are outside the fence (listed above).
- security-auditor's `server/routes/akahu.ts` suggestions are pre-existing and belong to whoever replaces the passthrough.

## For Baseline (four fields)

- **narrative_code_type:** a typed Akahu API client with a raw-text JSON number-quoting layer, in `server/sync/`.
- **narrative_built:** an Akahu client returning accounts, settled transactions and pending transactions in integer cents. A tokenizer quotes every JSON number literal in the response text, a strict amount regex feeds `parseDollars`, and nothing rounds. Credentials are parameters, pagination follows the cursor with a 500-page cap and a repeated-cursor guard, and settled and pending are distinct types. Failures are `AkahuError` codes. 759 tests pass across 43 files, with `tsc` and lint clean.
- **narrative_how:** researcher, then architect, then an opus implementer. The reviewer fuzzed the tokenizer against Node's `JSON.parse` reviver (200k documents, 0 differences) and found a quadratic scan and a leak-table gap. test-guard ran 111 mutations and the survivors were closed. security-auditor was clean, and docs-syncer's out-of-fence edit was reverted. Three commits: build, review fixes, test-guard gaps.
- **narrative_wrong:** the architect's tokenizer claim (`01` splits) was false and was caught only by a careful read. Two review rounds each found tests that could not go red, and the implementer's own mutation runs caught none of them, which is the third retro naming this cause. The tokenizer was quadratic on an unterminated `\"` string until the reviewer fuzzed it. This is the second copy of the Xero JSON parser because the fence blocked a lift into `shared/`. The pending shape is unconfirmed, and Done-when 2's grep already fails on main.
