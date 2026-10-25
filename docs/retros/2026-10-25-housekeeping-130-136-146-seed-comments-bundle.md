# Retro: #130, #136 and #146 Housekeeping bundle (seed category columns, stale cents comments, .gitignore)

Bundle of three issues in one lane, one PR. #136 is stamped gear 1 (comments only); #130 and #146 carry no gear line and the handoff called the bundle gear 1-2; no trigger fired, so no shift. The implementer ran on haiku, twice. Seats, in order: implementer (#130), reviewer, test-guard, implementer (#136, #146), reviewer, test-guard. No architect (gear 1-2). `second-opinion` was not run: it needs a PR number and none existed when the seats ran. Commits: 395b8af (#130), 2fd7260 (#136), fdfa308 (#146). Gate green at each commit: `tsc` 0 errors, lint 0, vitest 47 files / 1146 tests. Merge with `--merge`, not `--squash`, so per-issue commits survive (project CLAUDE.md, small-issues table). This file does not state Baseline telemetry (model, duration, tokens, tool calls).

## What was built

- **Kind of code:** one seed fix with a test (#130), a comment rewrite across three files (#136), and three lines of `.gitignore` (#146).
- **#130:** `toRow` in `server/db/seeds/transactions.js` now writes `akahu_category_id`, `_name`, `_group_id` and `_group_name` from the fixture's Akahu category, beside the legacy `category_*` columns (4 lines). The seed runs after `migrate:latest`, so the #19 backfill never saw its rows and a freshly seeded database had the new columns NULL. The test (`server/db/seeds/__tests__/transactions.test.ts`, +45) seeds, reads every row, and compares the four `akahu_category_*` columns to the four `category_*` columns as one whole-set `toEqual` keyed by `akahu_id`, so a mismatch names its row. A non-vacuity line first asserts that at least one legacy `category_id` is not NULL, so an all-NULL legacy column cannot make the comparison pass with nothing compared. The existing `toMatchObject` was also extended with the four fields.
- **#136:** comments in `models/akahu.ts` (+7/-3), `server/db/seeds/transactions.js` (+4/-2) and `shared/money.ts` (+13/-6) now say that the sync reads Akahu amounts as exact text and converts them through `exactAmountToCents` (`shared/exact-json.ts`) then `parseDollars`, and that `dollarsToCents` is the seed's float path only. No code moved.
- **#146:** `.gitignore` gains `*.sqlite3-*`, `.env.*` and `!.env.example`.

## What happened

1. **#130, test first.** The implementer wrote the every-row equality test and the non-vacuity guard before the fix. On the old seed it was red, 2 failed / 9 passed (`akahu_category_*` NULL against a value in the legacy columns). After the 4-line `toRow` change it was green. That is the proof the test measures the fix.
2. **#130, review.** The reviewer ran four mutations: a wrong field, one row left NULL, one row given a wrong value (row 049), and the legacy column all NULL. The one-row wrong value on row 049 was caught only by the new all-rows test, because the extended `toMatchObject` looks at row 002 alone. The all-NULL legacy mutation was caught by the non-vacuity line. 0 findings. test-guard: covered and gated.
3. **#136, first wording was wrong.** The implementer's first draft said `server/sync/akahu-client.ts` handles "live data". The reviewer checked and found it false (EXECUTED: `git grep createAkahuClient origin/main` finds only the definition). The sync client has no production caller yet. Today's live data goes Dashboard to `server/routes/akahu.ts`, which passes raw float dollars through. The reviewer reworded to "the sync" and named `exactAmountToCents` as the step before `parseDollars`: the issue text said `akahu-client` calls `parseDollars` directly, and since #135 it goes through `shared/exact-json.ts`.
4. **#136, comment-only proof.** The reviewer proved the diff touches comments only with a TypeScript printer: with comments removed, the three files print identical to HEAD; one-token controls differ, so the check can fail. That is stronger than reading the diff.
5. **#136, where the fix landed.** The reword was made in the working tree before the commit, so it sits inside 2fd7260. There is no separate review-fix commit, and a later reader cannot see the wrong first wording in history. Only this retro records it.
6. **#146.** Checked with `git check-ignore` on made-up paths only. No real `.env` and no database file was created. The handoff prompt told the implementer that `git check-ignore -v .env.example` would exit 1. It does not: with `-v` git prints the matching negation rule (`!.env.example`) and exits 0. The plain form, without `-v`, exits 1 for a path that is not ignored. The implementer ran both forms, reported the mismatch, and confirmed "not ignored" three ways: the plain form exits 1, an uncovered control path exits 1, and `git add --dry-run .env.example` succeeds.

## What went wrong

- **A claim in a comment was written without running anything.** "`akahu-client.ts` handles live data" was the implementer's wording and it was wrong: nothing calls `createAkahuClient`. A single `git grep` would have shown it. The reviewer caught it before commit, so the cost was one rewording, not a wrong comment on `main`. Do seat.
- **The issue's premise was stale.** #136 said `akahu-client` calls `parseDollars` directly. #135 had since put `exactAmountToCents` in front of it. The comment would have been wrong about the path on the day it merged. Found by the reviewer. Plan seat (slicing).
- **The handoff stated a command result that was not true.** `git check-ignore -v` on `.env.example` exits 0, not 1. The record shows no rework from it, so the cost is the risk: a "not ignored" check built on the handoff's version would pass or fail for the wrong reason. Plan seat (the conductor's prompt).
- **The review fix is invisible in history.** Making it before commit was fine for the gate, but the commit table in the user's CLAUDE.md wants review fixes separate so the second reader sees only the response. Here the first wording never reached a commit, so nothing is lost for the code, but the lesson lives only in this file. Minor.
- **Nothing else went wrong that I can point at.** No red gate, no retried round, no abandoned approach.

