# Retro: #47 prd04 w2, the insights agent writes patterns and chart specs from fixed aggregate queries and a template

## Retro summary (for the PR body)

#47 added the insights agent: one deterministic run for one scope and one ISO week that reads the ledger through fixed queries, folds the rows in code, fills a markdown template and a chart spec, and writes each insight to the `insights` inbox through the validating accessor. The final gate is green at `5cd9871` (tsc 0, lint 0, vitest 110 files, 4241 tests). The agent was right in shape from the first commit. What moved were the rules around it: two things landed on `main` mid-lane that the plan assumed would not, and the "exclude transfers" rule turned out to be an open decision on another issue. Four review and fix rounds followed the build, each its own commit.

Gear as stamped on the issue, no shift reported. Implementer on opus. No telemetry is stated here; the lane posts the narratives after `baseline finish`.

Seats, in order: researcher, architect, implementer (opus, build `3cdd629`), reviewer (`47e2c8a`), implementer (drawings and error-class logging, `116a258`), reviewer second pass and security-auditor (`6ecb6c5`), docs-syncer (nothing stale), test-guard (`5cd9871`), this retro. Diff against the merge base (`1e17084`): 5 files, 2992 insertions, no deletions, all under `server/agents/insights/`: `queries.ts` (783), `prompt.ts` (174), `agent.ts` (102), and two test files (1096, 837). The fence held: no widening, no migration, nothing outside `server/agents/insights/` touched.

## What was built

