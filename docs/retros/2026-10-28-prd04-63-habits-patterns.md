# Retro: #63, the Habits Patterns card shows agent insights with charts

Gear 3, no shift. Implementer ran on opus/high. This file states no telemetry; the conductor posts the narratives to Baseline after `baseline finish`.

Seats run: implementer, reviewer, brand-checker, this retro. Verify passed on the final state: 6473 tests (6466 after the build). I did not re-run it. Commits: e078dac (build), 1025f20 (review fixes).

## What was built

- **Kind of code:** a UI component and data hook (`PatternInsights.tsx`, `useInsights.ts`) plus a 411-line test file, mounted from `client/screens/Habits/index.tsx`.
- **Pattern:** `PatternInsights` renders `PatternsCard` itself and controls its children. With zero insights it passes none, so the card shows its own empty state.

## What went wrong

1. **The chart test skipped the real assembly point (Missed-by: do, caught by review).** The chart-equals-hand-query test built the insight from `topMerchantsMarkdown` and `topMerchantsChart` directly, not through `buildDrafts`. The reviewer mutated `buildDrafts` to swap the chart and every test still passed. Fixed: the test now takes the pattern draft from `buildDrafts`.
2. **Loading and error states show "No patterns yet".** While the list loads, the card shows the empty text, because the existing `Habits.test.tsx` (outside the fence) leaves unstubbed requests pending and expects `patterns-empty`. With the default QueryClient (3 retries), a failed read shows that text for several seconds before the error appears. Not fixed: a per-query retry override goes against the convention noted in `client/apis/habits.ts`.
3. **`scope` threaded through `HabitsBody` (Missed-by: plan, caught by review).** This was looser than the fence wording ("only mount"). Fixed: `PatternInsights` reads `useScope()` itself.
4. **Copy 10 of `call` (Missed-by: plan).** `client/apis/**` was fenced, so the implementer wrote another local copy. #438 was removing those copies in another lane. It merged mid-lane, and the lane fast-forwarded and swapped to the `http.ts` import. The cost was one rework commit's worth of lines.

## Root causes

- **Test composed the generator's parts, not the agent's output.** Item 1. The test reproduced the pieces and not the function that assembles them, so a change inside that function was invisible. Same shape as the #438 gap, where the gate was green and the changed path was untested. That is a second occurrence of "green gate, changed path untested", and review caught it both times.
- **Fence versus existing tests.** Item 2. The existing test fixes the behaviour the card can have during loading, and the fence put that test out of reach.
- **Fenced api directory, copy over lift.** Item 4. Same cause as #438: a fence that bars `client/apis/` leads to a local copy.
- **Prop named in the handoff.** Item 3. The lane's brief to the implementer said `PatternInsights` "takes the scope", which read as a prop; reading `useScope()` inside was the option that kept `index.tsx` to the mount the fence allowed.

## What worked, keep it

- **Reviewer mutation check.** It found a real gap that the green gate hid.
- **Fast-forwarding to main mid-lane** (no rebase, no stash) to drop the duplicate helper before the PR.
- **Surfacing the loading-state trade-off** and not hiding it.
- brand-checker found on-brand, no violations.

## Left as is, noted

- A dismiss in flight blocks Dismiss on any other card, and the second click is dropped silently. One user, so left.
- Stale docs, out of fence, not edited: the `PatternsCard.tsx` header comment and `docs/design/handoff.md:46` still describe Patterns as empty or Claude-generated.

## Recommended changes

1. **Fix the loading and error states in a follow-up.** Use a pending state in `PatternsCard` and update `Habits.test.tsx` to match. Filed as #464 (housekeeping, `Missed-by: plan`: the fence put the test out of reach), which also carries the stale docs.
2. **Add to the reviewer or test-guard checklist: a test that checks agent output must call the agent's assembly function, not its parts.** This is the second "changed path untested" finding (#438, #63). It is now a pattern, so it is worth encoding. File: the reviewer agent in the Baseline workflow.
3. **Fix the stale docs** (`PatternsCard.tsx` header, `handoff.md:46`): folded into #464.

## Highest-leverage next step

Encode item 2 in the reviewer/test-guard instructions: for any test that asserts on generated output, mutate the real assembly point and confirm a test fails.

## Open items for the PR body

- Gear 3, no shift.
- Loading and error show "No patterns yet" (item 2 above).
- `scope` read inside `PatternInsights`.
- Stale docs noticed, not edited.
