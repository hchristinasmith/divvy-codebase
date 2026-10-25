# Retro: #129 prd-01 Ruling 4, `setUserCategory` writes a correction and refuses pending rows

One issue, one lane, one PR. Gear 2 as stamped by the dispatcher (the issue carries no gear line). No gear-shift trigger fired: no file outside the fence, no migration, no new exported symbol, no `models/` change. Seats in order: test-writer (regression tests for the old behaviour, `55d02c6`, 12 tests) -> implementer (opus, high; `9d921ac`) -> reviewer and security-auditor in parallel -> test-guard -> test-writer (haiku, one test) -> review-fix commit `f845431` -> docs-syncer (report only, no edits). Final gate on HEAD: `tsc` clean, lint clean, vitest 46 files / 990 tests passed. This file states no Baseline telemetry (model, duration, tokens, tool calls).

## What was built

- **Kind of code:** a DB-layer write function change plus its route, with tests. The diff against the merge base is four files: `server/db/transactions.ts` (61 lines changed), `server/routes/transactions.ts` (13), and the two test files (+317 and +169).
- **Approach:** `setUserCategory` now runs in one `db.transaction`. It reads the row's `category`, runs the UPDATE with `status = 'settled'` in its WHERE, then inserts a `category_corrections` row (`source: 'user'`) and returns the row. Return type is `Transaction | 'pending' | undefined`; the route maps `'pending'` to 409 and `undefined` to 404.
- **Why this shape:** a tagged return value keeps the pinned not-found and returned-row assertions unchanged and adds no export (no gear-3 trigger). Putting the status check in the UPDATE's WHERE means the check and the write cannot be separated by a sync run. `from_category` is the row's `category` column before the write, which is prd-01 Ruling 4's effective category; `category_source` says whose it was. Pending is refused because sync deletes and re-inserts pending rows each run (Ruling 1) and the correction's `ON DELETE CASCADE` would silently delete the correction with them.

## What happened

1. Regression tests went in first (`55d02c6`, 12 tests), green on the old behaviour, so the change was reviewed against a pinned baseline.
2. The implementer built the change in one pass (`9d921ac`). It noted that the "no correction for an unknown id" tests are held by the foreign key, not by observation: a mutation that tries to write a correction for a missing id goes red through an FK error, not through the assertion the test reads as.
3. Before review, the lane snapshotted the build diff. The reviewer edits the working tree, so the snapshot is what let the build commit and the review-fix commit be split afterwards.
4. Reviewer (executed mutants): the trigger-based atomicity test covered one write order only. A correction-first implementation with no transaction at all passed all 48 tests. The reviewer added the mirror test, so atomicity is now proven in both write orders.
5. Test-guard (executed mutant): the JSDoc claim "a same-category PATCH still writes a correction" was untested; removing that behaviour survived 49/49. The haiku test-writer added the pin (one test).
6. Security-auditor: nothing against the diff. Four pre-existing low items, none from this lane (listed below).
7. Docs-syncer found `docs/akahu-pending-semantics.md` falsified and `README.md` already stale. See What went wrong.

## What went wrong

| Finding | Caught by | Cost |
|---|---|---|
| The atomicity test proved only one write order. A no-transaction, correction-first version passed 48/48. The claim "the two writes share a transaction" was not actually tested. | reviewer | one test added, in the review-fix commit. No wrong code shipped. |
| The JSDoc stated a behaviour (same-category PATCH still writes a correction) that no test pinned; a mutation survived 49/49. | test-guard | one test, one extra test-writer dispatch (haiku). |
| `docs/akahu-pending-semantics.md` §5 and the line reference in §4 are now false. §5 explicitly names this lane's work as future. `README.md:10` was already stale before this lane (it still says PUT). The lane could not fix them because they sit outside the fence. | docs-syncer | two follow-ups filed: #160 (the docs) and #161 (the client does not handle 409). Both housekeeping, `Missed-by: plan`. A known-stale doc stays stale for one more merge cycle. |
| The "no correction for unknown id" tests pass because of the FK, not because of the assertion. | implementer's note, not a gate | none now. It means those tests would not catch a missing guard on their own; a mutation does go red, via an FK error. |

Security-auditor's four pre-existing items, not caused or fixed here, and not filed by this lane: (a) no JSON error middleware, so in dev a malformed JSON body returns an HTML stack trace; (b) `server/routes/akahu.ts` echoes upstream error text; (c) the `searchTxns` argument is unchecked; (d) the seed's `transactions.del()` cascades away corrections in dev. The brief did not say whether these were filed; if not, they have no issue yet.

## Root causes

- **`author-blind-spot-on-own-mutants`** (named in the 2026-10-23 retro and repeated in the Rulings 9-11 and safe-to-spend bundle retros; this is the fourth sighting). The tests were written by the seat that already knew which order the code writes in, so they exercised that order. The second order, and the same-category claim, were found only by seats that did not write the code. The test-writer's regression pass could not catch this because it ran before the change existed.
- **A claim in a comment with no test behind it** (new name: `doc-claim-without-pin`, first occurrence). The JSDoc was written alongside the code and asserted a behaviour; nothing required a pin for each stated behaviour. Test-guard found it by mutation. Record only; encode if it recurs.
- **The fence did not include a doc the issue itself falsifies** (new name: `fence-omits-known-stale-doc`, first occurrence; `Missed-by: plan`). `docs/akahu-pending-semantics.md` §5 names this work, so the staleness was knowable when the issue was written. The global gear table has a trigger for "a doc in the project's reference table falsified", but that doc is not in the Reference docs list in the project `CLAUDE.md`, so the trigger could not fire and the docs-syncer finding became two follow-up issues instead of a few lines in the PR. This is a gap in the reference table and the slicing step, not a lane mistake.
- **The client was not in the issue's scope for a new status code** (`Missed-by: plan`). Returning 409 from a route the client calls is a contract change; #161 exists because the issue did not say who handles it. Unclear whether the slicing considered it and deferred it on purpose; the record does not say.