- **Kind of code:** an agent module (`server/agents/insights/{queries,prompt,agent}.ts`). `queries.ts` does one scope-filtered knex read of settled Akahu rows, joined through `accounts.scope`, then pure integer-cent folds: top merchants, week-over-week change by category, unusual spends (a row far above the lower median of the same merchant's history), and spend by category per month with an "Other categories" bucket. `prompt.ts` is the template module. `agent.ts` is `startRun`, aggregates, drafts, an idempotent `insertInsight` per draft, then `finishRun`.
- **Pattern:** the agent does the arithmetic and the template only selects and orders. Every label is cleaned once at load by `cleanLabel` (NFKC, allow-list, 40 code points, digit runs of 8 or more masked, bounded prefix) and written into markdown inside a code span. Chart specs are built from `Aggregates` only, with no `$schema`. A run is `failed` if anything throws or the validator refuses any spec; a refused draft stores nothing, the others are still written, and there is no retry.
- **Why this shape:** the issue was written for a Sonnet call. prd-04 Ruling 7 (2026-10-25) voided every model, prompt and token clause, so the module named `prompt.ts` holds no prompt; the file name is kept from the issue because the issue names it. The real alternative, calling a model, was ruled out by Hannah, not chosen by the lane.

## What went wrong

1. **#264 (drawings) merged to `main` mid-lane, and the plan assumed it would not.** The lane learned it from the first reviewer, then applied it in `116a258`: a strawb drawing is not spend, so a strawb run now makes one extra read of personal inflows (id, scope, date and amount only), and a personal run reads no strawb row. Cost: one fix round (+357/-30). A gap remains and is documented in `queries.ts`: a personal run cannot tell a drawing's inflow half from any other inflow, so the interim transfer rule can pair it with an equal personal outflow and hide that outflow from spend. The second reviewer reproduced it. It is filed as a follow-up for Hannah, not fixed here.
2. **#245 moved `AgentTrigger` into `contracts.ts` on `main` after the branch was cut.** The branch would have stopped typechecking at merge. Reviewer 1 found it by merging `main` into a scratch copy. The fix in `47e2c8a` was two lines of `agent.ts`. Cheap, but it was found by luck of the reviewer's habit, not by a step in the lane.
3. **The own-account transfer rule was not set by #47 or prd-04.** The lane brief said "exclude transfers", and the architect chose to pair transfers (same cents, another own account, within 2 NZ days, greedy one-to-one) instead of trusting Akahu's `TRANSFER` type. The conductor then pointed out that how to tell a transfer from spending is an open decision on #52 (Baseline decision `0a37d21b`). The lane renamed the function `excludeOwnAccountTransfers`, put the whole rule in that one function plus `TRANSFER_WINDOW_DAYS`, and marked both as following #52 (`5cd9871`). Cost: a rename and comments, plus a rule that may be replaced. The plan treated a domain rule nobody had specified as an implementation detail, and never searched for an open decision on it.
4. **The chart validator and merchant text were coupled.** The spec validator reads a `:` in a string as a possible link, and ordinary merchant text has colons, so one such merchant would have failed a whole spec and with it the run. `cleanLabel` removes the coupling structurally (allow-list, not a list of bad characters). The first version read an unbounded string and kept long digit runs; review and audit had it mask digit runs of 8 or more and read a bounded prefix (`6ecb6c5`). A sweep over the whole BMP now pins `cleanLabel` to the validator, so a future validator change fails a test instead of a production run.
5. **test-guard found a time bomb and unpinned output.** A `finished_at` assertion would have gone vacuous after 2026-10-27 because it compared against the real date. Bodies, specs, tie-breaks and fractional amounts were also unpinned. All fixed in `5cd9871` (+355/-43). Mutation counts: the implementer ran 81 on the build, the reviewers 27 and 10, test-guard 78 (66 killed, 3 equivalent, 9 survivors, all 9 then fixed). The nine survivors were written by the seat that wrote the code, again.
6. **The Write tool converted `\uXXXX` escapes into literal invisible characters** in the hostile-text fixtures, so the test source held characters nobody could see. The implementer found it and converted them back. No cost beyond the detour, but any lane writing bidi or zero-width fixtures will hit it.
7. **Baseline seats may dangle.** This is the known hand-back bug, not something this lane did. I have not seen the final Baseline state for this run. Nothing was hand-stated.

## Root causes

- **The plan was written against a `main` that moved (items 1, 2).** Two unrelated merges (#264, #245) each broke an assumption, and both were found by a reviewer, not by a lane step. Nothing in the lane compares `HEAD` to `origin/main` between the branch cut and review. First time this appears in the retros I read, but two hits in one lane.
- **A domain rule left unspecified was treated as an implementation detail (item 3).** "Exclude transfers" has two defensible answers with different consequences, which is the definition of a decision, and it was already open on #52. The architect picked one and no one searched the open decisions. Same family as #51's "the fence was written without opening the code it fenced": the plan did not look at what already existed around it. Second occurrence of that family (plan accepted without checking the surroundings).
- **A stale issue body after a ruling (the Sonnet call, Ruling 7).** The issue still described a model call. The lane brief carried the amendment, so no work was lost, but this is the third prd-04 issue in a row (#31, #26, now #47) where the issue text lagged a ruling. Recurrence confirmed.
- **Author-written tests have the author's blind spots (items 4, 5).** The implementer's 81 mutations still left nine survivors, a date-dependent assertion and several unpinned outputs that test-guard found. This is the same family as #51's "a test written with the branch it tests has the same blind spot". Third prd-04 retro in a row. The loop works because a different seat tries to break the tests, but it is the third time that seat has been the one finding things.
- **Item 6:** a tool behaviour, not a decision. The Write tool rewrites `\u` escapes into their characters.
- **Item 7:** the known Baseline hand-back bug, outside this lane.

## What worked, keep it

- **The scope and the fence held.** Five files, one folder, no widening, no migration. Everything the lane found outside it (below) was named and not folded in.
- **Ruling 7 made the agent testable.** With no model, every figure an insight shows is a query output that a test checks against a hand-written query, and `prompt.ts` adds, subtracts and divides nothing.
- **Logs name the error class only.** A knex error carries SQL and bound values (the #31 lesson), so `agent.ts` logs a thrown error's class and a validator rejection's kind, reason and path, and never a label, amount or message.
- **Idempotent writes.** A re-run skips any insight already stored for the same kind, scope and period, dismissed or not, so a re-run neither duplicates nor resurrects one.
- **Reviewer and security-auditor executed, not argued.** The trial merge (item 2), the drawing pairing gap (item 1) and the digit-run masking (item 4) each arrived as a demonstration. Each fix is its own commit (`47e2c8a`, `116a258`, `6ecb6c5`, `5cd9871`), so the response is readable apart from the build.
- **The conductor caught the open decision on #52** before the interim rule hardened into the design. The lane then isolated the rule to one function, so the answer to #52 changes one body.
- **test-guard: 66 of 78 mutations killed, 3 equivalent, the 9 survivors fixed.** The time bomb alone justified the seat.
- **docs-syncer ran and found nothing stale**, which is a useful result for a lane that touches no documented behaviour.

## Recommended changes

1. **Open decisions and mid-lane merges are checked before the plan, and again before review (encode now; two hits in this lane).** Before the architect and before the first reviewer, the lane runs `git fetch origin && git log --stat HEAD..origin/main` and reads the merged titles against the issue, and searches open Baseline decisions for the words in the Done-when ("transfer", "drawing", and so on). One command, and it would have caught items 1, 2 and 3. Judgement call: this is the first retro to record it, so it is the one change here without a second occurrence; I recommend it anyway because it costs one command. Artifact: the `architect` and `reviewer` agent briefs in the workflow import (Baseline side, via `pnpm import-workflow`).
2. **An issue sliced before a ruling is amended when the ruling lands (encode now; third occurrence: #26, #31, #47).** When a PRD ruling voids clauses, the conductor lists the open issues that cite those clauses and edits their bodies the same day. Until that happens, the lane brief must say which clauses are void, as it did here. Artifact: the conductor's ruling checklist wherever it lives (I did not find one in the repo); the PRD itself should carry the list of affected issues under the ruling.
3. **Unspecified domain rules go to a decision, not to the architect (do not encode yet).** First occurrence. If a second appears, add a line to the architect's plan template: "if the brief names a business rule the PRD does not state, raise it with `baseline decide` first". Here the cost was a rename.
4. **Hostile-text fixtures are built with `String.fromCodePoint`, or checked for literal invisible characters (do not encode yet).** First occurrence of the Write tool behaviour. If another lane hits it, add two lines to `docs/testing.md` under the assertion rules. Artifact: `docs/testing.md`.
5. **Tests for a pure fold are written by mutation from the start (optional).** Three retros show the author's tests leaving survivors that another seat then kills. Asking the implementer to run mutations is already happening (81 here); the gap is that the same seat writes both. Not a change to make now, because the loop caught everything. Watch it.

## Highest-leverage next step

Add the pre-plan check (change 1) to the `architect` and `reviewer` briefs: `git log --stat HEAD..origin/main` plus a search of open decisions on the Done-when's nouns. Items 1, 2 and 3 are all "the world moved or was already decided, and the plan did not look", and `#58` and `#55` are about to plan against the same `main`. It is a Baseline-side change, outside this lane's fence, for the conductor.

## Open items for the PR body

- **Void Done-when:** the model, prompt and token clauses in the issue are void (Ruling 7). `prompt.ts` is the template module. The file name is kept from the issue.
- **Follow-ups surfaced (filed as Housekeeping, each with a `Priority: housekeeping` line):**
  - #302 Personal drawing-inflow pairing gap: a personal drawing inflow can pair as a same-scope transfer and hide an equal personal outflow. For Hannah, because the fix depends on #52's answer.
  - #301 The civil-date helpers now exist in three copies; `readDrawingIds` is a copy of `loadDrawingIds`. Lift both to `shared/`.
  - #303 `insertInsight` has no length caps on title or body.
  - #304 `cleanLabel` drops combining marks, which changes some non-Latin merchant names.
  - #305 `finishRun` mixes clocks: the lane passes `max(Date.now(), now)`.
- **Notes for #55 (insights screen):** render labels as text only, with no linkify; set a CSP; isolate bidi text; the chart's value axis is cents, not dollars.
- **Notes for #58 (scheduler):** schedule at least a few days after Sunday so the week's rows have settled; a re-run does not refresh a stored insight; there is no unique index on `(kind, scope, period)`, so idempotence lives in the agent, not the schema.
- **Interim rule:** `excludeOwnAccountTransfers` and `TRANSFER_WINDOW_DAYS` follow #52 (decision `0a37d21b`) and are the only two places to change.
- **Baseline:** seats may dangle (the known hand-back bug). Nothing hand-stated.
- Gate: tsc 0, lint 0, vitest 110 files, 4241 tests at `5cd9871`.

## Baseline narratives

### narrative_code_type

A background agent module under `server/agents/insights/`: typed aggregate queries, a markdown and chart-spec template module, and a run function that writes to the `insights` inbox. There is no model call, because prd-04 Ruling 7 voided it. Imported by the scheduler (#58) and the insights screen (#55).

### narrative_built

`queries.ts`, `prompt.ts` and `agent.ts`, with 2992 lines added across 5 files and no deletions. One scope-filtered read of settled rows, then pure integer-cent folds for top merchants, week-over-week change, unusual spends and monthly spend by category with an "Other categories" bucket. Labels are cleaned once at load and written in code spans; chart specs are built from the aggregates only. A run is idempotent per kind, scope and period, fails if anything throws or a spec is refused, and does not retry. Drawings are never spend. Gate: tsc and lint clean, vitest 110 files and 4241 tests.

### narrative_how

Researcher, architect, then an opus implementer built it in one commit. The reviewer (two passes) and the security-auditor each ran on the working diff, and every fix went in its own commit. Test-guard ran 78 mutations: 66 killed, 3 equivalent, 9 survivors that were then fixed. Docs-syncer found nothing stale. The conductor flagged that the transfer rule is an open decision on #52, so the lane isolated it in one function and marked it as following #52. Follow-ups were filed as Housekeeping, not folded in.

### narrative_wrong

Two merges to `main` landed mid-lane that the plan assumed would not: #264 (drawings), which changed what counts as spend, and #245, which moved `AgentTrigger` and would have broken typechecking at merge. A reviewer found both. The transfer rule was an unspecified domain rule the architect settled alone, though it was already an open decision on #52; the lane renamed and marked it. Merchant text with a colon would have failed whole chart specs, and long digit runs leaked, fixed with a stricter `cleanLabel`. test-guard found a date-dependent assertion that goes vacuous after 2026-10-27 and nine surviving mutations. The Write tool turned `\u` escapes into invisible characters. Baseline seats may dangle, the known bug; nothing was hand-stated.
