# Retro: #59 prd02 w4, the Sync screen (each bank connection's sync status and a Sync now button)

Gear 3 as stamped; no shift. The implementer ran on opus at `high`, as the CLAUDE.md table says for gear 3. One file outside the declared fence was edited and declared (below). `docs/retros/` is in this lane's fence. This file states no telemetry (model, duration, tokens, tool calls); the lane posts the four narratives after `baseline finish`.

Seats run, in order: researcher, architect (the plan is PR #323's first comment, posted before any code, via an empty plan commit and a draft PR), implementer (opus, build), reviewer (two rounds), brand-checker, test-guard, docs-syncer (no doc falsified), this retro. Every seat the gear 3 table lists ran, plus brand-checker because the diff is UI. No security-auditor: there is no server change. Verify passed on the final state: tsc exit 0, lint exit 0, vitest 4525 tests in 115 files (4522 at the build commit).

Commits (`git log --oneline origin/main..HEAD`): ded2eb6 (plan, no code), c6e9752 (build, with the reviewer's round 1 inside it), 3c986eb (round 2 fixes). The code diff is 16 files, +1944 / -6, most of it tests (`Sync.test.tsx` 642 lines, `sync.test.ts` 273, `fixtures.ts` 175, `syncState.test.ts` 171).

## What was built

- **Kind of code:** a client screen (`client/screens/Sync/`: sources card, one row per bank connection, footer, pure `syncState.ts` for the row's wording), a client API module (`client/apis/sync.ts`), and two hooks, `useSyncNow` (the button's mutation) and `useNow` (a minute tick so "x min ago" ages without a refetch).
- **Pattern:** the server's `/sync/status` body is the only source of state; the client only words it. The screen and the header pill read the same endpoint but cache different shapes, so the screen caches the full body under a sub-key of the pill's key and writes the parsed last-success time into the pill's key on every read. A press is held in the mutation cache (`useMutationState`), so it outlives leaving the screen.
- **Why not one shared key:** the handoff said the two would share `queryKeys.syncStatus.all`. The pill caches a bare number there and its test asserts that, so sharing would have made each overwrite the other. That was the one genuine fork (below).

## What happened

- **A handoff decision was wrong and was caught before any code.** The handoff said "same key". The lane read what the pill caches under that key (`useSyncPill.ts`) before dispatching anyone; the researcher confirmed it, including that `SyncPill.test` asserts a number there; the lane raised it to Baseline instead of picking. The first raise was refused with a 400: an option's `fence` field must be an object. The text was folded into the option's costs and re-raised. The conductor answered B and corrected its own handoff: full body under `[...syncStatus.all, 'screen']`, and every screen read writes the exported `parseSyncStatus(body)` into the pill's key, so the pill is never older than the screen.
- **One edit outside the fence, declared.** `client/screens/__tests__/routes.test.tsx` excludes built screens from its "every stub says not built" loop; Sync joined the list. Overview, Subscriptions and Advisor/Privacy each made the same edit.
- **Plan before code.** The architect's plan sat as the PR's first comment before the build started, so the reviewer and the retro can read intent separately from result.
- **Reviewer, two rounds.** Round 1 ran 18 mutations in a scratch copy; one survived: `Math.max(tick, dataUpdatedAt)` (ageing a late reply) had no test. A test was added, plus a count removed from a comment. Round 2 found: a failed run's time did not obey the pill's future-timestamp rule; a press did not survive leaving the screen (fixed with `useMutationState`); and brand classes (outline offset so the focus ring shows on pink, hover only when enabled, `min-w-0` on the grid track, time never wraps). Types used only in their own file stopped being exported. Round 2 is its own commit, 3c986eb.
- **test-guard:** 34 mutations, 32 killed.
- **docs-syncer:** no doc falsified. One stale code comment turned up outside the fence (`client/hooks/useSyncPill.ts` says its fetch "can move there with the Sync screen"); noted on #205.
- **Screenshots.** Vite with every `/api` route stubbed in Playwright (no server, no `.env`), five states at 390, 1040 and 1600 wide, 0 px horizontal overflow on all fifteen. Published as a private Artifact.
- **A sibling defect found.** The implementer's API module turns a 200 that is not JSON into a fixed message. The same input on Overview and Subscriptions puts a raw `SyntaxError` quoting the reply body on screen. The reviewer reproduced it (EXECUTED). Filed as #324.
- **Copies counted, not lifted.** The change adds another copy each of `call` (#249), the shared screen styles (#249), a `/sync/status` body parser (#199), and the minute tick. The lifts were fenced out; the copies are counted on the open issues.

## What went wrong

1. **The handoff named a shared query key without reading what it caches (Missed-by: plan).** The conductor wrote "same key" from the intent (prd-02 Done-when 4: pill and screen agree), not from the pill's code or its test. One read of `SyncPill.test` shows the cache holds a number. Cost: one Baseline decision round, one refused raise, a corrected handoff. Caught before any build work, so the cost was small; the lane caught it on its first read of the pill, and the researcher confirmed it.
2. **The implementer broke code in the worktree to prove its tests (Missed-by: do).** Seven mutations were applied inside the worktree, against the handoff rule that deliberate breakage happens only in a scratch copy. It restored the files and `diff -q` showed none changed, and the lane checked the tree before review, so nothing leaked. The reviewer and test-guard did theirs in scratch copies. The record shows the rule was in the handoff; it does not show that the implementer's dispatch prompt repeated it, and `~/.claude/agents/implementer.md` does not contain it. Cost: a tree check, and exposure to a half-reverted file that did not happen.
3. **Review fixes landed inside the build commit (Missed-by: plan).** The reviewer ran on the working diff before the first code commit. The Sync files were new and untracked, so round 1's fixes edited the same untracked files and `git add -p` had nothing to split. The CLAUDE.md commit table says review fixes are a separate commit; here only round 2 is. This is the second time: the #134/#148 bundle retro has the same sentence, and #45, #46 and #229 avoided it by reviewing committed work. Cost: the second reader cannot see round 1 as a response.
4. **A wrong branch name from the session snapshot.** The lane's own snapshot said `feature/sync-screen`; the branch was already `feature/59-sync-screen`. The first push used the wrong local name and failed. Harmless. Likely cause: this worktree directory is named `sync-screen`, without the issue number the project CLAUDE.md puts first in the path (`<issue>-<slug>`), so the name was guessed from the directory. Not confirmed from the record.
5. **A recurring out-of-fence test edit (Missed-by: plan).** The "every stub" loop in `routes.test.tsx` needs a new exclusion for every screen that replaces a stub. This is at least the fourth screen to take that edit. The #45 retro recommended an architect step for it; `~/.claude/agents/architect.md` has no such line today. Cost per occurrence: one declared edit, low.
6. **A tool schema learned by failure.** The `baseline decide` file was refused with a 400 over the `fence` field's type. Cost: one retry. First occurrence.

## Root causes

- **A decision written from intent, not from the code it constrains.** The conductor's handoff fixed an implementation detail (the key) whose correctness depends on a shape in another file. The check is cheap (`rg` the key, read what each reader stores) but nothing in the handoff step asks for it. Symptom: failure 1.
- **A rule that lives in one handoff and nowhere durable.** "Breakage only in a scratch copy" is stated in the handoff text, not in `implementer.md`, so it applies only if the dispatch prompt repeats it. Reviewer and test-guard followed it; the implementer did not. Symptom: failure 2.
- **Review is sequenced before commit, and new files have no earlier state.** Pipeline step 5 says review before gate and commit; the commit table says review fixes are separate. For a change made of new files these conflict. Symptom: failure 3 (and #134/#148 before it).
- **A fence that cannot see its consumers.** Unchanged from the #45 retro: the issue's fence is written before anyone greps for who pins the thing being replaced. Symptom: failure 5.
- Failures 4 and 6: unclear / tooling; no deeper cause found in the record.

## What worked, keep it

- **Raising the fork instead of choosing.** The lane saw the contradiction between the handoff and the pill's code, had the researcher confirm it against the pill's test, stopped, and asked. Choosing "same key" would have gone green on the new tests and broken `SyncPill.test`; choosing otherwise silently would have overridden the handoff. The conductor corrected its own decision without defending it.
- **Plan posted before the build.** An empty plan commit and a draft PR make the plan visible without a code diff to wade through.
- **Mutation proof in scratch copies by the reviewer and test-guard.** Between them 52 mutations; the survivor list is short and specific (`Math.max(tick, dataUpdatedAt)`), and each survivor got a test.
- **Screenshots with every route stubbed.** No server, no `.env`, no tokens; five states at three widths with an overflow number per shot, so "looks fine" is a measurement.
- **Not widening the fence for a sibling defect.** The raw-parse-error bug was reproduced, filed and left alone.

## Surfaced, not absorbed

- **#324** Overview and Subscriptions show a raw JSON parse error on a 200 that is not JSON. `Missed-by: review`, `Priority: housekeeping`, `Spawned-by: #59`.
- **#325** the header pill stays green after a failed sync while the screen says "Last sync failed"; a design call. `Missed-by: none`, `Priority: housekeeping`, `Spawned-by: #59`.
- **#326** the footer says "every 15 min" whatever the scheduler's interval is, and the server's next-run time can be null. `Missed-by: none`, `Priority: housekeeping`, `Spawned-by: #59`.
- Copies counted on #249 (`call`, screen styles) and #199 (the status parser); the stale pill comment on #205.

## Recommended changes

1. **Commit the build before the reviewer runs, whenever the diff is new files.** Second occurrence (#134/#148, #59), so encode now. Add to the lane's review step: "if the change is new files, commit the build first; the reviewer reviews the commit and its fixes are a second commit". File: `~/.claude/agents/implementer.md` (its report-back step) and the Pipeline step 5 line in `~/.claude/CLAUDE.md`, then `pnpm import-workflow --name current`. High leverage: it is the only way the commit table's "review fixes separate" row holds for new-file work.
2. **Put the scratch-copy rule in the implementer's own file.** "Deliberate breakage (mutations, red demos) is done in a copy outside the worktree; never edit tracked or untracked files in place to prove a test." File: `~/.claude/agents/implementer.md`. One occurrence here, but the rule already exists in handoffs, so this moves it rather than inventing it. Optional; do it with item 1 in the same import so one file changes once.
3. **Handoff step for a conductor: when a handoff names a shared cache key, file or symbol, read each reader's stored shape and test first.** One line in the lane handoff checklist (the `parallel-agents` skill's handoff section). First occurrence; do not encode yet. Revisit on a second.
4. **Make the "every stub" loop in `routes.test.tsx` stop needing an edit per screen.** This is the fourth occurrence, so change code rather than add another reminder: derive "built" screens from the route table (a screen is a stub if it renders the shared stub component), or have each built screen register itself. File: `client/screens/__tests__/routes.test.tsx`, as its own small issue (Housekeeping). The alternative, the #45 architect line, never landed in `~/.claude/agents/architect.md`.
5. **Do not encode:** the `baseline decide` `fence` type (one retry, first occurrence); the branch-name guess (harmless, cause unconfirmed). If a lane again guesses a branch from its directory, make `baseline start` print the branch.

## Highest-leverage next step

Item 1: in `~/.claude/agents/implementer.md` and the Pipeline step 5 text in `~/.claude/CLAUDE.md`, require the build to be committed before the reviewer is dispatched when the change is mostly new files, then `pnpm import-workflow --name current`. It has now cost a separate review-fix commit twice, and it is a one-line change.

## Open items for the PR body

- Gear 3, no shift. One declared out-of-fence edit: `client/screens/__tests__/routes.test.tsx` (Sync added to the built-screens exclusion).
- Shared query key departed from the handoff by decision (Baseline decision, answered B); the screen writes the pill's key on every read.
- Round 1 of review is inside the build commit (untracked new files); round 2 is its own commit.
- Follow-ups #324, #325, #326; copies counted on #249 and #199; stale comment noted on #205.
- Gate: tsc 0, lint 0, vitest 4525 tests in 115 files.
- Retro POST: after `baseline finish`, from the four narratives below.

## Baseline narratives

These four are the text for the retro POST (`narrative_code_type`, `narrative_built`, `narrative_how`, `narrative_wrong`).

### narrative_code_type

A React screen with a client API module and two hooks: the Sync screen showing each bank connection's sync state and a Sync now button, reading the server's sync status. Gear 3.

### narrative_built

The Sync screen lists each bank connection with its last sync state and time, a Sync now button, and a footer. The server's status body is the only source of state; the client words it and ages "x min ago" with a minute tick. The header pill and the screen read the same endpoint but cache different shapes, so the screen caches the full body under its own sub-key and writes the parsed last-success time into the pill's key on every read. A press is held in the mutation cache, so it survives leaving the screen. Gate: tsc and lint clean, vitest 4525 tests in 115 files.

### narrative_how

Researcher, then architect (the plan was posted as the draft PR's first comment before any code), then the implementer on opus in one build commit. One fork went to Baseline: the handoff's shared query key contradicted the pill's test; the answer was a sub-key plus a write into the pill's key. The reviewer ran two rounds (18 mutations, one survivor; then a failed-run time rule, a press outliving the screen, and brand classes). test-guard ran 34 mutations and 32 were killed. Screenshots were taken with every API route stubbed, five states at three widths, with no overflow.

### narrative_wrong

The handoff said the screen and the pill share one query key without checking that the pill caches a bare number there; the lane caught it on reading the pill, before any code. The implementer proved its tests by breaking code inside the worktree seven times, against the rule that breakage happens in a scratch copy; files were restored and checked, and the rule is not in the implementer's own agent file. Round 1 of review landed inside the build commit because the files were new and untracked, the second time this has happened. A branch name guessed from the worktree directory failed its first push. The routes test needed its usual one-line exclusion for a newly built screen, for at least the fourth time. A sibling bug (raw JSON parse error on Overview and Subscriptions) was filed as #324 rather than fixed.
