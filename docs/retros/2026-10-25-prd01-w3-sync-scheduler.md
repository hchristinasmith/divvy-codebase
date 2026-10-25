# Retro: #27 prd01 w3, the scheduler runs syncs every 15 minutes and exposes sync status

Gear 4 as stamped; no shift in gear. The issue said `model: sonnet`; the implementer ran on opus, as CLAUDE.md's table says for gear 4. The fence moved once, with Hannah's consent (decision 4095a681): the mount went into the `/api/v1` barrel instead of `server.ts`. This file states no telemetry (model, duration, tokens, tool calls); the lane posts the four narratives after `baseline finish`. I wrote the file only: nothing committed, pushed or posted.

Seats run, in order: architect, the lane's three open questions decided, implementer (opus), a blocking decision to Hannah, then security-auditor and reviewer in parallel while that decision waited, then test-guard and docs-syncer, then this retro. Verify: the dispatch for this retro did not say it had passed, so I re-ran the gate on the final tree: `tsc --noEmit` clean, lint clean, 53 test files and 1283 tests passing. Working tree clean.

Commits (3, from `git log --oneline origin/main..HEAD`): 2aff7e7 scheduler, f0e6190 routes plus barrel mount, e5bdfe5 `index.ts` starts the scheduler. 7 files, 1343 lines added and 1 changed: `scheduler.ts` 193, `routes/sync.ts` 141, `scheduler.test.ts` 597, `sync.test.ts` 405, `server/index.ts` +4, `routes/index.ts` +2, `barrel.test.ts` one line. `server/server.ts` is untouched.

## What was built

- **Kind of code:** the prd-01 wave 3 scheduler and its API: an in-process interval scheduler (`server/sync/scheduler.ts`) around `runSync`, and two routes (`GET /api/v1/sync/status`, `POST /api/v1/sync/run`) mounted in the route barrel.
- **Pattern:** a module singleton `syncScheduler`, created unstarted; only `server/index.ts` calls `start()`, after `listen`, so importing the app in a test starts no timer. One in-process guard, the `current` promise set synchronously before anything is awaited, is shared by the timer tick and the POST, so a second caller is refused without writing. `running` comes from that flag, not from the database, so a `running` row left by a dead process does not show as a sync in progress. `lastSuccessAt` is the newest success row's `finished_at`. `SYNC_INTERVAL_MS` is digits only with a 60 s floor; anything else falls back to 15 minutes with one fixed warning. The POST is gated by `Sec-Fetch-Site` first and `Origin` against `Host` only when that header is absent.
- **Why that shape:** the contested choice was the "sync now" cross-site check. The plan used `Origin` against `Host`; that would have refused the button under `npm run dev` (below), so the browser's `Sec-Fetch-Site` decides first.

## What happened

