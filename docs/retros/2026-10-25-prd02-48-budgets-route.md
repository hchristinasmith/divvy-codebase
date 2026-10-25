# Retro: #48 prd02 w3, budgets can be created, adjusted and deleted (budgets data module, budgets routes, barrel test move)

Gear 4 as stamped; no shift. Gear 4 maps to opus in the CLAUDE.md table, and the implementer ran on opus at effort high. This file states no telemetry (model, duration, tokens, tool calls); the lane posts the four narratives to Baseline after `baseline finish`.

Seats run: researcher, architect, implementer (build), reviewer, security-auditor, implementer (review fixes), test-guard, test-writer (gap tests), docs-syncer (answer: "nothing needed"), this retro. The facts I was given mention no Baseline decision, so I state none. `schema-reviewer` does not apply (no migration) and `brand-checker` does not apply (no UI). Verify on the final tree: `npx tsc --noEmit` exit 0, `npm run lint` exit 0, `npx vitest run` 109 files / 4202 tests passed.

Commits (`git log --oneline origin/main..HEAD`): 38113f2 (build), dbc60b4 (review fixes), 7dfa066 (test-guard gap tests). The three-dot diff (`git diff --stat origin/main...HEAD`) is four files, +1909 / -8: `server/db/budgets.ts` (421), `server/routes/budgets.ts` (206 changed, replacing the 501 stub), `server/routes/__tests__/budgets.test.ts` (1286), and 4 lines in `server/routes/__tests__/barrel.test.ts`. Tests are about 3 times the size of the route and data code. `shared/` is untouched.

I was not in the lane's conversation. This retro is written from the diff, the commit messages and the facts handed to me; where the record does not say, I say so.

## What was built

- **Kind of code:** a money-state write route (`GET`/`POST`/`PATCH`/`DELETE /api/v1/budgets`), a data module under it, and one large route test file. No migration; the `budgets` table already existed.
- **Pattern:** the list does not compute spending itself. `spent`, `remaining` and `over` are read off `readOverview(scope, now, trx).safeToSpend.budgets` inside the same knex transaction that reads the budget rows, and notes are joined by id. The Budgets list and the overview's ledger are therefore one computation and cannot disagree (Done-when 2), and `overview.ts` needed no change. A `POST` or `PATCH` whose follow-up overview read fails rolls back.
- **Rules the route enforces:** Drawings is refused through `isKnownCategory`. The limit is an integer in cents from 0 to 1,000,000,000, with no coercion of strings or floats. A second budget for the same scope and category is a 409, taken from the `UNIQUE (scope, category)` constraint message. The same-site guard runs first on every write.
- **Why this shape:** the alternative was to recompute spending in the budgets module. That would give two definitions of "spent" that have to be kept equal. Reading the overview's own output removes the question.

## What happened

- **Researcher and architect** planned the module and its test seed. Two of the architect's assumptions were wrong (items 1 and 2 below). Both were found by running, not by reading.
- **Implementer** built in one commit (38113f2), including the one-line move of `budgets` from `PLACEHOLDERS` to `EXISTING` in `barrel.test.ts`. That file was outside the issue's fence; the widening was granted, one line. Lane #52 (habits) edits the same line, so a merge conflict there is likely and trivial.
- **Reviewer** found two things, fixed in dbc60b4 (item 3). **Security-auditor:** nothing new for this lane; the items it raised were already filed (see Surfaced).
- **Test-guard** mutated the route and data code: 23 mutations, 3 survived (item 4). **Test-writer** filled the three gaps in 7dfa066, and each new test was shown red on its mutation before it was kept.
- **Docs-syncer** reported that no doc needed changing. The one contradiction it could have flagged (`docs/design/handoff.md:34`) is already settled by the rule that the PRD wins over the handoff.

## What went wrong