## What worked well (keep)

- Regression tests committed before the change, so `9d921ac` shows only what moved. The pinned not-found and returned-row assertions stayed unchanged, and the return-type choice was made specifically to keep them so.
- Status check in the UPDATE's WHERE rather than a read-then-write: the atomic form was chosen over the obvious one and no race window exists to test around.
- Snapshotting the build diff before review, because the reviewer edits the working tree. Build commit and review-fix commit stayed separate, as the project commit table asks, with no `git stash` (shared stash stack rule).
- Reviewer and test-guard again found different things, both by executing mutants rather than reading. The reviewer's no-transaction mutant is the kind of probe that turns "the test looks right" into "the test fails when it should".
- Routing the one-test fix to a haiku test-writer instead of re-opening the opus implementer.
- Docs-syncer reported without editing outside the fence, and the follow-ups were filed with their origin and a `Missed-by` seat rather than absorbed into this PR.
- Security-auditor separated "against the diff" (nothing) from "pre-existing" (four), so none of the four was mistaken for this lane's work.

## Recommended changes

1. **Add `docs/akahu-pending-semantics.md` to the Reference docs list in `CLAUDE.md`.** It is the doc that defines the behaviour this lane changed and the one docs-syncer found falsified. With it in the table, the existing "reference doc falsified -> gear >= 3" trigger fires and the update belongs in the fence. File: `CLAUDE.md`, Reference docs. High leverage, one line. Needs its own docs change (the lane may not edit `CLAUDE.md`); can ride with #160.
2. **When slicing, grep the docs for the issue number and the feature name before writing the fence.** Here §5 named #129's work; a grep would have put the doc in the fence. First occurrence; record only. If it recurs, encode it in the issue-slicing step of whichever runbook or skill the conductor uses. Not encoded now.
3. **State in the issue whether the client is in scope when a route gains a status code.** First occurrence; record only. If it recurs, add the line to the issue template.
4. **Atomicity and ordering claims need a test per order.** Same family as `author-blind-spot-on-own-mutants`, whose fix has been recommended before (a boundary-input checklist in `docs/testing.md`). Add one line there: a "these writes are atomic" test must fail a version of the code with the writes in the other order and with no transaction. File: `docs/testing.md`. This extends a recommendation that already exists rather than a new one, so it is warranted now. Optional if the checklist from the earlier retros has landed (this lane did not check).
5. **Decide whether the four pre-existing security items get issues.** The record does not say they were filed. If not, file them as housekeeping so they have an owner.

## Highest-leverage next step

Change 1: add `docs/akahu-pending-semantics.md` to the Reference docs list in `CLAUDE.md`, and fix its §4/§5 (and `README.md:10`) under #160. It is a one-line change that makes an existing gear trigger work for the next lane that touches pending-row behaviour.

## Open items for the PR body

- Follow-ups: #160 (docs: `akahu-pending-semantics.md` §4/§5, `README.md:10`) and #161 (client does not handle 409), both `Priority: housekeeping`, `Missed-by: plan`.
- The four pre-existing security-auditor items above: confirm whether they were filed.
- Behaviour change for callers: PATCH on a pending row now returns 409 where it used to succeed.
- No gear shift to report.

## For Baseline (four fields)

**code type:** a DB-layer write function and its Express route, with tests. Gear 2 as stamped; no gear shift.

**built:** `setUserCategory` in `server/db/transactions.ts` now writes a `category_corrections` row in the same DB transaction as the category write. `from_category` is the row's `category` before the write (prd-01 Ruling 4's effective category). The UPDATE's WHERE carries `status = 'settled'`, so the check is atomic with the write. The function and `PATCH /api/v1/transactions/:id` refuse a pending row, the route with 409. The return type is `Transaction | 'pending' | undefined`, which kept the existing assertions and added no export. Gate on HEAD: `tsc` and lint clean, vitest 46 files / 990 tests passed.

**how:** 12 regression tests were committed first on the old behaviour, then one opus implementer pass. The build diff was snapshotted before review so the reviewer's working-tree edits could be committed separately. Reviewer and security-auditor ran in parallel, then test-guard; a haiku test-writer added one test, and docs-syncer reported without editing. No architect (gear 2).

**wrong:** the atomicity test covered one write order only, so a correction-first version with no transaction passed all 48 tests; the reviewer found it and added the mirror test. A JSDoc claim (a same-category PATCH still writes a correction) had no test; a mutation survived 49/49 until test-guard found it and one test was added. The docs-syncer found `docs/akahu-pending-semantics.md` §4/§5 falsified, with §5 naming this very work, but the doc was outside the fence, so #160 was filed; the client does not handle 409, so #161 was filed. Both are `Missed-by: plan`. The doc is not in the CLAUDE.md reference table, so the gear trigger for a falsified reference doc could not fire.
