# Retro: #19 prd01 w1, the sync schema (accounts, sync_runs, transaction status/source/Akahu category, category_corrections)

Gear 4 as stamped; no shift. Every changed file is inside the declared fence except `server/db/__tests__/transactionColumns.ts`, which the issue's "minimal reconciliation" clause for old column-list tests allows. This retro file is outside the fence, as with #68 and #78. The issue said `model: opus`; the implementer ran on opus. This file states no telemetry (model, duration, tokens, tool calls); the lane posts the four narratives after `baseline finish`.

Seats run, in order: researcher, architect, implementer (opus, high), then reviewer, schema-reviewer and security-auditor in parallel, test-guard, implementer again (one test plus the review-fix commit), docs-syncer, this retro. Verify passed on the final state: gate before work was tsc 0, lint 0, vitest 42 files / 611 tests; re-run for this retro on the clean tree at d6f1906 gives tsc 0, lint 0, vitest 43 files / 643 tests.

Commits: adf4dc6 (models), d198b21 (migrations + schema test), 3c007e4 (doc), 99d09ba (review fixes), d6f1906 (doc sync).

## What was built

- **Kind of code:** four additive SQLite migrations, row types in `models/sync.ts`, a 770-line schema test (`server/db/__tests__/prd01-schema.test.ts`, then 71 lines more after review), and `docs/akahu-pending-semantics.md` (241 lines). 1445 lines added across 9 files before the review commit.
- **Pattern:** no table is ever rebuilt. `accounts`, `sync_runs` and `category_corrections` are new tables. `transactions` gets six columns by native `ALTER TABLE ... ADD COLUMN` and loses them in `down` by native `ALTER TABLE ... DROP COLUMN` (bundled SQLite 3.44.2), never knex `dropColumn` or `.alter()`. Legacy `category_*` is copied to `akahu_category_*`, not renamed. Domain rules live in the database as CHECKs, and `sync_runs` allows one `running` row through a partial unique index. A schema test migrates to just before the first new migration, builds legacy rows from the M1 fixture, then asserts the backfill, defaults, CHECKs, FK cascade, rollback and key sets (pinned to the TS row types with `Record<keyof Account, true>`).
- **Why this shape:** the contested choice was copy-or-rename. Done-when 1 and 7 need the legacy columns to stay (M1 code, seed and `server/db/transactions.ts` still read them), and rename needs a table rebuild. Verified in the lane (knex 2.5.1): a rebuild inside the migration transaction cascade-deletes `category_corrections` rows and resets AUTOINCREMENT, because `PRAGMA foreign_keys = OFF` is ignored inside a transaction.

## What happened

- The researcher read Akahu's docs (pending endpoints, accounts, pagination, backfill depth) and one real, key-names-only settled response. The architect wrote a plan with seven executed facts about knex/SQLite behaviour. The lane accepted it with two rulings: keep the `sync_runs` CHECKs and the partial unique index, keep `ON DELETE CASCADE` on corrections. Both go beyond the issue's letter and are reported as choices, not requirements.
- The implementer built it. It put the models commit before the migrations commit, because the schema test imports the row types for its `Record<keyof ...>` key pins. To gate the models commit it moved the migration files out to scratch and back, with no stash.
- Review ran on `origin/main..HEAD` (the build was already committed). Findings, all executed, all fixed in 99d09ba:
  - **schema-reviewer W1:** migration 100003's `down` left pending rows in `transactions` looking like settled rows (no `status`, NULL `akahu_id`). Fixed: `down` deletes pending rows first. Rollback of 100004 runs before it, so nothing cascades.
  - **Review (S4):** the repair UPDATE could fill a NULL `category` on a row a user, rule or Claude owns. Fixed: it now has `.where({ category_source: 'akahu' })`.
  - **Review (the lane labels it S2):** `sync_runs` accepted negative counts. Fixed: `sync_runs_counts_non_negative` CHECK.
  - **security-auditor S1:** the doc did not say where real backfill dates go in a public repo. Fixed with a privacy note. The auditor also showed, by execution, that superagent's `err.response`, `JSON.stringify(err)` and `util.inspect(err)` carry the `Authorization` header while `err.message` does not. That went to #21 as a contract, not into this diff.
  - **security-auditor S2:** nothing stops a future migration rebuilding `transactions` and silently deleting every correction. Filed as #134.
  - **test-guard:** one surviving mutation, removing `.whereNull('category')` from the repair. Cause below. The implementer added a test for an Akahu-owned row whose existing category differs from Akahu's.
