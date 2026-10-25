# Retro: #67 prd05, read-only Xero routes (GET /api/v1/xero/totals and /status)

## Retro summary (for the PR body)

#67 added two read-only routes over the `xero_*` tables: `/totals` (receivables, payables with their bills, the latest profit figure, pay runs) and `/status` (connection state, last-stored time, what this week's syncs stored). The build, the review and test-guard all found and closed real gaps, and nothing wrong reached main. The run's one real cost was two Baseline decisions, both raised by the `researcher` before any code was written, because the issue was sliced against the PRD and not against the repo: (1) the barrel test fails for any unlisted mount, so the one-line mount the fence allowed could not go green without a file outside the fence; (2) no stored source existed for `last_synced_at` or "last run outcome". Hannah answered both in about four to five minutes. Both are Missed-by: plan, and the first is a recurrence of the "consumers of the thing being changed" family named in the #25 and #39 retros.

Gear 4 as stamped; no shift. The implementer ran on opus (the issue said sonnet; the CLAUDE.md model table maps gear 4 to opus). This retro states no telemetry (model, duration, tokens, tool calls); the lane posts the four narratives after `baseline finish`.

Seats run, in order: researcher, architect, implementer (build), reviewer and security-auditor in parallel, test-guard, implementer (test-guard gaps), docs-syncer, this retro. Every seat the gear 4 table lists ran, except `schema-reviewer`, which does not apply (no migration). Verify passed: the gate ran green before each of the three commits; the suite went 1481 (main) → 1520 (build, 39 new) → 1523 (test-guard gaps); `read.test.ts` ends at 42 tests.

Commits on the branch (`git log --oneline origin/main..HEAD`): 8c70e96 (build), 5a7c10e (review fixes), 18ac40d (test-guard gaps), then this retro. The code diff against the merge base (`git diff origin/main...HEAD`) is five files, 1403 insertions and 1 deletion: `server/xero/routes/read.ts` (339), `server/xero/routes/__tests__/read.test.ts` (964, 42 tests), `models/xero.ts` (97), plus the two-line mount in `server/routes/index.ts` and one word in `server/routes/__tests__/barrel.test.ts`. A plain `git diff origin/main..HEAD` shows far more, because the local `origin/main` is ahead of the merge base; use the three-dot form.

## What was built

