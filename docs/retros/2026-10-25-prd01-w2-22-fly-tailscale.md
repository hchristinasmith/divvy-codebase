# Retro: #22 prd01 w2, the container runs on Fly with Tailscale and no public IP

Gear 3 as stamped; no shift in gear. No trigger fired: every change stayed inside the fence, with no migration and no new export. The implementer ran on opus, as the gear table says for gear 3. This file states no telemetry (model, duration, tokens, tool calls); the conductor posts the four narratives after `baseline finish`. It sits outside the fence, as with the other retros.

Seats run, in order: researcher, architect, implementer (opus) for the build, reviewer and security-auditor in parallel, implementer for the security fixes (then a second round on the same agent for a flaky test), test-guard, implementer for the test-guard gaps, docs-syncer, then this retro. Verify passed on the final state as reported at dispatch: `tsc --noEmit` 0, lint 0, vitest 61 files / 1702 tests. I did not re-run the gate for this retro.

Commits (5, from `git log origin/main..HEAD`): 6566829 build, bece679 review fixes, 9622bc7 security-auditor fixes (the flaky-test fix landed inside it), 7cce3be test-guard gaps, 14daec3 docs sync. 5 files, 1062 lines added, 29 removed: `server/__tests__/deploy-config.test.ts` 718, `docs/deploy.md` 165, `scripts/start.sh` 84, `Dockerfile` and `fly.toml` the rest.

**Not verified, and this matters:** `docker build` never ran (Docker is not installed here), and no real `tailscaled` or Fly machine was run. Everything about the boot path is checked against fake binaries on `PATH`. The first real build is the w4 remote build.

## What was built

- **Kind of code:** deploy configuration and a boot script: `fly.toml` for `divvy-strawb`, a multi-stage `Dockerfile`, `scripts/start.sh`, the w4 operator runbook `docs/deploy.md`, and one test file that checks all four.
- **Pattern:** fail-closed boot. `start.sh` refuses without `TS_AUTHKEY` or with `HOST` off loopback, starts `tailscaled` in userspace mode under `env -i`, joins with `up --reset --timeout --accept-dns=false`, runs `serve reset` then `serve --bg --https=443 http://127.0.0.1:3005` under `timeout`, verifies the result with `serve status` (an exact newline-ended proxy match, plus a Funnel guard), and only then `exec`s `npm start` (under Litestream if its config exists, else a loud `WARNING: backups are OFF`). The `Dockerfile` has a `tools` stage that fetches Tailscale 1.104.2 and Litestream 0.5.17, each pinned by sha256. `fly.toml` has no `[http_service]`, `[[services]]`, `[checks]` or `[processes]`, so Fly routes nothing to the machine and no public IP is needed.
- **Tests:** 56 reported. Plain-text and parsed checks on `fly.toml`, the `Dockerfile` and the docs, plus behavioural runs of `start.sh` against fake `tailscale`, `tailscaled` and `litestream` binaries, each proven by mutation.
- **Why this shape:** the contested point was how to keep the app off Fly's network. A service-less `fly.toml` plus a loopback-only bind was chosen over a Fly service with an IP allow-list because D1 and D4 say no public IP. It turned out to be only half the answer (item 2 below).
- **Corrections to the issue, all checked against the record:** the volume path is `/data`, not the stale `/app/storage`; the app binds `127.0.0.1` with no `HOST`; there is no `min_machines_running` (it is only valid inside `[http_service]`, which Ruling 7 forbids, and at top level it is silently dropped, shown with `fly config validate` and `fly config show`); and the flag is `--auth-key`, not `--authkey`.

## What happened