- The reviewer ran 18 mutations; all were killed. docs-syncer found three PRD wording gaps and one doc line that rollback had made false (d6f1906); the PRD gaps went to #133 because `docs/prds/` is outside the fence.
- Follow-ups, each with an origin line: #129 (writer, phase, `Missed-by: plan`), #130 (seed, housekeeping, `Missed-by: plan`), #131 (Akahu reissues settled `_id`s, needs a ruling), #132 (replica allowlist for the new tables, phase, `Missed-by: none`), #133 (stale docs and types), #134 (rebuild guard). The contract the sync lane must hold went onto #21 as a comment.

## What went wrong

1. **The build was committed before review.** The lane's brief told the implementer to commit the build, so three commits landed before the reviewer ran. The reviewer then reviewed a branch range, and its fixes went in as a separate commit (99d09ba). Pipeline step 5 says review the working diff before commit. Cost: no wrong code shipped and the implementer gated each commit, so the cost is a departure from the written order and a reviewer working from a range instead of a diff it could re-mutate (the cost #34 hit when fixes were unstaged). The cause is the lane conductor's brief, not the implementer, which did what it was told. In the same text, the commit table asks for "review fixes, separate from the build", so the two instructions pull against each other and the brief picked the one that skips review-before-commit.
2. **A conductor comment on #19 contradicted the issue.** The PR #93 comment said to rename `category_*` to `akahu_category_*` and to make `setUserCategory` write a correction row. The issue's Done-when 1 and 7 need the legacy columns to stay, and its negative fence excludes `server/db/transactions.ts`. Following the comment would have broken the Done-when and the fence at once. The lane followed the Done-whens, built the copy, and filed #129 for the writer. prd-01 Ruling 4 still says the legacy columns "become" `akahu_category_*`, and migration 20261023130000's header says "prd-01 wave 1 renames them". Both are now wrong (#133). Cost: a lane judgement call that should not have been needed, one phase-level follow-up, and two stale texts. The record does not show whether the comment or the Done-whens came first.
3. **Done-when 5 is half met.** It requires the pending key to be decided from Akahu's documentation and a real response. The real `GET /transactions/pending` returned 0 items on 2026-10-25, so no pending item was seen. The schema is built to the documented shape (no `_id`, no `hash`, no natural key, pending rows replaced wholesale per account). The doc says "docs-verified, real-response pending" and gives a keys-only re-check recipe that stops everything if `_id` ever appears. "Not met while the doc says unverified" is therefore not cleanly satisfied. The conductor decides if the recipe is enough to merge.
4. **The plan's commit order could not pass its own gate.** The plan put the migrations and the schema test in commit 1 and the models in commit 2, but the test imports the row types. The implementer reordered and, to gate the models commit, moved the migration files out and back by hand. It worked and used no stash, but it was ad hoc.
5. **The repair fixture protected the wrong clause.** The plan's R2 row (user-owned, category set) was killed by `.whereNull('category')`. Once S4 added a `category_source` filter, R2 no longer exercised `.whereNull`, and removing it survived. The plan had no fixture where only that one clause decides the outcome.
6. **The seed was left behind.** The migration backfills `akahu_category_*` for rows present at migrate time. `server/db/seeds/transactions.js` runs after `migrate:latest` and does not write them, so a freshly seeded database violates Done-when 1's invariant. The seed was outside the fence. Filed as #130.
7. **The plan did not examine the `down` of the data-changing migration.** The `up` was planned in detail; the `down` was "drop the six columns". It took schema-reviewer to point out that dropping `status` turns pending rows into apparent settled rows.

## Root causes

