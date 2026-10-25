# Retro: #229 prd02 w3, subscriptions are detected from transactions and can be marked and cancelled

## Retro summary (for the PR body)

#229 adds one pure function, `subscriptions()` in `shared/subscriptions.ts`, that detects regular charges from settled Akahu outflows, applies Hannah's marks and cancel dates, and returns integer-cent totals. A new `subscription_marks` table, a db module and a `/api/v1/subscriptions` router (GET, PUT mark, POST cancel, POST uncancel) sit around it, with an additive contract block. The final gate is green (tsc 0, lint 0, vitest 84 files / 2908 tests), and a cancelled subscription charged again off its cadence now shows as charged again (Done-when 4) after review caught it vanishing. Test-guard then found four surviving mutants, all on strawb-scope marks, and tests closed them with no production change. The migration was renamed twice on rebase because two sibling lanes took the same "next slot" timestamp; that is the one lane-process cost worth fixing.

Gear 4 as stamped, no shift. Implementer on opus at effort high (the CLAUDE.md table, gear 4). This file states no telemetry (model, duration, tokens, tool calls); the lane posts the four narratives after `baseline finish`.

Seats, in order: researcher, architect (four forks, F1 to F4), implementer (migration commit, then build commit), reviewer + schema-reviewer + security-auditor in parallel, implementer (review fixes, one commit), test-guard, implementer (gap tests, one commit), docs-syncer, this retro. Every seat the gear 4 table lists ran; brand-checker does not apply (no UI). Verify passed on the final state, after the last rebase onto 33da9d9: tsc exit 0, lint exit 0, vitest 84 files / 2908 tests. Baseline before the build was 66 files / 2118 tests, on an older main.

Commits (`git log --oneline origin/main..HEAD`): 81db27d (migration), 9771dc5 (build), d7b5d72 (review fixes), cae5310 (test-guard gaps). The diff is 11 files, +4794 / -1, about 1250 lines of it production code and the rest tests.

## What was built

- **Kind of code:** one create-table migration (`20261025170000_subscription_marks.js`), a pure detection module (`shared/subscriptions.ts`), a db module that loads rows and writes marks (`server/db/subscriptions.ts`), a thin router, and an additive "Subscriptions" block in `shared/contracts.ts`.
- **Pattern:** the overview shape. Detection, marks, cancel status and totals are all computed on read by one pure function with no clock and no timezone; the db module only loads and converts dates to NZ days; the route validates and does no arithmetic. Hannah's answer and cancel date live in a table keyed by `(scope, merchant_key)`, so they survive re-synced transactions (pending rows get new ids every sync). The merchant key is a stored contract: `m:<akahu merchant id>` or `d:<normalised description>`.
- **Why this shape:** one alternative was genuinely contested, a marked merchant whose cadence cannot be classified (F1). The lane lists it with null figures and counts it in `totals.uncountedCount` instead of guessing monthly, which would overstate totals silently.

## What happened

- **Researcher first.** Findings: no scope column on `transactions` (scope lives on `accounts`), `models/` is outside the fence, no half-up rounding helper exists, the barrel test pins the exact mount set, and any FK would need a migration-guards entry. The plan therefore used no FK and one `roundHalfUpDiv` using integer arithmetic. Compare #46, where the researcher also found its blockers before a line was written.
- **The architect named four forks.** The lane decided all four; none went to Hannah:
  - **F1:** a marked subscription with no classifiable cadence is listed, figures null, counted in `uncountedCount`.
  - **F2:** cancelled rows are listed and left out of the totals.
  - **F3:** no endpoint to search any merchant. Filed as #237 (Housekeeping, `Missed-by: plan`).
  - **F4:** the literal Ruling's limits (gaps are checked over all history, so one skipped month stops detection; a stale subscription stays active until cancelled) are written into the module header.
  - Uncancel was included, because without it a mistaken cancel cannot be undone.