- The architect planned the singleton, the shared guard, `running` from the flag only, `lastSuccessAt = finished_at`, and an Origin check on POST. The lane answered its three open questions itself: no run at boot, an invalid `SYNC_INTERVAL_MS` falls back with a fixed warning, and the Origin check is in.
- The implementer built inside the fence and broke the code seven ways on purpose; every break turned a test red. Its mount in `server.ts` then turned `server/routes/__tests__/barrel.test.ts:137` red: that test requires `server.ts` to mount only the `/api/v1` barrel. #43 (PR #94) added the test after #27's fence ("one mount line in `server.ts`") was written. The implementer prepared the barrel variant (53 of 53 files green), reverted it, and surfaced the conflict instead of editing outside the fence.
- The lane raised decision 4095a681 with `baseline decide --block`. The first attempt was refused with a 400 (`body/options/0/fence must be object`): the lane had passed `fence` as an array of paths. It moved the paths into `costs` and re-raised. Hannah picked A: mount in the barrel (`server/routes/index.ts` plus `'sync'` in `barrel.test.ts` `EXISTING`), `server.ts` untouched. The wait was about 10 minutes, and security-auditor and reviewer ran in parallel during it.
- security-auditor: no credential leak and no wedged guard, from executed probes (sentinel credentials; 20 concurrent POSTs). Its W2: the lane's own Origin check would answer 403 to "sync now" under `npm run dev`, because `vite.config.js` uses the string proxy form (`'/api': 'http://localhost:3005'`), which Vite expands with `changeOrigin: true`, rewriting `Host`. The plan had asserted that Vite's dev proxy has no `changeOrigin` without checking.
- The reviewer fixed W2 inside the fence (`Sec-Fetch-Site` decides first, Origin-versus-Host as the fallback) and checked it through a real Vite proxy: 403 before, 202 after. It also added a test for the 500 path and a `try/finally` that stopped one failure from spreading to seven unrelated route tests. Follow-ups filed: #174 DNS rebinding and a Host allowlist, #175 a "sync now" cooldown, #176 SIGTERM leaves a `running` row and POST says started when `runSync` skipped, #177 a JSON error handler (a stack trace shows outside production).
- test-guard: covered and gated, with two gaps. Removing `timer.unref()` survived; it is fixed with a `hasRef` test that goes red when the line is removed. `syncScheduler.start()` in `index.ts` had no test, and a test there is outside the fence, so the lane did a manual boot check: on a scratch production database with empty credentials and `SYNC_INTERVAL_MS=60000`, the 60 s tick wrote a failed `akahu_missing_credentials` row, "sync now" returned 202, a cross-site POST returned 403, and status showed a non-null `nextRunAt`.
- docs-syncer fixed one comment in `sync.ts` (a leftover `running` row is closed only after 30 minutes) and found stale docs outside the fence. It filed them as #179: the `models/sync.ts` `SyncRun` "at boot" comment, `.env.example`, the README, and the prd-01 Ruling 6 note.
- Each intermediate commit was gated in a temporary worktree, with no stash.
- `fly.toml` has no machine-count key and no services. The single machine is held only by a comment and `fly deploy --ha=false`; enforcing it is #22's.

## What went wrong

