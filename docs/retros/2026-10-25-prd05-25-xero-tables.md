# Retro: #25 prd05 w1, the xero_* tables (xero_connection, xero_invoices, xero_bills, xero_pay_runs, xero_profit_loss)

## Retro summary (for the PR body)

#25 added the five `xero_*` tables as one additive migration with a 129-test schema suite, and the final gate is green (tsc and lint clean, vitest 53 files / 1403 tests, after rebasing onto #178). The build itself went cleanly; the one real stop was the first full gate, which went red (2 of 1267) because `server/db/__tests__/prd02-tables.test.ts` asserts an exact table list after `migrate:latest`, so any later migration breaks it, and that file was in the negative fence. The lane raised a Baseline decision, Hannah widened the fence by that one file, and the two assertions now compare at prd-02's own migration. Root cause: the slice said #25 "modifies nothing" and nobody checked which existing tests pin the table list (Missed-by: plan). Review (reviewer, schema-reviewer, security-auditor) and test-guard found real constraint and documentation gaps but no wrong code on main, and three downstream issues (#28, #66, #76) got explicit handoffs. Gap to record: gear 4 lists a `researcher` seat and none ran.

Gear 4 as stamped; no shift. The implementer ran on opus at effort high. This retro states no telemetry (model, duration, tokens, tool calls); the lane posts the four narratives after `baseline finish`.

Seats run, in order: architect, implementer (migration and schema test), then reviewer, schema-reviewer and security-auditor in parallel, implementer (the prd-02 test fix), implementer (review fixes), test-guard, docs-syncer, this retro. No `researcher` ran; the architect did the investigation. Verify passed on the final state: `npx tsc --noEmit` 0, `npm run lint` 0, `npx vitest run` 53 files / 1403 tests, after rebasing onto #178.

