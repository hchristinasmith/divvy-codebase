# Retro: #52 prd02, habits route (GET /habits, PUT /habits/verdicts/:id)

## Retro summary (for the PR body)

#52 added the habits route: runway, the no-overdraft streak, spending by habit and worth-it verdicts, plus a `habit_verdicts` table. Review and test-guard caught real defects (cross-scope transfer pairing, a streak with no balance evidence, 13 surviving mutants) and none reached main. The real cost was time, not code: two money decisions (own-account transfer detection; card debt in runway) blocked the lane for about two days, partly because Baseline's `decide --block` wait dropped with ECONNRESET about 8 times and had to be re-armed by hand. Hannah answered on 2026-10-28: A, pair match; B, subtract card debt (eea5986).

Gear 4 as stamped; no shift. Implementer ran opus, high. Seats run: researcher, architect, implementer, reviewer (each diff), schema-reviewer, security-auditor, test-guard, docs-syncer. This retro states no telemetry; the lane posts the four narratives after `baseline finish`.

Commits (`git log origin/main..HEAD`): 133288b migration (schema-reviewed, no FK because of the pending-row delete), 8af300a build, aeb027c test-guard mutant kills, a494f72 drawings left out of spending (Ruling 15, asked for by the conductor after #264 merged), eea5986 Hannah's rulings, then this retro.

## What was built

- **Kind of code:** a migration, a pure-function module (`shared/habits.ts`), a DB reader (`server/db/habits.ts`), and a route with GET and a PUT with a same-site check.
- **Pattern:** money maths in `shared/` on integer cents, reads in `server/db/`, thin route. Transfers are matched as pairs within the current view; runway subtracts card debt; the streak is omitted when there is no balance evidence.

## What went wrong

1. **Transfer pairing ran across scopes (Missed-by: do).** A Strawb row could take a Personal leg's partner. Caught by the reviewer; fixed by pairing within the view.
2. **The no-overdraft streak reported a number with no balance evidence (Missed-by: do).** Reviewer caught it; changed to omit, per Done-when 2.
3. **13 surviving mutants (Missed-by: do).** The build's tests passed code they should not have. test-guard found them; aeb027c kills them.
4. **Two money rulings were not in the PRD.** Own-account transfer detection and card debt in runway were real forks. The lane blocked on them for about two days. `decide --block` dropped with ECONNRESET about 8 times, needed a retry loop, and the waits were re-armed after a session restart. Cost: calendar time only, no rework.
5. **Drawings arrived late.** a494f72 was a conductor request after #264 merged, so spending was built once and then amended.
6. **Rebase conflict** in `server/routes/__tests__/barrel.test.ts` after the goals route landed. Same file as the #67 retro's barrel finding.
7. **Two fence widenings**, recorded on the PR: the migration test file and `barrel.test.ts`.

## Root causes

- **Money rules the PRD left open reached the lane as forks (item 4).** The PRD does not say how to detect an own-account transfer or whether card debt reduces runway. The researcher found both, correctly, before the build. Cause of the long wait: the answer sat in the conductor session while the wait sat in a connection that kept dropping. Cause of the ECONNRESET: unclear from the record.
- **Tests written to the happy path (items 1 to 3).** Mutation review found what example tests missed, the same pattern as #67.
- **Barrel test pins the whole set of mounts (items 6, 7).** Seventh case of the consumers family named in the #25, #39 and #67 retros. Parallel route lanes meet it at merge.

## What worked, keep it

- Researcher first: both forks were raised before code, not found as rework.
- Reviewer on each diff, and test-guard mutation work: three real defects stopped.
- Schema-reviewer on the migration, committed on its own before the code using it.
- Declining to invent: the streak is omitted rather than guessed.
- Surfaced findings were left out of the diff.

## Surfaced, not fixed

- PUT accepts a verdict on a drawing half, which then never shows in any list.
- If only one half of a drawing is hand-categorised, it counts as spend in All.
- The prd-03 replica lacks `balance_cents`, `category` and `category_source`, which `get_habits` would need.
- No Host allow-list (DNS rebinding risk) and `urlencoded` bodies are accepted app-wide. Both belong to #236.
- `docs/design/handoff.md:44` words runway as "liquid + savings" and omits card debt.

## Recommended changes

1. **Barrel test and route lanes (encode; recurrence).** Add a short "Adding a route" note to `docs/testing.md` naming `server/routes/__tests__/barrel.test.ts` as the pin on mounts, and add it to the fence of any issue that mounts a router. High leverage; every remaining route lane hits it.
2. **Long decision waits (do not encode yet; first occurrence).** The cause of the ECONNRESET is not known. If a second lane loses a `decide --block` wait, file it against Baseline with the timestamps; do not build a retry loop into a skill first.
3. **Fix `docs/design/handoff.md:44`** to say runway subtracts card debt (Hannah's ruling, 2026-10-28). Doc change, small, goes with the next docs lane.

## Highest-leverage next step

Recommendation 1: the "Adding a route" note in `docs/testing.md`.

## Baseline narratives

### narrative_code_type

A migration, a pure money-maths module, a DB reader and an Express route (GET and PUT) for habits. Gear 4.

### narrative_built

`GET /habits` returns runway (card debt subtracted), the no-overdraft streak (omitted without balance evidence), spending by habit with drawings excluded (Ruling 15), and worth-it verdicts. `PUT /habits/verdicts/:id` stores one verdict per settled transaction, with a same-site check. New table `habit_verdicts`, no FK.

### narrative_how

Researcher and architect first, then implementer on opus. The reviewer ran on each diff, plus schema-reviewer, security-auditor, test-guard and docs-syncer. Two money forks went to Baseline and Hannah answered on 2026-10-28: pair match for transfers, subtract card debt in runway. Commits are 133288b, 8af300a, aeb027c, a494f72 and eea5986.

### narrative_wrong

Transfer pairing crossed scopes and the streak reported a number with no balance evidence; the reviewer caught both. test-guard found 13 surviving mutants. The lane waited about two days on two money decisions because `decide --block` dropped with ECONNRESET about 8 times; the cause is unclear from the record. There was a rebase conflict in `barrel.test.ts` and two fence widenings (the migration test and `barrel.test.ts`).