1. **The fence contradicted the codebase.** The issue's fence was sliced before the barrel existed and was not re-checked when it landed. Cost: the implementer built, mutation-tested, prepared a variant, reverted it and stopped; one blocking decision and about 10 minutes of waiting, which review partly covered. No wrong code shipped, and the implementer's stop was the right call. The gate found the conflict, not the plan or the dispatch.
2. **The plan stated a tool fact without running it.** "Vite's dev proxy has no `changeOrigin`" was false for the string proxy form. The lane's decision to keep the Origin check was made on that premise. Had the auditor not run, "sync now" would have returned 403 under `npm run dev`, the one way Hannah would press it while developing. Cost: a reviewer round on a design correction. The Origin-versus-Host fallback that remains still leaves the DNS-rebinding hole (#174).
3. **The author's seven breaks missed `timer.unref()`.** All seven were red, and test-guard still found a surviving mutation. It is a small instance of a known family, and it is the kind that a mutation list written "from the code just written" misses: a call whose only effect is on process lifetime.
4. **`syncScheduler.start()` in `index.ts` has no regression test.** The line is the only place the scheduler starts, so deleting it leaves every test green and no sync ever runs in production. A test there is outside the fence; the manual boot check is real evidence but cannot repeat. The record has no issue for it.
5. **The `baseline decide` call was malformed again.** `fence` was passed as an array; w2's refused calls passed a string. Same field, same 400, one failed call and a re-raise. The CLI's `--help` lists "optional fence" with no type, and the lane found the rule only from the error.
6. **Review fixes could not be a separate commit.** The reviewer edited the same uncommitted files the build was in, and the lane may not stash. So the Sec-Fetch-Site logic, the 500-path test and the `try/finally` are inside the three feature commits. This misses the "review fixes separate from the build" commit rule; a second reader of f0e6190 cannot see the response to findings apart from the build.
7. **The reviewer found two gaps the author's tests left.** The 500 path had no test, and a failing test spread to seven unrelated route tests because cleanup was not in a `finally`. Both were fixed in the fence. Same family as item 3: the author's checks did not include the failure path of the thing just written.
8. **Accepted gaps, named so nobody finds them later.** A 202 can precede a `runSync` that returns `skipped`; fixing it needs `run.ts`, which is negative-fenced (partly #176). A `runSync` rejection leaves no `sync_runs` row, because the contract has no field for it; the scheduler logs the error's class name only. The record has no issue for the second.

## Root causes

- **Fence written against a codebase that moved (item 1).** The fence was cut when `server.ts` mounted routers directly, and a later PR added a test that makes the mount line illegal. Nothing between slicing and dispatch asks whether the files the fence names still match what the tests on them require. By its exact name this is a first occurrence; it is the same family as the fence-gap retros the w2 retro cites (#68, #78, #19), where the plan covered the thing and missed what else constrains it. I did not re-read those three.
- **A tool or config fact stated from belief (item 2).** The architect said what Vite does without running it. This is the third appearance of the pattern: #20's tokenizer claim, w2's SQLite bind limit (named there as a single occurrence, "do not encode yet"), and now Vite. It has crossed the line for encoding. It matters more here because a security design (the Origin check) rested on it.
- **Author-chosen mutations share the author's blind spots (items 3, 4, 7).** Fifth occurrence of the family w2 counted as four (Xero float grep #34, currency regex #102, Akahu client guards #20, chunking and ordering #21). This time the gap is side-effect lines and failure paths, not guards. `~/.claude/agents/implementer.md` still has no "looser" or "mutation" text (a grep returns 0), so the recommendation that w2's retro called the highest-leverage step had not landed when #27 was built.
- **The decision schema is not in the help text (item 5).** Second occurrence: w2's refusals were a string, this one an array, both for `fence`. w2 wrote "if the string form recurs, add an example to the decision template." It recurred in a different type, which says the type is the missing information, not one wrong guess. I found no decision template under `~/.claude`.
- **Two pipeline rules that cannot both hold (item 6).** Pipeline step 5 puts the review before the commit; the commit table wants review fixes separate. They only both hold if the build is committed before the reviewer edits, or the reviewer reports instead of editing. First occurrence, since w2 landed its fixes as d5d7d61 separate from the build; so a tension, not yet a pattern.
- **Unclear:** why the architect did not read `server.ts` against `barrel.test.ts`. The record does not say whether it read them. I am not assigning a cause.

## What worked, keep it

- **The implementer stopping on a red it could not fix in the fence.** It prepared the variant, showed 53 of 53 green, reverted, and surfaced the conflict. Hannah decided with the cost in front of her, and no out-of-fence edit had to be undone.
- **Reviewer and security-auditor in parallel while the decision waited.** About 10 minutes of waiting produced the W2 finding and the proxy fix.
- **EXECUTED, not REASONED, on the findings that mattered.** The auditor's sentinel-credential probes and 20 concurrent POSTs, and the reviewer's real Vite proxy check (403 before, 202 after), settled the questions that a reading of the code would only have argued.
- **The lane deciding its three small questions in the plan,** so that only the real fork reached Hannah.
- **A manual boot check where a test was out of fence.** The scratch production database run exercised the real tick, the real 202 and 403, and a non-null `nextRunAt`. It was reported as manual, not counted as a test.
- **Gating every intermediate commit in a temporary worktree,** so the commit history is green at each point and no stash was used.
- **Filing out-of-fence stale docs (#179) and review findings (#174 to #177) instead of absorbing them,** and docs-syncer limiting itself to one in-fence comment. This is the w2 docs-syncer lesson holding.
- **Seats that did not write the code earning their cost again:** the auditor and reviewer found the design miss, and test-guard found the surviving `unref`.

## Surfaced, not absorbed

- **#174** DNS rebinding and a Host allowlist.
- **#175** a "sync now" cooldown.
- **#176** SIGTERM leaves a `running` row; POST says started when `runSync` skipped.
- **#177** a JSON error handler (stack trace outside production).
- **#179** stale docs outside the fence: the `models/sync.ts` comment, `.env.example`, the README, the prd-01 Ruling 6 note.
- **#22** enforcing a single machine in `fly.toml` (existing issue; named here, not filed by this run).
- **Not filed in the record I read:** no regression test for `syncScheduler.start()` in `index.ts` (item 4); and a `runSync` rejection leaves no row (item 8). The conductor decides whether either needs an issue and which milestone passes the phase test.

## Recommended changes

1. **Land the implementer rule, widened.** In `implementer`'s checklist: the mutation list is written from a list of every guard and every side-effect call the change adds (`unref`, `clearInterval`, `close`, `listen`, a log line), with a case that goes red when each is deleted; every guard has a case that fails under its next-looser form; and every new handler has a test for its failure path with cleanup in `finally`. Artifact: `~/.claude/agents/implementer.md`, then `pnpm import-workflow --name current`. High leverage; fifth occurrence, and the first two recommendations were never made.
2. **Check a stated tool fact before it enters a plan.** In `architect`'s rules: a plan sentence that says what a tool, proxy, config or library does or does not do carries the command whose output shows it, or is marked REASONED and becomes the implementer's first check. Here the check was one line, `grep -n proxy vite.config.js`, plus knowing the string form expands to `changeOrigin: true`, or a request through a real proxy. Artifact: `~/.claude/agents/architect.md`. High leverage; third occurrence.
3. **Dispatch-time fence check.** Before a lane is dispatched from a fenced issue, the conductor runs `git log --oneline origin/main --since=<issue's slice date> -- <fence paths>` and `grep -rn "<fence file name>" --include=*.test.ts server client`; any hit means the fence is re-read against it before the handoff goes out. Artifact: the dispatch step in `~/.claude/skills/slice-issues/SKILL.md`, and the "Worktrees and lanes" section of Divvy's `CLAUDE.md` (project root) as one line. Medium to high; cheap, and it would have found `barrel.test.ts` before the implementer did.
4. **Say the type of `fence` in the decision schema.** The `baseline decide --help` text should name `fence` as an object and give its shape, and the repo should ship one example decision file. Until then, a line in the decision paragraph of `~/.claude/CLAUDE.md`: "omit `fence`; put file paths in `costs`." I could not see the object's shape in the help text, so I do not state it. Artifact: the Baseline CLI help (path to be named by the conductor) and `~/.claude/CLAUDE.md`. Second occurrence; encode.
5. **Do not encode yet:** the review-then-commit tension (item 6). If it recurs, pick one rule in `~/.claude/CLAUDE.md` pipeline step 5: the reviewer reports and the implementer applies the fixes as their own commit, or the gated build is committed before the reviewer edits. Single occurrence.
6. **Do not encode yet:** the missing `start()` regression test. It needs a fence decision first (a test importing `server/index.ts` with `listen` mocked, or a small extraction); that is the conductor's issue to file.

## Highest-leverage next step

Add the widened mutation rule (recommendation 1) to `~/.claude/agents/implementer.md` and import it. It has been named in three consecutive retros (#20, #21, #27) as the cause of surviving mutations and review-found gaps, and each time the author's own checks passed while a later seat did the catching. It is the only fix on this list that has already been written down once and not applied; the next retro that names the same cause will be the sixth. Recommendations 2 and 3 come next, because they prevent a stop and a design miss at the front of the run, not the back.

## Open items for the PR body

- The scheduler mounts in the `/api/v1` barrel, not `server.ts` (Hannah's decision 4095a681, option A); `barrel.test.ts` `EXISTING` now includes `'sync'`.
- First run is one interval after boot (no run at boot); an invalid `SYNC_INTERVAL_MS` falls back to 15 minutes with a fixed warning; the floor is 60 s.
- POST `/api/v1/sync/run` is cross-site checked by `Sec-Fetch-Site` first, `Origin` against `Host` as a fallback; the Vite dev proxy rewrites `Host`, which is why `Sec-Fetch-Site` goes first.
- A 202 can precede a `runSync` `skipped`; a `runSync` rejection leaves no row. Both accepted.
- Single machine is by comment and `fly deploy --ha=false` only; enforcement is #22.
- Review fixes sit inside the feature commits, not a separate one.
- `syncScheduler.start()` has only a manual boot check, not a test.
- Follow-ups #174, #175, #176, #177, #179.

## PR paragraph

This adds the prd-01 sync scheduler: an in-process timer that runs `runSync` every 15 minutes (`SYNC_INTERVAL_MS` overrides it, with a 60 s floor), plus `GET /api/v1/sync/status` and `POST /api/v1/sync/run`. One guard, set synchronously, is shared by the timer and "sync now", so two syncs never overlap in a process, and `running` reflects this process, not a stale database row. "Sync now" refuses cross-site requests using `Sec-Fetch-Site` and falls back to `Origin` against `Host`; the first version of that check would have refused the button under `npm run dev`, and review fixed it. The routes mount in the `/api/v1` barrel by Hannah's decision. A 1283-test gate backs it (tsc and lint clean). Follow-ups: #174, #175, #176, #177, #179.

## Baseline narratives

These four are the text for the retro POST (`narrative_code_type`, `narrative_built`, `narrative_how`, `narrative_wrong`).

### narrative_code_type

A scheduler and its API: an in-process interval timer around `runSync` with a single shared run guard, two Express routes (sync status and sync now) mounted in the `/api/v1` barrel, and a mutation-tested suite. Gear 4.

### narrative_built

`syncScheduler` is a module singleton, created unstarted and started only from `server/index.ts` after `listen`. It runs `runSync` every 15 minutes (`SYNC_INTERVAL_MS`, digits only, 60 s floor, invalid values fall back to the default with one fixed warning), first run one interval after boot. The timer tick and `POST /api/v1/sync/run` share one in-process guard set synchronously, so a second caller is refused (409) without writing. `GET /api/v1/sync/status` reports `running` (the process flag, not the database), the last run, `lastSuccessAt` (the newest success row's `finished_at`) and `nextRunAt`. The POST refuses cross-site requests: `Sec-Fetch-Site` decides first, and `Origin` against `Host` is the fallback when that header is absent. Gate on the final tree: tsc and lint clean, 53 files and 1283 tests passing.

### narrative_how

Architect first, then the lane answered its three open questions itself (no run at boot, invalid interval falls back, Origin check in). The opus implementer built inside the fence and broke the code seven ways, all red, then stopped when its `server.ts` mount turned `barrel.test.ts` red. The lane raised decision 4095a681 with `baseline decide --block`; the first call was refused for passing `fence` as an array, and the re-raise moved the paths into `costs`. Hannah picked the barrel mount after about 10 minutes. During that wait security-auditor and reviewer ran in parallel: the auditor's executed probes found no leak and no wedged guard, and found that the Origin check would refuse "sync now" under the Vite dev proxy; the reviewer fixed it and verified through a real proxy. Then test-guard (two gaps) and docs-syncer. Three commits, each gated in a temporary worktree; a manual boot check on a scratch production database covered `start()`.

### narrative_wrong

The issue's fence said to mount in `server.ts`, but `barrel.test.ts` (added by #43) requires the barrel to be the only mount, so the fence was never re-checked after the barrel landed and the conflict surfaced only when the gate went red; it cost a blocking decision and about 10 minutes. The architect asserted that Vite's dev proxy has no `changeOrigin` without running it, which was false for the string proxy form, and the lane's Origin check was kept on that premise until the auditor found it would have returned 403 to "sync now" under `npm run dev`. The implementer's seven breaks missed `timer.unref()` (fifth retro naming author-chosen mutations; the implementer rule is still not in the agent file), and `syncScheduler.start()` has only a manual boot check. The `baseline decide` call was refused for a wrongly typed `fence` for the second time, because the help text gives no type. The reviewer's fixes sit inside the feature commits, missing the separate-review-fix commit rule. Accepted gaps: a 202 can precede a skipped run, and a `runSync` rejection leaves no row.