- **Kind of code:** two GET endpoints, a typed response model and a route test suite. No migration, no write path, no call to Xero.
- **Pattern:** a read-model router over tables the sync (#66) will fill. Outstanding figures sum `amount_due_cents` (still owed), never `total_cents`. NZD is summed alone and other currencies are kept apart, never converted (Ruling 7). From `xero_connection` only `status` is ever selected, so no response can carry a token column (Ruling 2). "Not connected" returns `null` totals, not zero, so an unconnected install never reads as "$0 owed". `stale` is decided in one place (`readConnection`): connected, but no stored row newer than two sync intervals.
- **Why this shape:** the contested choice was where `lastSyncedAt` comes from. No last-sync column or run table exists, so it is derived as the max of `synced_at` / `fetched_at` over four tables, and `lastRun` is always `null` until #66 records runs (Hannah's decision, follow-up #195).

## What happened

- **Researcher first, and it paid for itself.** It found two things the issue's slicing missed and the lane raised each as a Baseline decision (a0f32dd8, ac0d942a) before the architect planned:
  - `server/routes/__tests__/barrel.test.ts` fails for any mount not in its list, so the "one-line mount" the fence allowed could not be green without a file outside the fence. Hannah widened the fence by one word (`'xero'` in the test's `EXISTING` list). The commit message says so.
  - The `xero_*` tables from #25 have no run table and no last-sync column, so the status route's `last_synced_at` and "last run outcome" had no stored source. Hannah picked: derive `lastSyncedAt` from the rows, `lastRun` always `null` until #66. Follow-up #195 was filed (Spawned-by #67, Missed-by plan, Priority phase, prd-05 Done-when 8).
- **Two spec phrases are not representable from the tables.** "Paid invoice" in "Pulled from Xero this week" cannot be counted, because the sync deletes paid documents. "This week" can only mean "present in this week's syncs", because `synced_at` is re-stamped on every run. Both are written into the route header and `models/xero.ts` (line 147), not left implicit. These were not raised as separate decisions; the record shows them settled as documented interpretations, and I did not see Hannah confirm that reading.
- **The implementer deviated from the plan once, on evidence.** The planned "select scopes" mutation could not turn the leak test red: a column that is selected but never returned never reaches the response body. The implementer added an exact-SQL test for `xero_connection` (what is selected, not just what is returned) so the Ruling 2 guarantee is tested where it can actually break.
- **Review, run in parallel on the build.** The reviewer ran 19 mutation breaks and all were caught. It still found two test gaps, fixed in 5a7c10e: `XERO_*` environment values were not in the no-leak test's forbidden list (two leak breaks passed the whole suite before the fix), and the never-synced status body was not pinned. It also asked for tokens to be seeded in the 500-path test; the lane refuted that, because they were already seeded and asserted exactly. It reported a mixed-snapshot risk (several reads outside one transaction), filed as #209 housekeeping.
- **security-auditor:** no critical findings. Warnings, all outside the fence: DNS rebinding with no Host check (existing #174, commented), HOST binding when #22 decides the production bind (commented on #22), raw Akahu error text (existing #184).
- **test-guard:** covered and gated, with three gaps, closed in 18ac40d, each shown red by a break first: `needs_reconnect` `pulledThisWeek` unpinned, `needs_reconnect` with no rows untested, and the profit and pay-run tie-breaks untested.
- **docs-syncer:** nothing stale.

## What went wrong

1. **The slice did not run the barrel test against a fence that adds a mount (Missed-by: plan).** The issue allowed a one-line mount and a fence that excluded the barrel test, which lists every mounted router and fails on an unlisted one. Cost: one Baseline decision, a wait of about four to five minutes, a mid-run fence change. No wrong code. This is the same shape as #25 (an additive migration tripping `prd02-tables.test.ts`): an addition to a set that a test pins whole. By the #25 retro's count of the "consumers" family (five), this is the sixth.
2. **The issue assumed stored sources that do not exist (Missed-by: plan).** `last_synced_at` and "last run outcome" were specified as if a column held them. The tables from #25 have none, and the sync that would write one (#66) has not landed. Cost: a second decision round, a degraded `lastRun` (always `null`) and follow-up #195. The slice was written from the PRD's Done-when text, not from the `xero_*` migration. The #25 retro recorded the missing last-sync column in its handoff to #66, so the information existed; it did not reach this issue's slicing.
3. **The build's no-leak test was weaker than it looked.** Two leak breaks, the `XERO_*` env values, passed the whole suite until review added them to the forbidden list. The reviewer's mutation run found it; the implementer's own tests did not. The record does not show why the list omitted env values, so I name no cause beyond "the list was built from token columns".
4. **A planned break could not fail (small).** The "select scopes" mutation could not turn the leak test red. The implementer found this and replaced it with an exact-SQL test instead of keeping a break that proves nothing. This is a worked-well item as much as a miss, but the plan listed a break it had not run.
5. **The spec language outran the data (two phrases).** "Paid invoice" and "this week" had no direct source. Handled by documenting the interpretation, but the interpretation is the build's, not a ruling.

## Root causes

- **Plan covers the code that changes, not the code that reads or pins it (items 1 and 2).** Same family as the #25 and #39 retros ("fence written without checking the consumers of the thing being changed"). Item 1 is the test that pins the set of mounts. Item 2 is the same slip one level up: the issue was written without reading the tables it depends on. Both are cheap to see from the repo (`rg` the barrel test; read the migration) and neither was done before the issue was cut. The researcher caught both, which is the seat doing its job, but it is the plan step that should not need a catch.
- **An upstream lane skipped its research seat, and its gap was recorded but not carried forward (item 2).** The dispatch states #25 skipped the `researcher`; the #25 retro said so and deferred the change ("do not encode yet; the record shows the gap but not a cost"). This run puts a cost on that gap: one decision round. I cannot show a researcher at #25 would have prompted a last-sync column, since #25's own plan was reviewed by three seats that did not raise it. What is shown is that the schema shipped without an answer to "where does the sync record when it last ran", and the first reader to need one found out at slicing time.
- **Mutation-checking found what example tests missed (items 3 and 4).** The leak guarantee was asserted by checking the body for forbidden strings, and a forbidden list is only as wide as its author thought of. Root cause of the gap: unclear from the record; the fix is the process that found it.
- **Item 5 has no root cause beyond the spec.** The PRD wording assumes the sync keeps history; the #25 design deliberately deletes paid documents.

## What worked, keep it

- **Researcher before architect.** Both blockers were found before a line was written, and each cost one short decision, not a rework. Compare #25, where the same class of problem was found by the red gate after the build.
- **Raising forks into Baseline and waiting.** Both answers came back in minutes and each was a small, concrete instruction (widen the fence by one word; derive from the rows, `lastRun` null).
- **Degrading honestly instead of inventing.** `lastRun` is `null`, not a guess, and #195 carries the real fix to the lane that can do it. The test suite pins that body.
- **The reviewer's mutation run, and the lane's willingness to refute a finding.** 19 breaks all caught is the headline; the two it did not catch were found by the same run. The 500-path request was checked against the test, found already satisfied, and not applied.
- **test-guard gaps proved red before they were fixed.** Each of the three new tests was run against a break first (18ac40d). A test added without watching it fail is not evidence.
- **Out-of-fence findings routed, not absorbed.** Three security warnings went to existing issues or a comment; the mixed-snapshot risk became #209. None entered this diff.

## Surfaced, not absorbed

- **#65 (connect routes):** if it mounts a second `/xero` router, the barrel test fails again. Whoever lands second composes one router.
- **`XERO_SYNC_INTERVAL_MS`** (15 minutes) is copied locally in `read.ts` until #66 exports one. If #66 changes the interval, `stale` drifts silently; the comment says to keep them in step.
- **The pay-run list is unbounded.** No cap or paging; fine for one tenant today.
- **#195** (Spawned-by #67, Missed-by plan): record sync runs and a last-sync column so `lastRun` stops being `null`.
- **#209** (housekeeping): reads in `/totals` and `/status` are not in one transaction, so a sync running between them can return a mixed snapshot.

## Recommended changes

1. **Fence and slicing checklist: for any issue that adds a mount, a migration or a table dependency, name the test that pins the whole set and put it in the fence; and for any field "read from storage", cite the column.** Sixth occurrence of the consumers family, so encode. Concretely: before an issue is cut, `rg` the barrel test for the mount list and read the migration for every column the issue's acceptance text names. Artifacts: the slicing instructions for the `architect` agent (`~/.claude/agents/architect.md`, then `pnpm import-workflow --name current`), and a short "Adding a route" note in `docs/testing.md` pointing at `server/routes/__tests__/barrel.test.ts`. High leverage; #65 and every remaining route lane meet the same test.
2. **Carry a producer's "what is not stored" list into the consumer issue.** Do not encode yet. One occurrence of the handoff not reaching a reader. If a second consumer issue is cut against a producer's tables without citing columns, add a "Reads from" line (table.column or NONE) to the issue template. Artifact if it recurs: the issue template.
3. **Leak-guard tests: when a response must never carry X, forbid X's source values (columns and env), then prove with a break that each source can turn the test red.** Do not encode yet; first occurrence. The reviewer's mutation run already catches it. If it recurs, add it to `docs/testing.md` under assertion rules.
4. **Gear 4 and the `researcher` seat: keep it required.** Not a change. This run is the case for it. If Hannah wants it written down, the gear table in `~/.claude/CLAUDE.md` is the place, but the table already lists the seat; what failed in #25 was the lane skipping it.

## Highest-leverage next step

Do Recommendation 1: add "name the test that pins the whole set, and cite the column behind every stored field" to the architect's slicing step, with the `rg` for the barrel test as the worked example. Both of this lane's decisions were questions a five-minute read of the repo answers before the issue exists, and #65 will meet the barrel test next.

## Open items for the PR body

- Fence widened by Hannah's decision (a0f32dd8): one word, `'xero'`, in `EXISTING` in `server/routes/__tests__/barrel.test.ts`.
- `lastSyncedAt` is derived from `max(synced_at / fetched_at)` over four tables; `lastRun` is always `null` until #66 (decision ac0d942a; follow-up #195, Priority: phase, prd-05 Done-when 8).
- "Paid invoice" is not countable and "this week" means present in this week's syncs; both are documented in `read.ts` and `models/xero.ts`.
- security-auditor: no critical; warnings out of fence, filed or commented (#174, #22, #184). Mixed-snapshot risk filed as #209.
- #65 mounting a second `/xero` router will fail the barrel test; the second lander composes one router.
- Gate: `npx tsc --noEmit` exit 0, `npm run lint` exit 0, `npx vitest run` 58 files / 1523 tests passed, before each commit.

## Baseline narratives

These four are the text for the retro POST (`narrative_code_type`, `narrative_built`, `narrative_how`, `narrative_wrong`).

### narrative_code_type

Two read-only Express GET endpoints over existing SQLite tables, with a typed response model and a route test suite. Gear 4, imported by the later prd-05 issues (the connect routes and the sync).

### narrative_built

`GET /api/v1/xero/totals` and `/status`. Totals sum `amount_due_cents` (still owed, not the invoice total) for receivables and payables, sum NZD alone and keep other currencies apart (Ruling 7), and return the latest profit figure and the pay runs. Status returns the connection state, a derived last-stored time, a `stale` flag (no stored row newer than two sync intervals) and what this week's syncs stored. Only `status` is ever selected from `xero_connection`, and an unconnected install returns `null` totals, not zero. `server/xero/routes/read.ts`, `models/xero.ts`, and `read.test.ts` with 42 tests; the suite is 1523 tests.

### narrative_how

The researcher ran first and found two blockers the slicing missed, each raised as a Baseline decision and answered in about four to five minutes. The architect planned and the implementer on opus built (8c70e96). The reviewer ran 19 mutation breaks and caught all of them, and found two test gaps, fixed in 5a7c10e. The security-auditor reported no critical findings and test-guard found three gaps, fixed in 18ac40d, each shown red by a break first. Docs-syncer found nothing stale. Out-of-fence findings were routed to existing issues or filed (#195, #209), not absorbed.

### narrative_wrong

The slice did not run the barrel test against a fence that adds a mount, so the one-line mount could not go green without a file outside the fence; Hannah widened the fence by one word. The issue also assumed a stored last-sync time and last-run outcome that the `xero_*` tables do not have, so `lastSyncedAt` is derived from the rows and `lastRun` is always `null` until #66 (follow-up #195). Both are Missed-by: plan, and the first is the sixth case of a fence written without checking what pins the thing being changed. The build's no-leak test also missed `XERO_*` env values until review (two leak breaks passed the whole suite), and the first planned leak break, selecting `scopes`, could not turn the test red.