## Root causes

- **Plan claims about behaviour go past what was run.** Recurrence of the cause named in the #20 and #135 retros. Here it appears twice: the implementer's "handles live data" (nothing ran `git grep` for callers) and the handoff's `check-ignore -v` exit status (nobody ran it). Both were facts about a tool or the codebase that one command settles.
- **Issue premises are not checked at slicing.** Second occurrence; the first was #135 ("the two regexes are identical"). #136's "calls `parseDollars` directly" was true when the issue was written and false by the time the lane ran, because #135 merged in between. A premise about code has a date, and the issue did not carry one.
- **A comment is a claim about the codebase, and comment-only issues get no test.** #136 had no failing test to write, so the only gate on its accuracy was the reviewer. That gate worked, but it is a person-shaped check on a fact a grep could produce.

## What worked, keep it

- **Test first, red on the old behaviour, then the fix** (#130). 2 failed / 9 passed on the old seed gives a number to point at.
- **A non-vacuity guard beside an equality test.** The all-NULL legacy mutation is exactly the case an equality test passes for free. It was killed by one line.
- **A whole-set comparison keyed by `akahu_id`** instead of a loop of expects. A single mismatching row shows its id in the diff, and row 049 was caught where the extended `toMatchObject` (row 002 only) was not.
- **Mutations by a seat that did not write the code.** The row-049 mutation is the reviewer's, not the author's.
- **Executed evidence for a comment.** `git grep createAkahuClient origin/main` turned "handles live data" from an opinion into a finding, and the TypeScript printer turned "comments only" into a checked statement with controls that can fail.
- **Checking `.gitignore` with `git check-ignore` on made-up paths.** The patterns were exercised without creating a real `.env` or a database file.
- **Surfacing, not absorbing.** Four things outside the fence were noticed and left (below).

## Recommended changes

1. **Second occurrence of the unchecked issue premise, so encode it. High leverage.** A comment-only or "stale text" issue must name, for each claim it asks the lane to write, the command that shows it (`git grep` for callers, the file and line for a call path), run on current `main` at dispatch. Artifact: the issue template the slicing seat uses; I could not find its path in the record, so the conductor should point at it. Conductor edit.
2. **Handoff prompts quote command results only after running them.** A line like "this exits 1" in the lane prompt is a claim of the same kind as a plan claim. First occurrence in this form (third for the wider cause), so record only. Candidate file when encoded: the lane handoff template.
3. **Verify "not ignored" by exit status of the plain `git check-ignore <path>`, never `-v`.** First occurrence; record only. If it recurs, one line in the Security or gitignore section of `docs/testing.md`, or a small check in the repo's lane notes.
4. **Optional: commit the comment-only proof as a script,** for example `scripts/comment-only-diff.mjs`, that prints a TypeScript or JS file with comments stripped for two refs and fails if they differ. It was ad hoc here and will be needed again for every comment-fix issue. Optional, first occurrence.
5. **Surfaced items to file as follow-ups, all housekeeping unless Hannah rules otherwise** (the lane does not file them, and each is outside the fence):
   - `shared/money.ts` line 1, "Money is integer cents everywhere Divvy stores or computes it", is false today: the Dashboard does float math on proxy data (`Txs.tsx:42`, `TxAnalysis.tsx:15`). #32 should end it.
   - `models/akahu.ts` still says "Money here is float dollars" about types owned by #133.
   - `.gitignore` lists `/dist` twice.
   - The sync client has no production caller yet; that is lane #21's concern.

## Highest-leverage next step

Add recommendation 1 to the slicing seat's issue template: every claim a comment issue asks for carries the command that shows it, run against current `main`. It is the only item here that has now recurred (#135, #136), and it would have stopped both the stale `parseDollars` premise and the first "live data" wording before the lane started.

## Open items for the PR body

- Bundled PR: merge with `gh pr merge <N> --merge --delete-branch`, then close #130, #136 and #146 by hand with a reason.
- #136 is comments only, proved with a TypeScript printer (comments removed: identical to HEAD; 1-token controls differ).
- The sync client has no production caller (`git grep createAkahuClient origin/main`: the definition only). The new comments say "the sync" and do not claim it handles live data.
- Surfaced and not absorbed: the four items in recommendation 5. Any follow-up filed from them names its origin, `Spawned-by: #136` or `#130`, with `Missed-by` as the filer judges.
- `.gitignore` was checked with made-up paths only; no real `.env` or database was created.

## For Baseline (four fields)

- **narrative_code_type:** a seed fix with a test, a comment-only rewrite, and a `.gitignore` change, bundled in one lane (#130 gear 2, #136 and #146 gear 1).
- **narrative_built:** `toRow` in the transactions seed now writes the four `akahu_category_*` columns beside the legacy `category_*` columns (4 lines), with a test that compares them on every seeded row and a non-vacuity guard. Comments in `models/akahu.ts`, `server/db/seeds/transactions.js` and `shared/money.ts` now say that the sync converts Akahu amounts through `exactAmountToCents` then `parseDollars`, and that `dollarsToCents` is the seed's float path only. `.gitignore` gains `*.sqlite3-*`, `.env.*` and `!.env.example`. The gate is 47 files, 1146 tests, green at each of the three commits.
- **narrative_how:** a haiku implementer ran twice, each followed by the reviewer and test-guard; no architect, because the work was gear 1-2. For #130 the test was written first and went red on the old seed (2 failed / 9 passed), then green after the 4-line fix. The reviewer ran four mutations and only the new all-rows test caught the wrong value on row 049. For #136 the reviewer proved comment-only with a TypeScript printer. For #146 the lane used `git check-ignore` on made-up paths only. Three commits, one per issue.
- **narrative_wrong:** the implementer's first #136 wording said the sync client handles "live data"; nothing calls `createAkahuClient` yet (`git grep` finds only the definition), and live data goes through `server/routes/akahu.ts` as raw float dollars. The reviewer caught it and the fix went into the #136 commit with no separate review-fix commit. The issue text also said `akahu-client` calls `parseDollars` directly, which stopped being true when #135 landed. The handoff said `git check-ignore -v` on `.env.example` exits 1; with `-v` it exits 0, and only the plain form exits 1. Root causes: plan claims going past what was run (recurrence), and issue premises not checked at slicing (second occurrence). `shared/money.ts` line 1 ("integer cents everywhere") is still false and was surfaced, not fixed.
