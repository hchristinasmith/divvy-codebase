# Retro: #24 prd01 w2, Litestream replicates the database and a restore script puts it back

Gear 3 as stamped; no shift in gear. No trigger fired beyond what gear 3 already assumes: no migration, no new exported symbol, every file inside the fence. The implementer ran on opus, as the gear table says for gear 3. This file states no telemetry (model, duration, tokens, tool calls); the lane posts the four narratives after `baseline finish`. It sits outside the fence, as with the other retros.

Seats run, in order: researcher, architect, implementer (opus, effort high) for the build, reviewer, test-guard, security-auditor, docs-syncer, then this retro. Verify passed on the final state as reported at dispatch: `tsc --noEmit` and lint clean at every commit, vitest 2488 tests green. I did not re-run the gate for this retro.

Commits (5, from `git log 828de2c..HEAD`): bf85bdd `litestream.yml`, the `Dockerfile` COPY and config tests; 27e27fe `scripts/restore.sh` and its tests; 0323b7a `docs/restore.md` and a `docs/deploy.md` paragraph; fb0c7ea review fixes; 1b0accc docs sync. 6 files, 1055 lines added, 1 removed: `server/__tests__/litestream-config.test.ts` 709 (76 tests as reported), `docs/restore.md` 198, `scripts/restore.sh` 109, `litestream.yml` 35, and two lines each in `Dockerfile` and `docs/deploy.md`.

**Consequence of merging this, stated first:** the image now refuses to boot until a backup provider is chosen and three Fly secrets are set (the replica URL and the two credentials). That is deliberate (fail closed: no replica, no app), but it means the next deploy fails until Hannah decides where the backup lives. That decision is still open and has to be made before w4.

**Not verified, and this matters:** `docker build` never ran, no real S3-compatible bucket was used, no `fly` command was run, and the Linux amd64 Litestream binary was never executed. The drill ran the darwin-arm64 binary (0.5.17, checksum-verified) against a local file replica. The `fly` steps in `docs/restore.md` are marked UNVERIFIED in the doc itself.

## What was built

- **Kind of code:** deploy configuration and an operator script: `litestream.yml`, a CLI restore script (`scripts/restore.sh`), the backup and restore runbook `docs/restore.md`, and one test file that checks all three plus the `Dockerfile` wiring.
- **Pattern:** fail-closed config and a never-overwrite restore. `litestream.yml` takes `path` from `${DATABASE_PATH}` (the variable the production knexfile reads, so the app and Litestream cannot disagree) and the replica from `${LITESTREAM_REPLICA_URL}`. An unset variable expands to nothing and Litestream refuses to start. `restore-if-db-not-exists: true` restores on a lost volume. `restore.sh` is config-free (it takes the replica URL from the environment), refuses unless the target directory is empty of anything starting `divvy.sqlite3` or `.divvy.sqlite3`, restores to a temporary name, and moves it into place with `mv` only after Litestream's integrity check passes. The file is written `0600`.
- **Why this shape:** the contested point was a restore script that reads `litestream.yml` against one that takes the URL directly. The URL form was chosen so a laptop restore needs no config, no live database path and no way to point at the live volume.
- **Corrections to the issue:** it named `/app/storage/prod.sqlite3`; the real path is `/data/divvy.sqlite3` via `DATABASE_PATH`.

## What happened

- The researcher did not work from docs. It downloaded Litestream 0.5.17 for darwin-arm64, verified the checksum, read the source and ran experiments: environment expansion runs over the whole file including comments, there is no `${VAR:-default}`, an unset variable fails closed, Litestream reads its credential variables itself, `restore-if-db-not-exists` behaves as claimed, a fresh volume buries the backup, SIGTERM is forwarded to the child, and `npm start` does not forward SIGTERM to node.
- The architect settled `path: ${DATABASE_PATH}`, `restore-if-db-not-exists: true` (flagged to Hannah as a lane judgement, not a ruling), a config-free `restore.sh`, temp-name-then-`mv`, and the test plan.
- The implementer built it and ran the restore drill for real (EXECUTED; transcript not committed). It departed from the plan once: `sqlite3 -readonly` cannot open a WAL-mode restored database that has no `-shm`, so the check uses `immutable=1`. It also found the txid is exactly 16 lowercase hex digits and made the script enforce that.
- The reviewer returned 9 findings; 6 were fixed in fb0c7ea:
  - **HIGH:** a stale `divvy.sqlite3-restoring-wal` beside the target is replayed into the restore by Litestream's integrity check. The restore exits 0 holding another database's rows.
  - **MEDIUM-HIGH:** a symlink at `divvy.sqlite3-restoring.tmp` is written through, so the restore overwrote a file outside the target.
  - **MEDIUM:** `restore-if-db-not-exists` only stats the database file. If only the database is deleted and its `-wal` is left, the `-wal` is replayed onto the restored copy. The docs now warn; a start-time guard belongs in `scripts/start.sh`, which is outside the fence, so it became #253.
  - **MEDIUM:** `docs/restore.md` gave the wrong boot log line for an empty replica.
  - **MEDIUM:** the `litestream ltx` command in the docs failed as written, because an environment prefix on the command line expands after Litestream reads its arguments.
  - **LOW:** the restored file was `0644`. Now `umask 077`.
