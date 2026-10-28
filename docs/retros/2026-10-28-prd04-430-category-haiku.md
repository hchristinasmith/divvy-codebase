# Retro: #430 prd04 Ruling 9, the category agent falls back to Haiku for merchants no rule covers

Gear 3 as stamped; no shift. The implementer ran on opus. Fence: `server/agents/category/**` plus tests. One declared widening: `server/agents/scheduler.ts` (blocked-run behaviour, below). This file states no telemetry (model, duration, tokens, tool calls); the lane posts the four narratives to Baseline after `baseline finish`.

Seats run: implementer (build), reviewer (4 findings), security-auditor (no blocking findings), test-guard (8 of 8 Done-when covered, one warning closed), this retro. Verify passed on the final state: tsc 0, lint 0, vitest 183 files / 6696 tests passed. I did not re-run it for this retro.

Commits: 3c76c8c (build), bf22ddd (review fixes), 19462b1 (test-guard). 8 files, +1167 -123.

## What was built

- **Kind of code:** a model fallback inside the category agent: prompt builder (`prompt.ts`), reply parsing and batching (`agent.ts`), candidate read (`read.ts`), plus tests. No migration.
- **Pattern:** rules run first; rows no rule covers go to Haiku in batches, with the batch's own scope and merchant examples (capped, newest first). Replies become `category_proposals` only. The Anthropic SDK is reached through `client.ts` alone.
- **Why this shape:** `reach.test.ts` allows the SDK in `client.ts` only, so `prompt.ts` takes its types from there.

## What went wrong

1. **The conductor's note named two retry cases and the build handled one (Missed-by: do).** The note on the issue asked the lane to decide scheduler behaviour for blocked runs and for failed runs. The build decided only blocked: a blocked category run counts as processed. The failed half was missed. Review found it as F1: with no API key the run failed, the scheduler retried the same sync every tick, 288 rows a day. Fixed by making no key skip the model pass, so the run succeeds rules-only.
2. **A thrown call's batch was resent every retry (Missed-by: do).** The brief told the implementer to store progress on every outcome "so a blocked or failed run never causes a resend". The implementer chose to count a thrown call as unsent, so a missing key or an outage never quietly loses rows, and it flagged that choice in its report. The lane accepted it without weighing it against the scheduler retrying failed runs every tick. So the batch was resent every tick, and with unreadable usage its tokens never reach the budget (F2). Fixed by moving the cursor past a thrown batch. Accepted cost: those rows never get a model proposal.
3. **First gate red.** `prompt.ts` imported the Anthropic SDK type, which `reach.test.ts` forbids outside `client.ts`. Fixed by using `CompleteResult` from `client.ts`. Cost: one gate round. The rule was in a test, not in anything the implementer read first.
4. **Two surviving mutations** (duplicate entry per row; thrown call). The implementer had mutation-checked 10 guards and still missed these; the reviewer added tests.
5. **Test-guard warning:** prompt examples were not tested for scope, merchant filter or cap. Closed with a test; the mutations went red.

## Root causes

- **Scheduler behaviour for a failed run was never checked (items 1, 2).** The conductor's note named blocked and failed cases together. The build handled blocked only. For thrown calls the implementer made a defensible local choice (do not lose rows) and flagged it, but the lane accepted the flag without reading how `scheduler.ts` treats a failed run (retried every tick). The record shows no deeper cause.
- **The SDK boundary is enforced only by a test (item 3).** First occurrence; no rule change yet.
- **Item 4:** unclear beyond mutation checks being chosen by the author.

## What worked, keep it

- **Review in a separate seat.** It found F1 and F2, both real cost bugs (money spent on retries), which the gate could not see.
- **Mutation checks, then reviewer mutations.** The implementer's 10 checks held, and the reviewer's extra two found the gaps.
- **Security-auditor and test-guard agreeing with review.** The auditor's no-key retry suggestion was F1; independent confirmation.
- **Taking the blocked-run choice in the lane** with the widening recorded, not absorbed silently.
- **Separate review-fix and test-guard commits**, so the second reader sees the response alone.

## Surfaced, not absorbed

- F3: a row passed while a rule covered it is never sent after the rule dies. Accepted, documented.
- The local blocked query duplicates the db accessor; fold in once #445's fence frees.
- Test-guard leftovers: direct `read.ts` unit tests, a prose-around-JSON parse case, a category set mid-sweep.
- Reply size is bounded by `max_tokens` only.
- Flaky, unrelated to the diff: `client/components/Insights/__tests__/InsightBody.test.tsx` "stays fast on unclosed delimiters at the length cap" took 1684ms against a 1000ms limit under full-suite load. Seen once.
- Not tested: real Haiku replies. The Quality (8/10) and Cost (under NZ$5/month) criteria are Hannah's to judge from real runs.

## Recommended changes

1. **When a conductor note on an issue names more than one case, the handoff lists each as its own checkbox** and the lane answers each in the PR body. Artifact: the lane handoff template used with `baseline start --handoff-file`. Optional; first occurrence, so hold until it repeats.
2. **Do not encode the SDK boundary yet.** First occurrence.

## Highest-leverage next step

When the lane accepts an implementer's flagged choice about failure handling, check it against how `scheduler.ts` treats a failed run (retried every tick) first. State that in the brief of the next agent that calls a model under the scheduler. Put it in the `docs/prds/prd-04` scheduler notes or the lane handoff for #58-dependent issues.

## Open items for the PR body

- Gear 3 as stamped; no shift. One declared widening (`server/agents/scheduler.ts`), and one line in `run.test.ts` for the new `discarded` result key.
- Reviewer: 4 findings; F1, F2 and F4 fixed, F3 documented.
- Security-auditor: no blocking findings. Test-guard: all 8 Done-when covered.
- Gate: tsc 0, lint 0, vitest 183 files / 6696 tests passed.
- Quality and Cost criteria are for Hannah to judge from real runs.

## Baseline narratives

### narrative_code_type

A model fallback in the category agent: prompt builder, reply parsing, batching and candidate read in `server/agents/category/`, plus a small change to `scheduler.ts`. No migration; gear 3.

### narrative_built

Rules run first. Rows no rule covers go to Haiku in batches, with the batch's own scope and merchant examples (capped, newest first). Replies become `category_proposals` only. No API key skips the model pass and the run succeeds rules-only. A thrown call's batch is not resent. A blocked category run counts as processed in the scheduler. 8 files, +1167 -123; 183 test files and 6696 tests at the end.

### narrative_how

The implementer on opus built it in one pass and mutation-checked 10 guards. The first gate was red because `prompt.ts` imported the SDK type; it now uses `CompleteResult` from `client.ts`. The reviewer found 4 issues; the lane fixed the no-key retry and the resent batch, and documented the third. Security-auditor found nothing blocking. Test-guard's one warning was closed with a test. Review fixes and the test-guard fix were separate commits.

### narrative_wrong

The conductor's note named both blocked and failed retries and the build handled only blocked. With no API key a failed run was retried every tick (288 rows a day), found by review. The brief said progress is stored on every outcome so a blocked or failed run never causes a resend; the implementer counted a thrown call as unsent (so an outage loses no rows) and flagged it, and the lane accepted that without weighing it against the scheduler retrying failed runs every tick. The batch was resent each tick, and its tokens never reached the budget. Rows in a thrown batch now never get a model proposal. Two mutations survived the implementer's checks. Real Haiku replies were not tested, and one unrelated flaky test failed once under load.
