# Retro: #392, a subscription with no charge for two billing cycles is "possibly stopped"

Gear 3 as stamped, held: no migration, no new export, route unchanged. Implementer opus/high. This file states no telemetry; the narratives are posted after `baseline finish`.

**This lane was overengineered.** The change is small: a computed flag and a totals rule. It took four Baseline decisions, a researcher, an architect, a 10-test regression block that the build then rewrote, and a diff of +1046 / -75 over 11 files. Hannah said so mid-lane and the lane switched to regular seats and a short PR. Most of the cost sat in the issue, not the code (items 1 and 2).

Seats run: researcher, architect, implementer (regression tests, build, one review fix), reviewer, brand-checker, test-guard, docs-syncer, this retro. `schema-reviewer` and `security-auditor` do not apply. Gate green on the final state: `npx tsc --noEmit` 0, `npm run lint` 0, `npx vitest run` 121 files / 5235 tests.

Commits (`git log --oneline 5ab6f3f..HEAD`): e78c739 regression tests, 696b247 build, a102de7 review fix, a0b3038 doc sync.

## What was built

- **Kind of code:** a computed field on the subscriptions read path (`shared/subscriptions.ts`, `server/db/subscriptions.ts`, `shared/contracts.ts`) and a small client change (item badge, summary tile).
- **Pattern:** a row is `possiblyStopped` when its own last charge is older than 14 / 60 / 730 days (strict, by cadence). It leaves the totals and adds `possiblyStoppedCount`. Never stored, always recomputed from the row's last charge. Rows with no cadence are never flagged.
- **Why this one:** decisions A and the three that followed, all picked by Hannah. The alternative, rejoining a resumed charge to the old row, is the detector's job and is filed as #409.

## What went wrong

| # | What | Cost | Missed-by |
|---|---|---|---|
| 1 | Done-when 3 said "a new charge clears the flag". The architect found, and the conductor ran on main's detector with invented charges, that a charge resuming after a two-cycle gap is **never joined back to the old row**. Unmarked rows vanish on the first new charge and return as a new row after three. A marked row keeps its old last charge. The line could not be met inside the fence. | A researcher and architect round, then Baseline decision A: read Done-when 3 as "computed, never stored", file #409. | plan |
| 2 | The issue left the period (how long is "stopped") and the no-cadence case open. | Three more decisions: 14/60/730 strict, never flag no-cadence rows, widen the fence by one totals pin in `client/apis/__tests__/subscriptions.test.ts`. The issue could have stated these. | plan |
| 3 | The regression block (e78c739) pinned "an old last charge is active and counted". The build changed that on purpose, so those tests were rewritten, plus one older shared test (marked bare-key lane moving billing day: per-month 4500 to 3500, `possiblyStoppedCount` 1). | A 10-test block written, then rewritten. The "green on old behaviour" proof has no value when the change is the behaviour. | plan |
| 4 | Fence widening was one line short: the `empty` literal in that same client test file also needed the new key for `tsc`. | One line beyond the granted widening, reported, not hidden. | plan |
| 5 | test-guard found one surviving mutation: `readSubscriptions`' default `now` set to `new Date(0)` survived, because no route test had a flagged row. | One route test (a102de7). | do |
| 6 | `noHardcodedStyle.test.ts` reads "#392" in a client comment as a hex colour. | Client comments say "issue 392". | do |
| 7 | brand-checker: no warn-tint token exists and `App.css` is out of fence. | The flag uses existing tokens only. Passed. | none |
| 8 | docs-syncer: prd-02 Ruling 14 (line 154) is now false, and Ruling 16 (line 177) needs a sentence about #409. Fence only allowed two comment edits (a0b3038). | Notes only; PRD edits left for a person. | plan |

## Root causes

- **`issue-asserts-behaviour-the-code-does-not-have`** (new). Done-when 3 described how a resumed charge behaves without anyone running the detector on one. A ten-minute run on main showed it was false. Items 1 and 3.
- **`open-parameters-left-to-decisions`** (new). Period, no-cadence rows and the totals pin were all answerable from the issue's own subject. Each became a blocking decision. Item 2.
- **`seat-weight-not-matched-to-change-size`** (new, and what Hannah named). A small computed flag got the full gear-3 seat list and a regression block sized for a behaviour change. Not a tool problem; it was a dispatch choice.
- **`author-blind-spot-on-own-mutants`** (reused). The implementer's own tests missed a default argument; test-guard caught it. Item 5.

## What worked, keep it

- **Running the detector on main with invented charges before building.** It killed a Done-when line that could not be met, before any code wrote to it.
- **Decisions raised in Baseline, not guessed.** Hannah picked with the options in front of her; the fence was widened by a decision and one line beyond is reported.
- **Reviewer: 0 findings, 14 scratch mutations all caught.** Test-guard then found the one real gap.
- **Computed, never stored.** No migration, no stale flag, route unchanged.

## Surfaced, not absorbed

- **#409** the detector should rejoin a charge resuming after a two-cycle gap to the old row (Spawned-by: #392, Missed-by: plan).
- prd-02 Ruling 14 line 154 now false; Ruling 16 line 177 needs a #409 sentence.
- No warn-tint token exists in the design tokens.

## Recommended changes

1. **Dispatch a small, single-behaviour change with regular seats only: no researcher or architect unless the issue names a conflict.** One occurrence, named by Hannah, so a note rather than a rule. Artifact: the dispatch checklist in `docs/` (the lanes section of `CLAUDE.md`).
2. **For an issue that adds a flag or filter, Done-when should state the period, the rows it skips, and what happens when the flagged thing resumes.** Single occurrence, by the encode-on-second rule do not add it to the template yet; note it here so a second hit promotes it.
3. **Do not write a "green on old behaviour" regression block when the issue changes that behaviour.** Pin only what must not change. Single occurrence.

## Highest-leverage next step

Recommendation 1: the lane for a gear 3 issue that is one computed field should start from the issue and the diff, not from a researcher and architect. It would have skipped most of the 10-test rewrite and put the real question (item 1) in front of Hannah as one decision, not four.

## Open items for the PR body

- Gear 3 held. Fence widened by Baseline decision to one client test file (plus one `empty` literal line for `tsc`).
- Follow-up #409. PRD edits for Ruling 14 and Ruling 16 are notes, not done.
- Gate: tsc 0, lint 0, vitest 121 files / 5235 tests.
