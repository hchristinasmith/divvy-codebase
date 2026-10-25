# Retro: #31 prd04 w1, the agent inbox tables and their typed accessors

## Retro summary (for the PR body)

#31 added the three tables the background agents write to (`category_proposals`, `insights`, `agent_runs`) and one typed accessor module per table under `server/agents/db/`. The final gate is green (tsc 0, lint 0, vitest 78 files, 2494 tests). The code is right; the first build was not. Review found a real data-loss bug in the processed-sync-run design, the security-auditor showed that knex errors leaked merchant text, and the source guard that keeps writers inside the three inbox tables was bypassable four ways. All three were fixed in `b98ac8d`. A fourth round, `791a979`, existed only because the review-fix brief asked for a guard wider than the issue allows.

Gear 4 as stamped, no shift. Implementer on opus throughout. No telemetry is stated here; the lane posts the narratives after `baseline finish`.

Seats, in order: researcher, architect, implementer (opus, `4d83f51` migration, `ae99c7a` accessors), reviewer, schema-reviewer and security-auditor in parallel, implementer (review fixes, `b98ac8d`), implementer (guard scope, `791a979`), test-guard and docs-syncer in parallel, this retro. Diff against the merge base (`a0a6249`): 9 files, 2524 insertions, no deletions: the migration (166), three accessors (165, 163, 189), four test files (631, 557, 310, 328), and a 15-line `GUARDS` entry in `server/db/__tests__/migration-guards.test.ts`.

## What was built

- **Kind of code:** one migration (`20261025160000_agent_inboxes.js`) and three typed data accessors (`proposals.ts`, `insights.ts`, `agent-runs.ts`). Each accessor can write only its own table. The accessors reuse the validators from #26 (`parseProposedCategory`, the chart spec validator), so a bad row is refused before SQL.
- **Pattern:** an inbox table with the invariant in the schema, not in the code. The unique `(transaction_id, proposed_category)` index makes the insert a no-op in every status, so a `rejected` row is permanent suppression without a read-before-write. Integer and real columns carry `typeof()` CHECKs because SQLite affinity stores `12.5` in an INTEGER column rather than refusing it. A `scrubbed` wrapper rethrows DB errors as SQLite's own words, never the SQL. The write boundary is checked by a test that parses `server/agents/db/**` with the TypeScript compiler API.
- **Why this shape:** two designs were genuinely contested. `category_proposals.transaction_id` is CASCADE, not RESTRICT: sync's `replacePending` deletes every pending row each run, so RESTRICT would throw on the first pending row with a proposal and wedge sync for good. The cost is on the category agent, which must propose on settled rows only. `agent_runs.sync_run_id` is NO ACTION, so a delete of a sync run fails loudly instead of erasing a run's record. There is no `mermaid` column on `insights`; Ruling 3's optional text has nowhere to live yet.

## What went wrong

