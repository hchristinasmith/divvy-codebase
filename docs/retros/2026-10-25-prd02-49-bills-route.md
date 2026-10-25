# Retro: #49 prd02 w3, bills can be created, edited and marked paid (bills data module, bills routes, contract comments)

Gear 4 as stamped; no shift. The issue said `model: sonnet`; the CLAUDE.md table maps gear 4 to opus, and the implementer ran on opus per the table. No Baseline decision widened the fence. This file states no telemetry (model, duration, tokens, tool calls); the lane posts the four narratives after `baseline finish`.

Seats run, in order: researcher, four Baseline decisions (answered by Hannah), architect, implementer (build, two commits), reviewer and security-auditor in parallel, implementer (review fixes, one commit), test-guard, implementer (same-site check tests, one commit), docs-syncer (report-only), implementer (contract comments, one commit), this retro. Every seat the gear 4 table lists ran. `schema-reviewer` does not apply (no migration) and `brand-checker` does not apply (no UI). Verify passed on the final state: `npx tsc --noEmit` exit 0, `npm run lint` exit 0, `npx vitest run` 76 files / 2616 tests.

Commits (`git log --oneline origin/main..HEAD`): 8355260 (data module), 3a6cc76 (route), bfcb904 (reviewer's two test fixes), e3e1a0a (test-guard's same-site check tests), 8129ca8 (contract comments). The three-dot diff (`git diff --stat origin/main...HEAD`) is six files, +3503 / -9: `server/db/bills.ts` (734), `server/db/__tests__/bills.test.ts` (1327), `server/routes/bills.ts` (238 changed), `server/routes/__tests__/bills.test.ts` (1193), 16 lines in `shared/contracts.ts`, and 4 lines in `server/routes/__tests__/barrel.test.ts`. Tests are about 2.6 times the size of the code.

A note on the fence, because I checked it against the record. The issue body lists three paths (`server/db/bills.ts`, `server/routes/__tests__/bills.test.ts`, `server/routes/bills.ts`). The diff has three more: the data module's own test file, the additive contract block, and the barrel test. I was told the lane's fence included all six, and no decision or issue comment widens it, so I report them as "inside the lane's fence, outside the issue's list". That gap is item 5 below.

## What was built

