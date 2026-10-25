# Retro: #155 housekeeping, the Akahu client dropped fields Ruling 4 says are stored in full

Gear 3 as stamped; no shift. The implementer ran on opus at effort high. Housekeeping milestone, `Spawned-by: #21`, `Missed-by: plan`. One file was added to the fence mid-run: a single five-value hunk in `server/sync/__tests__/run.test.ts` (lane #169's file), allowed by Hannah on a Baseline decision. This retro file is in the fence (`docs/retros/`, added by the handoff). It states no telemetry (model, duration, tokens, tool calls); the lane posts the four narratives after `baseline finish`.

Seats run, in order: architect, implementer (phase A), reviewer (A), implementer (phase B), reviewer (B), security-auditor (A and B), test-guard, docs-syncer, this retro. Verify passed on the final state, HEAD 666ef6c: the gate ran twice on that exact tree (the lane before committing 666ef6c, test-guard afterwards on a clean tree). `npx tsc --noEmit` exit 0, `npm run lint` exit 0, `npx vitest run` 58 files / 1563 tests passed. PR #189 (#169) merged mid-lane; the rebase was clean and `run.test.ts` did not conflict.

Commits (`git log --oneline origin/main..HEAD`): 9afeffe (characterisation tests), 3b2ad95 (transaction fields), 3c37c84 (account fields), 666ef6c (review fix).

## What was built

- **Kind of code:** a widening of the Akahu sync path in `server/sync/`: new optional fields on the client's typed output (`akahu-client.ts`, `types.ts`), the mapping into existing columns (`upsert.ts`), two fixtures, and two test files (`full-fields.test.ts`, 586 lines, plus 465 lines added to `akahu-client.test.ts`). 8 files, 1338 insertions.
- **Pattern:** every new field is optional on read and NULL when absent, so a field Akahu stops sending is cleared on the next run. Settled and pending rows share one `detailFields()` helper. Transactions gain `conversion_amount_cents`, `conversion_currency`, `conversion_rate`, `card_suffix` and `merchant_logo`. Accounts gain `attributes` (JSON text, Akahu's order kept), `connection_type`, `connection_logo`, `authorisation_id` and `credentials_id`.
- **Why this shape:** the conversion rate is the one contested choice. `akahu-client.ts` is banned from using `Number(` by its own test, so the rate travels as decimal text and becomes a number in `upsert.ts`. The architect found by execution that the reverse breaks idempotence: SQLite's float column never equals the incoming text, so every run would rewrite every converted row.

## What happened

- The architect established two facts by running them, not by reading. `conversion_currency` is a float column (2025 migration). SQLite keeps `'USD'` as text but silently turns `'978'` or `'1e3'` into a real. That is why the client accepts only a three-letter code (`/^[A-Z]{3}$/`) and fails closed on anything else. The second fact is the rate-as-text decision above.
- The work was split. Phase A (transactions) was unblocked, so the lane built and reviewed it while the account half waited on a decision. Phase B (accounts) started when Hannah answered. The lane's estimate was that building straight through would have idled it about 25 minutes.
- **Decision 1:** `posted_date` and `merchant.nzbn` have no column. Hannah chose to store them through a migration, filed as #191 (gear 4), not to add a column here. The Done-when line "either a migration adds columns, or a prd-01 note says they are deliberately not stored" is met by the filed migration, not by this diff.
- **Decision 2:** storing account fields turns `run.test.ts:224-230` red. That test pinned the bug itself (`attributes: '[]'`, the four id and type columns `null`) and sits in lane #169's file. Hannah allowed one hunk: five expected values changed. The first `baseline decide` raise was refused with `options/1/fence must be object` because a string fence was sent. The lane moved the fence text into `costs` and the second raise went through.
- Characterisation first. 9afeffe pins how sync already follows optional fields (two runs over unchanged fixtures write nothing; a dropped `merchant.website` or `meta.logo` goes back to NULL) and is green on the old code. The new fields were then held to the same rule.
- Review and the other seats:
  - **reviewer A:** 0 defects, 8 mutations, all caught.
  - **reviewer B:** 1 defect, 13 mutations. Its sort mutation on stored `attributes` survived all 328 sync tests, because every fixture list was already in sorted order. Fixed in 666ef6c by a test that gives `attributes` out of alphabetical order and checks the stored text keeps Akahu's order.
  - **security-auditor (both phases):** nothing critical. W1: a malformed conversion fails closed (the three-letter rule above). W2: logo URLs are stored without validation, filed as #193.
  - **test-guard:** 23 mutations killed, Done-when 1 met.
  - **docs-syncer:** no comment inside the fence is now false. Three spots in `docs/akahu-pending-semantics.md` are stale, but the file is outside the fence; filed as #194 (its section 6).
- Follow-ups, each with an origin line: #191 (`posted_date` and `nzbn` migration, gear 4), #192 (conversion currency minor units: JPY would be stored as hundredths, and a three-decimal amount fails the whole sync), #193 (https check on stored logo URLs before any render; its comment list adds `connection_logo`), #194 (docs section 6).

## What went wrong

1. **The fence missed a test that pins the old behaviour, and a doc that describes it.** The issue's fence was `server/sync/` only. Storing the account fields necessarily turned `run.test.ts` red, and the same change falsified `docs/akahu-pending-semantics.md`. The first cost a Baseline decision and a blocked phase B; the second cost a follow-up (#194). Neither was found at slicing. The issue body even says "the first-run test confirms the columns stay NULL" as its evidence, so the pinning test was named in the issue and still left out of the fence. Nothing reached main broken: the architect and the first red run found both before commit.
2. **A mutation that sorted the stored attributes survived 328 tests.** The fixture lists were already sorted, so the tests could not tell sorted from unsorted. Only reviewer B tried it. The implementer's own break-and-watch pass did not use an out-of-order input. Cost: one review fix (666ef6c, 16 lines of test), small.
3. **The decision file failed validation once.** The lane sent `fence` as a string where the schema wants an object. It was refused with `options/1/fence must be object`, and the retry (fence text moved into `costs`) went through. This is the second time this exact error has appeared; #39's lane hit `options/0/fence must be object` with an array.
4. **Two questions the issue should have answered went to Hannah as decisions.** Whether `posted_date` and `nzbn` get columns, and whether the lane may touch `run.test.ts`, were both visible from the issue text and a read of the schema. Cost: two raises and a wait on the second. Neither is a lane mistake. It is the same slicing gap as item 1.

## Root causes

- **Fence written without checking the consumers of the thing being changed (item 1; fifth occurrence).** Earlier cases were #68 and #78 (build and test config), #19 (the seed) and #39 (a test of the seed). The consumers this time were a test that pins the old value and a reference doc that maps the dropped fields. The issue was sliced from reviewer finding F5 of #21, which was marked REASONED. Nobody ran the finding's own evidence ("the first-run test confirms the columns stay NULL") to see which test that was. The plan covers the code that is changing and not the code and docs that read or pin it. #39's retro recommended a grep of the dropped name over the repo at slicing time; the record I read does not show that landing, and this repeat says it did not.
- **A test that pins a bug as expected output is invisible to a fence.** This is a variant worth keeping apart: `run.test.ts:224-230` asserted `'[]'` and `null` as correct, so fixing the bug fails the gate. A fence built from the production files cannot see it. The place to find it is the issue's own evidence line, or a grep for the old values in `__tests__/`.
- **Author's list versus the reach of the mutation (item 2).** Same family as #39 item 2 and the earlier "author's list" retros: the implementer mutated what it thought of, and a reviewer found the order case. Here the cause is narrower: fixtures that were already in sorted order cannot detect a sort.
- **Decision-file shape (item 3).** Second occurrence, one retro apart. Cause: the schema's shape for `fence` is not shown anywhere the lane reads. In both cases the error named the field and the retry worked.

## What worked, keep it

- **Characterisation tests committed first, green on the old code (9afeffe).** The new fields were then held to a rule already shown to hold. The lane did not have to argue what "optional" means for each field.
- **The architect executed the SQLite and client-test constraints before the build.** The float column, the three-letter rule and the rate-as-text decision all came from running them. None was reopened in review.
- **Splitting the work into phase A and phase B.** The unblocked half was built and reviewed while the decision was pending, about 25 minutes the lane did not idle.
- **Raising both forks through Baseline.** Hannah's answers are on the record: store `posted_date` and `nzbn` through #191, and one hunk in `run.test.ts`. The out-of-fence change is five values, and nothing else in that file moved. The rebase onto #169's merge was clean.
- **Reviewers who run the code.** 21 mutations across the two reviewers, and 23 more from test-guard. The sort mutation came from execution, not reading.
- **Fail closed on a malformed conversion** (security-auditor W1), so a bad Akahu value cannot reach the float column as a wrong number.
- **Surfacing, not absorbing.** Each of the items below went to a follow-up or a note and not into the diff.

## Surfaced, not absorbed

- `models/transactions.ts` types `conversion_currency` and `conversion_rate` as `number`, and `card_suffix` and `merchant_logo` as non-null. That is #133 item 3, outside the fence.
- No length caps on the `optionalText` fields (security S1).
- `card_suffix` format is unchecked (security S2).
- test-guard suggestions not taken: a key-set check on a column-selected row is vacuous, and the currency `typeof` branch is not tested on its own.
- Docs: three stale spots in `docs/akahu-pending-semantics.md` (#194).

## Recommended changes

1. **Slicing and architect fence step: for any issue that makes a stored column non-NULL, or otherwise changes an output a test asserts, grep `__tests__/` for the old value and grep `docs/` for the field names, and put every hit in the fence or on a named owner.** Fifth occurrence of one cause, so encode it now; do not wait for a sixth. It is the same recommendation as #39's item 1, widened from "dropped name" to "old expected value". Artifacts: `~/.claude/agents/architect.md` (fence checklist, imported to Baseline) and the conductor's issue-slicing checklist. High leverage.
2. **When a follow-up issue cites a reviewer finding as its evidence, the slicer runs that evidence before writing the fence.** The finding said "the first-run test confirms the columns stay NULL"; running or opening that test would have named `run.test.ts`. Artifact: the slicing checklist, one line. High leverage, cheap. It is a specific case of item 1 and can be one rule with it.
3. **Mutation lists include order and duplicates for any stored list, and fixtures for a list are not given in sorted order.** First occurrence for the order case, so do not encode it yet. If it recurs, add it to the implementer's break-and-watch step (`~/.claude/agents/implementer.md`).
4. **Show the `fence` shape in the decision-file template.** Second occurrence (#39, #155) of the same schema refusal. Artifact: the decision-file template or `baseline decide --help` text, whichever the lane reads. Low cost; an example of one option with a `fence` object is enough.
5. **Docs-syncer already found the stale doc; the lane has no way to fix it inside the fence.** A rule that a doc named in `docs/` as a reference for the area is in the fence of any gear 3 issue touching that area would have avoided #194. Optional for now. It follows from item 1 if item 1 puts doc hits in the fence.

## Highest-leverage next step

Do Recommendation 1 with Recommendation 2 folded in: add to the architect's fence checklist (`~/.claude/agents/architect.md`) and to the conductor's slicing checklist a required step. For every issue that changes what is stored or returned, grep the tests for the old expected value, grep `docs/` for the field names, run any evidence the issue cites, and put each hit in the fence or give it an owner. This is the fifth lane in which a fence missed a reader of the changed thing. #39 asked for it and the repeat shows it did not land.

## Open items for the PR body

- `posted_date` and `merchant.nzbn` are not stored here. #191 (gear 4) adds the columns and mapping, per Hannah's decision.
- One hunk in `server/sync/__tests__/run.test.ts` (five expected values, lines 224-230) changes, by Hannah's decision, because that test pinned the old NULL and `'[]'` values. #169's PR #189 had already merged and the rebase was clean.
- Follow-ups: #191, #192, #193, #194. Each names its origin and its `Priority:` line.
- `docs/akahu-pending-semantics.md` is stale in three places and was left alone (outside the fence).
- Fixture values are invented.

## For Baseline (four fields)

- **narrative_code_type:** a widening of the Akahu sync path in `server/sync/`: optional fields on the client's typed output, their mapping into existing columns, two fixtures and two test files.
- **narrative_built:** sync now stores the fields Akahu sends that Ruling 4 says are kept in full and that already had columns. For transactions that is the conversion amount, currency and rate, the card suffix and the merchant logo, on settled and pending rows. For accounts it is the attributes (in Akahu's order), connection type, connection logo, authorisation id and credentials id. A field Akahu stops sending is cleared to NULL. The conversion rate travels as decimal text and becomes a number in `upsert.ts`, so a second run over the same data writes nothing. A conversion currency must be three letters, and anything else fails closed. The final gate is green: `tsc` and lint clean, 1563 tests passing.
- **narrative_how:** the architect ran the SQLite float-column behaviour and the client test's `Number(` ban before the build. Characterisation tests that pin how sync treats optional fields went in first, green on the old code. The work was split into transactions (phase A) and accounts (phase B), so the first half was built while a decision was pending. Two decisions went to Hannah through Baseline. `posted_date` and `merchant.nzbn` get a migration in follow-up #191. One five-value hunk in `run.test.ts` was allowed, because that test pinned the old NULL values. Two reviewers, a security-auditor, test-guard and docs-syncer ran. The one review defect is fixed in its own commit.
- **narrative_wrong:** the issue's fence (`server/sync/` only) left out a test that pinned the bug as the expected output and a reference doc that describes the dropped fields. Both cost a decision or a follow-up (#194). The issue had named that test as its own evidence, and the slicing did not run it (`Missed-by: plan`, the fifth fence that missed a reader of the changed thing). A reviewer's sort mutation on stored attributes survived 328 tests because the fixtures were already sorted, and was fixed in 666ef6c. The decision file failed validation once because `fence` was sent as a string, the second such refusal after #39.