- The researcher and architect ran first. The conductor then dispatched the implementer with an "Architect plan (verbatim)" heading and no plan text under it. The implementer found the plan in the architect's seat transcript and built from that; the conductor later sent a plan file.
- The build commit went through green. Reviewer and security-auditor then ran in parallel on the same diff and each, independently, found the same thing: in userspace networking mode, `tailscaled` forwards a tailnet connection on any port to loopback. The loopback bind therefore does not stop tailnet peers from reaching `:3005` over plain HTTP. Only the tailnet policy does. The researcher, the architect and the build's own docs had all said "only `tailscale serve` can reach it".
- Reviewer findings fixed in bece679: the proxy check was a substring match (`:30050` passed for `:3005`); `HOST` off loopback is now refused; `exec`, `--reset` and `--timeout` are pinned by test. Security-auditor findings fixed in 9622bc7: the exact tailnet policy (members reach `tag:divvy:443` and their own devices, tag owner is the admin group) is now in `docs/deploy.md` and marked mandatory; what to do if the auth key leaks; and `env -i` so `tailscaled` holds none of the app's secrets (`AKAHU_*`, `XERO_*`, Litestream credentials).
- The implementer's first gate on the security fixes showed "2 failed" once. It did not diagnose it. The conductor's gate then ran the full suite three times and one was red. The cause: the fake `tailscaled` is a node process, and the test waited 2 seconds for its socket. Under full-suite load the socket took up to about 1.7 seconds, and under heavy artificial load the test failed 9 of 11 runs. Fix: a 15 second wait for every run that expects the socket (2 seconds only for the no-socket case), and the pid and call-log writes moved into the shell wrapper so they no longer wait on node start-up. Afterwards 40 of 40 runs passed under heavy load.
- test-guard found three refusal paths (`serve reset`, `serve`, `serve status` failing) where deleting the `|| die` left every test green. It also found unpinned behaviour: the `Dockerfile` wiring (`COPY`, `chmod`, `USER`), the tailnet policy text, and the `kill_signal` and `kill_timeout` values. All are now pinned, and each was mutation-proven in 7cce3be.
- docs-syncer added the `Dockerfile` header and three missing troubleshooting entries in 14daec3.
- Separately, under artificial 8x-concurrent load, the canary in `server/db/__tests__/migration-guards.test.ts` timed out at 5000 ms in 19 of 40 runs. It is outside the fence and was not touched.

## What went wrong

1. **A brief went out with a heading and no content.** The "Architect plan (verbatim)" section was empty. Cost: the implementer spent a recovery step reading a seat transcript, and built the first pass from a plan it had to find itself; one extra conductor message. No wrong code is known to have resulted, but nobody can say how closely the recovered text matched what the conductor meant to send.
2. **The central safety claim was wrong in three documents.** "Only `tailscale serve` can reach the app" was written by the researcher, repeated by the architect, and shipped in the build's `fly.toml` and `docs/deploy.md` comments. The truth: any tailnet peer reaches loopback on any port unless the tailnet policy forbids it. A reviewer and a security-auditor each caught it in the first review round. Had it shipped, the runbook would have told Hannah the app was reachable only through HTTPS while the tailnet's default policy exposed plain HTTP on `:3005` to every device on it. Cost: one review round and a security-fix commit; the policy section in `docs/deploy.md` is now the real control.
3. **A substring proxy match** (`:30050` passed for `:3005`) in the verification step. Reviewer caught it; fixed by ending the match at a newline.
4. **No scrub of `tailscaled`'s environment.** The build started `tailscaled` with the app's full environment, so it held every app secret. Security-auditor caught it.
5. **A flaky test left undiagnosed.** The implementer saw "2 failed" once and moved on. The gate on the conductor's side ran three full runs and caught it. The wait was sized by guess (2 seconds) and not from the measured start-up time under load. Cost: one extra implementer round and the diagnosis work. A red test with no stated cause shipped to the gate.
6. **Three refusal paths and the `Dockerfile` wiring were untested.** The implementer's own mutation pass missed deleting `|| die` on three of the `serve` commands, and the `COPY`, `chmod`, `USER`, tailnet policy and `kill_*` values. test-guard found all of them. Cost: one more seat and one more commit.
7. **No real build.** The checks cover text, parsing and fake binaries. Whether the image builds, whether `tailscaled` behaves as the fake does, and whether `serve status` prints the string the match expects are all unproven until w4.

## Root causes

- **Research asked how a thing works, not what else it exposes (item 2; first occurrence under this name).** The research question was how `tailscale serve` publishes a loopback service. That question has a correct answer that says nothing about userspace networking forwarding every port. Nobody asked "what else can reach loopback in this mode", so the researcher answered the question as asked and the architect carried it forward. This is the cause, not that the researcher was careless.
- **A brief heading that promises content the sender did not check (item 1; first occurrence).** The conductor wrote the heading and meant to paste the plan; nothing checks that the section under a heading is non-empty before sending. The receiving agent had no way to tell "no plan" from "plan elsewhere" except by hunting.
- **Author-chosen mutations share the author's blind spots (items 4 and 6).** Same family as #20, #21 and the earlier retros: the implementer's own mutation list missed the three `|| die` removals and the `Dockerfile` wiring, and a later seat (test-guard) found them. Fifth appearance. #21's retro recommended an "next-looser guard" rule in `~/.claude/agents/implementer.md`; a grep of that file for "looser" and "mutation" today returns nothing, so that recommendation has still not landed. This issue adds a variant worth stating: the unguarded paths here were refusal paths (`|| die`), which no test names unless the author lists them from the script's own failure branches.
- **A time-based wait sized by guess, and an undiagnosed red (item 5).** Same family as #97 (a library default meeting a shared host, with the diagnosis guessed before anyone measured) and #113 (the green came from the speed of one machine). Here the 2 second wait came from no measurement. Under load the fake's start-up took close to it. The implementer's "2 failed" once was a signal that was seen and not followed; it was a decision to move on, not a tool fault. Third appearance of the time-sized-by-guess family.
- **Environment unavailable (item 7).** Docker is not installed on the lane's machine, so the strongest check (the build) cannot run. This is a tool constraint, not a decision, and it is already managed by making w4's first build the real test.
- **Unclear:** why the implementer left "2 failed" undiagnosed. The record shows it happened and that the conductor's gate caught it; it does not show whether it judged the failure unrelated or simply did not look.