- **Kind of code:** a money-state write route (`GET`/`POST`/`PATCH`/`DELETE /api/v1/bills`, `POST /api/v1/bills/:id/payments`), a data module (`server/db/bills.ts`) under it, an additive edit to `shared/contracts.ts` (a `nextBill` field and comments), and two large test suites. No migration; the tables already existed.
- **Pattern:** a bill is a schedule (`firstDueDate` and `repeat`) plus an append-only `bill_payments` log. "Mark paid" inserts a payment row and never updates one. Which occurrences are unpaid comes from `billOccurrencesThrough` and `nzCalendarDate`, imported from `server/db/overview.ts`, so the Bills list and the overview hero work out the same occurrences. A one-off is paid once (a second attempt answers 409); a repeating bill moves to its next unpaid occurrence. A write that would leave more than 1000 unpaid occurrences is refused with a 400, and one that would reschedule or delete a bill with payments with a 409, rather than truncated or allowed. Invalid input is a 400 with a message; any other failure is a fixed-text 500.
- **Why this shape:** the contested choices went to Hannah (see "What happened"). The shared occurrence code was imported from `overview.ts` and not moved to `shared/`, because moving it needs files outside the fence (#233).

## What happened

- **The researcher ran first and the lane then raised four Baseline decisions instead of building through them.** Hannah answered all four:
  1. 49c5aac2, option A: import `billOccurrencesThrough` and `nzCalendarDate` from `server/db/overview.ts`, and copy the 1000-occurrence limit into `server/db/bills.ts` with a "change both together" note. Follow-up #233 moves all three to `shared/`.
  2. afd188fb, option A: delete and reschedule answer 409 once a bill has payments. How a repeating bill ends without losing history stays open in #147.
  3. 1964e048, option A: the payment route is `POST /:id/payments`, as the contract says. The issue body said `/pay`.
  4. 1a2c3eb4, option C: no pay-ahead limit. I had recommended B. Hannah added that a technical bound must answer a clear 400 or 409 and never crash, so mark paid answers 409 for an occurrence past 2099-12-31.
- **The first raise of decision 1 was refused with a 400** (`options[].fence must be object`), because `fence` was sent as a string. This is the sixth recorded occurrence (the #46 retro counts five). Cost: one lost round trip. Nothing has reached the lane's instructions since the first recommendation, so the lane guessed the type again.
- **The fourth decision was the architect's addition.** The architect proposed refusing a payment on an occurrence not yet due (`not_payable_yet`). The issue text, as I read it, does not state that behaviour, and a wrong guess means rework, so the lane raised it as a decision instead of building it. Hannah chose against both the architect's proposal and my recommendation.
- **The issue text and the repo disagreed in three places, and the lane followed the repo:** the `/pay` path (the contract says `/payments`), a "next one" figure with no field in `BillsResponse` (the lane added `nextBill`), and #35's due-date model (the issue comments say #170 changed the request to `firstDueDate` and `repeat`).
- **Reviewer** (4 findings, 0 blocking). 30 mutations, 25 killed. A randomized cross-check of 60 setups and 402 bill checks against `GET /overview` found no disagreement, which is direct evidence for the "due before payday agrees with the overview ledger" done-when. Fixed in bfcb904: no test pinned the generic 500 on 4 of the 5 endpoints, and the one-off already-paid check and the UNIQUE catch masked each other (either one alone gave the same 409). Left: an unreachable `OverviewDataError` branch, and an open question for Hannah (below).
- **Security-auditor:**
  - **W1 (EXECUTED).** The 1000 limit is checked only when a bill is written. A weekly bill created at the limit moves past it as weeks go by, and then `GET /overview` answers 500 for every scope. Filed as #247 (housekeeping); it needs `server/db/overview.ts`, outside the fence.
  - **W2.** DNS rebinding passes `fromThisSite`. This is pre-existing in the copied helper; the evidence went on #218.
  - **Suggestions.** S1, the settings and transactions writes have no site check (#218). S2, a payment cannot be undone (accepted with decision C). S3, no cap on the number of bills. S4, gaps in the header tests (fixed in e3e1a0a).
- **Test-guard: gated PASS.** 63 mutations, 55 killed, 7 survived: 1 equivalent mutant, and 6 in `fromThisSite` and the check order. The implementer killed all of them in e3e1a0a.
- **Docs-syncer (report-only).** The contract comment on `paidThisMonthCents` named columns against the file header, and `paid` was undocumented for repeating bills. Both were fixed in 8129ca8. The reverse copy notes went to #233, the Bills screen notes to #54, and a proposed amendment to prd-02 Ruling 2 is for Hannah.
- **Copies added.** `fromThisSite` is now in 3 places, `errorClass` in 4, `parseScope` in 2, and `server/db/bills.ts` carries its own `guard` and `MAX_UNPAID_OCCURRENCES`. Tracked in #236 (comment added) and #233.
- **One disagreement kept on purpose and pinned by a test:** a corrupt `payday_weekday` row makes the overview answer 500, while `GET /bills` answers 200 on the default.
- **One path not tested:** the UNIQUE-conflict catch in `markBillPaid` cannot be reached under SQLite's single connection.

## What went wrong

1. **Three of the four decisions existed because the slice was cut from the PRD, not from the repo (Missed-by: plan).** #49 was sliced before #44 put the occurrence helpers in `server/db/overview.ts` rather than `shared/`, so the issue could not say where to import from. It named a `/pay` path that the contract already contradicted. And it asked for a "next one" figure that `BillsResponse` had no field for. Cost: three of the four decisions, and a copied limit that now exists twice. No wrong code reached main. The comments on the issue (#170, #44) did carry the latest facts, so the information existed; it was in comments, not in the body or the fence.
2. **A limit that depends on the clock was enforced only at write time (Missed-by: plan).** The 1000 limit comes from #44's design. A check made when a bill is saved is not true a week later, because every week adds an occurrence to a weekly bill. The #44 comment on this issue even said "consider guarding `firstDueDate` on create", which is the write-time check this lane built. It is correct as far as it goes and it still lets the overview break later (W1 / #247). The security-auditor demonstrated it; nothing in the plan or the contract says the limit moves with time.
3. **`baseline decide` was refused again for `fence` shape (Missed-by: plan).** Sixth occurrence. The cause is the same as in the #46 retro: a recommendation in a retro file is not a change until someone edits the instructions, and no one is named to do that. Cost: one lost round trip, small. The cost of leaving it is that every lane that raises a decision pays it.
4. **Tests that could not fail, and behaviours with no test (Missed-by: do; caught by review and test-guard).** The implementer's suite had no pin on the generic 500 for 4 of 5 endpoints, two checks that masked each other, and 6 surviving mutants in the same-site check and the check order. Cost: two follow-up commits (bfcb904, e3e1a0a). This is the "author's list versus the reach of the code" pattern again (#39, #44, #46). Six of the survivors were in a copied helper (`fromThisSite`); I cannot tell from the record whether the original's tests were copied with it.
5. **The issue's fence did not list three files the work needed (Missed-by: plan).** The data module's own test file, the additive contract block and `barrel.test.ts` were all predictable. The barrel move from `PLACEHOLDERS` to `EXISTING` has now happened in #44, #46 and #49. The lane treated each as a forced consequence and did not stop, but a fence that lists none of them makes "needed, touched" uncheckable. Third occurrence of this specific miss.
6. **Duplication left by the fence (Missed-by: plan).** Each route lane adds a copy of `fromThisSite`, `errorClass` or `parseScope` because lifting them touches other lanes' files. The helper that needs the fix (#218) now has three copies to fix. #236 is open and the three sibling lanes in wave 3 (budgets #48, goals #50, habits #52) will each add to the count unless it lands first.
7. **Process slips (mine, the lane):**
   - My first `lint` and `vitest` exit codes printed blank, because zsh has no `PIPESTATUS`. I re-ran the gate to get real exit codes. Cost: one extra full gate. Single occurrence.
   - I read `git diff --stat origin/main` (two-dot) and saw client files from #243 that had landed on main in the meantime. I almost took that for a fence breach. The three-dot form showed only the six fenced files. Cost: a few minutes of doubt, nothing shipped. Single occurrence.

## Root causes

- **Plan covers the code that changes, not the code that reads, pins or constrains it (items 1, 2, 5, 6).** Same family as #25, #39, #46 and #67. Here it appears as: the module the new code must import from (item 1), a limit that moves with time (item 2), the three files that move with every route (item 5), and the helpers that will be copied again (item 6). The slice was cut from the PRD and the issue comments were not folded into the body.
- **A recommendation with no owner never lands (item 3).** `fence` shape, six occurrences, recommended in at least three retros. The fix is a one-line edit to `~/.claude/CLAUDE.md` or a decision example, and the record shows no one assigned to it. This is not a lane fault; the lane can only report it again.
- **Author's list versus the reach of the code (item 4).** The implementer tests what it thought of; the reviewer and test-guard mutate and find the rest. Nothing new to add. A copied helper should carry its source's test cases; here it carried none of them.
- **A clock-dependent invariant checked at one moment (item 2).** The plan treated "at most 1000 unpaid occurrences" as a property of a bill, when it is a property of a bill and today's date. I cannot say from the record whether the PRD or #151 ever stated this; #44's comment says only "consider guarding".
- **Item 7:** a shell difference and a diff flag. No deeper cause.

## What worked, keep it

- **Raising a decision instead of building through a fork.** Four forks, four short answers, no rework after any of them. The fourth one (pay-ahead) came from the architect's own proposal and the lane did not absorb it; Hannah's answer went against both the proposal and my recommendation, which is the case the rule exists for.
- **The contract and the repo beat the issue text.** `/payments`, `nextBill` and `firstDueDate` were followed from the contract and the #170 comment, and the lane said so in the decisions, not in a silent edit.
- **A seat that runs the real thing.** The reviewer's randomized cross-check of 402 bill checks against the overview and the security-auditor's executed W1 are demonstrations. Both came from seats that did not write the code.
- **Test-guard as a separate seat from the reviewer.** Its 7 survivors were in code the reviewer's 30 mutations did not reach (the same-site check and the check order).
- **Review fixes in their own commits** (bfcb904, e3e1a0a, 8129ca8), so each second reader saw only the response.
- **Out-of-fence findings filed, not absorbed:** #233, #236 (comment), #247, #218 (evidence added), #54, #147. The PR can say "not needed, not touched" for each.
- **Refusing instead of defaulting or truncating:** past the occurrence limit, past 2099-12-31, on a paid one-off, on a bill with payments. Each answers a clear 400 or 409, as Hannah asked.
- **Append-only payments.** Mark paid inserts and never mutates, which is the first done-when, and the one-off and repeating cases fall out of the same log.

## Surfaced, not absorbed

- **#247** a bill that passes 1000 unpaid occurrences over time makes the overview answer 500 (housekeeping, Missed-by: plan). Needs `server/db/overview.ts`.
- **#233** move the occurrence and date helpers and the limit to `shared/`; the copied constant and its note then go. The reverse copy notes (in `overview.ts` pointing back) go with it.
- **#236** lift `fromThisSite`, `parseScope` and `errorClass` into one module. Comment added with this lane's counts.
- **#218** server-side same-site check on writes. Evidence added: DNS rebinding passes the check, and settings and transactions writes have none.
- **#54** the Bills screen: the docs-syncer's notes for the screen went there.
- **#147** how a repeating bill ends without losing its history; this lane's 409 on delete and reschedule depends on it staying open.
- **For Hannah, no issue yet:** (a) the reviewer's open question: does a scope `PATCH` on a paid bill move its payment history to the new scope? The code and the tests do not say either way. (b) The docs-syncer's proposed amendment to prd-02 Ruling 2 (how paid and paid-this-month work). (c) S3, no cap on the number of bills.
- I did not read the bodies of #218, #54 and #147 beyond their titles, so I do not state their `Missed-by` lines.

## Recommended changes

1. **Architect fence checklist: when an issue turns a placeholder route into a real one, the fence lists `server/routes/__tests__/barrel.test.ts`, the module's own `__tests__` file, and any additive `shared/contracts.ts` block; and the slice folds the latest facts from issue comments into the body.** Third occurrence of the barrel miss, so encode now. Artifacts: `~/.claude/agents/architect.md` (the fence checklist, then `pnpm import-workflow --name current`) and the "Adding a table, route or mount" note proposed in the #46 retro for `docs/testing.md`. High leverage; it is mechanical and costs one `rg`.
2. **Put the `fence` shape in the decision-file example, and name who edits it.** Sixth occurrence; encode now. I cannot see the object's real shape from the record, so I do not state it. Artifacts: the decision paragraph of `~/.claude/CLAUDE.md` and an example decision file. Owner: the conductor session (Hannah's), because the lane cannot edit those files. Cheap.
3. **Sequence #236 before the three sibling route lanes merge, or give each of them the lift in its fence.** The next three lanes each add another `fromThisSite`, `errorClass` and `parseScope`. Not a doc change; it is a planning decision for the conductor. Artifact: the dispatch order for #48, #50 and #52 and the fence of whichever lane takes #236. High leverage if done before those lanes merge, worthless after.
4. **A limit that depends on today's date is enforced where it is read, or the contract says it moves.** First occurrence (#247); do not encode yet. If a second time-dependent invariant is found, add one line to the contract header in `shared/contracts.ts`. Hannah decides the shape of the #247 fix.
5. **A copied helper brings its source's test cases.** The 6 `fromThisSite` survivors were all in a copy. Do not encode yet: I cannot show from the record that the original's tests were available to copy, and #236 should remove the cause. If #236 stalls, add the rule to `docs/testing.md`.
6. **Shell exit codes: `cmd; echo "exit $?"` per command, not `PIPESTATUS`; and `git diff --stat origin/main...HEAD` (three dots) for a fence check.** Single occurrence each; do not encode.

## Highest-leverage next step

Do recommendation 1: add the barrel test, the module's own test file and any additive contract block to the architect's fence checklist, and fold comment facts into the issue body at slicing. It is the third time the barrel move has been predictable and unlisted, three of this lane's four decisions trace to facts that sat in comments or in another file, and the next three prd-02 route issues (budgets, goals, habits) will make the same moves. Recommendation 2 goes in the same edit session because it costs a line.

## Open items for the PR body

- Gear 4 as stamped; no shift. Fence: six files, three more than the issue lists (the data module's test, the additive contract block, the barrel test); no decision widened it.
- Decisions 49c5aac2 (import the helpers, copy the limit, #233), afd188fb (409 on delete and reschedule with payments, #147 open), 1964e048 (`POST /:id/payments`), 1a2c3eb4 (no pay-ahead limit, 409 past 2099-12-31).
- Follow-ups: #247 (a bill can push the overview to 500 over time), #233, #236, #218 (evidence added), #54, #147.
- For Hannah: whether a scope `PATCH` on a paid bill moves its payment history; the proposed prd-02 Ruling 2 amendment; no cap on the number of bills.
- Known disagreement pinned by a test: a corrupt `payday_weekday` row gives overview 500 and `GET /bills` 200 on the default. Untested: the UNIQUE-conflict catch in `markBillPaid` (unreachable under SQLite's single connection).
- Gate after 8129ca8: tsc 0, lint 0, vitest 76 files / 2616 tests.
- `baseline finish` comes after this retro and may be refused because seat transcripts end on a hand-back (known bug). Hannah granted a standing exception to open the PR anyway.

## Baseline narratives

These four are the text for the retro POST (`narrative_code_type`, `narrative_built`, `narrative_how`, `narrative_wrong`).

### narrative_code_type

A money-state write route with a data module under it, an additive contract edit and two large test suites, over existing SQLite tables with no migration. Gear 4; the later Bills screen calls it, and the overview reads the same tables.

### narrative_built

`GET`, `POST`, `PATCH` and `DELETE /api/v1/bills` and `POST /api/v1/bills/:id/payments` manage bills and record payments. A payment is an appended row and never an update; a one-off is paid once and a repeating bill moves to its next unpaid occurrence. The list returns the bills in scope, the amount due before payday (which equals the overview's figure on the same rows), the next unpaid bill and what was paid this month. Occurrences come from the same helpers the overview uses. Invalid input and a schedule with more than 1000 unpaid occurrences are a 400; a refused state change (a second payment on a one-off, delete or reschedule with payments, an occurrence past 2099-12-31) is a 409. Gate: tsc and lint clean, vitest 76 files / 2616 tests.

### narrative_how

The researcher ran first, and the lane raised four Baseline decisions for Hannah rather than building through them: import the occurrence helpers from the overview module and copy the limit, 409 on delete and reschedule once a bill has payments, the payment path `/payments` as the contract says, and no pay-ahead limit (against my recommendation). The architect planned, and the implementer built in two commits. The reviewer (30 mutations, 25 killed, and a 402-check cross-check against the overview) and the security-auditor ran in parallel, and the reviewer's two test fixes went in their own commit. Test-guard ran 63 mutations and 7 survived, and the implementer closed them in a third commit. Docs-syncer ran report-only and its two in-fence fixes went in a fourth. Out-of-fence findings were filed (#247, #233, #236, #218, #54, #147), not absorbed.

### narrative_wrong

Three of the four decisions came from a slice cut before #44 moved the occurrence helpers, from a `/pay` path the contract already contradicted, and from a "next one" figure with no field. The issue's fence listed none of the data module's test, the contract block or the barrel test, the third lane in a row to need the barrel move. The first decision raise was refused because `fence` was a string, the sixth recorded time, since the earlier recommendations have no owner. The 1000-occurrence limit is checked only on write, so a backdated weekly bill can push the overview to a 500 weeks later (#247). Review found tests that could not fail or were missing: the generic 500 on four of five endpoints, two checks that masked each other, and six survivors in the copied same-site check. The lane added copies of `fromThisSite`, `errorClass` and `parseScope`. Two process slips of mine: blank exit codes from `PIPESTATUS` in zsh forced a second gate run, and a two-dot diff made landed client files look like a fence breach.
