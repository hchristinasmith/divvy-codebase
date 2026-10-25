# Retro: #45 prd02, the Overview screen on real data (hero, ledger, cards, alerts, activity)

Gear 3 as stamped; no shift. The issue said `model: sonnet`; the CLAUDE.md table maps gear 3 to opus, and the implementer ran on opus at `high`. Two test files outside the declared fence were edited and declared (below). `docs/retros/` is in this lane's fence. This file states no telemetry (model, duration, tokens, tool calls); the lane posts the four narratives after `baseline finish`.

Seats run, in order: researcher, architect, implementer (opus, build, one commit), reviewer (four findings, fixed in one commit), brand-checker, test-guard, implementer (haiku, survivor fixes, one commit), docs-syncer (no stale docs), this retro. Every seat the gear 3 table lists ran, plus brand-checker because the diff is UI. Verify passed on the final state: tsc exit 0, lint exit 0, vitest 78 files / 2440 tests.

Commits (`git log --oneline main..HEAD`): 972a424 (build), 44fca6e (review fixes), 87c4d30 (test-guard fixes). The diff is 21 files, +2511 / -13, most of it tests (`Overview.test.tsx` 829 lines, `fixtures.ts` 305, `overview.test.ts` 201).

## What was built

- **Kind of code:** a client screen (`client/screens/Overview/`: hero, ledger, accounts, tax, alerts and activity cards, a category picker), a client API module (`client/apis/overview.ts`), and a rewrite of `useAlertCount` so the shell badge reads the same overview query.
- **Pattern:** the server's overview response is the only source of money. The client maps alert `kind` to dot and link, composes the alert text, and does presentation-only sums and ratios (card totals, bar widths). Scope comes from `ScopeContext`; the query is keyed on it.
- **Why `fetch`, not superagent:** the architect chose `fetch` because `useAlertCount` makes the shell fire the overview query, and every shell test already stubs global fetch. Superagent would have opened real XHRs in those tests.

## What happened

- **Contract surprises, found by reading the route, not the contract comment.**
  - The dismiss route is `/api/v1/overview/alerts/:id/dismiss`; the comment in `shared/contracts.ts` gives a different path. Filed as #250.
  - Alerts carry no colour, link or text, so the client owns that mapping.
  - The handoff ledger has four lines; the data has a fifth (card debt).
  - The tax card's "Next payment" and "auto top-up" have no data and were dropped.
  - `formatCents` always prints cents, so the empty hero shows `$0.00`, not the handoff's `$0`.
  - The `/subscriptions` link has no route until issue 230, so it renders an empty main.
- **Two out-of-fence test edits, both declared.** `client/hooks/__tests__/useAlertCount.test.ts` was rewritten because it pinned the old `return 0` stub. `client/screens/__tests__/routes.test.tsx` took one filter change because Overview is no longer a stub. The architect found the second; the issue fence foresaw neither.
- **A comment trap, flagged in advance by the architect.** `noHardcodedStyle.test.ts` scans comments, so a hash followed by issue digits (230) reads as a hex colour. No red gate came from it.
- **Review ran on committed work.** The reviewer found four things, all fixed in 44fca6e:
  - three tests where client arithmetic for short-by, tax shortfall and per-day would have passed, so the tests could not catch a client that did its own money math;
  - one bug: a failed dismissal's error message followed the user into another scope. The scope switch now drops it.
- **brand-checker:** on-brand, nothing must-fix. Minors left as is: arbitrary values `leading-[1.35]`, `text-[16px]`, `pl-[50px]`, `p-[3px]`, and `gap-0.5`.
- **test-guard:** gate green, 30 mutations, 28 killed, 2 survived.
  1. Non-user rows carried no assertion about the blush marker. Test added.
  2. "Drop the redundant pending guard" was false. The lead passed that reading on to the implementer (haiku) as an instruction. The implementer ran the mutation with a settle wait and showed the guard is load-bearing: the existing pending-row test passed with the guard removed only because it asserted before the async PATCH fired. The test now flushes inside `act` first, and the guard stays (87c4d30).