## What worked, keep it

- **Reviewer and security-auditor in parallel on one diff, and finding the same defect independently.** Two seats that did not write the code reached the central problem separately, which is the strongest evidence the finding was real. Keep both seats in every gear.
- **Fixing the policy in the docs and calling it mandatory**, instead of pretending the bind was enough. The runbook now states the exact tailnet policy Hannah set, so the control is written down where the operator acts.
- **Fail-closed boot.** Every tailnet step is bounded (`--timeout`, `timeout 30`) and a failed step stops the app; `serve status` is verified rather than trusted because `serve` can exit 0 having configured nothing.
- **Behavioural tests against fake binaries**, so the refusal paths and ordering of `start.sh` are exercised, not only grep-checked. This is what made the test-guard mutations possible and what let `exec` be proven by pid.
- **The conductor running the gate three times and not trusting one green.** The flake was found because the gate was repeated, not because the implementer reported it.
- **Evidence for config claims.** `min_machines_running` was run through `fly config validate` and `fly config show` before being dropped, and the issue's wrong path and flag were corrected from the record, not copied.
- **Separate commits per round**, so each second reader saw only the response to its own findings.
- **Surfacing outside-fence items instead of folding them in** (below), including the migration-guards timeout.

## Surfaced, not absorbed

- Stale text outside the fence: `mcp/spike/RUNBOOK.md` (lines 20-22, 192, 194), prd-01 line 33, prd-03 lines 35, 80, 140, `server/index.ts` line 5. CLAUDE.md's reference table does not list `docs/deploy.md`.
- `tailscaled` is unsupervised after the `exec`: if it dies, the app keeps running with no tailnet path.
- The process runs as root.
- `serve status` has no timeout (unlike `up` and `serve`).
- #24 (Litestream) must not add a metrics listener, because netstack would expose it to the tailnet; it must use a least-privilege bucket credential; and it must add restore-on-empty-volume.
- Base images are not pinned by digest.
- The `migration-guards.test.ts` canary times out at 5000 ms under heavy concurrent load (19 of 40 runs). Follow-up; not touched.

## Recommended changes

1. **Researcher prompt for any network component: add "what else does this expose".** For any issue that adds a listener, tunnel, proxy or network daemon, the research brief must ask what else the component makes reachable in the mode we run it in (every port, every interface, every peer), with a test or doc citation, and the architect's plan must carry that answer as a stated assumption to verify. Artifact: `~/.claude/agents/researcher.md` (a "network components" checklist line) and `~/.claude/agents/architect.md`. High leverage: the miss was in the security claim the whole issue rests on. First occurrence under this name, so per the retro rule this is the first time and is recorded, not yet encoded as a rule; if it recurs, encode it.
2. **Conductor self-check before dispatch: every heading in a brief has content.** Before sending a brief, confirm each section heading (plan, constraints, fence) is followed by text, not a placeholder. Cheapest form: a script that fails if a heading is followed immediately by another heading or the end of the brief. Artifact: `~/.claude/skills/parallel-agents/SKILL.md` (dispatch checklist), or a small script run on the handoff file. Optional until it recurs, since the implementer recovered; first occurrence.
3. **Behavioural tests that spawn processes take their waits from measured latency under load, and an undiagnosed red stops the implementer.** In `implementer`'s checklist: any wait on a spawned process is sized from a measured worst case under the full suite (run it under load once and record the number), and a failure seen even once is diagnosed or reported as unexplained, never left. Artifact: `~/.claude/agents/implementer.md` and `docs/testing.md` (a "waiting on spawned processes" paragraph). High leverage; third occurrence of the time-sized-by-guess family (#97, #113, #22), so encode it.
4. **Land the standing "next-looser guard" rule and add refusal paths to it.** Every `|| die` or failure branch in a script has a test that fails when it is deleted, and the mutation list is written from the script's failure branches and its `Dockerfile` or config lines, not from the code just written. Artifact: `~/.claude/agents/implementer.md`, then `pnpm import-workflow --name current`. High leverage. Fifth occurrence, and the earlier recommendation is still not in the file.
5. **Add `docs/deploy.md` to CLAUDE.md's reference table** so the next deploy-touching lane reads it. Artifact: `CLAUDE.md`. Trivial; the conductor decides.