- **A comment on a sliced issue can silently contradict its Done-whens.** Items 2 and 6 trace to one fact: the issue was the contract, but a later comment and a PRD sentence carried a different one, and nothing forced them to be reconciled. First occurrence under this name.
- **Fence written without checking the consumers of the thing being changed (item 6; same family as "fence written without checking the build and test config" in #68 and #78).** There the fence missed `vitest.config.ts` and `build:mcp`. Here it missed the seed, which reads and writes the table whose invariant is a Done-when. In each case the plan covered the code and missed something that consumes it. The consumer differs, so I name this as the same family, a third occurrence, and not an exact repeat. The #78 retro recommended widening the architect's fence checklist; whether that landed is not in the record I read.
- **Instructions in the pipeline text and the commit table disagree about commit-before-review (item 1).** First occurrence. #34 handled the same tension by staging the build and not committing, which worked.
- **Plan wrote the happy path in detail and the reverse path in one line (item 7), and wrote fixtures for the case the author thought of (item 5).** Same underlying habit as "author's list vs the attacker's reach" in #68 and #78: the reviewing seats found what the author's list lacked. It is weaker here. The lane ran the security-auditor in parallel with the reviewer, as #78 recommended, and one fix commit covered all three seats, so the second fix round of #78 did not recur.
- **A Done-when that needs an observation the lane cannot cause (item 3).** The condition (a card payment in flight at fetch time) is not schedulable. First occurrence. The issue had no fallback acceptance for it.
- **Plan commit order not checked against the test's imports (item 4).** Single slip, first occurrence.

## What worked, keep it

- **Never rebuilding `transactions`.** The cascade hazard was verified, not remembered, and the whole design routes around it: native ADD/DROP COLUMN, no `sqlite_sequence` handling, and a rollback test that checks table_info, rows and the sequence are identical to the snapshot. #134 now guards the hazard for later migrations.
- **Testing on legacy-shaped data.** The test migrates to just before the first new migration and builds rows from the M1 fixture, including a repair row (NULL category, name set) and a survivor row. Delete-highest-id makes `sqlite_sequence` exceed `max(id)`, so a rebuild would show.
- **Key-set pins tied to the TS types** (`Record<keyof Account, true>`): adding a column to a table without updating `models/sync.ts` is a red test, which is what "the types live in `models/sync.ts`" needed.
- **Executed findings.** Reviewer mutations (18, all killed), the security-auditor's superagent header leak, and the cascade check were run, not asserted. The leak became a concrete test spec on #21.
- **Following the Done-whens over the comment, and saying so.** The conflict was reported and the missing writer was filed as #129 with a phase line, not absorbed (it would have touched `server/db/transactions.ts`, which the issue excludes).
- **Evidence labelling in the doc.** Each Akahu claim says whether it was observed or documented and the date read. "Docs-verified, real-response pending" is stated plainly instead of rounded up.
- **Parallel reviewer, schema-reviewer, security-auditor, one fix commit.** One fix round covered three seats.
- **Follow-ups named their origin, passed the phase test, and #132 and #134 credit the seat that found them.**

## Surfaced, not absorbed

- **#129** `setUserCategory` writes a correction and refuses pending rows. Phase: prd-01 Done-when 7 depends on it.
- **#130** seed writes `akahu_category_*`. Housekeeping.
- **#131** Akahu reissues about 0.1% of settled transactions under a new `_id`; Ruling 1 says sync never deletes a settled row, so a duplicate could inflate spend. Needs a ruling from Hannah.
- **#132** the prd-03 replica must hold `formatted_account` (full account number), bank-link ids and `error_message` out. Phase for prd-03 Done-when 3.
- **#133** prd-01 Ruling 1, Ruling 4, Open question 3, Done-when 2, prd-02 Ruling 3 and prd-04 wording; the 20261023130000 header; `models/akahu.ts` drift; `models/transactions.ts` typing.
- **#134** guard against a migration rebuilding `transactions`.
- **Comment on #21** the six-point schema contract: stale `running` rows must be closed before a new run, pending inserts must set `status`, no token in `error_message`.

## Recommended changes

1. **Rule for comments on a sliced issue.** Anyone posting a conductor note to an open issue that changes what it requires must edit the issue's Done-when or fence, or say "this comment is superseded by Done-when N" in the comment. A comment that contradicts the body is a bug in the slice. Artifact: `CLAUDE.md`, section "Issues and the board". High leverage. First occurrence, but the cost is one sentence and the failure mode puts a lane between two instructions.
2. **Lane brief says what the build seat does with commits.** For gear 3 and 4 build dispatches, say "do not commit before the reviewer seat; leave the build staged, and commit it before committing review fixes". #34 shows this works without `git stash`. Resolve the pipeline-versus-table conflict in the same edit. Artifact: `CLAUDE.md`, section "Worktrees and lanes", and step 5 of `~/.claude/CLAUDE.md`. Low cost; the effect this time was small, so I do not rank it first.
3. **Third occurrence of the fence-gap family: widen the architect's fence checklist.** For each table a migration changes, list every writer and reader (seeds, fixtures, column-list tests, `server/db/transactions.ts`) and state who owns the fix for each outside the fence. Artifact: `~/.claude/agents/architect.md`, imported to Baseline. This repeats #78's recommendation 1 with "consumers of the data" added next to "build and test config".
4. **Architect plan for a data-changing migration: state `down` as carefully as `up`, with one line on what a row looks like after rollback.** Single occurrence; do not encode yet. If it recurs, add to the architect's migration section.
5. **Architect plan for conditional UPDATEs: name a fixture row per predicate clause that only that clause decides.** Single occurrence. test-guard's mutation pass already catches it, so it is a cost note, not a gap.
6. **Done-when that needs live external state (a pending item that exists on the day): give a fallback acceptance in the issue.** Single occurrence. Item 3 is the first example. If it recurs, add to the slicing checklist.
7. **Plan commit order: check each commit's imports are satisfiable at that commit.** Single occurrence; the architect should have followed the test's imports. Do not encode yet.

## Highest-leverage next step

Add the rule from recommendation 1 to `CLAUDE.md`, "Issues and the board": a comment that changes what a sliced issue requires must be folded into the Done-when, or marked superseded by number. #19's lane had to choose between a comment and the issue, chose right, and still left a phase-level follow-up (#129) and two stale texts (#133). The next lane may choose the other way.

## Open items for the PR body

- Done-when 5 is half met: pending shape is docs-verified; the real response had no pending item on 2026-10-25. The doc has the keys-only re-check; if `_id` appears, prd-01 Ruling 1 and this schema are wrong.
- Copy, not rename, of `category_*` (Done-when 1 and 7 supersede the PR #93 comment). Legacy columns stay; Ruling 4's "become" is stale (#133).
- Beyond the issue's letter: `sync_runs` CHECKs, the one-running partial unique index, non-negative counts, `ON DELETE CASCADE` on `category_corrections.transaction_id`.
- `transactionColumns.ts` was reconciled (six names added), under the issue's "minimal reconciliation" clause.
- `down` of 100003 deletes pending rows; rollback of 100004 drops all corrections.
- `status` and `source` default to `settled` and `akahu` (required by SQLite ADD COLUMN NOT NULL); a pending insert that forgets `status` becomes a permanent settled row. This is on #21.
- Follow-ups #129 to #134 and the comment on #21.

## PR paragraph

This adds the prd-01 sync schema, additively, without rebuilding `transactions`. Four migrations create `accounts`, `sync_runs` (CHECKs; one `running` row at a time via a partial unique index) and `category_corrections` (`ON DELETE CASCADE`), and add `status`, `source` and `akahu_category_*` to `transactions` by native `ADD COLUMN`, copying (not renaming) the legacy `category_*` values. Every `down` works; 100003's deletes pending rows so none is left looking settled. `models/sync.ts` holds the row types and a 43-file / 643-test gate backs it (tsc 0, lint 0). Review fixes in 99d09ba cover the `down` pending-row issue, a repair UPDATE that could fill a user-owned NULL category, negative sync counts and a doc privacy note. `docs/akahu-pending-semantics.md` records the pending key, backfill depth and effective-category choice; the pending shape is docs-verified only, because the real pending endpoint returned no items on 2026-10-25 (re-check recipe in the doc). Follow-ups: #129 (the writer, phase), #130, #131, #132 (phase, prd-03), #133, #134.

## Baseline narratives

These four are the text for the retro POST (`narrative_code_type`, `narrative_built`, `narrative_how`, `narrative_wrong`).

### narrative_code_type

A database schema contract: four additive SQLite migrations with CHECKs and a partial unique index, row types, a migration/backfill/rollback test suite, and an Akahu pending-transaction evidence doc. Gear 4, imported by every later prd-01, prd-02 and prd-03 wave.

### narrative_built

Migrations creating `accounts`, `sync_runs` and `category_corrections`, and adding `status`, `source` and `akahu_category_*` to `transactions` with native `ADD`/`DROP COLUMN`, never a table rebuild. Legacy `category_*` is copied to `akahu_category_*`, not renamed. `models/sync.ts` holds the row types, a 32-test schema suite runs against fixture-shaped legacy rows, and `docs/akahu-pending-semantics.md` records the pending key, backfill depth and effective-category choice. Gate: tsc 0, lint 0, vitest 43 files / 643 tests.

### narrative_how

Researcher, architect, then the implementer on opus. Reviewer, schema-reviewer and security-auditor ran in parallel, then test-guard, then one implementer pass for a single review-fix commit, then docs-syncer. Verified that a knex table rebuild inside the migration transaction cascade-deletes correction rows, so the plan used native column add and drop. The reviewer ran 18 mutations, all killed. Six follow-ups (#129 to #134) were filed with origin lines, and a schema contract was posted on #21.

### narrative_wrong

The lane brief told the implementer to commit the build, so review ran on a branch range and not the working diff, which departs from the pipeline order. A PR #93 conductor comment told the lane to rename the legacy columns and change `server/db/transactions.ts`, contradicting the issue's Done-whens and fence; the lane followed the Done-whens and filed #129, but prd-01 Ruling 4 is still stale. Done-when 5 is half met because the real pending endpoint returned no items, so the pending shape is documented, not observed. Review found that rollback left pending rows looking settled, the repair could fill a user-owned category and counts could go negative, and the seed was left out of the fence (#130).