Commits after the rebase (`git log --oneline origin/main..HEAD`): 07358d1 (prd-02 table-list tests compare at prd-02's own migration), 87be843 (the xero_* tables), 82bbe72 (review fixes), f2dc189 (import the shared omit helper), then this retro. The code diff is three files, 1280 insertions: the migration (281 lines), `server/xero/__tests__/schema.test.ts` (992 lines) and 7 lines in `prd02-tables.test.ts`.

## What was built

- **Kind of code:** one additive SQLite migration (`server/db/migrations/20261025130000_xero_tables.js`) and a schema test suite. No row types: `models/` was outside the fence.
- **Pattern:** the rules live in the database as named CHECKs, the same shape as the prd-02 planning tables. Cents columns are `typeof(col)='integer'` plus a range, calendar dates use `date(x,'+0 days') IS x`, and instants are strict ISO-8601 UTC text (milliseconds and `Z`) checked by reformatting with `strftime` and requiring the value back unchanged. `xero_connection` is a single-row vault pinned by `id = 1`, with `*_enc` columns as BLOB ciphertext of at least 29 bytes (12-byte IV, 16-byte tag, one byte of data) and a `version` column that guards the atomic refresh (Ruling 3). Invoices and bills carry `currency` with no default (Ruling 7), and every row has a `synced_at` the architect added beyond the issue's list. There are no foreign keys and nothing outside the `xero_` namespace is touched.
- **Why this shape:** the contested choices were `synced_at` and the single-row mechanism. `synced_at` exists so a sync can delete the rows it did not see this run; the client returns only outstanding documents, so upsert alone never removes a paid or voided one. The single row is a CHECK, not an application convention.

## What happened

- The architect's plan fixed the five tables, the BLOB and instant rules, the `id = 1` CHECK, currency per Ruling 7 and `synced_at`. The implementer built the migration and a 127-test suite in one pass.
- **The first full gate went red, 2 of 1267.** `prd02-tables.test.ts` asserts the exact table list after `migrate:latest`, so any migration added after prd-02's breaks it. The file was in the negative fence. The lane stopped and raised Baseline decision 703e3195. The first raise was refused with a 400 because an option's `fence` field must be an object and the lane had passed an array; it dropped the field and raised again. Hannah picked: widen the fence by that one file, change only the two assertions (lane #165 edits the same file's imports and omit helper, so the diff had to stay out of its way), and compare at prd-02's own migration. The fix is a `migrate.down()` loop back to prd-02's migration, with an assertion that it is in the applied list, committed first (07358d1).
- **Two of the plan's test cases could not exist.** The plan listed `'100'`, a REAL `1e2` and `'1'` as values the CHECKs refuse. SQLite coerces all three to INTEGER through the column's affinity before any CHECK runs, so they are stored as integers and nothing is refused. The tests assert that they land as integers, and the migration header says so.
- **Review, run in parallel on the build.** The findings applied in 82bbe72:
  - Pay-run totals lost their `>= 0` CHECK. Ruling 6 says Xero data is stored as received, and the client reader accepts a minus sign, so a negative total is data, not a bug. `amount_due_cents >= 0` stayed, because "still owed" cannot be negative.
  - A `connected` vault now needs non-empty `scopes`.
  - The migration header was reworded: the vault owns `xero_connection` and refreshes with a version-guarded UPDATE, and a sync must delete rows it did not see this run.
  - Writer rules were added to the header: an `_enc` column takes a raw Buffer (base64 or hex text is refused) and an instant is `Date#toISOString()` text.
  - A compare-and-swap test was added for the version guard.
  - The CHECK suffix `_non_negative` was renamed `_is_cents`, because the rule is "an integer count of cents", not only "not negative".
- **test-guard** ran 33 valid mutants and killed all of them. It flagged two clauses with no test evidence (the `version` typeof check and "connected needs `expires_at`"). The lane mutated each itself, and each was killed by exactly one test.
- **Handoffs posted:** #28 (the vault: BLOB writer rules, compare-and-swap, the W1 caveat that the CHECK cannot tell `Buffer.from(plaintext)` from ciphertext, and closure of the D6 doc), #66 (sync: delete-unseen contract, the P&L row-per-day shape, no last-sync column) and #76 (the replica must exclude `xero_connection` and `xero_pay_runs`).
- **Follow-up filed, then closed as a duplicate:** #171, `.gitignore` for the sidecar and `.env*` files. #146 (merged in #164) had already fixed it; the security-auditor read `.gitignore` from a worktree cut before that merge. A seat reading a stale tree can file work main already did, so fetch before filing.
- **Rebase onto #178:** its accounts/bills/goals migration guards un-skip once a migration lands after prd-02; over `20261025130000_xero_tables.js` all 24 pass. #166 landed a shared `omit` helper, so the schema test now imports it instead of keeping a copy (f2dc189).

## What went wrong

1. **The slice did not foresee that a new migration breaks a prior lane's exact-list test (Missed-by: plan).** #25's fence said it modifies nothing. But `prd02-tables.test.ts` ran `migrate:latest` and compared the table list against prd-02's tables, so it was bound to fail for the first migration that came after. Cost: a red gate, a Baseline decision, a wait on Hannah, a fence change mid-run and one extra commit, plus a coordination point with lane #165. No wrong code reached main. The test, not the schema, was wrong: a migration-specific test compared against `latest` instead of its own migration.
2. **No `researcher` seat ran at gear 4.** The architect did the investigation. Whether a researcher would have found the table-list test is not shown in the record. It is plausible: in #39 the researcher caught the analogous test outside the fence, before the build. Here the gate caught it, after. I cannot show it would have been caught; I record it as a gap against the gear 4 table.
3. **The plan asserted refusals SQLite does not perform.** The "refuse `'100'`" cases were impossible, because affinity coerces before the CHECK. The implementer found it by running the tests. The record does not show the architect executing those cases. Cost: a few tests rewritten as "lands as an integer" and a header note. Small, but it is the failure that #39's architect avoided by measuring.
4. **Review found real gaps that the implementer's own tests did not.** The negative-total CHECK on pay runs contradicted Ruling 6 and the client reader; connected vault scopes could be empty; the header's description of who writes the vault and what a sync must delete was missing. None was wrong code on main, and one was a rule the build had added beyond the ruling. The record does not show why the implementer added `>= 0` to the pay-run totals, so I name no cause.
5. **The decision file failed schema validation again.** Same error as #39: `fence` passed as an array where the schema wants an object. One wasted raise. #39's retro said to encode a field-shape example if it recurred. It has.

## Root causes

- **Plan covers the code that changes and not the code that reads it (item 1, also item 2).** This is the root cause named "fence written without checking the consumers of the thing being changed" in the #39 retro, which counted four occurrences (#68, #78, #19, #39). By that count this is the fifth, in a new form: not a drop or rename, but an addition tripping a test that pins the full set. The consumer is a test again. The fence for an additive migration should list "tests that assert the whole table list".
- **A migration-specific test compared against `latest`, not its own migration (item 1).** The proximate cause. The test was written at prd-02 when prd-02's migration was the latest, and it has no way to know it will stop being so. Every future migration lane would have hit it. The fix in 07358d1 pins the comparison; `docs/testing.md` does not yet say so.
- **A plan claim about database behaviour was not executed (item 3).** First occurrence in this record; #39 shows the opposite habit working. Not encoded yet.
- **Decision-file shape (item 5).** Second occurrence. Cause: the lane guesses the field type, and the schema's error message is good but the template shows no example. Now encode.
- **Item 4 has no root cause I can point at in the record.** "Unclear" is the honest answer for why `>= 0` was added.

## What worked, keep it

- **Stopping at the red gate and raising a decision.** The fence was Hannah's to widen, and the lane did not edit the file on its own. The answer came back with the constraint that matters (do not touch the lines lane #165 edits), and the fix is two assertions.
- **Committing the prd-02 fix first as its own commit.** 07358d1 can be read and reverted alone, and the new tables do not ride on it.
- **The architect's plan reused the date and `typeof` CHECK patterns from the prd-02 tables (#39).** The record shows none of the review findings concerned those two rules.
- **Mutation seats that run the code.** test-guard's 33 mutants all died, and the lane then mutated the two clauses test-guard flagged as un-evidenced and watched each die on exactly one test. That is the right end of the loop: a flagged gap closed by evidence, not by assertion.
- **Documenting the contract in the migration header and the handoffs, not just the code.** #28, #66 and #76 each got the rules they will need (writer shapes, delete-unseen, replica exclusions), and the header says who owns what. The downstream lanes arrive with a contract, not a guess.
- **Surfacing, not absorbing.** No `models/` row types, a `testing.md` line and the kept `amount_due_cents >= 0` were all noted, not folded in.

## Surfaced, not absorbed

- **No `models/` row types for the five tables.** Outside the fence. #28, #66 and #71 will likely need them.
- **`docs/testing.md` could gain one line:** table-list tests pin to their own migration. See Recommendation 1.
- **`amount_due_cents >= 0` kept** while pay-run totals lost theirs. The distinction is deliberate: "still owed" cannot be negative, a stored-as-received total can.
- **#171** closed as a duplicate of #146 (Missed-by: none).
- **Handoffs, not issues:** #28, #66 and #76, as listed above.

## Recommended changes

1. **Fence checklist for any new migration: grep the tests for the whole-table-list assertions and put every hit in the fence or on a named owner; and pin such tests to their own migration.** A one-line `rg` for `migrate.latest` near an exact table list would have found `prd02-tables.test.ts`. Fifth occurrence of the consumers family, so encode. Artifacts: `~/.claude/agents/architect.md` (the fence step, then `pnpm import-workflow --name current`), and `docs/testing.md` (one line plus a pointer to the `migrate.down()` loop in `server/db/__tests__/prd02-tables.test.ts`). High leverage; every remaining migration lane would otherwise hit this.
2. **Decision-file template: show `fence` as an object, with an example.** Second occurrence, so encode. Artifact: the template the lane uses for `baseline decide` (its path is not in the record I read). Low cost, removes a wasted raise.
3. **Plan rule for SQLite behaviour: a "refused" case in a plan is run before it is written down.** Do not encode yet. One occurrence here; #39 shows the habit working. If it recurs, add it to the architect's checklist.
4. **Gear 4 and the `researcher` seat: either run it, or say in the handoff that the architect covers it.** Do not encode yet. The record shows the gap but not a cost. It is Hannah's call whether the seat is needed when the architect investigates. Artifact if she decides: the gear table in `~/.claude/CLAUDE.md`.

## Highest-leverage next step

Do Recommendation 1: add "tests that assert the whole table list" to the architect's fence checklist, and add the pin-to-own-migration line to `docs/testing.md`. This lane lost a gate, a decision and a wait to one test that was written correctly for its day; the next migration lane has the same test waiting unless the pattern is documented and the other schema tests are checked for it.

## Open items for the PR body

- Fence widened by Hannah's decision (703e3195): `server/db/__tests__/prd02-tables.test.ts`, two assertions only, compared at prd-02's own migration. Lane #165 edits the same file's imports and omit helper; the two diffs should not overlap.
- Currency on invoices and bills has no default (Ruling 7). `synced_at` was added beyond the issue's list. `xero_pay_runs` totals are stored as received and may be negative.
- The `_enc` CHECK enforces type and length only (BLOB, at least 29 bytes); it cannot tell plaintext bytes from ciphertext, so the encryption guarantee belongs to the vault (#28).
- prd-03's replica must exclude `xero_connection` and `xero_pay_runs` (#76).
- Handoffs posted to #28, #66, #76. Follow-up #171 closed as a duplicate of #146.
- Gate: tsc 0, lint 0, vitest 53 files / 1403 tests, after rebasing onto #178.

## Baseline narratives

These four are the text for the retro POST (`narrative_code_type`, `narrative_built`, `narrative_how`, `narrative_wrong`).

### narrative_code_type

A database schema contract: one SQLite migration with CHECK-heavy tables and a schema test suite. Gear 4, imported by the later prd-05 issues (the token vault, the sync, the Overview and tax hold readers).

### narrative_built

A migration creating `xero_connection` (a single-row token vault with BLOB ciphertext of at least 29 bytes and a version guard), `xero_invoices`, `xero_bills` (with a currency column and no default), `xero_pay_runs` and `xero_profit_loss`. Money is integer cents, enforced by `typeof` CHECKs. Dates and ISO-8601 instants are strictly checked, and pay-run totals are stored as received. `server/xero/__tests__/schema.test.ts` has 129 tests. Gate: tsc and lint clean, vitest 53 files / 1403 tests, after rebasing onto #178.

### narrative_how

The architect planned the five tables, then the implementer on opus built the migration and tests. Reviewer, schema-reviewer and security-auditor ran in parallel, followed by the implementer's review fixes, test-guard (33 valid mutants killed) and docs-syncer. The first full gate went red because a prd-02 test pins the exact table list; the lane raised a Baseline decision, and Hannah widened the fence by that one file so the test compares at prd-02's own migration. Handoffs went to #28, #66 and #76, and #171 was filed, then closed as a duplicate of #146. A final rebase onto #178 ran its migration guards over the new migration (24 pass).

### narrative_wrong

The slice said #25 modifies nothing, but a prior lane's test asserted the exact table list after `migrate:latest`, so the first gate went red (2 of 1267); this cost a decision, a wait and a mid-run fence change (Missed-by: plan). No `researcher` seat ran, though gear 4 lists one. The plan listed `'100'` and a REAL `1e2` as refused values, but SQLite coerces them to integers before any CHECK runs. Review found a pay-run `>= 0` CHECK that contradicted Ruling 6, empty scopes on a connected vault, and header gaps. The first decision raise failed because `fence` was an array, the same error as #39.
