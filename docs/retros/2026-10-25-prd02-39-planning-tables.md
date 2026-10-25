# Retro: #39 prd02 w1, the planning tables (budgets, bills, bill_payments, goals, goal_contributions, account_settings, alert_dismissals; `targets` dropped)

Gear 4 as stamped; no shift. The implementer ran on opus at effort high. One file was added to the fence mid-run: the single `it` block in `server/db/seeds/__tests__/transactions.test.ts` that reads `targets`, after Hannah picked option A on Baseline decision 0edbc484. This retro file is outside the fence, as in the earlier gear 4 retros. It states no telemetry (model, duration, tokens, tool calls); the lane posts the four narratives after `baseline finish`.

Seats run, in order: researcher, architect, implementer, reviewer, schema-reviewer, security-auditor, test-guard, test-writer, docs-syncer, this retro. Verify passed on the final state: after the rebase onto origin/main (which had gained prd-02 Ruling 12; Ruling 12 needs no schema change) tsc and lint are clean and vitest passes, 47 files / 1145 tests.

Commits (`git log --oneline origin/main..HEAD`): 2a89b1c (targets seed and its one test removed), af90481 (build), f9a3cf1 (review fixes), 7144dff (PRD Ruling 2 amendment note).

## What was built

- **Kind of code:** one additive-plus-drop SQLite migration (`20261025120000_prd02_budgets_bills_goals_roles_dismissals.js`, 259 lines), row types in `models/planning.ts`, and a schema test (`server/db/__tests__/prd02-tables.test.ts`, 80 tests in the final file). It also removes the `targets` seed and a four-line PRD amendment note.
- **Pattern:** rules live in the database as CHECKs, not in a route. Every cents column is `typeof(col)='integer'` plus a range, every calendar date is `date(x,'+0 days') IS x`, and `scope`, `repeat` and `role` have no default so a writer has to say. A goal's saved amount is the SUM of its contributions, with no stored balance. Bill occurrences are computed from `first_due_date`, one `bill_payments` row per paid occurrence, `UNIQUE (bill_id, due_date)`. `account_settings` uses a surrogate id, not `account_id` as the primary key.
- **Why this shape:** two SQLite traps were measured by the architect before the build, not remembered (see below). The contested choice was bill recurrence, ruled by Hannah on #35 (option C: per-bill `repeat`, anchored occurrences).

## What happened

- The researcher found the one test outside the fence that the `targets` drop necessarily breaks. The lane raised a Baseline decision. The first raise was refused with `body/options/0/fence must be object`: the lane had passed `fence` as an array. It dropped the field and raised again. Hannah picked A, and the fence widened to delete that one `it` block. Commit 1 was gated in isolation in a throwaway worktree (45 files, 932 tests green), so the removal is provably not riding on the new code.
- The issue body listed three roles (`current|savings|tax_pot`). The handoff and `shared/contracts.ts` `AccountRole` have four, adding `credit_card`, and the PRD spells them with spaces. The build used four, in the contract spelling, and the amendment note in 7144dff says so.
- The architect measured two traps before the build. A single-integer primary key is a rowid alias, so an insert with no `account_id` silently took 1. `date(x) = x` accepts 2026-02-30, and `=` against NULL lets a CHECK pass. Its fixes (surrogate id, `date(x,'+0 days') IS x`, `typeof(col)='integer'`) went straight into the migration, and nothing in the later review rounds reopened either trap.
- Review ran on the working diff, before the build was committed:
  - **reviewer:** 24 mutations, 3 survived. The tests built rows with `{col: undefined}`, which knex binds as NULL, so "no default" was never tested. It added an `omit()` helper, an index pin and a never-rebuild header note, and corrected a wrong comment. These fixes were made on the uncommitted diff, so they shipped inside af90481, not as a separate review-fix commit.
  - **schema-reviewer:** approved with notes. It showed by execution that `INSERT OR REPLACE`, or delete plus reinsert, on `accounts` wipes `account_settings` and nulls `bills.account_id`. It became header notes (in f9a3cf1) and follow-up #145. A bill-scope note went in the same way.
  - **security-auditor:** nothing blocking. A `.gitignore` gap went to #146. The prd-03 replica allowlist must add the new tables when that lane lands.
  - **test-guard:** 36 more mutations, 27 survived, all of them NOT NULL and no-default. **test-writer** added a table-driven NOT NULL test whose column list is tied to `PRAGMA table_info`, so a new column with no entry is a red test. All 10 sampled mutations were then killed.
