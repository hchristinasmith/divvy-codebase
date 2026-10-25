# Retro: #102 prd05, only NZD is ever summed

Gear 2 as stamped; no shift. Implementer ran on opus (high), per the gear 2 "subtle, not merely small" row. This run has a `BASELINE_RUN_ID`, so the lane posts the four narrative fields below after `baseline finish`. Commits: fd4b4e5 (Ruling 7 in the PRD), 297d4b0 (build), 5120746 (review fix). Gate at the end: 623/623 tests, `tsc` and lint clean.

## What was built

- **Kind of code:** a behaviour change to one pure function, `sumAmountDueCents` in `server/xero/client/invoices.ts`, plus a mixed-currency fixture and tests. The PRD gained Ruling 7, appended verbatim from Hannah's decision, and an amendment line under Ruling 4.
- **Pattern:** the function now returns `{ nzdCents, otherCurrencies }` with an inline return type. Amounts are grouped per currency code, and only exact, case-sensitive `NZD` goes in `nzdCents`. Any code not matching `/^[A-Z]{3}$/` throws `TypeError`.
- **Why this shape:** the architect rejected (b), an NZD-only sum that throws on foreign currency plus a separate grouping helper. A throwing sum is the "refused list" Ruling 7 rules out, and the helper would be a new export (gear 3). Shape (a) keeps the gear.

## What happened

- Hannah chose option A on 2026-10-25: sum only NZD, keep other currencies apart, never convert. fd4b4e5 recorded it before any code.
- The architect picked shape (a). The implementer wrote the fixture `invoices-accrec-mixed-currency.json` (NZD 100.00, USD 250.50, USD 49.50, all invented) and the tests first. On the old code 11 of 24 tests failed (`expected undefined`, the old return was a number). A scratch assertion `sumAmountDueCents(mixed) toBe 10000` failed with 40000. That is the "added as one number" proof. A broken-new mutation (NZD total adds every row) went red on 4 tests.
- The reviewer had one finding, fixed in 5120746. The currency regex could lose either anchor, or be wrapped in a trim, and every test stayed green. None of `nzd`, `''`, `NZ`, `__proto__` could tell `/^[A-Z]{3}$/` from `/[A-Z]{3}/`. The fix added `NZDX`, `XNZD` and ` NZD`, and those mutations then go red.
- The reviewer left three notes unfixed:
  - The inline return type has no name. `models/` is outside the fence, and #66 as first consumer may add one.
  - There is no production caller yet. #66, #71 and #73 are the intended callers.
  - `docs/testing.md` wants money tests in `shared/__tests__`, but this sum has lived in `server/xero/client` since #34.
- test-guard found nothing. Its mutation M3 (`toUpperCase` on the NZD compare) is an equivalent mutant, because the regex already rejects lowercase. It noted that the AUD payables test depends on fixture order, since it replaces the first `"CurrencyCode": "NZD"`.
- docs-syncer found nothing to change. The 2026-10-23 retro for #34 still says the sum "adds across currencies". It is a dated record and was left alone.

## What went wrong

- **The gap existed because #34 did not plan for currency (Missed-by: plan).** `sumAmountDueCents` added across currencies from the day it was written, and the #34 retro already named this. Cost here was a whole lane plus a PRD amendment. It was caught by a person, not a gate.
- **The regex guard shipped held by too few cases.** The implementer wrote the guard test with four bad codes. Only the reviewer noticed that none of them separated the real regex from a weaker one. The implementer's mutation set covered the NZD compare, not the regex anchors. Cost: one review finding and one fix round, small.
- **Scratch-dir gate run failed first.** The scratch directory did not exist yet. Trivial, one rerun.
- **Splitting build from review-fix commits needed a back-out.** To commit the build without the reviewer's fix, one test line had to be backed out and the gate re-run on that state. Cost: one extra gate run.

## Root causes

