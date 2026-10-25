# Retro: #149 server listens on loopback by default, with #180 bundled (`server/index.ts` and its first test)

Bundle of two gear-1 issues in one lane, one PR, branch `fix/149-server-index-bundle`. Both haiku implementer; no gear shift. Fence held: the diff touches only `server/index.ts`, `.env.example` and `server/__tests__/index.test.ts` (`git diff --stat 8f60cb7..HEAD`: 3 files, +106 -2). Commits: 0489cc2 (#149 build), 88e3a45 (#180 test), 1e856b6 (review fixes). Verify passed on the final state: gate run on the exact tree committed as 1e856b6 (`npx tsc --noEmit` 0, `npm run lint` 0, `npx vitest run` 56 files / 1471 tests passed), then run again by test-guard on HEAD with the same results and a clean `git status`. No follow-up issues filed. This file states no Baseline telemetry (model, duration, tokens, tool calls). Merge with `gh pr merge <N> --merge --delete-branch` so the per-issue commits survive; the merger closes #149 and #180 by hand.

## What was built

- **Kind of code:** a one-line security default in the server entry point (#149) and the first test of that entry point (#180).
- **#149 pattern:** `const host = process.env.HOST || '127.0.0.1'` and `server.listen(Number(port), host, cb)`. `.env.example` documents a blank `HOST=`. Before this the one-argument `listen(port, cb)` bound every interface, on an app with no auth that relies on the tailnet (D4).
- **#180 pattern:** `server/__tests__/index.test.ts` mocks `server.ts` (its `listen` holds the callback instead of running it) and the scheduler. It asserts the scheduler's `start` is not called on import, is called once after the callback fires, and asserts the host and port passed to `listen`.
- **Why `||` and not `??`:** a blank `HOST=` is what `.env.example` ships, and `listen(port, '')` binds `::`. The reviewer proved this; see below.

## What happened

1. **Implementer build (#149).** Wrote the host default. `listen(port, host, cb)` failed `tsc` (TS2769) because `port` is `string | 3005`. The old one-argument call had compiled only because `listen(handle: any, cb)` accepted anything. The implementer added `Number(port)`. Side effect: a junk `PORT` now throws `ERR_SOCKET_BAD_PORT` instead of silently creating a Unix socket file named after the junk. That is better behaviour, arrived at by accident, and it is a change nobody asked for.
2. **Implementer raised a risk:** a loopback-only server might break the Vite dev proxy, which targets `localhost`. The conductor tested it rather than reasoning about it: on Node 22, `http.get('http://localhost')` tries `::1` first and falls back to `127.0.0.1`, and it reached a 127.0.0.1-only server. Risk disproved.
3. **Conductor ran the Done-when (EXECUTED).** With no `HOST`: `curl 192.168.0.231:3999` was refused (curl exit 7), while `127.0.0.1` and `localhost` answered. They answered HTTP 500, because `NODE_ENV=test` gives an unmigrated `:memory:` DB; a 500 is still an answer, and it avoided writing a dev DB. With `HOST=0.0.0.0` the LAN address answered. Port 3999, not 3005: another checkout's dev server held 3005.
4. **#180 build.** Three mutations (remove the `start()` call, move it out of the callback, drop the host argument) each went red. One snag: with vitest 1.6.1, `vi.stubEnv('HOST', undefined)` stores the string `"undefined"`, which would have been a wrong host. The test deletes and restores `HOST` by hand.
5. **Reviewer found the real miss (EXECUTED).** A blank `HOST` was untested, and it is the exact value `.env.example` ships. `listen(port, '')` binds `::`; a LAN probe got HTTP 200. Swapping `||` for `??` left every test green. Fixed in 1e856b6 with a blank-`HOST` test and a comment on the `||`.
6. **Reviewer also found a false comment.** The comments said "production sets HOST (#22)". The handoff and #149 both asserted that. #22's plan uses `tailscale serve` to loopback and sets no `HOST`. Reworded to "#22's call".
7. **security-auditor:** no critical findings. It confirmed `dist/server.js` carries the same host line, and that dotenv loads in `server.ts` before `index.ts` reads `HOST`. DNS rebinding with no Host allowlist is pre-existing and already tracked as #174. `server/routes/akahu.ts` returns `err.message` in 500s; that route is due for removal, noted in #149. It suggested the name `HOST` may collide with env vars some shells or CI export (zsh sets but does not export it here); that is Hannah's call, not made here. `fly.toml:32-34` has a comment about `fly proxy 3005` reachability that is now stale; it is outside the fence and belongs to #22.
8. **test-guard:** 12 mutations killed, 2 survived (the `PORT` default `|| 3006`, and the log text). Both behaviours are unchanged by this diff, so they were surfaced, not absorbed.

## What went wrong

- **The slice never said "blank".** The issue, the handoff and the implementer prompt all specified `HOST` "unset", while the same change ships `HOST=` blank in `.env.example`. A blank value is not unset: it is the one case that reopens the hole. The implementer used `||` (correct) but with no test and no reason recorded, so the correct choice was unprotected; a later edit to `??` would have passed the gate. Only the reviewer closed it.
- **An unchecked claim travelled through three documents.** "Production sets HOST for Fly (#22)" sat in the issue and the handoff, and the conductor repeated it in the implementer prompt without opening #22. The implementer copied it into code comments and `.env.example`. The reviewer was the first to read #22. Cost: one review-fix round and a rewording in two files.
- **Unplanned behaviour change in a gear-1 fix.** `Number(port)` changes what a bad `PORT` does. It is harmless and arguably right, but it was a compiler workaround, not a decision. It is recorded here and in the PR body, not decided.
- **Port 3005 was occupied** by another checkout's dev server, so the Done-when needed an improvised port. Minor; no cost beyond a retry.
- **A stale skill claim.** The `house-shape` skill says vitest 4.1.10; this repo runs 1.6.1. The `stubEnv(undefined)` snag is a 1.6.1 behaviour, so the skill's version would have steered the implementer wrong.

## Root causes

- **Specification covered the happy path of an input and not its empty form (blank vs unset).** The slice described the case in the author's head (the variable absent) and not the case the same diff creates in `.env.example`. Environment variables have three states: absent, empty, set. At gear 1 there is no architect, so the plan seat is the author of the issue, and nothing in that seat prompts for the empty state. Missed-by for the blank `HOST`: **plan** (the slice), caught by **review**.
- **A claim about another issue was copied, never verified.** The #22 line passed from issue to handoff to prompt to code because each reader trusted the one before. This is the general shape "an assertion about a neighbouring ticket becomes a code comment". It is a first occurrence in this repo's retros, so record it and do not encode it yet.
- **A compiler error steered a behaviour.** `Number(port)` came from TS2769, not from a decision about bad `PORT`s. The tool was right to complain (the old call compiled only through an `any` overload); the miss is that the lane did not notice a type fix had a runtime effect until the retro. Not a tool fault.
- **Stale skill text** (vitest version) is a documentation drift, cause unclear beyond "the skill was written against another repo's version".

## What worked, keep it

- **The conductor ran the Done-when against the real server and a real LAN address.** curl exit 7 on the LAN IP, with `127.0.0.1` and `localhost` answering and `HOST=0.0.0.0` reopening it, shows the claim, not the code. The proxy-risk question was settled the same way, with a test, not an argument.
- **The reviewer executed its claim.** "A blank `HOST` binds every interface" came with a LAN probe returning 200 and a `??` mutation that stayed green. That is why the fix was a test, not a comment alone.
- **Mutations before trust.** #180's three mutations and test-guard's 12 kills tie each assertion to a failure; the two survivors were named and left alone because the diff did not change those behaviours.
- **Surfacing, not absorbing.** The akahu 500 body, `fly.toml`, `HOST` naming, DNS rebinding (#174) all went to the report or an existing issue. The fence held at three files.
- **Bundling worked.** #180 tests exactly the file #149 edits; one lane and one PR, with per-issue commits.

## Recommended changes

1. **Add "empty value" to the issue template for env-var changes.** When a slice adds or changes an env var, the Done-when names three cases: unset, blank and set, and the blank case matches what `.env.example` ships. First occurrence, so record only; encode on the second. Candidate file: `docs/testing.md` as a rule for config tests, or the conductor's issue-slicing notes.
2. **Check a cross-ticket claim before it goes into a prompt.** If a handoff says "#N does X", the conductor opens #N first or writes the claim as unverified. First occurrence, so record only. Candidate: the lane handoff template.
3. **Fix the `house-shape` skill's vitest version** (4.1.10 should read 1.6.1 for this repo, or point to `package.json`). This is a plain factual correction, not a first-occurrence fix, so it can go in now. File: `~/.claude/skills/house-shape/SKILL.md`, which goes live only via `pnpm import-workflow`.
4. **Hannah's calls, not made here:** whether `HOST` is the right name given shell collisions, and #22's `fly.toml:32-34` comment.

## Highest-leverage next step

Correct the vitest version in `~/.claude/skills/house-shape/SKILL.md` (or make it say "see `package.json`"). It cost a snag here and it will cost the next test-writing lane too, and the fix is one line. The first two recommendations wait for a second occurrence.

## Open items for the PR body

- No gear shift: gear 1 as stamped for both.
- Behaviour change to state: a junk `PORT` now throws `ERR_SOCKET_BAD_PORT` instead of creating a Unix socket file.
- Blank `HOST` is handled (`||`) and tested; `.env.example` ships `HOST=` blank on purpose.
- #22 sets no `HOST` in its current plan; the comments say "#22's call".
- Left for others: `fly.toml:32-34` comment (#22); DNS rebinding Host allowlist (#174); `server/routes/akahu.ts` 500 bodies (route due for removal); `HOST` name collision (Hannah).
- Surviving test-guard mutations (`PORT` default `|| 3006`, log text) cover behaviour this diff did not change.

## For Baseline (four fields)

See the four paragraphs returned with this retro; the conductor posts them after `baseline finish`.