1. **The approved plan chose a high-water mark for processed sync runs, and it loses data.** The architect's plan, approved by the conductor, had `lastProcessedSyncRunId`. The reviewer EXECUTED the failure: a failed sync run 1 is hidden forever once sync run 2 succeeds, because the mark has moved past it. The fix (`b98ac8d`) is `processedSyncRunIds`, which returns a set. Cost: one review-fix round and a rewrite of the agent-runs accessor and its tests. The plan seat missed it, and so did the conductor who approved the plan. The Done-when does not ask for a mark or a set; this was a design choice made without a check against the failure case.
2. **DB errors echoed row text.** Knex puts the full SQL, bound values included, in its error message. A refused write therefore carried merchant text in the thrown message, and `reason` is merchant text. The security-auditor EXECUTED it. The accessors never echoed a value in their own validation errors; the care covered the code the author wrote and not the library under it. Fix: the `scrubbed` wrapper, applied to every write.
3. **The first source guard was regexes, and the auditor bypassed it four ways.** A URL on the same line, double-quoted imports, side-effect imports, and `db['raw']` all got through. The guard was rebuilt on the TypeScript compiler API in `b98ac8d`. A guard written to catch an adversary's shape needs a parser; a regex only catches the shapes the author imagined.
4. **`listRuns` accepted a negative limit.** SQLite treats a negative `LIMIT` as no limit, so a negative limit would return the whole table. It was fixed in review; a limit guard was added.
5. **The review-fix brief overreached the issue.** The conductor's brief told the implementer to widen the guard to all of `server/agents/`. The Done-when names the accessor modules only. Widening would have blocked every w2 agent, which must read `transactions`. The implementer surfaced the conflict instead of applying it, and `791a979` narrowed the guard to `server/agents/db/**`. Cost: one extra fix round. The implementer's refusal to just comply is what kept it at one round.
6. **The issue body was stale.** It still described a `UsageStore` and model, token and cost columns. Ruling 7's comment (no model calls) superseded it, so the "UsageStore total-for-day" Done-when is void. The lane brief carried the amendment, so no work was lost, but the issue itself still reads wrong to anyone arriving cold.
7. **The fence said "modifies nothing" and the lane had to touch `migration-guards.test.ts`.** Its first test fails on any unguarded CASCADE foreign key, so the new CASCADE needs a `GUARDS` entry. The researcher predicted this and the lane brief allowed it as reconciliation. No cost, but the fence as written in the issue was wrong from the start.
8. **The implementer fast-forwarded the branch onto origin/main (#46) without asking.** Harmless: the branch was clean, the move was a fast-forward, and the merge base is `a0a6249`. It is still an unrequested history change.
9. **Baseline recorded every seat as dangling** (started, never completed). This is the known hand-back bug, not something this lane did. Nothing was hand-stated into any row.

## Root causes

- **Approving a plan without running its failure case (items 1, 3, 4).** The high-water mark, the regex guard and the negative limit have one source: a design that works on the happy path and was accepted on reading. In each case the reviewer or auditor found the bug by executing one adversarial input. Same family as #26's size estimate, where the author's tests pinned one side of a boundary; here the missing case was "a failed run before a successful one", "a URL on the line", "limit -1". Recurrence: this is the second prd-04 retro in a row where review, not the author's tests, found the gap.
- **Care that stops at the code you wrote (item 2).** The accessors scrubbed their own error messages and not the driver's. The class of bug is "a library's error text carries the input". Nothing in the plan or the tests asked what a refused write throws.
- **A brief that restates the issue wider than the issue (item 5).** The review-fix brief was written from the finding ("the guard is bypassable") and not re-read against the Done-when. The implementer's check against the issue was the safety net. First occurrence in what I read.
- **Stale issue body after a ruling (item 6) and a fence that predicts its own breach (item 7).** The fence is written before the researcher runs; the researcher then finds a file the fence did not account for. The lane brief reconciles it, but the issue stays wrong. Cause: the issue is not updated when a ruling or the researcher changes the scope. I did not check whether this recurs.
- **Item 8:** unclear. The record does not show why the implementer moved the branch.
- **Item 9:** the known Baseline hand-back bug, outside this lane.

## What worked, keep it

- **Review seats in parallel, each told to execute.** Reviewer, schema-reviewer and security-auditor ran together on the working diff. The two real findings (the lost failed run, the leaked SQL) were both demonstrated, not argued. Review fixes got their own commit (`b98ac8d`), so the response is readable apart from the build.
- **The implementer surfaced the brief's overreach.** It did not widen the guard and break w2. It reported the conflict, and the conductor narrowed it. That is the fence working in the direction it should.
- **Schema-reviewer signed off all three Done-when schema items** (CASCADE and NO ACTION reasoning, the unique key, the `typeof()` CHECKs). The migration's header comment records each choice and its consequence, including "never rebuild `transactions` or `sync_runs`" and "never INSERT OR REPLACE a proposal", so w2 inherits the reasons, not just the schema.
- **`test-guard`: 33 mutations, 32 killed.** The survivor, M22 (the `latestRun` id tiebreak), is equivalent: no input can tell the two versions apart.
- **The researcher predicted the `migration-guards` reconciliation** before the build, so item 7 cost nothing.
- **Follow-ups filed or named, not absorbed** (below).

## Recommended changes

1. **Plan check: for each stored cursor or mark, name the failure case it must survive.** Do not encode yet; one occurrence of this exact shape, though the family (plan accepted on reading) is now in two retros. If a third appears, add a line to the architect's plan template in the workflow skills ("for every design choice that discards information, state the input that would be lost"). Here the cost was one fix round.
2. **Review-fix brief: check it against the Done-when before sending.** Do not encode yet; first occurrence. If it recurs, add one line to the conductor's review-fix handoff in the `parallel-agents` skill: "a fix that widens a guard or a rule is checked against the issue's fence first".
3. **Wrapper for library errors, as a convention.** `scrubbed` exists in `server/agents/db/proposals.ts`. The next accessor module that writes merchant text (w2 and later) should import it, not re-solve it. Not a rule yet; w2 is the second use.
4. **Source guards parse; they do not grep.** The compiler-API guard in `server/agents/db/__tests__/proposals.test.ts` is the pattern. If another guard is written, add a sentence to `docs/testing.md`; until then it is one example.

## Highest-leverage next step

Fix the stale passages in `docs/prds/prd-04-background-agents.md`: Ruling 2 and the In-scope lines 38, 44, 92 and 131 still say "usage log", token budget and cost, which Ruling 7 removed. The same PRD text misled #26 and left #31's issue body wrong. A lane that reads the PRD in w2 will plan against the dead scope again. This is a doc edit for the conductor, outside this lane's fence.

## Open items for the PR body

- **Void Done-when:** "UsageStore total-for-day" is void; Ruling 7 superseded it. `UsageStore` and the model, token and cost columns do not exist and should not be added.
- **`AgentRun` type** lives in `server/agents/db/agent-runs.ts` because `models/` was outside the fence. Follow-up: move it to `models/`.
- **Follow-ups the next issues must honour:**
  - #215 (eslint boundary) clashes with the accessors importing `connection`; resolve before the boundary rule lands.
  - #42 (category agent) must propose on settled rows only, because of the CASCADE, and has no cursor reader yet.
  - #58 must use `processedSyncRunIds` (a set), never a high-water mark.
  - #51 (accept route) must call `setStatus` first in its transaction and re-validate the category.
  - #76 and #132: the scrubbed replica's allow-list must exclude the three inbox tables.
- **Stale PRD text:** prd-04 Ruling 2 and In-scope lines 38, 44, 92 and 131 still say "usage log".
- **Branch:** fast-forwarded onto origin/main (#46) by the implementer; merge base `a0a6249`.
- **Baseline:** every seat shows dangling (the known hand-back bug). Nothing hand-stated.
- Gate: tsc 0, lint 0, vitest 78 files, 2494 tests.

## Baseline narratives

### narrative_code_type

A SQLite migration plus typed data accessors: three inbox tables (`category_proposals`, `insights`, `agent_runs`) and one write-only-its-own-table accessor module for each, under `server/agents/db/`. Gear 4, imported by every later prd-04 agent issue.

### narrative_built

Migration `20261025160000_agent_inboxes.js` and the accessors `proposals.ts`, `insights.ts` and `agent-runs.ts`, with 2524 lines added across 9 files. Proposals are unique on `(transaction_id, proposed_category)`, so a rejected pair suppresses itself for good; the foreign key to transactions is CASCADE because sync deletes pending rows every run, and `agent_runs.sync_run_id` is NO ACTION. Integer and real columns carry `typeof()` CHECKs. Processed sync runs are read as a set. A `scrubbed` wrapper keeps SQL and row text out of thrown errors, and a compiler-API test guard confirms `server/agents/db/**` writes only the three inbox tables. Gate: tsc and lint clean, vitest 78 files and 2494 tests.

### narrative_how

Researcher, architect, then an opus implementer built the migration and accessors in two commits. Reviewer, schema-reviewer and security-auditor ran in parallel on the working diff; the implementer fixed their findings in a separate commit, and one more small commit narrowed the guard scope. Schema-reviewer signed off all three schema Done-when items. Test-guard ran 33 mutations and 32 were killed; the survivor is equivalent. Docs-syncer ran alongside. One existing test file, `migration-guards.test.ts`, was touched on purpose, because its first test fails on any unguarded CASCADE foreign key; the researcher had predicted it. The follow-ups were filed or named rather than folded in.

### narrative_wrong

The architect's plan, approved by the conductor, chose a high-water mark for processed sync runs, and review showed a failed run 1 is hidden forever once run 2 succeeds; the plan seat missed it, so the design became a set. Knex errors had echoed full SQL with merchant text, found by the security-auditor, and the first regex source guard was bypassed four ways, so it was rebuilt on the compiler API. A negative `LIMIT` in `listRuns` meant "no limit". Then the conductor's review-fix brief asked for a guard over all of `server/agents/`, wider than the issue's Done-when and one that would block w2; the implementer surfaced it, which cost one extra fix round. The issue body was stale after Ruling 7, the fence said "modifies nothing" yet a test file had to change, and the implementer fast-forwarded the branch unprompted (harmless). Baseline recorded every seat as dangling, the known hand-back bug; nothing was hand-stated.
