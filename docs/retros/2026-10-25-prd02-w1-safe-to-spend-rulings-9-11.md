# Retro: #36 prd02 w1 (round 2) — safe-to-spend moved to Rulings 9-11

Gear 4, model opus, as stamped on the issue; the work ran the gear-3 seats (see "Gear" below). Recorded in Baseline (this worktree's run id); no telemetry (model, duration, tokens, tool calls) is hand-stated here. This is a second retro on #36 by design: the first (`2026-10-23-prd02-w1-safe-to-spend.md`) covers the original build and is unchanged; this one covers the rework after Hannah amended prd-02.

## PR-body paragraph

On 2026-10-25 Hannah blessed three amendments to prd-02, and PR #96 had encoded the old rules. Ruling 9: payday is a weekday (Tuesday), weekly, not a day of the month. Ruling 10: credit-card debt, `max(0, -balance)`, is subtracted from safe-to-spend. Ruling 11: tax holds are per scope: Strawb is rate x profit against Strawb pots, personal is the typed owed amount against personal pots, All is the sum of the two with no cross-netting. The lane rebased the branch onto `origin/main`, appended Rulings 9-11 to prd-02 verbatim (with one amendment line under Ruling 2), and reworked `shared/safe-to-spend.ts`, `shared/contracts.ts` and the fixed test table to match. The table was re-worked by hand on a Friday 2026-10-23 fixture and grew from 100 to 140 tests (142 after the F1 fix); 113 of the 140 fail against the old code (the 27 that stay green are the unchanged `budgetSpentCents`, `daysInMonth` and unknown-scope rows). Review found one real defect (a personal tax owed of -0 was echoed as -0), fixed in its own commit. Gate green at every commit: `tsc` 0 errors, lint 0, vitest 753/753. Two follow-ups filed, one surfaced; see below.

## What was built

A rework of a pure calculation module and its contract file in `shared/`. Pattern unchanged from round 1 (one function, no I/O, integer cents, signed result), with three semantic changes: payday found by weekday instead of day-of-month, account roles `credit_card` and `tax_pot` that drive the card-debt subtraction and the tax-pot matching, and a per-scope result (Strawb, personal, All) where `taxHoldCents` is the sum and the old aggregate owed/pot fields are gone. The architect found no importers outside `shared/`, so the result-shape change was a straight rename, not a migration.

## Pipeline as it ran

1. Rebase of 22 commits onto `origin/main` (5 commits replayed, clean), `npm ci`, gate green (711 tests) before any change, so the baseline was known.
2. `791b4ff`: Rulings 9-11 appended to prd-02 verbatim plus one amendment line under Ruling 2. Doc commit first, so the code commit cites text that already exists.
3. Architect plan. It left seven decisions open (D1-D7); the lane settled them: role strings `credit_card` and `tax_pot`; per-scope result fields; card spend counts in budgets; 7 days to payday on payday itself; default weekday 2; `paidThisMonthCents` left as is; card sign (owed = negative balance).
4. `10435c0`: implementer built it. Lane mutation sweep of 23 mutants, all killed.
5. Reviewer (EXECUTED): re-derived 61 cases and 13 payday rows by hand, 0 mismatches; ran 11 mutants of its own plus 4 re-runs, all killed. Findings F1-F3 below. F1 fixed in `9b75d28` (one more case).
6. Test-guard (EXECUTED): 65 mutants, 54 killed, 5 equivalent, 6 survivors, all in code unchanged since round 1. Timezone runs clean in 4 zones.
7. Docs-syncer: nothing it was allowed to edit was stale; 10 stale spots in the prd-02 body and `docs/design/handoff.md` are outside the fence and were surfaced, not edited.
8. Mid-run, the conductor confirmed the card sign from live data (the sign only, no amount) and #29 closed (Hannah confirmed Rulings 3 and 5).

## Gear

The hand-off described #36 as "stamped lower" than gear 3. The issue says gear 4. The seats run were gear-3's. The gear-4 extras (researcher, security-auditor, schema-reviewer) did not run, and none of their triggers (routes, migrations, CI, `.env`) were touched. Reported here as a gear difference, not absorbed: the stamp was right and the hand-off wrong.

## What went wrong

| Finding | Caught by | Cost |
|---|---|---|
| F1: a personal tax owed of -0 was echoed as -0 in the result. The table had no -0 input. | reviewer | one fix commit (`9b75d28`), one case. The hand-worked table and the lane's 23 mutants both missed it. |
| F2: years 0000-0099 are wrong because `Date.UTC` maps them to 1900-1999. Pre-existing in `daysBetween`, not caused by this diff. | reviewer | filed as #126, not fixed here (outside the rework). |
| F3: the prd-02 body still says "payday day" in places Ruling 9 supersedes. | reviewer | surfaced, not edited: the PRD body is not in the fence and rulings are never renumbered or rewritten. |
| 6 surviving mutants, all in code unchanged since round 1. | test-guard | filed as #127. They are residue from round 1, not new gaps. |
| The lane briefed docs-syncer with edit permission wider than the lane's own fence (any reference doc under `docs/`). | the lane, by message, before docs-syncer edited anything | no edit made; one correction message. It would have been an out-of-fence change had it run. |
| Test-guard reported the per-file test split as 140+44; the actual split was 142+42. The total, 184, was right. | the lane, checking the report against the run | none beyond a correction, but a wrong number in a report that people read as evidence. |
| The hand-off said #36 was "stamped lower" than gear 3; the issue says gear 4. | the lane, reading the issue | a misread of the seat set, harmless this time because the extras' triggers were absent. |
| The reviewer saw local/remote divergence after the rebase, so `second-opinion` was skipped: it reads `gh pr diff`, which was the stale remote. | reviewer | one planned review step did not run. Review still happened (reviewer plus test-guard plus hand re-derivation). |

Also worth stating: PR #96 was complete and green against the rules in force when it was built, and the rules changed under it. The rework cost three files, a new table (100 to 140 tests) and a second review round. The record does not show a step that could have prevented this; the amendments were blessed after the build.

## Root causes

- **`author-blind-spot-on-own-mutants`** (named in the round-1 retro; second occurrence). The lane's 23 mutants all died, then the reviewer found a boundary the author had not considered (-0), and test-guard found 6 survivors the lane never reached. Honest accounting: F1 is a new author miss, the 6 survivors are round-1 residue that round-1 test-guard missed or that were filed rather than fixed, so this is a recurrence of the cause, not a fresh set of blind spots. Cause: self-review by mutation is bounded by the author's model of the function, and the table is worked by hand, so it holds the cases someone thought of.
- **A seat's brief does not carry the lane's fence.** The docs-syncer brief widened the edit permission to "any reference doc under `docs/`"; the lane's fence was three files. Cause: the brief was written fresh instead of copying the fence. Caught only because the lane re-read its own brief in time; nothing structural would have stopped the edit.
- **Hand-offs restate facts from memory** (gear stamp, per-file test counts). Both slips were small and both were caught by checking against the issue or the run. Cause: summaries are written from recollection of a record that is one command away.
- **`second-opinion` depends on the remote matching the local branch.** After a rebase they diverge until a push, and the tool reads the stale side. Cause: sequencing, not tooling: the review was scheduled before the push.

## What worked well (keep)

- Rulings appended to the PRD in a commit of their own, verbatim, before the code. The code commit then cites existing text, and the reviewer could check the code against the ruling rather than against the lane's paraphrase.
- Green baseline first: rebase, `npm ci`, gate (711) before touching code, so every later red was attributable to the diff.
- The architect checking importers before the rename: it found none outside `shared/`, so the result-shape change needed no migration of callers.
- The lane settling the architect's open decisions in writing (D1-D7) instead of leaving them for the implementer to guess.
- Measuring the new table against the old code: 113 of 140 red on the old code, and the 27 green are exactly the rows that should not change. That is a direct check that the table tests the new rules.
- Reviewer re-deriving by hand (61 cases, 13 payday rows, 0 mismatches) rather than re-running: this is what makes "all matched" mean something.
- Reviewer and test-guard as separate seats, again finding different things (a boundary versus unchanged-code survivors).
- Out-of-fence findings filed as issues (#126, #127) or surfaced (F3, the 10 stale doc spots), not folded in.
- The one unconfirmed assumption (card sign) was named, and the conductor confirmed it from live data, sign only, without an amount reaching the record.
- Fix commits kept separate from the build.

## Recommended changes

1. **Copy the lane's fence verbatim into every seat's brief** (high leverage, small). The docs-syncer slip is a first occurrence: write it here and make the cheap change, since it is a handoff template line and not a runbook rule: a one-line "Fence: <files>. Edit nothing else; surface the rest" in the lane's dispatch text for each seat. File: `~/.claude/agents/` seat prompts or the lane dispatch template, not this repo.
2. **Encode the scope-crossing and boundary-input checklist now** in `docs/testing.md` under Money. The round-1 retro said to wait for a second occurrence; this is it (F1 plus the test-guard residue). Content: for any money function, include -0, zero, and the other scope holding a different non-zero value as fixtures; validation must not depend on scope. File: `docs/testing.md`.
3. **Fix the -0 class at the source.** If a second function can echo -0, a shared `normalizeZero` in `shared/money.ts` is better than a per-field fix. Hold until a second site appears; one site is not a pattern.
4. **Push before `second-opinion`.** After any rebase, push (or give the tool a local diff) before running a seat that reads `gh pr diff`. File: the reviewer seat prompt / lane dispatch template.
5. **Check hand-off numbers against the record before restating them.** Gear from the issue, test counts from the run. Optional; fold into the dispatch template.
6. **Open items, not fixed here:** #126 (years 0000-0099 in `daysBetween`), #127 (6 survivors in unchanged code), the PRD-body "payday day" lines and the 10 stale spots in prd-02 body and `docs/design/handoff.md` (needs a docs issue; the PRD body is Hannah's to edit). The round-1 `tsconfig.json` `include` item has landed (#98).

## Highest-leverage next step

Add the boundary-input and scope-crossing checklist to `docs/testing.md` under Money (change 2). It is the only cause that has now recurred, it applies to every later money function (tax, budgets, forecasts), and a fixture list is cheaper than discovering -0, other-scope and zero cases by review each time.