- **Screenshots.** No Playwright. The lead drove headless Chrome over the DevTools protocol against a scratch fixture API with invented data. The first 390px shot looked broken (content cut off on the right, 4 of 5 tabs). That was Chrome's minimum window width, not the layout; device-metrics emulation showed `scrollWidth` 390 equal to the viewport.

## What went wrong

1. **Two test files outside the fence were predictable (Missed-by: plan).** A stub screen being replaced, and a hook whose stub return value a test pins, are each one `rg` away (`useAlertCount`, the stub's name). The issue fence listed neither. Cost: two declared edits, low. This is the same consumers family as #46 item 2 and #67; I count it as the eighth occurrence on the #46 retro's numbering, but I did not re-read every earlier retro to check that count.
2. **A wrong instruction went to the implementer (Missed-by: do, caught by the implementer).** test-guard reported a surviving mutation and a reading of it ("the guard is redundant"); the lead relayed the reading as a task. Deleting the guard would have removed code the behaviour depends on. The implementer's habit of running the mutation before editing caught it. Cost: one short detour, no code harm.
3. **Tests that could not fail, again (Missed-by: do, caught by review).** Three of the implementer's tests passed under client-side arithmetic, the whole point of the screen being "the server computes, the client shows". Cost: one review-fix commit. Same family as #46 item 4 and #39 item 2.
4. **A cross-scope state leak (Missed-by: do, caught by review).** A failed dismissal's message was not cleared on a scope switch. Cost: one fix and one test.
5. **Four contract facts the issue and handoff did not carry.** The wrong route path in a contract comment, the fifth ledger line, the dropped tax rows, and the `$0.00` formatting each needed a decision in the build. None cost rework, because the researcher and architect read the route and the data first. The contract comment itself is still wrong (#250).
6. **A misleading screenshot (tooling, not code).** The 390px shot cost one look at a layout that was fine. Cost: a few minutes and a wrong suspicion.
7. **Three copies of existing code (surfaced, not fixed).** `send`, the Settings card styles and the category wrappers in `apiClient.ts` now each exist twice. Follow-up #249 (housekeeping).

## Root causes

- **Plan covers the code that changes, not the code that pins it (item 1).** Same name as #25, #39, #46 and #67. The plan step looks at what the issue says to change; a test that asserts the old stub is not in the issue, so it is not in the fence. The architect found one of the two, which is the seat doing its job, but the fence was already written by then.
- **A surviving mutation has two meanings, and the report did not say which (item 2).** "Survived" can mean the code is dead, or the test checked too early. With async code the second is common. The lead read the first meaning into the result without running the mutation with a wait. New name: **survivor read as dead code**. First occurrence in the record I read.
- **Author's list versus the reach of the code (item 3).** Same name as #39 item 2 and #46 item 4. The implementer wrote tests that agree with its own arithmetic; only a seat that mutates the arithmetic shows they cannot fail.
- **Item 4:** unclear. The record shows the fix (the scope switch drops the message) but not why the build left it in; I do not state a cause.
- **Item 6:** a flag (`--window-size`) that sounds like a viewport and is not one below the browser's minimum width.

## What worked, keep it

- **Researcher and architect before any code.** Every contract surprise above was a line in a plan, not a failing build. The `fetch` choice and the comment trap were both made up front, with the reason attached.
- **The server is the only source of money.** The tests for short-by, tax shortfall and per-day were tightened until client arithmetic would fail them. That is the design rule (prd-02 Ruling 1) made checkable.
- **Review on committed work, fixes as their own commit.** Three commits, each with one purpose; the second reader saw only the response.
- **The implementer ran the mutation before deleting.** It turned a wrong instruction into a fact. Keep the habit of reproducing a survivor before acting on it.
- **Out-of-fence edits declared, follow-ups filed and not absorbed.** #249 and #250 exist; the two test edits are named.
- **Screenshots with invented data against a scratch fixture API,** and checking `scrollWidth` against the viewport before believing the picture.

## Surfaced, not absorbed

- **#250** the dismiss route path in the `shared/contracts.ts` comment is wrong.
- **#249** duplicated `send`, Settings card styles and category wrappers (housekeeping).
- **Pending, not done:** Hannah's visual check at 1040 and 390 wide, and a real-data check of the hero, which needs prd-01 w3 (#27, #32) and #30.
- #249 carries `Missed-by: plan`, `Priority: housekeeping`; #250 carries `Missed-by: review`, `Priority: housekeeping`. Both `Spawned-by: #45`, milestone Housekeeping.

## Recommended changes

1. **Fence checklist: for a screen replacing a stub, `rg` the stub's route name and any hook or constant it returns, and list each test hit in the fence.** Also the eighth occurrence of the family, with #46 recommendation 1 already asking for the architect-step edit. I cannot see from the record whether that edit landed; check `~/.claude/agents/architect.md` for it before adding a second line. If it is there, this occurrence is evidence the architect did not apply it, and the fix is to make it a literal step. High leverage.
2. **test-guard report format: for each survivor, state whether it is "dead code" or "test too early", and say whether the mutation was re-run with an async settle.** Do not encode yet; one occurrence. If a second survivor is misread, add the line to `~/.claude/agents/test-guard.md`.
3. **Screenshots: use device-metrics emulation, not `--window-size`, for phone widths.** Do not encode; first occurrence, small cost. If a second lane makes a headless shot, put it in `docs/testing.md` or the design handoff notes.
4. **Fix the contract comment (#250)** with the route the server mounts, and consider a test that compares comment paths to mounted routes. Do not encode the test; one drift so far.

## Highest-leverage next step

Make recommendation 1 a literal line in the architect's fence step, `~/.claude/agents/architect.md`, then `pnpm import-workflow --name current`: "for each file the issue replaces or deletes, `rg` its name and any value it returns across `**/__tests__/`; every hit is in the fence or has a named owner". It would have put both out-of-fence edits in the fence this time, and the same miss appears in at least four earlier retros.

## Open items for the PR body

- Gear 3, no shift. Two declared out-of-fence test edits: `client/hooks/__tests__/useAlertCount.test.ts`, `client/screens/__tests__/routes.test.tsx`.
- Dropped from the handoff for lack of data: tax card "Next payment" and "auto top-up". Added: a fifth ledger line (card debt). Hero prints `$0.00`.
- `/subscriptions` link has no route until issue 230.
- Follow-ups #249 (housekeeping), #250 (contract comment path).
- Not yet done: Hannah's visual check at 1040/390 and the real-data hero check (needs #27, #32, #30).
- Gate: tsc 0, lint 0, vitest 78 files / 2440 tests.

## Baseline narratives

These four are the text for the retro POST (`narrative_code_type`, `narrative_built`, `narrative_how`, `narrative_wrong`).

### narrative_code_type

A React screen with a client API module and a hook rewrite: the Overview (hero, ledger, cards, alerts, activity) reading the server's overview response. Gear 3.

### narrative_built

The Overview shows the chosen scope's hero, ledger, accounts and tax cards, alerts and activity from the overview route. The server is the only source of money; the client maps alert kinds to dots and links, composes alert text, and does presentation-only sums. `useAlertCount` now reads the same query for the shell badge. The client API uses `fetch` because the shell tests already stub it. Gate: tsc and lint clean, vitest 78 files / 2440 tests.

### narrative_how

Researcher, then architect, then the implementer on opus in one build commit. The reviewer found four things (three tests that client arithmetic would pass, and a failed dismissal's message that followed the user into another scope), fixed in one commit. brand-checker found nothing must-fix. test-guard ran 30 mutations and 2 survived; a haiku implementer fixed them in one commit. Screenshots came from headless Chrome against a scratch fixture API with invented data.

### narrative_wrong

Two test files outside the fence were forced by the change and were not foreseen by the issue. The lead passed test-guard's reading of a surviving mutation ("drop the redundant pending guard") on as an instruction; it was false, because the existing test asserted before the async PATCH, and the implementer proved the guard load-bearing by running the mutation with a settle wait. Three of the implementer's tests could not catch client-side arithmetic, and a failed dismissal's message leaked across scopes; review caught both. The first 390px screenshot looked broken because of Chrome's minimum window width, not the layout. The real-data hero check and Hannah's visual check are still pending.
