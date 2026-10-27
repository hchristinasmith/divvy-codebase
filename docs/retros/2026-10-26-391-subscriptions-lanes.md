# Retro: #391, the subscriptions detector reads one merchant as lanes

Gear 3 as stamped. No gear shift: the fence widening was granted by Baseline decision 948caf08, not absorbed. This file states no telemetry (model, duration, tokens, tool calls); the lane posts the four narratives after `baseline finish`.

Seats run: researcher, architect (twice), test-writer (twice), implementer (three passes), reviewer (two passes), docs-syncer, test-guard, this retro. `schema-reviewer`, `brand-checker` and `security-auditor` do not apply (no migration, no UI, no route, hook or CI file). Gate green on the final state (db23f67): `npx tsc --noEmit`, `npm run lint`, `npx vitest run` (5026 tests; 4936 before).

Commits (`git log --oneline b24004d..HEAD`): d97c401 regression tests, 49e655b build, c129e58 review fix, bcdb0ff decision 4e6a7dcd, 18f355b docs sync, db23f67 test-guard gaps. Diff: five files, +4003 / -51. `shared/subscriptions.ts` is +725 / -44; the two test files are +3240; `server/db/subscriptions.ts` +31; prd-02 +14.

## What was built

- **Kind of code:** a change to a pure detector function in `shared/`, plus tests and a new PRD ruling. No migration, no route, no UI.
- **Pattern:** `subscriptions()` (prd-02 Ruling 14) still runs the all-history gap rule first. A merchant it misses is dealt into **lanes** forward, oldest charge first. Each lane is its own subscription. Key is `<bare>#<first date>:<first cents>`, so it never moves once formed. The first lane to reach 3 charges owns the bare key forever, so existing `subscription_marks` rows keep matching. Weekly stays on the old rule. Written up as prd-02 Ruling 16.
- **Why this one:** Hannah chose it in decision 948caf08 (option B, split into lanes) over keeping one row per merchant. The lane-owns-bare-key rule is decision 6b2d3b4f (option A).

## What went wrong

| # | What | Cost | Missed-by |
|---|---|---|---|
| 1 | The issue named `server/db/subscriptions.ts`. Both causes are in `shared/subscriptions.ts`. The researcher confirmed this on main with invented fixtures. | One decision (948caf08) before anything could be built. | plan |
| 2 | v1 dealt lanes **backwards from the latest charge**. Reviewer #1 replayed reads charge by charge. The bare key swapped monthly between P2's two subs (marks moved on 622/2000 invented merchants). A cancelled lane's sibling inherited the cancel. A moved billing day passed the mark to the sibling. Irregular visitors every 10-20 days went 0 to 351/500. | v1 thrown away: architect #2, forward dealing, decision 6b2d3b4f, implementer v2. Marks moved fell 622 to 32. | plan |
| 3 | The requirement behind #2 was never written down: **a key must not change when a later charge is appended**. The issue said "every existing detected subscription keeps its key", which is true on one read and says nothing about the next. | The cause of item 2. | plan |
| 4 | Reviewer #2: the bare key can still move once, in the read where a lane forms, when two subs bill within 3 days (12/8000 close-billed trials, 0/4000 random). Decision 4e6a7dcd: accept, document, pin with a test. | One decision, bcdb0ff. | do |
| 5 | The false-positive table came from 500-trial samples. Batch variance on the 10-20 day row was 49 to 79, so the sample hid the real rate. Corrected to 5000 trials (c129e58). | One review finding; the first numbers were wrong in the header. | do |
| 6 | The first `baseline decide` call returned 400: `fence` is a diagram object, not a file list. | One retry. | do |
| 7 | Docs-syncer found a cancel date on the bare key can make Ruling 14's cancel-date reading fold a later sibling into a "charged again" row. Identical on main. Filed as #406. | Follow-up, not a regression. | review |
| 8 | Gate was green but test-guard found 23/120 mutants surviving across 8 gaps. One test looked like it covered the single-lane path and never reached the lane code. The cents test in the lookahead, the day and live edges, the noise-guard ends, the 31st anchor, strawb and all scopes, the `.3+` suffixes, never-split answers, a stale `not_subscription` lane and `knownMerchant`'s RangeError path were unpinned. | Test-writer pass #2: 28 new tests; 112/126 mutants killed, 3 equivalent. | do |

## False positives this adds (accepted, owned by #393)

5000 trials, seed 20261026. Visits every N days that now read as a subscription:

| Visit gap | Main | Now |
|---|---|---|
| 10-20 days | 0/5000 | 641/5000 |
| 20-40 days | 27/5000 | 637/5000 |
| 25-35 days | 1495/5000 | 2660/5000 |
| 5-10 days | 37/5000 | 121/5000 |

Weekly-visit fixtures are unchanged. Numbers are in the module header and posted on #393.

## Root causes

