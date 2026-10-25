# Retro: #26 prd04 w1, proposals, insights and the chart spec have validated types

## Retro summary (for the PR body)

#26 added validated types for category proposals, insights and the chart spec, plus `server/agents/contracts.ts`. The final gate is green (tsc 0, lint 0, vitest 1965/1965). The code is right; the route to it was not clean. The opus implementer built the full scope, a ruling then arrived mid-build (no paid Anthropic API spend), and the lane held, resumed on an amended scope, and the implementer trimmed what the ruling killed: `toModelView`, `ModelTransactionView`, `UsageStore`, `InMemoryUsageStore`, `AgentRunRecord`, `usageDayOf`, and the model ids and token budget from `AgentConfig`. That dropped 39 tests. Separately, the chart spec's size check was wrong in both directions: review caught the false-accept side, `test-writer` caught the false-reject side, and the second fix landed after the `reviewer` seat had run.

Gear 4 as stamped, no shift. Implementer on opus (haiku for the amendment commit and the one-line fix). No telemetry is stated here; the lane posts the narratives after `baseline finish`.

Seats, in order: researcher, architect, implementer (opus, full scope), HOLD, RESUME, implementer (haiku, the amendment, `3bb2402`), implementer (opus, trim to Ruling 7, build `0b3e222`), reviewer and security-auditor in parallel, implementer (review fixes, `e9c6184`), test-guard, test-writer (haiku, `b9610f0`), implementer (haiku, `096724b`), docs-syncer, this retro. Diff against `origin/main`: 6 files, 1454 insertions: `models/insights.ts` (494), `models/__tests__/insights.test.ts` (724), `server/agents/contracts.ts` (69), `server/agents/__tests__/contracts.test.ts` (141), plus the prd-04 amendment and one `docs/decisions.md` line.

## What was built

- **Kind of code:** pure validators and types, no I/O and no database. `models/insights.ts` holds the insight and chart spec types, `validateChartSpec` and `parseChartSpecJson`; `server/agents/contracts.ts` holds the proposal types, `parseProposedCategory` and `AgentConfig` (`{batchSize, ruleThreshold, enabled}`). Origin is `rule` only (Ruling 7).
- **Pattern:** parse, don't trust. Input of type `unknown` is snapshotted into plain data first, then checked against closed field lists, size and nesting caps, URL and invisible-character rules. The chart spec is validated data even though code now writes it (Ruling 8). `parseProposedCategory` reuses `isKnownCategory` from `server/db/categories.ts`; the `data/cats.js` import needed no config change, since `allowJs` was already on.
- **Why this shape:** nothing contested after the ruling. Before it, the model-facing view (`toModelView`) and a usage store were in scope; Ruling 7 removed the reason for both.

## What went wrong

1. **The full-scope build was wasted work.** The architect planned, and the opus implementer built, a model view and a usage store. Hannah's no-API ruling arrived while it ran. The step was allowed to finish uncommitted, then the lane waited, resumed, and the implementer removed the dead parts and 39 tests. Cost: one opus build of code that did not ship, a hold, and a second pass. The validators survived untouched, so the loss was the model-facing half, not the whole.
2. **Was it avoidable? Probably yes, and the record shows why.** The PRD's open questions listed "Does the Anthropic API key exist, and is an API budget acceptable?" as *Open, not ruled* before dispatch, and #23 (the API-key issue) was open. #26's scope depended on the answer: model ids, a token budget and a usage store only make sense if the API exists. The record does not say whether anyone weighed that at dispatch. I am not assigning more than that. What it supports: the part of #26 that did not depend on the answer (proposals, insights, the chart validator) could have been dispatched alone.
3. **The phase-1 size estimate was wrong both ways.** The chart validator estimated size in a cheap first pass, then checked `JSON.stringify` length. The first pass ignored JSON escapes, so a spec could pass on write and fail on render; review fixed that by adding the exact check. It also charged a flat 12 characters per number, which refused valid numeric-heavy specs at about 52k characters against a 64k cap. Review did not find that; `test-writer` did, when it wrote a numeric-heavy spec. The two errors have one source: a constant standing in for a quantity that was cheap to compute.
4. **A code fix landed after the `reviewer` seat.** `096724b` is a one-line change (`grow(String(value).length, path)`) to `models/insights.ts`. The lane read the diff and the gate ran on the final state; the `reviewer` did not see it. Low risk here (`String(n)` equals the JSON form for finite n, and the `bad_number` check just above rejects the rest), but the sequence is review, then more code.
5. **The dispatch gave a scratchpad path under an earlier session's id**, and one agent noticed. Cost was small. Cause: the handoff named a scratchpad under a different session id than the lane's own; the lane passed it on as given.

## Root causes