## Highest-leverage next step

Add the standing rule from recommendation 4 (with the refusal-path line from this issue) to `~/.claude/agents/implementer.md` and import it. Four earlier retros named the cause (per #21's count) and the rule is still not in the file; each recurrence costs a test-guard seat and a commit, and this issue added a flaky wait to the same pattern (recommendation 3), which should go into the same edit. The reviewer, security-auditor and test-guard seats stay in every gear; this only moves the cheap catches earlier.

## Open items for the PR body

- Verified: `tsc` 0, lint 0, vitest 61 files / 1702 tests.
- Not verified: `docker build` (no Docker here) and any real `tailscaled` or Fly machine. The first real build is the w4 remote build.
- The tailnet policy in `docs/deploy.md` section 2 is mandatory: userspace `tailscaled` forwards a tailnet connection on any port to loopback, so without it `:3005` answers peers over plain HTTP.
- Corrections to the issue: path `/data`, no `HOST`, no `min_machines_running`, flag `--auth-key`.
- Follow-ups for the conductor to file: the migration-guards load timeout; stale docs outside the fence; `tailscaled` supervision; root user; `serve status` timeout; digest-pinned base images. For #24: no metrics listener, least-privilege bucket credential, restore-on-empty-volume.

## PR paragraph

This puts the container on Fly with Tailscale and no public IP. `fly.toml` names `divvy-strawb` in Sydney with the volume at `/data` and no service, check or process table. The `Dockerfile` adds checksum-pinned Tailscale and Litestream and boots through `scripts/start.sh`, which refuses without the auth key or with `HOST` off loopback, joins the tailnet, publishes the app with `tailscale serve`, verifies it, and only then starts the app. `docs/deploy.md` is the w4 runbook and states the tailnet policy that must be set, because userspace `tailscaled` forwards any port to loopback and only the policy keeps plain HTTP closed. 56 tests (fake binaries for the boot path) back it, and the gate is green. Not verified: `docker build` and a real machine, which first happen in w4.

## Baseline narratives

These four are the text for the retro POST (`narrative_code_type`, `narrative_built`, `narrative_how`, `narrative_wrong`).

### narrative_code_type

Deploy configuration and a fail-closed boot script: a service-less Fly config, a multi-stage image with checksum-pinned tools, a shell entrypoint that joins a tailnet and publishes the app there, an operator runbook, and a test file mixing text checks with behavioural runs against fake binaries. Gear 3.

### narrative_built

`fly.toml` for `divvy-strawb` in Sydney with the volume at `/data` and no service, check or process table. The `Dockerfile` adds Tailscale 1.104.2 and Litestream 0.5.17, each pinned by sha256, and runs `scripts/start.sh`. That script refuses without the auth key or with `HOST` off loopback, starts `tailscaled` in userspace under `env -i`, joins the tailnet, publishes the app with `tailscale serve`, verifies the result with an exact match and a Funnel guard, then `exec`s the app (under Litestream if configured, else a loud warning). `docs/deploy.md` is the w4 runbook with the exact tailnet policy. Gate: 61 files, 1702 tests, `tsc` and lint clean. `docker build` and a real machine were not run.

### narrative_how

Researcher, architect, then an opus implementer for the build. Reviewer and security-auditor ran in parallel, then the implementer fixed the security findings and, in a second round, a flaky test. Then test-guard, the implementer again for its gaps, docs-syncer, and this retro. Five commits: build, review fixes, security fixes (with the flake fix), test-guard gaps, docs sync. The conductor's repeated full-suite gate caught the flake the implementer had seen once and left. Docker is not installed here, so the first real build is the w4 remote build.

### narrative_wrong

The researcher, architect and the build's own docs all said only `tailscale serve` could reach the app, but userspace `tailscaled` forwards a tailnet connection on any port to loopback; reviewer and security-auditor each found it independently, and the exact tailnet policy in the runbook is now the real control. The research question asked how serve works, not what else the mode exposes. The conductor also sent the implementer a brief with an "Architect plan" heading and no plan under it; the implementer recovered it from a transcript. A test waited 2 seconds for a fake socket that took up to about 1.7 seconds under load, failed 9 of 11 heavy-load runs, and had been seen red once and left undiagnosed until the gate repeated it. test-guard found three refusal paths and the `Dockerfile` wiring with no failing test, the fifth retro naming author-chosen mutations as a blind spot. A `migration-guards` canary also times out under heavy load; it is outside the fence and is a follow-up.
