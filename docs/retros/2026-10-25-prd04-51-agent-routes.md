# Retro: #51 prd04 w2, proposals and insights have list, accept, reject and dismiss routes

## Retro summary (for the PR body)

#51 put the agents' inbox on HTTP: five routes under `/api/v1/agents` (list and accept and reject for proposals, list and dismiss for insights), plus a static test guard that no module under `server/agents/` writes money state. The final gate is green at `f00dc6e` (tsc 0, lint 0, vitest 83 files, 2798 tests). The routes were right early; the guard and the accept route's safety were not. Reviewer and security-auditor bypassed the first guard in two rounds (held builders, transaction handles, aliases; then `createRequire`, a self-HTTP `fetch`, `child_process`, seeds). Two decisions were needed from Hannah because the one category writer hardcoded `'user'` and no by-id category reader existed. A second reviewer pass found three test gaps in the stale check, all demonstrated by mutation, with no source defect.

Gear 4 as stamped, no shift. Implementer on opus. No telemetry is stated here; the lane posts the narratives after `baseline finish`.

Seats, in order: researcher, architect, implementer (opus: `0572601`, `46d050c`, `d1badaf`), reviewer (`0cb7f56`), security-auditor (`57dae08`), test-guard (10 of 10 mutations killed), docs-syncer, implementer (stale check, `4d27a88`), reviewer second pass (`f00dc6e`), this retro. Diff against the merge base (`33da9d9`): 10 files, 2698 insertions, 6 deletions: three route modules (59, 116, 218), three test files (863, 377, 860), and the planned widenings in `server/db/transactions.ts` (+29), its test (+170), `server/routes/index.ts` (+2) and `server/routes/__tests__/barrel.test.ts` (+10, -6).

Three widenings, each declared on the issue before the change: the barrel mount, `setUserCategory`'s `source` parameter (decision `3cb449c6`, Hannah picked A), and the read-only `getTransactionCategory` (decision `70b41742`, Hannah picked A). A fourth, `barrel.test.ts`, was forced by the first.

## What was built