- **`requirement-true-on-one-read-not-over-time`** (new). The stability property was stated as "keys do not change versus today". The real requirement is "keys do not change as charges arrive". Nothing in plan or architect #1 asked for it. Review found it by replaying reads one charge at a time, which nobody had done before. Cause of items 2 and 3.
- **`issue-fence-from-the-wrong-reading`** (new). The issue was written from `server/db/subscriptions.ts`; the logic is in `shared/`. Nobody opened the pure function before slicing. Cause of item 1. Single occurrence.
- **`author-blind-spot-on-own-mutants`** (reused; 5th retro to name it). The test-writer's first block missed 23/120 mutants. A different seat, test-guard, found them. Item 8.
- **`proxy-check-passes-without-the-property`** (reused). The single-lane test passed because it never entered the lane path. Item 8.
- **Small sample, wrong rate** (unnamed, single occurrence). 500 trials with a 49-79 spread cannot show a rate; the figure looked fine until the 5000-trial rerun. Item 5.
- **Tool schema from memory** (also in #206's retro, item 2). Item 6.

## What worked, keep it

- **The regression block went in alone and green on old code (d97c401)**, and has not changed since. No test on main was edited.
- **Raising a decision when the fence could not hold the fix**, instead of editing `shared/` on the quiet. Hannah chose with options in front of her; the fence rule did its job.
- **The researcher confirmed both causes on main with invented fixtures first**, so the wrong-module finding cost one decision, not a half-built fix.
- **Reviewer replayed reads charge by charge.** Found item 2 before merge. Reviewer #2 measured the residual case (12/8000, 0/4000) instead of arguing it.
- **Key stability measured, not asserted:** fuzz main versus new, 2760/2760 detected rows identical and 4704/4704 mark-listed rows keep their key; about 40,000 replayed reads, 0 differences on rows main lists.
- **Separate seats found separate things:** researcher the module, reviewer the key movement, docs-syncer #406, test-guard the 8 test gaps. None was in the implementer's own list.
- **Mutants that survive are named.** 3 equivalent, listed, not hidden.

## Surfaced, not absorbed

- **#400** dismiss every part of a split merchant from the screen when the plain-key part is hidden (from decision 6b2d3b4f; Housekeeping).
- **#406** a cancel date on the bare key folds a later sibling into the cancelled row (Spawned-by: #391, Missed-by: review).
- **#393** owns the false positives above.
- **#394** owns the description key (`normaliseDescription`), fenced out of this lane; not touched.

## Recommended changes

1. **Any issue that changes a key other rows reference must say, in Done-when, that the key is unchanged for every row listed today and after each later charge is appended, and the test replays reads charge by charge.** Single lane, so this is one occurrence by the encode-on-second rule. But it cost the most (item 2), and the record shows the replay is what found it. Add it to the architect brief for key-changing work now; promote to the issue template on a second hit. Artifact: the architect's agent prompt (`.claude/agents/architect.md` as imported; source in the Baseline workflow).
2. **Run mutants on the first test-writer block, not only at test-guard.** `author-blind-spot-on-own-mutants` is in 5 retros now; waiting for test-guard cost a full test-writer pass (28 tests). Encode: make the test-writer run its own mutation set in scratch and report survivors. Artifact: the test-writer agent prompt; add the rule to `docs/testing.md` assertion rules.
3. **Before slicing a logic fix, open the function, not the DB layer.** Single occurrence; do not encode. If it recurs, the issue-slicing step names the file where the failing rule is read from.
4. **Report a rate with trial count and the batch spread.** Single occurrence; the module header now shows the 5000-trial table as the example.

## Highest-leverage next step

Recommendation 1: put "the key is stable as charges are appended; test by replaying reads" into the architect brief for key-changing work. It would have caught v1 at plan time and saved the whole v1 build, architect #2 and decision 6b2d3b4f round.

## Open items for the PR body

- Gear 3 as stamped; no shift. Fence widened by decision 948caf08 (option B) to `shared/subscriptions.ts` and its test, plus prd-02 Ruling 16.
- Decisions: 948caf08, 6b2d3b4f, 4e6a7dcd. Follow-ups: #400, #406; false positives to #393.
- Gate on db23f67: tsc, lint, vitest 5026 tests (4936 on main). No test on main edited.
- False-positive table above is stated in the module header.

## Baseline narratives

These four are the text for the retro POST (`narrative_code_type`, `narrative_built`, `narrative_how`, `narrative_wrong`).

### narrative_code_type

A change to a pure detector function in `shared/` (the subscriptions detector, prd-02 Ruling 14), with tests and a new PRD ruling. No migration, route or UI. Gear 3 as stamped; no shift.

### narrative_built

A merchant the all-history gap rule misses is now dealt forward into lanes, oldest charge first, each lane its own subscription with key `<bare>#<first date>:<first cents>` that never moves. The first lane to reach 3 charges owns the bare key, so existing marks keep matching. Weekly stays on the old rule. Written up as prd-02 Ruling 16. Key stability: 2760/2760 detected rows identical to main, 4704/4704 mark-listed rows keep their key. Tests 4936 to 5026; gate green. Added false positives (5000 trials): visits every 10-20 days 0 to 641; owned by #393.

### narrative_how

Researcher confirmed both causes on main; the issue's fence named the wrong module, so decision 948caf08 widened it. Regression tests went in alone, green on old code. Implementer v1, then reviewer #1 blocked it; architect #2 redesigned with forward dealing (decision 6b2d3b4f), implementer v2 cut marks moved from 622 to 32 of 2000. Reviewer #2 found one residual key move and wrong false-positive figures (decision 4e6a7dcd, fix c129e58). Docs-syncer found #406. Test-guard found 23/120 mutants surviving; a test-writer pass added 28 tests, 112/126 killed, 3 equivalent.

### narrative_wrong

The issue named the wrong module (Missed-by: plan), costing a decision. Worse, v1 walked lanes back from the latest charge; the real requirement, that a key does not change as charges are appended, was never stated, so the bare key swapped between two subscriptions and marks moved on 622/2000 merchants (Missed-by: plan). Review found it by replaying reads. The first false-positive figures used 500-trial samples whose spread hid the rate. A single-lane test never reached the lane code, part of 23/120 surviving mutants (`author-blind-spot-on-own-mutants`, `proxy-check-passes-without-the-property`). Change: state key stability over time in the architect brief for key-changing work.