- **The migration timestamp clashed twice with lanes that merged while this one ran.** The plan named it `20261025150000`. #46 merged `20261025150000_settings_drop_user_id` first, so the file became `...160000`. Then #31 merged `20261025160000_agent_inboxes`, so it became `...170000`. Each time the lane rebased and rewrote the migration commit so the file shipped under the new name. The barrel test also conflicted once with #46 (`EXISTING` and `PLACEHOLDERS`).
- **Review ran on committed work.** The build was two commits before the review seats started, so the review fixes (d7b5d72) and the gap tests (cae5310) are their own commits and the second reader sees only the response.
- **Review findings, both medium, both demonstrated by running code:**
  - **A `d:` key cut at 253 UTF-16 units could split a surrogate pair.** The security-auditor found it and the reviewer reproduced and fixed it. A cancel for such a merchant answered 200 but did not stick, because the stored key no longer matched the one read back. `merchantKeyOf` now drops a trailing high surrogate at the cut.
  - **A cancelled subscription charged again off its cadence vanished from every list.** Detection checks all gaps, so a late charge that breaks the rhythm made the merchant undetected and the row disappeared, which breaks Done-when 4 ("charged again on <date>"). Fixed by using the charges up to and including the cancel date to decide cadence and detection when a cancel date exists; with no cancel date nothing changes.
  - The reviewer's 25-mutation sweep killed all 25.
- **test-guard found four surviving mutants, all on strawb-scope marks:** a mark keyed as personal regardless of scope; scope dropped from the uncancel UPDATE; scope dropped from the `setAnswer(null)` UPDATE; the `stored()` readback by `merchant_key` only. No test read a strawb mark back, or wrote both scopes for the same key. cae5310 adds 192 lines of tests and no production change, and all four now go red.
- **schema-reviewer:** PASS, no warnings. **security-auditor:** no Critical or Warning findings, three suggestions:
  - the same-site gap on the settings and transactions writes, which predates this change and is already #218;
  - the surrogate bug, fixed;
  - a cosmetic floor on the `on` date, not taken.
- **docs-syncer** found nothing stale inside the fence. It proposed a "Superseded by #229" banner in `docs/audit-2026-10-23.md`. That file is outside the fence, so the lane reverted the edit; the patch is kept for the conductor.
- **Files beyond the issue's fence line, inside the handoff's.** The issue fence lists `shared/subscriptions.ts`, the migration, the route, the mount line and additive contract types. The lane handoff widened it to name `server/db/subscriptions.ts` and its test and "minimal reconciliation of the barrel test", so both are in scope. The barrel edit is one line (`'subscriptions'` into `EXISTING`). The issue text was not updated to match.

## What went wrong