- test-guard ran about 30 mutations. All were killed except two that matter little: an equivalent `mv -f` (no observable difference) and the tail of an error message.
- security-auditor found no Critical. It rated the stale-`-wal` boot case a Warning. It also found that Node inherits five backup variables, including the `AWS_*` copies Litestream sets, so the app's process holds the bucket credential (#254). Its suggestions were applied by docs-syncer: ask for a delete-protected bucket, and take a volume snapshot before touching the live volume.
- docs-syncer made the two in-fence doc additions and reported stale text outside the fence: `docs/deploy.md` sections 5, 6, 10 and 12 (#256), and CLAUDE.md's reference list missing `docs/deploy.md` and `docs/restore.md` (a comment on #256).

## What went wrong

1. **The refusal list named files instead of a pattern, and missed what Litestream itself creates.** The plan listed the names `restore.sh` must refuse (the database, `-wal`, `-shm`, `-journal`). Litestream also creates `<-o>.tmp`, and `<-o>-wal` and a state directory beside the temporary name. Two real defects came from that gap (the replayed stale `-restoring-wal`, the symlink write-through), found by the reviewer. Cost: one review round and one fix commit. The fix is the prefix rule in fb0c7ea, covered by tests.
2. **Docs carried claims the drill never ran.** The boot log line for an empty replica and the `litestream ltx` command were written into `docs/restore.md` from reading, not from a run, and both were wrong. A runbook is read under stress, by the person with a broken volume. Cost: two MEDIUM findings; the wrong command would have failed at the worst moment.
3. **`restore-if-db-not-exists` is weaker than its name.** It stats the database file only, so deleting the database alone replays a leftover `-wal` onto the restored copy. The guard is outside the fence (#253). Until it lands, the only protection is a paragraph in the docs. Missed-by on #253: plan.
4. **The issue named a path that was stale.** `/app/storage/prod.sqlite3` against the real `/data/divvy.sqlite3`. Caught from the record before any code used it, so it cost nothing; #22's issue had the same stale `/app/storage` path.
5. **No real build, bucket, `fly` command or Linux binary.** Everything is proved on one darwin-arm64 binary against a local replica. Whether the image starts, whether the amd64 binary behaves the same, and whether the `fly` steps work are unproven until w4.

## Root causes

- **Research asked how a thing works, not what else it touches (items 1 and 2; second occurrence, first was #22).** In #22 the question was how `tailscale serve` publishes a service and nobody asked what else netstack exposes. Here the researcher read Litestream's source and ran good experiments, but the question was how restore behaves, not "what files does restore create beside `-o`". The answer was in the source it had already read. Same shape as #22, different component; per the record this is now the second time under this name.
- **Documentation claims are not held to the evidence standard the code is (item 2; first occurrence under this name).** The drill proved the script and the config; the runbook commands and log lines were treated as prose and checked by nobody until the reviewer ran them. Nothing in the process says that a command in a runbook must have been run. Related to the plan-claims-not-executed items in #20 and #25, but those were about plans and this is about shipped documentation.
- **A guard sized to a name, not a class (items 1 and 3).** The refusal list and Litestream's own "database not present" check both test the one name they were written for. The class (everything the engine leaves beside a database) was wider. The prefix rule fixes the script; the same fix for the start path is #253.
- **Author-chosen mutations: did not recur here.** In #20, #21 and #22 test-guard found unguarded paths the implementer's mutation list missed. This time test-guard's ~30 mutations were all killed except two equivalent ones. I cannot say why from the record. The recommendation to put a "next-looser guard" rule in `~/.claude/agents/implementer.md` was not landed before this lane: a grep of the lane's `.claude/agents/implementer.md` for "looser" and "mutation" returns nothing. So the improvement is not explained by the rule; it may be the drill, the shell-script shape, or the opus implementer. Unclear.
- **Environment limits (item 5)** are a tool constraint, not a decision, and are already managed by making w4's first build the real test.

## What worked, keep it

- **A researcher that ran the real binary.** Downloading, checksum-verifying and exercising Litestream 0.5.17 turned the key design questions (does expansion cover comments, does an unset variable fail closed, does `npm start` forward SIGTERM) into observed facts. The "no dollar sign in a comment" rule in `litestream.yml` exists because of that run.
- **The restore drill, EXECUTED, by the implementer.** It is why `immutable=1` and the 16-hex txid rule exist, and why the review findings were about edge cases and not about whether restore works at all.
- **The reviewer finding data-integrity defects, not style.** Both top findings (a stale file replayed into a restore that exits 0; a symlink write-through) would have given a clean-looking restore that is wrong, or damage outside the target. Keep the reviewer seat in every gear.
- **Fail closed, twice.** An unset replica URL stops the boot, and `restore.sh` refuses before Litestream runs and writes nothing on failure. A restore to a temporary name moved into place after the integrity check leaves the directory as it found it.
- **Surfacing, not absorbing.** Five follow-ups filed instead of widening the fence (below), each with the seat that should have caught it.
- **Separate commits per round**: build, restore script, docs, review fixes, docs sync, so each second reader saw only the response to its own findings.
- **No names in a public repo.** No bucket, provider, key or tailnet name is in any file; the docs say plainly that the provider is not decided.

## Surfaced, not absorbed

- **#253:** `scripts/start.sh` should refuse to boot when a leftover `-wal` sits beside a missing database. Missed-by: plan.
- **#254:** strip the backup credentials from node's environment; Node inherits five variables including the `AWS_*` copies.
- **#255:** SIGTERM does not reach node through `npm start` (the researcher's experiment). Missed-by: review of #22.
- **#256:** `docs/deploy.md` sections 5, 6, 10 and 12 are stale; CLAUDE.md's reference list omits `docs/deploy.md` and `docs/restore.md` (added as a comment). Priority: phase.
- **#257:** MCP environment guard prefixes need the backup variables, and prd-03 should use `immutable=1` to read a restored database.
- **Open for Hannah:** the backup provider, and whether `restore-if-db-not-exists: true` stays. It is a lane judgement, flagged by the architect, not a PRD ruling.

## Recommended changes

1. **Researcher brief: for any tool that writes files, list every file it creates, not just the one asked about.** When the issue adds or wraps a tool that writes to disk (restore, backup, migrate), the research brief asks for the full set of names the tool creates beside its output (temp files, sidecars, state directories) with a source line or a run as evidence, and the architect's refusal or cleanup list is written as a prefix or class from that set. Artifact: `~/.claude/agents/researcher.md` (a "tools that write files" line) and `~/.claude/agents/architect.md`. High leverage; second occurrence of the "how it works, not what else it touches" family (#22, #24). Per the retro rule this is the point to encode it, together with the network line already recommended in #22 as one "what else does it touch" check.
2. **A runbook command or output line is run before it is committed, or marked UNVERIFIED in the text.** `docs/restore.md` already does this for `fly` steps; the rule extends it to every command and expected log line. A test in `server/__tests__/litestream-config.test.ts` can pin the commands that run locally. Artifact: `docs/testing.md` (a "documentation claims" paragraph) and `~/.claude/agents/implementer.md` docs step. High leverage for operator docs, optional elsewhere. First occurrence under this name: recorded here, not yet encoded.
3. **Land the standing "next-looser guard" rule and add refusal paths to it.** Carried from #21 and #22; still not in the agent files. Artifact: `~/.claude/agents/implementer.md`. Not repeated here in detail, since this lane's test-guard result is the first counter-example and I cannot say what changed.
4. **Decide the backup provider before w4.** Not a workflow change: the image will not boot without it. Artifact: `docs/decisions.md` (a D2 follow-on) once chosen.

## Highest-leverage next step

Add the "what else does it touch" check from recommendation 1 to `~/.claude/agents/researcher.md` and `~/.claude/agents/architect.md`, covering both network components (#22) and file-writing tools (#24), and import it. Two retros now name the same cause with different components, and in both the answer was already available to a seat that was reading the right material. The reviewer, test-guard and security-auditor seats stay in every gear; this only moves one class of catch earlier.

## Open items for the PR body

- Verified: `tsc` 0, lint 0, vitest 2488 tests green; the restore drill (darwin-arm64 binary, local replica).
- Not verified: `docker build`, any real bucket, any `fly` command, the Linux amd64 binary.
- Merging makes the image refuse to boot until a provider is chosen and the three secrets are set.
- Open for Hannah: the provider; `restore-if-db-not-exists: true` is a lane judgement.
- Follow-ups: #253, #254, #255, #256, #257.

## PR paragraph

This adds continuous database backup and a restore path. `litestream.yml` replicates `DATABASE_PATH` to a replica URL taken from the environment and restores automatically on a lost volume; `scripts/restore.sh` restores into a separate directory, never overwrites, refuses every `divvy.sqlite3*` leftover, and writes `0600`. `docs/restore.md` is the runbook. 76 tests back it and the full suite is green. Merging means the image will not boot until a backup provider is chosen and three Fly secrets are set; that choice is open. Not verified: `docker build`, a real bucket, any `fly` command, the Linux binary.

## Baseline narratives

The four fields for the retro POST (`narrative_code_type`, `narrative_built`, `narrative_how`, `narrative_wrong`) are in the lane's hand-back message, not repeated here.