- **Kind of code:** an Express router (`server/agents/routes/{index,proposals,insights}.ts`) mounted at `/api/v1/agents`, and a static source-guard test (`server/agents/__tests__/no-money-writes.test.ts`) that parses every module under `server/agents/` with the TypeScript compiler API.
- **Pattern:** the accept route is one transaction: `setStatus(id, 'accepted', trx)` first and require `true`, re-validate the stored category, run the stale check (refuse 409, proposal left pending, if the transaction's category moved or its `category_source` is `user`), then write through the existing `setUserCategory` with source `'rule'`. Every non-GET request on the router passes a same-site check once, at the router level, so a write route added later is covered. The guard flags writes, not names: agents may read `transactions`, but any knex write must start at an inbox-table literal, and imports of writers, drivers, module loaders, the network, child processes and the file system are banned.
- **Why this shape:** one real alternative was contested. Accept could have had its own category writer. Hannah chose to extend `setUserCategory` with a `source` argument (default `'user'`, so `PATCH /transactions` is unchanged), so there is one category writer, not two. Ruling 7 trimmed the issue: `category_source` is always `'rule'`, `GET /agents/usage` is void and was not built, and the "few-shot" criterion was read as "a rejected pair is never re-listed and a re-proposal is refused".

## What went wrong

1. **The only category writer hardcoded `'user'`.** The issue said to reuse it, the fence excluded `server/db/transactions.ts`, and reusing it as-is would have marked an agent's category as the user's own, which prd-01 Ruling 4 forbids. It needed a decision (`3cb449c6`). Cost: a raised decision, a regression test committed first (`0572601`, "no source writes user"), then the change (`46d050c`). The order was right; the cost was the wait. The fence was written without reading the writer it told the lane to reuse.
2. **The stale check needed a by-id category reader that did not exist.** Also outside the fence; a second decision (`70b41742`). The first build left the check as a placeholder (`// #51: stale check (decision pending)`), so the accept route first landed in `d1badaf` without it and the check arrived in `4d27a88`. Whether building ahead was cheaper than waiting is unclear from the record. The visible cost is item 6.
3. **Mounting `/agents` broke `barrel.test.ts`.** Its exact-set check (`the barrel mounts exactly the existing and placeholder routers`) goes red on any new mount, so the lane added `'agents'` to `EXISTING`. This is the same forced move as #44, #46 and #49. Open PR #251 (#49) edits the same line and has since merged, so this branch has a one-word rebase conflict that the conductor resolves at merge. The conflict is the new cost; the forced widening was predictable.
4. **The first guard was bypassable, twice.** The reviewer found that it did not follow a held builder (`const q = db('transactions'); q.update(...)`), a transaction handle (`trx.insert(row).into(...)`), `schema`, `migrate` and `seed` calls, or aliases. Fixed in `0cb7f56`. The security-auditor then got through with `createRequire` and `module`, `getBuiltinModule`, a self-HTTP write via `fetch` (the app's own port, which is reachable and has no auth), `child_process`, `fs`, and importing seeds or migrations. Fixed in `57dae08`. Two fix rounds, both confined to the guard test (`0cb7f56` +133/-12 across two files, `57dae08` +195/-11 in one). The first guard was already on the compiler API, as #31's retro recommended; a parser does not help when the rule it checks is a list of shapes the author thought of.
5. **docs-syncer edited a file outside the fence.** It changed `docs/akahu-pending-semantics.md`, because my brief told it to sync any doc the change touched and did not name the files it could write. I reverted it and surfaced the point as a follow-up. No cost to the diff; the brief was the cause.
6. **The second reviewer pass found test gaps in the stale check.** In `4d27a88`, the "category moved to a non-user value" case was covered only through a row whose source was `user`, so the test would pass if the category-moved branch were deleted. The reviewer deleted it and the test stayed green. Same pass: the refusal order was unpinned, and the exempt reader `getTransactionCategory` was exempt from the guard without a test that it only reads. All three were EXECUTED by mutation and fixed in `f00dc6e`. Source defects found: none. The tests had a hole where the new branch was, written by the seat that wrote the branch.
7. **A mutation survives as a no-op.** S1 (dropping `?? null`) is not a gap in the tests. Step 6's `undefined` branch became unreachable once the check moved into the same transaction, and it is kept only for type narrowing. Left in on purpose, noted here so nobody chases it.
8. **Baseline seats probably dangle.** This is the known hand-back bug, not something this lane did. I have not seen the final Baseline state for this run, so this is likely, not confirmed. Nothing was hand-stated.

## Root causes

- **A guard checks the shapes its author imagined (item 4).** Second prd-04 retro in a row: #31's regex guard was bypassed four ways, and this AST guard was bypassed in two rounds by a different set of shapes. The common cause is that a static guard is a list of known write paths and no one lists the paths first. Each reviewer found the next path by trying one: a held builder, `fetch`, `createRequire`. The guard also has limits it cannot close and says so: table names built at run time, writers in new top-level folders, and a reader that calls another writer. A guard is a tripwire and not a wall. Recurrence: this is the second occurrence, so the #31 retro's rule (encode on the second) now applies. See change 1.
- **The fence was written without opening the code it fenced (items 1, 2, 3).** All three widenings were knowable by reading `server/db/transactions.ts` and `barrel.test.ts` before slicing. The issue said "reuse the category writer" and listed no file for it. The barrel move has now happened in four issues in a row. Same family as #31's "fence predicts its own breach"; recurrence confirmed.
- **A brief that restates the task wider than the task (item 5).** The docs-syncer brief named no writable files. #31's review-fix brief overreached the same way (the guard scope). Second occurrence of one cause, in two different seats. The implementer's check against the issue saved #31; here nothing checked until I read the diff.
- **A test written with the branch it tests has the same blind spot (item 6).** The author covered the moved-category case through the nearest convenient row, and the author's own tests passed. Review found it only because the reviewer deleted the branch. Same family as #31's "plan accepted on reading": the missing case came out only when someone ran one adversarial input. Two retros in a row.
- **Item 2 (build ahead of a decision):** unclear. The record shows the placeholder and the later fix but not what waiting would have cost.
- **Item 8:** the known Baseline hand-back bug, outside this lane.

## What worked, keep it

- **Both decisions went to Hannah, not into the diff.** The category writer and the by-id reader each had two designs with different consequences. Each was raised into Baseline with the widening declared on the issue before the change. Nothing was absorbed.
- **The regression test went first** (`0572601`), green on the old behaviour, then the change, so `PATCH /transactions` staying on `'user'` is shown, not argued.
- **Review seats were told to execute, and they did.** The reviewer and security-auditor each broke the guard with a concrete input; the second reviewer pass found its three gaps by mutation. Findings arrived as demonstrations, and each fix is its own commit (`0cb7f56`, `57dae08`, `f00dc6e`), so the response is readable apart from the build.
- **The security-auditor changed the design, not just the code.** It showed that comparing categories alone lets accept overwrite a category Hannah set by hand to the same value. That became the `category_source = 'user'` refusal in `4d27a88`. A same-value comparison would have passed every test the author had.
- **`test-guard`: 10 of 10 mutations killed** on the routes.
- **Router-level same-site check.** One `router.use` covers every non-GET, so a write route added later is protected without remembering.
- **Follow-ups named, not folded in** (below).

## Recommended changes

1. **Source guards start from a corpus of bypass classes (encode now; second occurrence).** Add a "Source guards" section to `docs/testing.md` listing the classes found across #31 and #51: held builders, transaction handles, aliases, `schema`, `migrate` and `seed` calls, module loaders (`createRequire`, `module`, `getBuiltinModule`), the network (`fetch`, `http`, `net`), `child_process`, `fs`, seeds and migrations as imports, and the three known limits. A new guard writes one failing fixture per class before its rule. High leverage: it turns the next guard's two fix rounds into zero. Artifact: `docs/testing.md`.
2. **Router-mount issues list `server/routes/__tests__/barrel.test.ts` in the fence (encode now; fourth occurrence).** The cheaper fix is to stop the test failing on a new mount at all, by deriving `EXISTING` from the barrel's actual mounts. If that is wanted, it is its own issue. Until then, any issue that mounts a router must list the barrel test and its `EXISTING` line. Artifact: the slicing checklist the conductor uses for issues (I did not find a template in the repo, so it belongs wherever the conductor's issue-slicing notes live), plus `docs/testing.md` for the barrel test's purpose.
3. **Every seat brief names the files the seat may write (encode now; second occurrence).** For docs-syncer, "docs the change touches" is not a scope. List the doc paths. Artifact: the `docs-syncer` agent file's brief template in the workflow import; Baseline-side, so it goes through `pnpm import-workflow`.
4. **Fences are checked against the code they say to reuse.** If an issue says "reuse X", the fence names X's file. Do not encode a new rule yet beyond change 2; one more occurrence of a missing file in a fence and it goes in the slicing checklist.
5. **A test for a new branch is checked by deleting the branch.** First occurrence of this exact shape in my reading. Do not encode; if it recurs, add it to the implementer's test step. Here the reviewer's mutation did the job, so the loop works as is.

## Highest-leverage next step

Write the "Source guards" section in `docs/testing.md` (change 1). #42 and #58 write under `server/agents/`, so they sit under the guard from this PR; the next guard anyone writes (the `mcp/` import rule, the scrubbed-replica allow-list) will otherwise repeat the same two rounds. It is a doc edit, outside this lane's fence, for the conductor.

## Open items for the PR body

- **Void Done-when:** `GET /api/v1/agents/usage` is void (Ruling 7) and was not built.
- **Rebase:** PR #251 (#49) edits the `EXISTING` line in `barrel.test.ts`; one-word conflict, resolved by whichever merges second.
- **Follow-ups surfaced (to file; each needs a `Priority:` line):**
  - W3: DNS rebinding; add a Host allowlist.
  - S1: `PATCH /transactions` and `PUT`/`PATCH /settings` lack a same-site check; hoist `fromThisSite`.
  - S3: insight text length caps; the client must treat `body_md` as untrusted.
  - S4: `err.stack` and full errors are logged in `server/server.ts` and `server/routes/transactions.ts`.
  - #42's learner must count only `source = 'user'` corrections, or accepted proposals reinforce themselves.
  - `CLAUDE.md` line 49 should name the accept-route exception (agents write only inbox tables, except accept calling `setUserCategory`).
  - `docs/akahu-pending-semantics.md` section 5 should name accept as a second `setUserCategory` caller.
  - Duplication: `fromThisSite` in three places, `parseId` in four, `snapshotTables` in four.
  - Move `AcceptProposalResponse` to `models/`.
  - `GET /proposals` carries no transaction details for the pill.
  - Same-category proposals are allowed.
  - Guard limits: run-time table names, writers in new top-level folders, and a reader that calls another writer.
- **Baseline:** seats likely dangle (the known hand-back bug). Nothing hand-stated.
- Gate: tsc 0, lint 0, vitest 83 files, 2798 tests at `f00dc6e`.

## Baseline narratives

### narrative_code_type

An Express router with five routes under `/api/v1/agents` (proposals: list, accept, reject; insights: list, dismiss), plus a static test guard built on the TypeScript compiler API that no module under `server/agents/` writes money state. Gear 4, so later prd-04 agents sit under the guard.

### narrative_built

Route modules in `server/agents/routes/`, mounted from `server/routes/index.ts`, with 2698 lines added across 10 files. Accept is one transaction: status first, re-validate the category, a stale check that refuses 409 and leaves the proposal pending if the category moved or was set by hand, then `setUserCategory` with a new `source` argument set to `rule`. A same-site check covers every non-GET on the router. Gate: tsc and lint clean, vitest 83 files and 2798 tests.

### narrative_how

Researcher, architect, then an opus implementer, with the regression test committed before the `setUserCategory` change. Two genuine forks went to Hannah as decisions: extend the one category writer with a `source` argument, and add a read-only by-id category reader for the stale check; she picked A both times. The reviewer and security-auditor each ran on the working diff and each fix is its own commit. Test-guard killed 10 of 10 mutations, docs-syncer ran, then a second implementer pass added the stale check and a second reviewer pass followed.

### narrative_wrong

The first no-money-writes guard was bypassable. The reviewer got through with held builders, transaction handles, schema calls and aliases, and the security-auditor then got through with `createRequire`, a self-HTTP `fetch`, `child_process` and seeds, so it took two fix rounds. The only category writer hardcoded `'user'` and no by-id reader existed, both outside the fence, so two decisions were needed. Mounting `/agents` broke `barrel.test.ts` for the fourth issue running, and PR #251 now conflicts on that line. docs-syncer edited a file outside the fence because the brief was too broad; I reverted it. The first build left the stale check as a placeholder, and the second review pass found three test gaps in it, all shown by mutation, with no source defect. Baseline seats likely dangle (the known bug); nothing was hand-stated.