- The lane itself corrected one wrong issue reference in a comment (the bills route is #49, not #44).
- Follow-ups, each with its origin line: #144 (bill contracts lack `repeat`; `Missed-by: plan`), #145 (sync must keep roles; `Missed-by: none`), #146 (`.gitignore`), #147 (how a repeating bill ends; `Missed-by: plan`), #148 (prd-01 tests use `undefined`; `Missed-by: review`), #151 (Hannah: do several overdue occurrences of one bill all count toward "unpaid bills"; `Missed-by: plan`).

## What went wrong

1. **The fence omitted a test the drop necessarily breaks.** `targets` is dropped; a seed test reads `targets`; the test was not in the fence. The researcher caught it, so nothing broke on main, but it cost a Baseline decision, a blocked wait on Hannah, and a fence change mid-run. One grep for `targets` over the repo at slicing time would have found it. This is the fourth time a fence missed a consumer (see Root causes).
2. **Three review rounds each found test gaps the round before missed.** The reviewer's 24 mutations left 3 alive; test-guard's next 36 left 27 alive, all NOT NULL and no-default. The 27 are one gap, not 27: no test ever inserted a row with a column missing or NULL and expected a refusal. The implementer's own break-and-watch step sampled a handful of constraints per table and the sample did not reach the dullest class. The reviewer found the mechanism (`undefined` becomes NULL under knex) and fixed it for the no-default case it hit, but the record does not show a sweep of the NOT NULL columns by that seat; test-guard did that. Cost: two extra rounds and a 125-line test change after the review fixes. No wrong code reached main, and every miss was a test gap, not a schema bug. The record does not show why the first reviewer pass did not widen the fix to every column.
3. **The issue body's role list was stale against its own amendment.** The body said three roles; the amendment comment on the same issue, the handoff and the shared contract said four. The lane read all three and built four, so no rework, but a lane that read only the body would have shipped three and failed the contract. Cause: the amendment was a comment, not an edit to the body (same shape as #19's PR #93 comment).
4. **The commit table and the pipeline pulled apart again.** The pipeline says review the working diff before commit; the commit table says review fixes go in their own commit. Review on the working diff means the reviewer's fixes (omit helper, index pin, header note) landed inside af90481, and only the later seats' fixes got their own commit (f9a3cf1). So the "second reader sees only the response" property holds for two of the five seats. No harm, but the rule and the table cannot both be followed.
5. **The decision file failed schema validation once.** `fence` was passed as an array where the schema wants an object. The error message named the field, so the fix took one retry; the cost is one wasted raise. Single occurrence.
6. **One wrong issue number in a comment (#44 for #49).** Caught by the lane's own read-through, not a seat. Minor.

## Root causes

- **Fence written without checking the consumers of the thing being changed (item 1).** Fourth occurrence: #68 and #78 (build and test config), #19 (the seed), now #39 (a test of the seed). The consumer differs each time; the habit is the same, the plan covers the code that is changing and not the code that reads it. Because it is now a fourth occurrence, it is time to encode it (Recommendation 1). Whether the #78 recommendation landed is not in the record I read; the repeat says it did not do enough.
- **Author's list versus the reach of the constraints (item 2).** Same family as "author's list vs the attacker's reach" in #68, #78 and #19: the implementer tested the constraints it thought of, and the mutation seats found the rest. The new fact here is size: the unexamined class was every column, and a sample cannot show an absent class. The fix is to make the list exhaustive by construction (a test tied to `PRAGMA table_info`), not to sample harder.
- **A comment on a sliced issue contradicts or amends the body without the body changing (item 3).** Second occurrence (#19 was the first). #19's highest-leverage step was a rule in `CLAUDE.md` "Issues and the board". That rule is not in `CLAUDE.md` today, so this retro repeats it. Reading the shared contract was what saved this lane both times.
- **Pipeline text and commit table disagree about review versus commit (item 4).** Second occurrence (#19 was the first; #34 handled it by leaving the build staged). The two sources of rules have not been reconciled.
- **Decision-file shape (item 5).** Cause: the lane guessed the field type. The error message was good. No root cause beyond a guess.

## What worked, keep it

- **Measure the trap, then design around it.** The architect executed both SQLite traps (rowid alias, `date(x)=x`/NULL) before the build and wrote the fixes into the plan. Neither trap came back in review. That is the same habit that kept #19 from rebuilding `transactions`.
- **Gating the fence-widening commit alone in a throwaway worktree.** 45 files, 932 tests, green, before the new code existed. It makes the removal checkable and revertible by itself, and it used no `git stash`.
- **Mutation seats that run the code.** The reviewer's 24, test-guard's 36 and the schema-reviewer's `INSERT OR REPLACE` demonstration were all executed, so each finding was a fact. The `INSERT OR REPLACE` finding in particular could not have been found by reading.
- **A table-driven test tied to `PRAGMA table_info`.** The column list cannot go stale: adding a column with no entry is a red test. All 10 sampled mutations died after it.
- **The lane read the issue, the handoff and `shared/contracts.ts` and used the contract spelling** for the four roles when the body was stale, and recorded the spelling in the PRD note.
- **Raising a genuine fork through Baseline, not absorbing it.** The fence widening was Hannah's call. The failed first raise was recoverable in one retry.
- **Follow-ups filed with origin lines and phase tests,** including #148, which credits `review` as the seat that missed it.

## Surfaced, not absorbed

- **#144** bill contracts lack `repeat`. `Missed-by: plan`.
- **#145** the sync writer must keep roles; `INSERT OR REPLACE` or delete plus reinsert on `accounts` destroys `account_settings` and nulls `bills.account_id`. `Missed-by: none`.
- **#146** `.gitignore` gaps (security-auditor).
- **#147** how a repeating bill ends. `Missed-by: plan`.
- **#148** prd-01 schema tests use `{col: undefined}` and have the same untested no-default gap. `Missed-by: review`.
- **#151** for Hannah: whether several overdue occurrences of one bill each count toward "unpaid bills". `Missed-by: plan`. Noted in the PRD amendment as open, not ruled.
- The prd-03 replica allowlist must add the seven new tables when that lane lands. Not filed as a separate issue in the record I read.

## Recommended changes

1. **Slicing and architect fence step: grep for every table, column, file or export the issue drops or renames, and put every hit in the fence or on a named owner.** Fourth occurrence, so encode now. A one-line `rg` of the dropped name over the repo would have found the seed test. Artifacts: `~/.claude/agents/architect.md` (fence checklist, imported to Baseline), and the issue-slicing checklist the conductor uses (its path is not in the record I read). High leverage.
2. **Make constraint coverage exhaustive, not sampled.** For schema work, the implementer's break-and-watch step covers every column against every constraint class it has (NOT NULL, no default, CHECK, FK, UNIQUE) through a table-driven test tied to `PRAGMA table_info`, and test rows are built with an `omit()` helper, never `{col: undefined}` (knex binds it as NULL). Artifacts: `docs/testing.md` (add the pattern and the knex `undefined` trap) and `~/.claude/agents/implementer.md` (the break-and-watch step). High leverage; it would have removed two review rounds. #148 fixes the existing prd-01 test.
3. **Rule for comments on a sliced issue.** A comment that changes what a sliced issue requires must be folded into the body, or say "supersedes Done-when N" by number. Second occurrence, and #19's version did not land. Artifact: `CLAUDE.md`, "Issues and the board". High leverage, one sentence.
4. **Reconcile pipeline step 5 with the commit table.** Say plainly: review runs on the working diff; the build is committed after the reviewer seat; fixes from later seats are the "review fixes" commit. Second occurrence. Artifacts: `~/.claude/CLAUDE.md` (pipeline step 7 table) and `CLAUDE.md`, "Worktrees and lanes". Medium; low cost.
5. **Do not encode yet:** the `baseline decide` fence-as-object error (single occurrence; if it recurs, add a field-shape example to the decision-file template).

## Highest-leverage next step

Do Recommendation 2: add the exhaustive-constraint pattern and the `{col: undefined}` warning to `docs/testing.md`, and require the implementer's break-and-watch step to use it for any migration. This lane spent two review rounds and 60 mutations finding what one table-driven test now covers by construction. Recommendation 1 (the fence grep) comes straight after; it has the higher repeat count but a smaller per-occurrence cost here (one decision and a short wait).

## Open items for the PR body

- Roles stored as `current`, `savings`, `tax_pot`, `credit_card` (four, not the issue body's three); the PRD note in 7144dff records the spelling.
- Fence widened by Hannah's decision (0edbc484, option A) to delete one `it` block in `server/db/seeds/__tests__/transactions.test.ts`; `server/db/seeds/targets.js` is removed. `targets` rows are discarded, not copied; `down` recreates `targets` empty.
- Reviewer's fixes are inside the build commit af90481 (working-diff review); f9a3cf1 holds the schema-reviewer and test-guard/test-writer fixes.
- Rebased onto origin/main (gained prd-02 Ruling 12, no schema change). Gate after the rebase: tsc and lint clean, vitest 47 files / 1145 tests.
- Follow-ups #144 to #148 and #151; the prd-03 replica allowlist note.

## Baseline narratives

These four are the text for the retro POST (`narrative_code_type`, `narrative_built`, `narrative_how`, `narrative_wrong`).

### narrative_code_type

A database schema contract: one SQLite migration with CHECK-heavy tables, row types, and a schema test suite. Gear 4, imported by the later prd-02 routes (budgets, bills, goals, settings, overview).

### narrative_built

A migration creating `budgets`, `bills`, `bill_payments`, `goals`, `goal_contributions`, `account_settings` and `alert_dismissals`, and dropping `targets` and its seed. Money is integer cents, enforced by `typeof` CHECKs, calendar dates are checked with `date(x,'+0 days') IS x`, and `scope`, `repeat` and `role` have no default. Four account roles, in the contract spelling. `models/planning.ts` holds the row types and `server/db/__tests__/prd02-tables.test.ts` has 80 tests. Gate after the rebase: tsc and lint clean, vitest 47 files / 1145 tests.

### narrative_how

Researcher, architect, then the implementer on opus. The architect measured two SQLite traps first (a single-integer primary key silently becomes a rowid alias; `date(x) = x` accepts 2026-02-30 and NULL passes a CHECK). Hannah widened the fence by decision to delete one seed test, and that commit was gated alone. Reviewer, schema-reviewer, security-auditor, test-guard, test-writer and docs-syncer followed. Reviewer ran 24 mutations, test-guard 36 more; a table-driven NOT NULL test tied to `PRAGMA table_info` then killed all 10 sampled mutations. Six follow-ups filed with origin lines.

### narrative_wrong

The fence missed a seed test that the `targets` drop breaks; the researcher caught it, but it cost a Baseline decision and a wait. Review found test gaps in three rounds: 3 of 24 mutations survived, then 27 of 36, all NOT NULL and no-default, because tests used `{col: undefined}` (knex binds NULL) and the implementer's own break-and-watch step sampled too few constraints. The issue body listed three roles while its own amendment, the handoff and the contract said four. The reviewer's fixes were made on the uncommitted diff, so they shipped inside the build commit, not a separate review-fix commit, a conflict between the pipeline and the commit table. The first decision raise failed schema validation because `fence` was an array.