1. **The architect's test seed used category names the app does not know (Missed-by: plan).** The seed used 'Groceries', 'Eating out' and 'Software'. None is in `data/cats.js`, so `isKnownCategory` would have refused every one of them with a 400. The implementer caught it when its first run failed and switched to real NZFCC names. Cost: one failed run, no code shipped wrong. The architect wrote category names from memory of the prototype instead of reading the list the route validates against.
2. **The architect assumed `null` and JSON-string `POST` bodies reach the router (Missed-by: plan).** They do not. `express.json` in strict mode answers 400 'Bad request' before any route code runs. The implementer's tests found this too. Cost: a planned test case that could not be written as designed; the tests assert the 400 the app really gives. This is a fact about the app's body parser that sits in no doc I can point to.
3. **A bad stored note in one scope failed the other scope's list (Missed-by: do; caught by review).** `readBudgets` type-checked every note in the table, not just the lines in scope. One corrupt row in `strawb` would have made the `personal` list answer 500. The reviewer found it; dbc60b4 narrows the check to in-scope lines. The same commit pins the limit cap, whose `<=` boundary had no test.
4. **The author's tests missed three behaviours (Missed-by: do; caught by test-guard).** 3 of 23 mutations survived: `PATCH` to limit 0 (`??` changed to `||` makes 0 fall through to the old value), `PATCH` of both fields at once, and a write beside a bad note in the other scope (the fix for item 3 had no test of its own). Cost: one more commit (7dfa066), +67 lines of tests. Item 3 shows the pattern: a fix made in review shipped without a test, and test-guard found that.
5. **The barrel test move was again unlisted in the fence (Missed-by: plan).** The move of a route from `PLACEHOLDERS` to `EXISTING` has now been needed in #44, #46, #49, #50 and this issue. The lane treated it as a forced one-line consequence and did not stop, which is right, but it needed a grant each time. The recommendation to put it in the architect's fence checklist has been made in the #49 and #50 retros. I checked `~/.claude/agents/architect.md` and `docs/testing.md`: neither mentions the barrel test, so it has not landed.
6. **Process slip in review: the reviewer overwrote `server/db/budgets.ts`.** It made a scratch copy of the route file with the same file name as the data module and the copy replaced `server/db/budgets.ts`. The reviewer noticed and restored it. Cost: none that I can see in the diff; the final file is the lane's. This is the second lane in a row where a review seat's scratch work touched source (#50 had two seats mutating one tree). It is not the same mechanism, so I count it as a related occurrence rather than a repeat.

## Root causes

- **Plan covers the code that changes, not the code that reads, pins or constrains it (items 1, 2, 5).** Same family as #25, #39, #44, #46, #49, #50. Here it appears as: the list of valid categories the route checks against (item 1), the body parser in front of the router (item 2), and the barrel test that pins the route's old state (item 5). The architect planned the route and not the things around it.
- **Author's list versus the reach of the code (items 3, 4).** The implementer tests what it thought of; the reviewer and test-guard find the rest. A review fix is code too, and it went in without its own test. Nothing new to add to the process; the two seats did what they exist for.
- **A recommendation with no owner never lands (item 5).** Two retros recommended the fence checklist change and no one edited the architect's instructions. The lane cannot edit `~/.claude/agents`, so it can only report again.
- **Item 6:** scratch files named after real files, with no rule for where a review seat writes them. One occurrence in this form; I cannot name a deeper cause from the record.

## What worked, keep it

- **Reading the overview's output instead of recomputing.** One definition of spent, so Done-when 2 holds by construction and `overview.ts` was not touched. A test for agreement between the two would have been weaker than removing the chance to disagree.
- **A transaction around read and follow-up read.** The list and the ledger are read at one moment, and a write whose answer cannot be built is rolled back instead of left half-applied.
- **Refusing instead of coercing.** Strings and floats as limits, Drawings as a category, a duplicate budget, a bad note in the lane's own scope: each answers a clear 400, 409 or fixed-text 500.
- **The implementer running its own tests against the plan.** It caught items 1 and 2 on the first run and followed the app, not the architect's text.
- **Reviewer and test-guard as separate seats.** The reviewer found the cross-scope failure; test-guard found three gaps the reviewer's list did not include. Different questions of the same diff.
- **Gap tests shown red on their mutation.** Each of the three new tests was run against its mutation before it was kept, so each one is known to be the test that catches it.
- **Review fixes in their own commits** (dbc60b4, 7dfa066), so the second reader sees only the response.
- **Surfacing the contract gap instead of editing the contract.** `BudgetResponse` in `shared/contracts.ts` has no `status` field and the file is outside the fence. The lane returned `over` as `overCents > 0`, stated the gap, and did not touch the contract.

## Surfaced, not absorbed

- **Contract gap:** `BudgetResponse` has no `status`. The Budgets screen (w4) must derive the amber band (over 80% of the limit) itself.
- **For the Budgets screen (w4):** it must filter Drawings out of the selectable category list, or `POST` answers 400.
- **`docs/design/handoff.md:34`** says "Claude Code owns budget creation". The PRD wins, so the route allows creation. No edit made.
- **Already filed, not new:** #277 (missing same-site guard on transactions and settings writes), #174 (DNS rebinding passes `fromThisSite`), #236 (lift the copied helpers into one module). This lane adds one more copy of the same-site helper and error-class code; #236's counts need updating. I did not read the bodies of #277, #174 or #236 beyond their titles, so I do not state their `Missed-by` lines.
- **Merge note:** #52 (habits) edits the same line in `barrel.test.ts`. Whoever merges second resolves a one-line conflict.

## Recommended changes

1. **Architect fence checklist: when an issue turns a placeholder route into a real one, the fence lists `server/routes/__tests__/barrel.test.ts`, the module's own `__tests__` file and any additive `shared/contracts.ts` block.** Fifth occurrence of the barrel miss and third retro to recommend it. Encode now. Add to the same list: read the validated value list (here `data/cats.js`) before writing test seeds, and note that `express.json` strict mode answers 400 before the router for non-object bodies. Artifacts: `~/.claude/agents/architect.md` (then `pnpm import-workflow --name current`) and a short "Adding a route" note in `docs/testing.md`. High leverage and mechanical. The owner is the conductor session, because the lane cannot edit those files.
2. **A fix made in review ships with a test of its own, in the same commit.** First occurrence in this form (item 3 fixed with no test; test-guard found it). Do not encode yet. If it happens again, add one line to the `reviewer` agent's instructions at `~/.claude/agents/reviewer.md`.
3. **Review seats write scratch files to the scratchpad directory, never under the repo and never with a real source file's name.** First occurrence (item 6); do not encode yet. The conductor can say so in the dispatch prompt at no cost. If it recurs, add one line to the `reviewer` and `test-guard` agent files.
4. **Sequence #236 before #52 merges.** Repeats the #49 and #50 retros, still open. It is a dispatch order, not a doc change. Worthless after the habits lane merges.

## Highest-leverage next step

Do recommendation 1: add the barrel test, the module's own test file, any additive contract block, and the two seed-and-parser notes to the architect's checklist and to `docs/testing.md`. It is the fifth predictable and unlisted barrel move, it has been recommended twice without landing, and habits (#52) is next to make the same move.

## Open items for the PR body

- Gear 4 as stamped; no shift. Out-of-fence touch: `server/routes/__tests__/barrel.test.ts`, one line, `budgets` from `PLACEHOLDERS` to `EXISTING`, granted. `shared/contracts.ts` not touched. No migration.
- Contract gap: `BudgetResponse` has no `status`; `over` is `overCents > 0`. The Budgets screen derives the amber band.
- Review: reviewer's two fixes in dbc60b4. Test-guard: 23 mutations, 3 survived, closed in 7dfa066, each shown red on its mutation. Security-auditor: nothing new for this lane. Docs-syncer: nothing needed.
- Gate on the final tree: tsc 0, lint 0, vitest 109 files / 4202 tests.
- Follow-ups and watch items: #277, #174, #236 (counts stale), the w4 Drawings filter, the likely one-line conflict with #52 in `barrel.test.ts`.
- Process note: the reviewer briefly overwrote `server/db/budgets.ts` with a same-named scratch copy of the route file and restored it; the final file is the lane's own.

## Baseline narrative

These four are the text for the retro POST (`narrative_code_type`, `narrative_built`, `narrative_how`, `narrative_wrong`).

### narrative_code_type

A money-state write route with a data module under it and one large test suite, over an existing SQLite table with no migration. Gear 4; the later Budgets screen calls it and the overview reads the same figures.

### narrative_built

`GET`, `POST`, `PATCH` and `DELETE /api/v1/budgets` list, create, adjust and delete a budget per scope and category. Spent, remaining and over are read off the overview's own budget lines inside one transaction, so the list and the overview ledger cannot disagree and the overview module was not changed. A write whose follow-up overview read fails rolls back. Drawings is refused. The limit is an integer in cents from 0 to 1,000,000,000 with no coercion, a duplicate is a 409, and the same-site guard runs first on every write. The contract has no status field, so over is the overage being above zero. Gate: tsc and lint clean, vitest 109 files / 4202 tests.

### narrative_how

The researcher and architect planned it, and the implementer (opus, high) built it in one commit, including a one-line move of budgets in the barrel test that the fence had not listed. The reviewer and security-auditor ran next; the reviewer's two fixes went in their own commit. Test-guard ran 23 mutations and 3 survived, and the test-writer closed them in a third commit, each new test shown red on its mutation. Docs-syncer found nothing to change. Out-of-fence findings were surfaced, not absorbed: the missing contract status, the Drawings filter the Budgets screen needs, and the existing issues #277, #174 and #236.

### narrative_wrong

The architect's seed used category names the app does not know, and it assumed null and JSON-string bodies reach the router when the body parser answers 400 first; the implementer found both by running. Review found that one bad stored note in one scope failed the other scope's list, and that the limit cap boundary had no test. Test-guard then found three more gaps, including that the review fix itself had no test. The barrel test move was unlisted in the fence for the fifth time, and the recommendation to fix the architect's checklist has not landed after two retros. The reviewer briefly overwrote the data module with a same-named scratch copy of the route file and restored it.