1. **Two migration renames from one plan decision (Missed-by: plan).** The architect picked "the next round timestamp after the newest on main". Sibling lanes in the same wave did the same, and the namespace is shared. Cost: two rebases that rewrote the migration commit, a renamed migration test file, and one barrel-test conflict. No wrong code reached main, and the clashes surfaced as file-name collisions at rebase, not as a silently wrong order. This is the first occurrence in the retros I read, and I could not measure the time.
2. **A cancelled subscription charged again off its cadence disappeared (Missed-by: do and plan; caught by review).** The plan's cancel fixtures I read describe "a charge the day after gives active with `chargedAgainOn`", and none says the late charge is off the old rhythm. Detection over all gaps and the cancel rule were each correct alone; the interaction was not in anyone's list until the reviewer ran it. Cost: one review-fix round and 178 lines changed in d7b5d72, with no wrong code on main. The error would have shown as a subscription Hannah just cancelled and then got billed for silently disappearing, the exact moment the feature exists for.
3. **Four surviving mutants on one side of a scope boundary (Missed-by: do; the reviewer's sweep also missed them).** The build's tests exercised personal marks. The strawb side was read back only through the GET payload, never as a stored row, and no test wrote the same key under both scopes. The reviewer's 25 mutations did not include "drop scope from each write path". Only test-guard did. Cost: one gap-test commit of 192 lines. The Done-when says "scope isolation tested both ways", so this was the stated requirement, not an extra.
4. **A surrogate-pair cut in a stored key (Missed-by: do).** The key length limit counts UTF-16 units. Nothing in the plan's test list put a code point above U+FFFF at the cut. Cost: part of the review-fix commit.
5. **Three more copies of route helpers (Missed-by: none).** `fromThisSite` is now in three route files (copy 3), `parseScope` in two and `errorClass` in four places. The fence allowed new files only, so lifting them was impossible. Filed as #236. This is the same family as #46 and #44 ("fence beats consistency"); the plan flagged it up front, so it is a priced cost, not a miss.
6. **The first attempt to save the researcher's findings to a file came back empty (process, mine).** The lane condensed them by hand into `research.md`. The condensed file marks itself "verified by reading files", and the lane did not diff it against the original. Minor; a hand condensation could have dropped a finding, and I cannot tell that it did not.
7. **Forks decided in the lane (a judgement for the conductor to check, not a miss I can show).** The plan labelled F1 "real fork, needs a call" and F3 "needs conductor sign-off". The lane chose the plan's recommended option on both, and none went to Hannah through `baseline decide`. F1(a) is reversible (nothing stored depends on it), F1(c) would have needed a Ruling amendment, and F3 was deferred and filed as #237. I see no evidence this was wrong, and none that the conductor signed off F3.

## Root causes

- **A shared namespace picked from the same rule by parallel lanes (item 1).** Migration file names sort globally, and the plan's rule ("next round slot after main") has every lane in a wave choose the same name. The lanes were in one wave, so the clash was predictable from the rule, not bad luck. Name it **shared-namespace pick**; the same shape would apply to any other global identifier two lanes mint at once.
- **The author's list versus the reach of the code (items 3 and 4).** Same name as #39 item 2 and #46 item 4. The implementer tested the cases it thought of, and the reviewer's mutation list came from reading the diff, not from "every write path times every key column". Third occurrence in this family, and the first where the gap is a boundary the Done-when names. `docs/testing.md` still has only the one-line rule at line 83.
- **A rule that is right alone and wrong with another rule (item 2).** "All gaps must fit one band" and "a late charge returns the row to active" both come from Ruling 14 and both were implemented as written. The conflict showed only when one input drove both. The plan covered each rule's cases and not the cases where one rule's input breaks the other.
- **Fence beats consistency (item 5).** Not a cause to fix in this lane; the plan priced it.
- **Item 6:** a tool call that returned nothing, with no check on the saved file. No deeper cause I can point at.
- **Item 7:** the lane applied the rule that a decision goes to Hannah only when a wrong guess means rework. F1(a) stores nothing and changes no schema; moving to (b) or (c) later is additive. So the lane decided it and surfaced it in the PR rather than blocking. Whether that reading of the rule is right is the conductor's call.

## What worked, keep it

- **Researcher, then architect, with a plan that named its forks and recommended an option for each.** The lane could proceed on F2 and F4 without a call, and the F3 deferral became a filed issue with a suggested shape. Nothing in the forks caused rework.
- **A pure function with no clock and no timezone.** Every detection, mark, cancel and totals rule is testable with literals; the route does no arithmetic. That is why the reviewer could run a 25-mutation sweep against it and why a surrogate bug was demonstrated in one call.
- **Integer arithmetic for half-up rounding.** `roundHalfUpDiv` is exact (no float division), rounds once per subscription, and per-year is `12 x` per-month, so no second rounding enters a sum. Hand-worked fixtures pin it.
- **Review on committed work, parallel read-only seats, each demonstrating its finding.** Both medium findings were reproduced by running code and fixed in a commit of their own. The security-auditor's finding was handed to the reviewer, who reproduced and fixed it; the seats did not just agree with each other.
- **test-guard after the review fixes.** The four mutants were on a path the reviewer's sweep did not reach. The retro seat sees that two mutation seats with different lists are worth both.
- **Out-of-fence items filed, not absorbed.** #236, #237 and the audit banner patch were each routed. The banner edit was reverted because the file was outside the fence.
- **Migration with no foreign key, and no `transactions` rebuild.** Nothing in `migration-guards.test.ts` needed an entry, so no forced reconciliation file beyond the barrel line.

## Surfaced, not absorbed

- **#236** (Housekeeping, `Missed-by: none`): lift `fromThisSite`, `parseScope` and `errorClass` into one route helper file. Check #218 first; either lands first and the other shrinks.
- **#237** (Housekeeping, `Missed-by: plan`): `GET /api/v1/subscriptions/merchants?scope=&q=`, so Hannah can mark a one-off merchant that appears in no payload (prd-02 Ruling 14: "mark any merchant").
- **#218** (existing): no server-side same-site check on settings and transactions writes. Not touched.
- **The audit banner:** `docs/audit-2026-10-23.md` should carry a "Superseded by #229" note (detection now runs on real transactions; `Subscriptions.tsx` is still mock data until prd-02 w5). Outside the fence, so the patch is for the conductor.
- **Cosmetic floor on the `on` date** (security-auditor suggestion 3). Not taken, not filed; I did not judge it worth an issue.
- I did not read the bodies of #236 and #237 beyond their drafts, and I did not open #218.

## Recommended changes

1. **Test every write path of a `(scope, key)` table in both scopes, by construction.** For any table keyed by scope, each write function needs one test that writes the same key under both scopes and reads each back, and the mutation list for review and test-guard includes "drop scope from this WHERE or INSERT". Third occurrence of the author's-list family (#39, #46, here), so encode now. Artifact: add to the assertion rules in `docs/testing.md` (beside line 83). High leverage; Done-when "scope isolation both ways" recurs on every prd-02 and prd-05 table (budgets, bills, goals).
2. **Plan step: when two rules in a Ruling both fire on the same input, put one test in the plan where one rule's input breaks the other.** Here "a cancelled row charged again off its rhythm". Do not encode yet; first occurrence, and the reviewer caught it. If a second interaction miss appears, add an "interactions" line to the architect's test list in `~/.claude/agents/architect.md`.
3. **Migration names: use the lane's own clock, not the next round slot, and check main before the commit.** Name the file from `date -u +%Y%m%d%H%M%S` at the time of writing, and run `git fetch && git ls-tree --name-only origin/main server/db/migrations/ | tail -3` before the migration commit. Do not encode yet; this is the first recorded occurrence, though it cost two renames in one lane. If a second lane renames, add the rule to the architect's "Files" step in `~/.claude/agents/architect.md` and import it.
4. **Key-length limits count code points, not UTF-16 units.** Do not encode; first occurrence, and the fix is one line in `shared/subscriptions.ts`. If another stored key gets a length cap, add "test a code point above U+FFFF at the cut" to `docs/testing.md`.
5. **Verify a condensed research file against the original.** Do not encode; single occurrence and I cannot show a finding was lost. If it recurs, save the researcher's output to the scratch file in the same call that dispatches the seat.

## Highest-leverage next step

Do Recommendation 1: add the "write the same key under both scopes and read each back, for every write path" rule to the assertion rules in `docs/testing.md`, with the "drop scope from this WHERE" mutation named for test-guard. The next prd-02 and prd-05 routes add tables keyed by scope, and this lane's four survivors were all the same missing test written four ways.

## Open items for the PR body

- Fence: `server/db/subscriptions.ts` and its test, and the one-line `barrel.test.ts` edit, are named in the lane handoff's fence but not in the issue's.
- Four forks decided in the lane, none raised to Hannah: F1 (null cadence, counted in `uncountedCount`), F2 (cancelled rows excluded from totals), F3 (no merchant search, #237), F4 (known limits in the module header). Uncancel was added.
- Migration renamed twice at rebase (`...150000`, then `...160000`, now `...170000`); `barrel.test.ts` conflicted once with #46.
- Shipped constants: `MIN_CHARGES` 3; weekly 7 +/- 2, monthly 30 +/- 4, yearly 365 +/- 10; hints (subscription(s), membership(s), streaming, software, premium, cloud, hosting, vpn, newsletter, magazine, antivirus); rounding half-up once per subscription, per year = 12 x per month.
- Follow-ups: #236, #237. Audit banner patch for the conductor (outside the fence). #218 untouched.
- Rebased onto 33da9d9. Gate: tsc 0, lint 0, vitest 84 files / 2908 tests.

## Baseline narratives

These four are the text for the retro POST (`narrative_code_type`, `narrative_built`, `narrative_how`, `narrative_wrong`).

### narrative_code_type

A create-table migration, a pure detection module in `shared/`, a db module, a thin Express router with four endpoints, and an additive contract block. Gear 4, imported by the later Subscriptions screen (#230) and read again by prd-03.

### narrative_built

One pure function, `subscriptions()`, detects a merchant with at least three settled charges whose gaps are all weekly, monthly or yearly. It applies Hannah's mark and cancel date from a `subscription_marks` table keyed by scope and merchant key. It returns integer-cent per-month and per-year totals, rounded half-up once per subscription. A marked merchant with no clear cadence is listed with null figures. Cancelled rows are listed but not totalled, and a late charge returns the row to active. Gate: tsc and lint clean, vitest 84 files / 2908 tests.

### narrative_how

Researcher, then architect, which named four forks; the lane decided them with the plan's recommendations and filed the merchant-search deferral as #237. The implementer on opus built the migration and then the code in two commits. Reviewer, schema-reviewer and security-auditor ran in parallel, and the two medium findings were reproduced by running code and fixed in one commit. Test-guard then found four surviving strawb-scope mutants, closed by tests alone. The migration was renamed twice on rebase after #46 and #31 merged.

### narrative_wrong

The migration name clashed twice because the plan took the next round timestamp and sibling lanes did the same, costing two rebases that rewrote the migration commit. Review found that a cancelled subscription charged again off its cadence vanished from every list, breaking Done-when 4, and that a long key could split a surrogate pair so a cancel did not stick. Test-guard found four surviving mutants on strawb-scope marks that the build's tests and the reviewer's 25-mutation sweep missed. The first save of the research findings came back empty and was condensed by hand.