- **The money type's data dimensions were not enumerated at plan time.** This is the same cause as #34's second item. #34 covered amounts (cents, no floats) and not currency. #102 is the cost of that, and no new cause appeared.
- **A guard's tests were not required to separate it from weaker guards.** The float guard in #34 was held only by a grep. The regex here was held by cases that a weaker regex also passes. These are the same family, a guard whose tests cannot tell it from a looser one. It is the second occurrence, and in both cases review or a hand-built value caught it, not the implementer's own mutation list.
- **The commit split was an ordering problem.** The build was not staged before review, which #34 had done to avoid exactly this back-out.

## What worked, keep it

- **Decision before code, appended verbatim.** Ruling 7 went in as its own commit, so the code cites a fixed text and the retro cannot drift from what Hannah chose.
- **Architect rejecting the throwing sum.** The choice was made against the ruling's own wording, and the gear check (new export means gear 3) kept the lane at gear 2.
- **Tests first, shown red on the old code.** 11 of 24 red, plus the 40000 scratch assertion, proves the tests detect the original bug and not just the new shape.
- **A separate review-fix commit.** The second reader sees only the response to the finding.
- **Surfacing, not absorbing.** The unnamed return type, the missing caller and the `testing.md` location were noted, not folded in.

## Recommended changes

1. **Second occurrence, so encode it. High leverage:** in the implementer's mutation checklist, add "for any regex guard, mutate each anchor away and wrap the input in trim; each must go red". Artifact: the `implementer` agent file under `~/.claude/agents/`, then `pnpm import-workflow --name current` (the lane's copy comes from Baseline, not `~/.claude`). The conductor owns this edit.
2. **Plan check for money helpers, now at two instances (#34, #102):** list the dimensions (currency, scope, sign) and say which the helper ignores. Artifact: the `architect` agent file. Optional until it recurs outside currency.
3. **Stage the build before review as standard in this repo.** #34 did it, #102 did not and paid a back-out. Artifact: the lane handoff template, owned by the conductor. Optional.
4. **`docs/testing.md`:** say whether `server/xero/client` money helpers stay put or move to `shared/__tests__`. Repo doc, optional, and a separate issue, not this lane.

## Highest-leverage next step

Add the regex-guard mutation line to the `implementer` agent's checklist (item 1).

## Open items for the PR body

- Ruling 7 extends to #66 (sync), #71 (Overview "owed to Strawb") and #73 (tax hold payables). None calls `sumAmountDueCents` yet, so nothing in production changed.
- #66 will probably want a named type for the return shape, and `models/` is the place for it.
- The AUD payables test depends on fixture order. A fixture reorder would break it loudly, not silently.
- Fixture amounts are invented.

## For Baseline (four fields)

- **narrative_code_type:** a behaviour change to a pure money-summing function in `server/xero/client`, with a fixture and tests.
- **narrative_built:** `sumAmountDueCents` now returns `{ nzdCents, otherCurrencies }`. Only exact `NZD` is summed into `nzdCents`, and every other currency is summed alone and kept apart, never converted. A code not matching `/^[A-Z]{3}$/` throws `TypeError`. The change comes with an invented mixed-currency fixture and tests. prd-05 Ruling 7 records Hannah's decision. 623 tests pass, with `tsc` and lint clean.
- **narrative_how:** Hannah's decision (option A) went into the PRD as Ruling 7 first. The architect chose the `{ nzdCents, otherCurrencies }` shape over a throwing sum plus helper, which would have been a new export and gear 3. The implementer on opus wrote tests first, 11 of 24 red on the old code, and ran a broken-new mutation, 4 red. The reviewer found one issue, fixed in a separate commit. test-guard and docs-syncer found nothing.
- **narrative_wrong:** the gap came from #34, which never planned for currency (Missed-by: plan). The currency regex guard shipped with test cases a weaker regex also passed, so losing an anchor or adding trim stayed green, and only the reviewer caught it. Splitting build from review-fix commits cost a back-out and an extra gate run. A scratch-dir gate run failed once because the directory did not exist.
