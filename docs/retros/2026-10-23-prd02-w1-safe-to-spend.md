# Retro: #36 prd02 w1 — safe-to-spend is one pure function with a fixed test table

Gear 4, model opus, as stamped on the issue; no gear shift. Off the record: Baseline does not know this project, so there is no run id and no telemetry (model, duration, tokens, tool calls) is stated here as measured.

## PR-body paragraph

`shared/safe-to-spend.ts` is one pure function from integer-cent rows plus a scope to a signed result and every part (liquid, unpaid bills, remaining budget, tax hold, short-by, days to payday, per-day), with `shared/contracts.ts` holding the typed API shapes for later waves; both are hand-worked in a fixed test table (100 tests in the fenced file, 142 with the existing money tests, passing). The first pass was not clean: the reviewer re-derived every table value by hand (all matched) but found two real gaps: the table could not detect a personal tax pot leaking into the Strawb figure (the code did not leak, but a mutant that summed every account's pot left 87 tests green), and input validation depended on scope, a real defect; test-guard then found three more classes of surviving mutants (settings defaults and keys never imported at runtime, tax-rate bounds, All-scope pot, upfront date check). All were fixed in two separate commits and the mutants now die. One thing outside this fence: the repo `tsconfig.json` `include` omits `shared/`, so the gate's `npx tsc --noEmit` never type-checks these files; the lane type-checked through a scratch tsconfig outside the repo, and the fix is a one-line `include` change for another issue. #29 (money rules confirmed) is still open and must close before merge; bills are taken as already-resolved occurrences, so #35 (recurrence) does not change the function.

## What was built

A pure calculation module plus a contract file (types and two settings constants) in `shared/`, shared by client and server. Pattern: one function, no I/O, integer cents throughout, signed result with `shortByCents` (clamp left to the display layer), tax rate as integer basis points, tax owed rounded up and per-day rounded down (the single final rounding step), payday counted as the last payday. Transactions are keyed by `accountId` so scope comes from the account; per-budget lines are returned in the result; `CategorySource` is type-imported from `models` rather than copied. Test table is worked by hand with the arithmetic in comments beside each case, as the issue's lane note asks.

## Pipeline as it ran

1. Architect plan agreed with the lane's draft (signed result, basis-point rate, ceil on tax owed, floor on per-day, payday counts as last payday) and added three refinements, all adopted: per-budget lines in the result, accountId-keyed transactions, type-imported `CategorySource`.
2. Build, in two commits: contracts first (d3db8f1), then the function and table (aea8738).
3. Lane mutation sweep of 20 mutants; all killed. This said the suite was strong. It was not, as the next two steps showed.
4. Reviewer (EXECUTED): hand re-derivation of every table value, all matched; two findings (below). Fixed in 74b6a96.
5. Test-guard (EXECUTED) and security-auditor: fixes in 00a7578.
6. Fence held: only `shared/contracts.ts`, `shared/safe-to-spend.ts`, `shared/__tests__/safe-to-spend.test.ts`. This retro file is outside the issue's fence by the dispatcher's explicit instruction.

## What went wrong

| Finding | Caught by | Cost |
|---|---|---|
| The table could not detect a personal tax pot leaking into the Strawb figure: the code was right, but a mutant summing every account's pot left 87 tests green. The table had a pot case but not one where a personal pot existed beside a Strawb one. | reviewer | a test in the fix commit; without it a later edit could leak the pot unnoticed |
| Input validation depended on scope: a fractional out-of-scope balance threw in All and passed in Personal. | reviewer | a fix commit |
| `SETTINGS_DEFAULTS` and `SETTING_KEYS` could be mutated and the whole suite stayed green, because the test imported `contracts.ts` type-only. | test-guard | pins added to the fenced test file |
| Surviving mutants on tax-rate bounds, the All-scope pot, and the upfront date check. | test-guard | same fix commit |
| The gate's `tsc` does not see `shared/` (`include` is `client, server, src, models, data`). `tsc --noEmit --listFiles` lists only `shared/money.ts`, reached through imports. | found by the lane while type-checking | the issue's last Done-when ("`tsc` does not error in `shared/`") is true of the gate by vacuity |

Security-auditor: no critical findings. Pre-existing subsystem warnings, not caused by or fixable in this diff: `cors()` allows any origin with no auth; `server/routes/akahu.ts` proxies raw Akahu bodies; the settings PATCH will need a validator or one bad stored row 500s the overview.

## Root causes

- **The lane's own mutation sweep was chosen by the author.** Twenty mutants, all killed, was real evidence but it covered the mutants the author thought of. The two gaps the reviewer found were cross-scope interactions (a pot in the other scope, validation depending on scope); the test-guard gaps were things the author's tests could not reach at all (type-only import of runtime constants). Both are blind spots of the person who wrote the code. Cause: self-review by mutation is bounded by the author's model of the function.
- **The gate cannot see `shared/`.** Cause: `tsconfig.json` `include` was never extended when `shared/` became a home for money logic (M1 #8). The pre-commit check in CLAUDE.md says `npx tsc --noEmit` and every lane reads a clean run as typed; for these files it is not evidence. Cause is a config omission, not a tool fault.
- **A table written to be "worked by hand" tests the cases someone thought of.** The reviewer's re-derivation confirmed the values but could not confirm coverage; only mutation could, and only another seat's mutants found the holes.

## What worked well (keep)

- The architect pass before the build: the lane's draft and the plan agreed on the numeric decisions that are easiest to get plausibly wrong (rounding direction, rate representation, payday semantics), and its three refinements were cheap before code and would have been expensive after.
- Contracts committed first, separately, so the review saw the API surface before the logic.
- Hand-worked arithmetic in comments beside each case: the reviewer could re-derive every value, and all matched. This is what made the review about coverage rather than arithmetic.
- Reviewer and test-guard as separate seats: they found different classes of gap (semantic leaks versus unreachable code), and neither overlapped the lane's own sweep.
- Fixes in separate commits from the build, so the second reader sees only the response.
- Fence held without strain; the contracts pins went into the fenced test file instead of a new `contracts.test.ts` outside it.
- Stating the open dependency (#29) and the #35 independence in the PR rather than waiting.

## Recommended changes

1. **Add `shared` to `tsconfig.json` `include`** (high leverage, one line). Currently every `shared/` file, including all future money logic and what prd-03 and prd-05 w3 import, escapes the gate. Needs its own issue because it is outside this fence; expect new errors to surface in `shared/money.ts` and its consumers, so compare counts per CLAUDE.md. File: `tsconfig.json`.
2. **Add a "scope-crossing" case checklist to `docs/testing.md` under Money**: for any function with a scope argument, each scope-conditional input needs a fixture where the other scope holds a different non-zero value, and validation must be scope-independent. Hold this until it recurs once more before encoding (first occurrence: write the retro, change the runbook on the second). Name for recurrence: `author-blind-spot-on-own-mutants`.
3. **Runtime import rule for constants under test**: a test that only imports types from a module of runtime constants cannot see them change. Same rule as above: note on first occurrence, encode on second.

## Highest-leverage next step

Add `shared` to the `include` array in the repo's `tsconfig.json`, in its own small issue, before the next wave imports `shared/safe-to-spend.ts` or `shared/contracts.ts`. Until then the pre-commit `tsc` gate gives no signal on the files this subsystem exists to protect.
