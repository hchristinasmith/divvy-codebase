# Retro: #34 prd05 w1, typed read-only Xero client

Gear 3 as stamped; no shift. Implementer ran on opus: the handoff overrode the issue's `model: sonnet` per the gear 3-4 opus rule. This run has a `BASELINE_RUN_ID`, so the conductor posts the four narrative fields after `baseline finish`. Nothing was posted from this lane. Commits: fc33725 (build), 6980462 (review fixes).

## What was built

- **Kind of code:** a typed, read-only API client in `server/xero/` returning invoices, bills, pay runs and P&L in integer cents, with 116 tests of its own (276 in the repo).
- **Pattern:** plain `fetch` through one internal `xeroGet` that hard-codes GET and `redirect: 'error'`. Before `JSON.parse`, every JSON number literal in the raw response text is quoted, so amounts arrive as decimal strings. A strict `/^-?\d+(\.\d{1,2})?$/` guard then delegates to shared `parseDollars`. Pagination stops on an empty page or on `pageCount`, never on a short page, and a 200-page cap raises `bad_response`.
- **Why this shape:** `xero-node` deserialises amounts to JS numbers, which is the float path done-when 1 rules out. Many Xero API facts were written from memory and marked UNVERIFIED, so the design rule was that a wrong guess must fail loudly as `bad_response` or `forbidden`, never as zero.

## What happened

- The architect planned first. The conductor ruled on its open questions: `XeroInvoice[]` plus an exported `sumAmountDueCents`, and `XeroBill.dueDate` as `string | null`.
- The implementer wrote 107 tests and ran 28 mutations, all red. The float mutation (`Math.round(parseFloat*100)`) was caught only by a source grep. It brute-forced a value where float is a cent out (85541708717991.35) and added that as a behaviour row. The escaped-quote fixture had no digits, so ignoring escapes stayed green. It added digits so that mutation went red.
- The conductor staged the build before review so the reviewer's fixes could land as a separate commit without `git stash`.
- Reviewer findings:
  - **HIGH:** rows missing `Type` or `Status` were silently filtered out, so a Xero shape change returned `[]`. That reads as "zero invoices" (done-when 9). Fixed by reading those keys strictly.
  - **LOW:** the number scanner accepted invalid JSON numbers (`01`, `1.`, `1-2`). Fixed with a JSON number-grammar check.
  - **Comments:** they claimed every failure is a `XeroClientError`. In fact `fetch` and `getAccessToken` rejections pass through unchanged. Comments were corrected and a test pins the behaviour.
  - **Scopes:** names changed to the granular `accounting.invoices.read`, `accounting.reports.profitandloss.read` and `payroll.payruns.read`. Xero apps created on or after 2 March 2026 get only granular scopes. Still UNVERIFIED against a live app.
- security-auditor found no critical or warning items. test-guard ran 20 more mutations, all red. Its thinnest guards, cash-basis and token-cache, are each held by a single test. docs-syncer left the PRD evidence and audit row as dated snapshots and noted that `testing.md` has no fixtures section.
- Test count after fixes: 116 in the client, 276 in the repo.

## What went wrong

- **Missing keys read as "not outstanding".** The plan said "re-filter in code on type, status". The build implemented that as a comparison, so a row with no `Type` or `Status` failed the comparison and was dropped. That is the silent-zero failure the whole design was meant to prevent. Only review caught it. The implementer's 28 mutations did not, because no fixture lacked those keys.
- **Currency was never considered at plan time.** `sumAmountDueCents` adds across currencies. That was found after the fact and filed as #102 (Missed-by: plan). The decision is Hannah's, in the sync lane.
- **The float guard was held only by a grep.** No behaviour test failed under the float mutation until the implementer hunted for a value where float is a cent out. This was caught in the lane, and cost a brute-force search.
- **Stale CLAUDE.md line.** The implementer and the reviewer both said "Baseline does not know this project", but this run has a run id. Neither checked the environment. The cost was misleading wording, not lost data.
- **The reviewer could not re-mutate its own fixes.** Its mutation script restores from the index, and the fixes were unstaged. test-guard covered them (M16, M17).

