# Retro: #165 migration guards for the accounts, bills, goals and users children, with #166 bundled (both test-only, `server/db/__tests__/`)

Bundle of two issues in one lane, one PR. Both stamped gear 2. Shifted 2 -> 3 by the trigger list: the helper lift adds new exported symbols (`omit` in `omit.ts`, `migrateThrough` in `migrateToJustBefore.ts`), test-only. The seats stayed gear 2 plus this retro file; no architect. Implementer on opus (effort high) built all three steps; reviewer reviewed the working diff and verified by mutation; test-guard passed with no findings. No stash. Commits: ee01f1e (helper lift, #166), 04d4798 (#165 build), 4c5c4fe (#166 NOT NULL checks), 542ee37 (#165 review fix). Merge with `gh pr merge <N> --merge --delete-branch` so the per-issue commits survive; the merger closes #165 and #166 by hand. No file under `server/db/migrations/**` was touched. This file states no Baseline telemetry. I did not re-run the gate; the dispatch says it passed on the final state (tsc 0, lint 0, vitest 52 files, 1258 passed, 3 skipped).

## What was built

- **Kind of code:** regression guards over the migration stack (#165), a table-wide schema assertion (#166), and two lifted test helpers. No production code changed.
- **#165 pattern:** `migration-guards.test.ts` holds one guard per parent (`transactions`, `users`, `accounts`, `bills`, `goals`). Each `Child` names the migration that created it (`createdBy`). The guard writes the parent at its first child's migration, steps up one migration at a time writing each child as its table appears, runs `migrate:latest`, and asserts every child row and the parent's AUTOINCREMENT counter survived. Each parent has a canary that adds a rebuilding migration in the test and expects the guard's check to fail. One pin test says every ON DELETE CASCADE or SET NULL foreign key at latest has a guard; another pins each `createdBy` to the migration that creates the table.
- **Skips by design:** the `accounts`, `bills` and `goals` guards use `it.skipIf`, because all their children come from the newest migration (`20261025120000`), so there is nothing after it to run over them and a real guard would be vacuous. They un-skip on their own when any later migration lands (lane #25's xero_tables will). Their canaries run today and go red.
- **#166 pattern:** `prd01-schema.test.ts` gets a table-wide "refuses being left out" check for prd-01's NOT NULL columns, modelled on the existing prd-02 `it.each`. `omit` and the step-up helper now live once under `server/db/__tests__/` and every caller imports them.

## What happened

1. **The helper lift went first.** The #134 retro said to land #166 before #165 so #165 would not add a third copy of the step-up loop. It did (ee01f1e), and #165 imported `migrateThrough`.
2. **The issue's FK table was wrong in three places.** The implementer read `PRAGMA foreign_key_list` on a migrated DB instead of trusting the table. There is no prd-02 `users` child; `challenges` is really `user_challenges`; `targets` is dropped by prd-02 (Ruling 6), so it has no child left to lose. The guards follow the database, and the `users` guard carries a comment saying why `targets` is absent.
3. **Step 3 of #166 found a shape the issue did not expect.** Every NOT NULL prd-01 `transactions` column has a default, so `transactions` has only "takes its default" rows and no "refuses being left out" rows. `category_source` (M1 #9) was excluded as not one of #166's "new transactions columns".
4. **Reviewer F1 (substantive, EXECUTED).** See below.
5. **Reviewer F2.** The diff made a second copy of `count()` and a near-duplicate NOT NULL PRAGMA filter in `prd01-schema.test.ts`, next to pre-existing `columns`/`sequence` duplicates. Not folded in (fence and scope); filed as #173 (`Spawned-by: #166`, `Missed-by: do`, `Priority: housekeeping`).
6. **`file://` imports** fail under vite on this repo path (`%20`, `%7E`), carried from #167. The handoff warned of it; plain absolute path used; no time lost.
7. **Test-guard:** passed with no findings.

## What went wrong

- **F1: the first guard design merged green while deleting `account_settings`.** It seeded every child once, after the migration that created the parent's *last* child. A future migration that both creates a new child and rebuilds the parent would be that "last child" migration, so it would be treated as the seed point, never run over the older children, and the guard would skip as if nothing came after it. The reviewer showed it by writing such a migration: the guard stayed green and `account_settings` was gone. Fixed in 542ee37 (each child seeded at its own `createdBy`, parent at the first child's migration, one-step stepping, plus the per-child "created by X, and not before" pin). Proven red in a scratch copy. Cost: one review round and a rewrite of `seed()` and the flow around it.
- **F2: a second helper copy created in a lane whose bundle partner was about to remove copies.** Small; the duplicate sits in a file this lane owned for #166 itself.
- **Process note:** the build commits for #165 and #166 were made by the conductor after one working-tree gate with both changes present, because the two cannot be gated in isolation without a stash, which is banned. The file sets are disjoint, so the split is clean, but neither commit was gated alone.

## Root causes

- **One snapshot standing in for a timeline (F1).** The issue text asked for a child row "in the schema the migration that created the child leaves", which is per child. The first design collapsed that to one seed point for the whole parent. The record does not say why; what it shows is that the single seed point is simpler to write and share across children, and that the check which would have exposed it was absent. The canary only appended a rebuilding migration *after* the newest one. It never covered a migration that creates a child and rebuilds the parent in the same file, so the guard and its canary were red and green for the same narrow case. A guard over "future migrations" has to be tested against the *shapes* a future migration can take, not just one position in the list.
- **The design was taken from the issue text, not from the hazard.** The table in #165 was wrong in three places; the PRAGMA check caught that. The same habit (measure the schema, not the description) was not applied to the guard's own model of when children appear. The wrong FK table and F1 share a cause: a description of the schema stood in for the schema.
- **No architect at gear 2.** The design of a guard over unwritten migrations is a small design problem. The reviewer is where it was caught, which is the seat working, but a plan seat would have been cheaper than a review round. Not a reason to add one by default: this is the first occurrence.
- **F2** is the usual cost of a fence: the implementer wrote the narrow helper inside the file it was working in. Cause: no step in the do seat that greps the test dir for a near-identical helper before writing one.

## What worked, keep it

- **Landing #166's helper lift before #165**, as the previous retro advised. One copy, imported.
- **Measuring the schema.** `PRAGMA foreign_key_list` on a migrated DB corrected the issue's table before any test was written.
- **`it.skipIf` with a live canary** instead of a vacuous green guard: the skipped guards say plainly when they will wake up, and their canaries prove the check works today.
- **The FK-coverage pin.** A new CASCADE or SET NULL foreign key with no guard now fails a test, which closes the "someone adds a child and forgets" route.
- **Reviewer verified by mutation**, not by reading. F1 was found by running a migration through the guard, and the fix was shown red in a scratch copy.
- **Follow-up filed with origin (#173), not absorbed.**

## Recommended changes

1. **Write the "shapes of a future migration" into the guard-family header, and test them in the canary.** Add a canary case for "creates a new child and rebuilds the parent in one migration" for the guards that run today (`transactions`, `users`). Artifact: `server/db/__tests__/migration-guards.test.ts`. Optional; the per-child `createdBy` pin already makes the F1 shape fail, but a direct canary would show it. First occurrence, so a note in the file, not a runbook change.
2. **Record the recurring cause name: "description stood in for the schema".** This is the second place in one lane where the issue text was wrong or too coarse (FK table, seed point). Not yet a rule; if it recurs on the next migration-guard issue, add to the handoff template "read `PRAGMA foreign_key_list` / `sqlite_master` on the migrated DB before designing". Artifact: the conductor's lane handoff template.
3. **Gate bundles one lane at a time where files overlap.** Bundles whose halves cannot be gated alone without a stash should either commit the first half before starting the second (as the helper lift was) or say so in the PR body. Artifact: `CLAUDE.md`, "Small issues share a lane". Optional.

## Highest-leverage next step

Add the missing canary case to `migration-guards.test.ts`: a migration that creates a new child table and rebuilds the parent in the same step, expected to fail the `users` and `transactions` guards. It turns the F1 shape from "caught once by a reviewer" into a check that runs forever.

## Open items for the PR body

- Gear shift, one line: `shifted 2 -> 3: the helper lift adds new exported symbols (omit, migrateThrough), test-only`.
- Follow-up filed: #173 (`Spawned-by: #166`, `Missed-by: do`, housekeeping).
- Three guards (`accounts`, `bills`, `goals`) are skipped today by design and un-skip when any migration after `20261025120000` lands; lane #25 will do it.
- #165's issue table was wrong in three places (listed above); the issue could be corrected on close.
- Merge with `--merge`; close #165 and #166 by hand with a reason.
