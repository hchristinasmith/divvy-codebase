# Retro: #42 prd04, a rules-only category agent that proposes categories from Hannah's corrections

## Retro summary (for the PR body)

#42 adds the category agent: a deterministic run that reads Hannah's category corrections, learns a rule per merchant when the net support (corrections that agree minus rejections) reaches N (default 2), and writes pending proposals to `category_proposals`. Confidence is net/(net+1) and the reason text carries no merchant text. The issue was written for Haiku plus rules; prd-04 Ruling 7 (2026-10-25) cut it to rules only, so there is no model call and no `prompt.ts`. Gate at `95a3ac6`: tsc 0, lint 0, vitest 124 files, 5180 tests. Gear 3, unchanged (new exports; no migration; nothing outside the fence). Review found one bug, an explicit `undefined` config field overriding its default; it is fixed with a test in `95a3ac6`. Four things are not fixed and are listed below as follow-ups. Not run, by the conductor's call: security-auditor and docs-syncer (no model call, and no doc describes the agent).

## What was built

- **Kind of code:** an agent module, `server/agents/category/{rules,read,agent}.ts` (522 lines) with three test files (1215 lines). `rules.ts` is the pure rule learner, `read.ts` the ledger and corrections reads, `agent.ts` the run: batch 500, trailing-run support, a cursor `{rules: fingerprint, after: id}` that resets when the rules change. A correction with `from === to` is neutral. A disabled agent writes no run row.
- **Fence versus files:** the issue's fence lists `prompt.ts` and `prompt.test.ts` (not created) and omits `read.test.ts` (created). Its line "ships in prd04-w2-behaviour" is superseded by this single-issue PR.

## What went wrong

1. **The scope cut arrived after the work.** The handoff asked for test-first with many extras and per-test mutation proof, and the implementer started a mutation-testing driver in scratch. Mid-lane Hannah (through the conductor) said lanes are overengineered: build to the Done-when tests only, no mutation testing. The driver was killed before it produced a result, but the tests were already written. 89 new tests shipped (30 rules, 9 read, 50 agent) for 8 Done-when lines. The cost is review and gate surface and a 737-line `agent.test.ts` that someone now has to maintain.
2. **Explicit `undefined` overrode a default.** `{...DEFAULTS, ...options.config}` lets a field passed as `undefined` replace its default. The reviewer found it, and `95a3ac6` fixes it with a test. Nothing in the plan or the tests had asked what an `undefined` field does.

## Root cause

**Scope was set by the handoff and the plan, and Hannah's cut came after the work.** The handoff stacked extras on the issue's Done-when (mutation proof, extra edge cases) without saying they were optional. The implementer did what was asked. The cut was right, but it cost nothing only if it comes before the first test is written. Item 2 is a one-off with a known cause (spread semantics) and is not a pattern.

## What worked well

- The lane built to Ruling 7, not to the issue text: no prompt module and no model call.
- Seats sized to the work: security-auditor and docs-syncer were skipped on stated grounds, not by default.
- The reviewer found a real bug in a small diff, and the fix went in its own commit.
- The fence held: nothing outside `server/agents/category/`. Four problems found along the way were surfaced as follow-ups and not absorbed (below).

## Follow-ups surfaced (not fixed; filed as Housekeeping)

- **Sweep restart (#411):** any rule change restarts the sweep at id 0, so a large backlog may never reach its high ids. #58 (the scheduler) must pass the changed ids.
- **Stale proposals (#410):** a pending proposal outlives the rule that made it. Fixing it needs a status writer in `server/agents/db/**`, outside the fence.
- **`errorClass` is now copy 12 (#412).** Lifting it to a shared place needs files outside the fence.
- **Strawb drawings (#413):** drawings rows in the strawb scope may get proposals. The insights agent excludes them through `loadDrawingIds`; this agent does not. Needs a decision on whether a category proposal on a drawing matters.

## Recommended changes

1. **A handoff lists the issue's Done-when and nothing else as required; extras are opt-in, named as extras.** Test-first and a test per Done-when line stay. Mutation proof and extra edge cases are written as "only if asked". Artifact: the conductor's handoff file (the `--handoff-file` for `baseline start`), set by the conductor. This is outside the lane's fence, and I did not find a template for it in the repo.
2. **Decide mutation testing once.** The #47 retro (item 5) said to watch it and consider mutation-first tests. Hannah has now said not to use it. Two retros pointing opposite ways should be settled in one line in `docs/testing.md`, by Hannah. I have not edited it.

## Highest-leverage next step

Change 1. A cut stated in the handoff costs one line, while the same cut mid-lane cost 89 tests that were already written for 8 Done-when lines.

## Baseline narratives (for the lane to post after `baseline finish`)

### narrative_code_type

A background agent module under `server/agents/category/`: a pure rule learner, ledger and corrections reads, and a run function that writes pending proposals to `category_proposals`. There is no model call, because prd-04 Ruling 7 cut it to rules only.

### narrative_built

`rules.ts`, `read.ts` and `agent.ts` (522 lines) with three test files (1215 lines; 89 tests). A rule is learned when net support (agreeing corrections minus rejections) reaches N (default 2); confidence is net/(net+1); the reason text carries no merchant text. Batch 500, trailing-run support, a cursor that resets on a rule change, and a disabled agent writes no run row. Gate: tsc and lint clean, vitest 124 files and 5180 tests.

### narrative_how

Researcher, architect, an opus implementer at high effort, the reviewer, test-guard, then the retro. Security-auditor and docs-syncer were skipped by the conductor (no model call; nothing in docs describes the agent). The review fix is its own commit, `95a3ac6`. Four out-of-fence problems were surfaced as follow-ups and not absorbed.

### narrative_wrong

The scope cut (rules only; no mutation testing) reached the lane after tests were written, so 89 tests shipped for 8 Done-when lines; a mutation driver was killed before it produced a result. The reviewer found that an explicit `undefined` config field overrode its default, now fixed. Not fixed: a rule change restarts the sweep at id 0, pending proposals outlive their rule, `errorClass` is now in 12 copies, and strawb drawings rows may get proposals.