## Root causes

- **Fail-loud rule stated at the design level but not at the predicate level.** "Every wrong guess fails loudly" was the principle, but "re-filter on type, status" was left as a comparison. Any comparison on a field that might be absent has a third outcome, and the plan did not name it. Symptom: `[]` on shape change. Cause: no plan line saying a filter must distinguish absent from not-matching.
- **Plan did not enumerate the data dimensions of the money type.** Amounts were covered (cents, no floats). Currency was not, so summing was written as if there were one.
- **The CLAUDE.md "off the record" line is a static claim about runtime state.** It was stale for this run.
- **Several UNVERIFIED Xero facts remain.** The scope names are the clearest example. This is honest uncertainty, not a miss, and only a live app or spike can close it.

## What worked, keep it

- **Fail loudly, never zero, as the stated response to unverified API facts.** Review's HIGH finding was found because this rule gave the reviewer something to test against.
- **Choosing plain `fetch` over the SDK after checking what the SDK does to numbers.** The float path was removed by design, not patched.
- **Mutation testing by three seats.** The implementer ran 28, test-guard ran 20 more, and all were red. The implementer also strengthened the weak spots it found (the float row and the escaped-quote digits).
- **Staging the build before review.** It made the review fixes a separate commit with no stash, which is exactly what the second reader needs.
- **Surfacing, not absorbing.** #102, #103 (prettier would rewrite fixture number literals, needs `.prettierignore`, outside fence) and #104 (`testing.md` fixtures section) were each filed rather than folded in.

## Recommended changes

1. **High leverage:** in the architect's plan template, add a line for any "filter" or "re-filter in code" step. It must state what a missing field does, and the answer must be to throw, not to exclude. Artifact: the `architect` agent file. First occurrence, so per the retro rule, encode it only if it recurs.
2. **At plan time for any money-summing helper:** list the dimensions of the data (currency, scope, sign) and say which the helper ignores. #102 is the first instance.
3. **Reviewer mutation script:** make it restore from `HEAD` or a named base, not the index, so it can re-run mutations over unstaged fixes. Optional.
4. **CLAUDE.md "Baseline does not know this project" line:** change it to "check `$BASELINE_RUN_ID`". Optional, and it belongs to the conductor.

## Highest-leverage next step

Before the sync lane uses `getReceivableInvoices` or `getPayableBills`, settle #102: decide what `sumAmountDueCents` does with a multi-currency set (reject, group, or filter to NZD).

## Open items for the PR body

- A Draft pay run with null totals fails the whole `getPayRuns` call. This is loud, not wrong.
- Pay-run availability on the real tenant is unknown until the OAuth lane or a spike. Open questions: is Payroll NZ enabled, and is the scope obtainable?
- The granular scope names are UNVERIFIED against a live app.

## For Baseline (four fields)

- **narrative_code_type:** a typed read-only API client with a raw-text JSON number-quoting layer, in `server/xero/`.
- **narrative_built:** a plain-`fetch` Xero client with a single GET-only, redirect-refusing `xeroGet`. It quotes JSON number literals before parsing so amounts arrive as decimal strings. A strict two-decimal guard feeds shared `parseDollars` to give integer cents. It returns invoices, bills, pay runs and P&L. Pagination stops on an empty page or `pageCount`, with a 200-page cap raising `bad_response`. 116 tests (276 in the repo).
- **narrative_how:** architect plan first. `xero-node` was rejected because its number deserialisation is the float path. Conductor rulings on the open questions. Implementer on opus ran 28 mutations. Build staged before review so review fixes committed separately. The reviewer found 1 HIGH and 1 LOW. security-auditor found nothing. test-guard ran 20 more mutations, all red. Follow-ups #102, #103 and #104 were filed, not absorbed.
- **narrative_wrong:** the plan's "re-filter on type, status" became a comparison, so rows missing those keys were silently dropped and a shape change returned `[]`. Only review caught it. Currency was never considered at plan time, so `sumAmountDueCents` sums across currencies (#102). The float guard was held only by a source grep until a brute-forced value made it a behaviour test. Xero scope names and pay-run availability remain UNVERIFIED.