- **Dispatching against an open PRD question the scope depends on (items 1, 2).** First occurrence in what I read; I did not re-read other retros for it. The gate cannot catch it, since the build was correct against the plan; only the dispatch step can.
- **Approximating a limit instead of computing it (item 3).** The author's tests pinned the cap from above only (a spec over the limit is refused), so an estimate that over-counted passed every test until someone wrote a valid spec near the limit. This is the same family as earlier retros where author-chosen tests share the author's blind spots; here the blind spot was the accept side of a boundary.
- **Fix after review has no re-review rule (item 4).** The pipeline puts review before gate and commit, and says nothing about a code change that appears later from `test-writer`. First occurrence.
- **Scratchpad path (item 5):** unclear beyond "copied from the wrong session".

## What worked, keep it

- **HOLD, then RESUME with a widened fence.** The running step finished uncommitted, the amendment landed verbatim as its own commit (`3bb2402`), and the trim was a clean subtraction. Nothing from the dead scope shipped.
- **Reviewer and security-auditor in parallel.** The auditor found the bidi-control hole; the review round also produced the backslash protocol-relative URL fix and the exact-length check. Review fixes got their own commit (`e9c6184`), so the response is readable apart from the build.
- **`test-guard` and `test-writer` back to back.** Of 111 mutations, 22 survived and 9 of those were equivalent; four real gaps were listed and closed in `b9610f0`. Writing the missing tests is what exposed the 12-character bug. A foreign-array-prototype test also killed a surviving mutation.
- **The `researcher` seat ran** at gear 4, unlike #25.
- **Follow-ups filed, not absorbed:** #215 (lint boundary for `server/agents/**` and `models/**`, Housekeeping) and #216 (Mermaid validated or never rendered, phase).

## Recommended changes

1. **Dispatch check: if the issue's PRD lists an open question the scope touches, slice off the independent part or hold.** Do not encode yet; one occurrence. If it recurs, add a line to the dispatch checklist in the project `CLAUDE.md` ("Worktrees and lanes"). Here the cost was one opus build and 39 tests.
2. **Size and length caps: test the accept side near the limit.** Do not encode yet; one occurrence, though the test now exists at `models/__tests__/insights.test.ts` ("accepts numeric-heavy rows whose exact JSON is under maxChars"). If the next validator has a cap, add the near-limit accept case to `docs/testing.md`.
3. **Late fixes after `reviewer`:** record them in the PR body as "changed after review" with the commit. Not a rule yet.

## Highest-leverage next step

Recommendation 1, once it recurs. Until then, the single concrete step is to fix the stale passages in prd-04, prd-03 and the D3 "Why" cell (see below); a PRD that still describes Haiku and a token budget will send the next lane down the same path.

## Open items for the PR body

- `docs-syncer` found nothing needing change inside the fence. Stale Haiku and token-budget passages remain in `docs/prds/prd-04-background-agents.md`, `docs/prds/prd-03-*` and the D3 "Why" cell in `docs/decisions.md`; these are for the conductor.
- Follow-ups: #215 (Housekeeping), #216 (phase).
- The lint boundary that keeps `models/**` from importing `server/**` does not exist yet (#215).
- Gate: tsc 0, lint 0, vitest 1965/1965.

## Baseline narratives

### narrative_code_type

Pure validation contracts: typed parsers for category proposals, insights and a chart spec, plus agent config types. No I/O, no database. Gear 4, imported by later prd-04 issues.

### narrative_built

The insight and chart spec types, `validateChartSpec` and `parseChartSpecJson` in `models/insights.ts`; the proposal types, `parseProposedCategory` (reusing `isKnownCategory`) and `AgentConfig` as `{batchSize, ruleThreshold, enabled}` in `server/agents/contracts.ts`. Origin is `rule` only. The chart validator snapshots untrusted input, then applies closed field lists, size and nesting caps, URL rules, and invisible and bidi character rejection. Gate: tsc and lint clean, vitest 1965/1965.

### narrative_how

Researcher and architect planned the full scope, and the opus implementer built it. A no-paid-API ruling arrived mid-build, so the lane held, then resumed on an amended scope: a haiku implementer landed the prd-04 amendment (Rulings 7 and 8) as its own commit, and the opus implementer trimmed the model view and usage store, dropping 39 tests. Reviewer and security-auditor ran in parallel and their fixes went in a separate commit. Test-guard found 22 of 111 mutations surviving, 9 equivalent; test-writer closed four gaps and found a real size-estimate bug, which a haiku implementer fixed. Docs-syncer found nothing in fence. Follow-ups #215 and #216 were filed.

### narrative_wrong

The full-scope build was partly wasted: the PRD listed the API-key question as open and #23 was open, yet the model view and usage store were planned and built, then removed after the ruling (39 tests). The chart spec's phase-1 size estimate was wrong both ways: it ignored escapes (review caught it) and charged a flat 12 characters per number, refusing valid specs at about 52k of a 64k cap (test-writer caught it). That second fix landed after the reviewer seat, and the lane read the one-line diff. The dispatch also gave a scratchpad path from an earlier session's id, which one agent noticed.
