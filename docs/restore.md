# Backups and restores (Litestream)

The operator runbook for Divvy's database backup (D2; prd-01 Done-when 6; #24). Every `fly` command here is run by Hannah; no agent runs one that changes the app. Deploying is [deploy.md](deploy.md); this page assumes it.

Steps marked **UNVERIFIED (flyctl -h only)** were written from `fly … -h` output (flyctl v0.4.122) and have not been run against the app. Record what you see when you run them, here. Sections 3 and 4 were run in the #24 drill against Litestream 0.5.17, a local `file://` replica and made-up data; nothing in this page has yet been run against the production replica or the tailnet.

## What backs up what

- The database is `/data/divvy.sqlite3` on the `divvy_data` volume (`DATABASE_PATH`, set in the image and in `fly.toml`).
- `scripts/start.sh` finds `/app/litestream.yml` in the image and runs `litestream replicate -config /app/litestream.yml -exec "npm start"`. The app runs as Litestream's child; Litestream ships every change to the replica about once a second.
- On a boot that finds **no file** at `/data/divvy.sqlite3` (a lost or new volume), Litestream restores the latest backup before it starts the app (`restore-if-db-not-exists`). If any file is there, it never touches it.
- Only the database file counts. A `divvy.sqlite3-wal` left on the volume without its database is replayed on top of the restored copy when the app opens it, and that mix replicates as the newest state (EXECUTED in the #24 review against Litestream 0.5.17 with made-up data). So `scripts/start.sh` refuses to boot when it finds a `-wal`, `-shm` or `-journal` with no `divvy.sqlite3` beside it (`start.sh: ERROR: leftover database files with no database`, #253), before it starts Tailscale or Litestream, and leaves the files where they are. Never delete `divvy.sqlite3` alone: delete it, its `-wal` and its `-shm` together. If the boot refuses, move the named files off the volume (keep them; they may be the only copy of recent writes) and restart.
- On `fly machine stop` or a deploy, Fly sends SIGTERM and waits `kill_timeout` (30s). Litestream passes the signal to the app, waits for it, then does a final sync. A write in the last moments before a hard kill can still be lost.
- What is in the replica is a full off-box copy of the bank data: every account, balance and transaction. Treat the bucket and its credential like the Akahu token.
- Where the replica lives is not decided yet (no provider is named in this repo, which is public). Whatever it is, it is an S3-compatible bucket, and the credential you make for Litestream should be limited to **one bucket prefix** with list, get, put and delete on it, and nothing else.
- That credential has to be able to delete, because retention prunes old files, so anyone who holds it can also erase the backup. Turn on bucket versioning or object lock, or keep a second copy of the replica that this credential cannot delete, so a leaked or misused key cannot wipe the only backup. Never share the bucket, or this key, with another service.
- `scripts/restore.sh` is not in the image. It runs on a laptop (or anywhere with `litestream` on `PATH`). On the machine, use `litestream restore` directly (section 5).

## 1. Set the secrets

Three Fly secrets. Without `LITESTREAM_REPLICA_URL` the machine does not boot at all: Litestream exits with `file replica path required` and the app never starts (section 8). That is deliberate.

```sh
fly secrets set LITESTREAM_REPLICA_URL=<replica url> LITESTREAM_ACCESS_KEY_ID=<key id> LITESTREAM_SECRET_ACCESS_KEY=<secret key> -a divvy-strawb
```

- `<replica url>` is the bucket and a path inside it, in the form your provider documents for Litestream (for an S3-compatible bucket, `s3://<bucket>/<path>`, plus `?endpoint=<url>&region=<region>` when it is not AWS). Quote the whole `NAME=VALUE` argument in single quotes if the URL holds a `?` or `&`.
- Fly never shows a secret's value again. Keep all three in your password manager.
- Keep the values out of your shell history: start the line with a space (zsh `HIST_IGNORE_SPACE`), or feed them on stdin instead, which **UNVERIFIED (flyctl -h only)** `fly secrets import` reads as `NAME=VALUE` lines:

  ```sh
  fly secrets import -a divvy-strawb < <file of three NAME=VALUE lines, outside the repo>
  ```

  Delete that file afterwards.
- Setting secrets restarts the machine. Then check `fly logs -a divvy-strawb` shows `start.sh: backups ON (litestream, /app/litestream.yml)` and no `WARNING: backups are OFF` line.

## 2. Rules

- **Only the machine replicates to the production URL.** Never run `litestream replicate` (or the app under it) against that URL from a laptop. Litestream does not support two writers to one replica, and the second one's history would mix into the first's (REASONED, not tried).
- **A restore always goes into a side directory, never in place.** `scripts/restore.sh` refuses the live database's own directory, refuses any directory that already holds a file whose name starts `divvy.sqlite3` or `.divvy.sqlite3` (the database, its `-wal`, `-shm` or `-journal`, a half-finished restore), and never overwrites. Never add `-force` to a hand-run `litestream restore`.
- **A boot that hangs or fails before the app starts is the replica.** On a fresh volume Litestream must reach the replica before the app can start. If it cannot, the app is deliberately not started (section 8).

## 3. The local drill

Run this to see a restore work end to end, with made-up data, before you need it. It needs the `litestream` binary on `PATH` (the version the Dockerfile pins: `ARG LITESTREAM_VERSION`) and `sqlite3`. All paths are under a scratch directory of your choice; nothing touches the repo's database.

```sh
export DRILL=<an empty scratch directory>
export DATABASE_PATH="$DRILL/data/divvy.sqlite3"
export LITESTREAM_REPLICA_URL="file://$DRILL/replica"
mkdir -p "$DRILL/data" "$DRILL/restored"

# Seed: the real migrations, then a few made-up rows.
env -i PATH="$PATH" HOME="$HOME" NODE_ENV=production DATABASE_PATH="$DATABASE_PATH" \
  npx knex --knexfile server/db/knexfile.js migrate:latest
sqlite3 "$DATABASE_PATH" "insert into accounts (akahu_id, name, balance_cents, created_at, updated_at) values ('acc_drill', 'DRILL', 12345, '2026-01-01', '2026-01-01');"

# Replicate with the repo's own config for a few seconds, then stop it.
litestream replicate -config litestream.yml &
sleep 5; kill -TERM $!; wait

# Lose the database, restore it beside, and compare.
rm -rf "$DRILL/data/divvy.sqlite3"* "$DRILL/data/.divvy.sqlite3-litestream"
scripts/restore.sh "$DRILL/restored"
sqlite3 "file:$DRILL/restored/divvy.sqlite3?immutable=1" "select count(*), sum(balance_cents) from accounts;"

# Run it again: it refuses (exit 2) and the file is unchanged.
scripts/restore.sh "$DRILL/restored"; echo "exit $?"
```

A restored database is in WAL mode with no `-shm` beside it, so `sqlite3 -readonly` cannot open it (`unable to open database file`). Open it with `file:<path>?immutable=1`, which reads without writing anything, as above.

## 4. Restore production's replica to a laptop and compare

This is the w4 check that the backup holds what the app shows. Do it right after a sync, so neither side moves while you compare.

1. Restore into an empty directory, with the same three values the machine has:

   ```sh
   mkdir <empty directory>
   LITESTREAM_REPLICA_URL=<replica url> LITESTREAM_ACCESS_KEY_ID=<key id> LITESTREAM_SECRET_ACCESS_KEY=<secret key> \
     scripts/restore.sh <empty directory>
   ```

   It prints `restored: <empty directory>/divvy.sqlite3` and exits 0. The file is readable by you only (mode 0600). Exit 1 means Litestream or its integrity check failed and nothing was written; exit 2 means it refused (the message says why) and nothing was written. Start the line with a space to keep the key out of history.

2. Row counts and integer-cent totals, read without writing:

   ```sh
   sqlite3 "file:<empty directory>/divvy.sqlite3?immutable=1" "
     select 'accounts', count(*), sum(balance_cents) from accounts;
     select 'transactions', count(*), sum(amount_cents) from transactions;
     select scope, name, balance_cents from accounts order by scope, name;
     pragma integrity_check;"
   ```

   Compare the per-account balances against the Dashboard's account list on production.

3. The Dashboard totals, side by side. Serve a **copy** of the restored file locally (the server opens it read-write and adds `-wal`/`-shm` files), with none of the app's secrets:

   ```sh
   cp <empty directory>/divvy.sqlite3 <scratch>/compare.sqlite3
   npm run build:server
   env -i PATH="$PATH" HOME="$HOME" NODE_ENV=production DATABASE_PATH=<scratch>/compare.sqlite3 \
     PORT=3998 SYNC_INTERVAL_MS=2147483647 node dist/server.js
   ```

   In another terminal:

   ```sh
   curl -s "http://127.0.0.1:3998/api/v1/overview?scope=personal"
   curl -s "http://127.0.0.1:3998/api/v1/overview?scope=strawb"
   curl -s "https://divvy.<tailnet>.ts.net/api/v1/overview?scope=personal"
   curl -s "https://divvy.<tailnet>.ts.net/api/v1/overview?scope=strawb"
   ```

   The two answers for each scope should match: `safeToSpend` (every `…Cents` field) and each account's `balanceCents`. `today` and `daysToPayday` come from the clock, so run the four requests within the same minute.

   - Without `AKAHU_USER_TOKEN` the server still starts and serves. Its sync scheduler (`server/sync/scheduler.ts`, started by `server/index.ts`) runs nothing at boot; its first run is one interval later, and a run with no token is recorded as a failed `sync_runs` row, not an Akahu call. `SYNC_INTERVAL_MS=2147483647` (the largest it accepts, about 24 days) keeps even that from happening while you compare.
   - `node dist/server.js` runs no migrations (`npm start` would), so the copy's schema stays the one production has.

   Stop the server and delete the copy and the restored directory when done; they are bank data.

## 5. Restore into a clean Fly volume (prd-01 Done-when 6)

**UNVERIFIED (flyctl -h only).** Two procedures: a drill that proves the backup restores on Fly without touching the live machine, and the real recovery after the volume is lost.

### 5a. Non-destructive drill on a scratch volume

```sh
fly releases --image -a divvy-strawb                     # note the current <image>
fly volumes create restore_drill --region syd --size 1 -a divvy-strawb
fly machine run <image> --region syd -v restore_drill:/data --rm -a divvy-strawb \
  --entrypoint /bin/sh -- -c 'litestream restore -integrity-check quick -o /data/restored.sqlite3 "$LITESTREAM_REPLICA_URL" && cd /app && node -e "
const s = require(\"sqlite3\");
const db = new s.Database(\"file:/data/restored.sqlite3?immutable=1\", s.OPEN_READONLY | s.OPEN_URI);
db.all(\"select (select count(*) from accounts) accounts, (select count(*) from transactions) transactions, (select sum(amount_cents) from transactions) cents\", (e, r) => { console.log(e ? e.message : JSON.stringify(r)); db.close() });"'
fly logs -a divvy-strawb                                 # read the counts from the drill machine
fly machine list -a divvy-strawb                         # the drill machine must be gone (--rm)
fly volumes list -a divvy-strawb                         # note the restore_drill volume id
fly volumes destroy <restore_drill volume id> -a divvy-strawb
```

- The image has no `sqlite3` CLI, so the counts come from Node and the app's own `sqlite3` module (this script was run locally against a restored copy; not in the image).
- The machine runs only `litestream restore`, never `start.sh`: it does not join the tailnet and does not replicate.
- **Open point:** whether a machine started with `fly machine run` receives the app's secrets. If `$LITESTREAM_REPLICA_URL` is empty the restore fails with `file replica path required`. Do not paste the secret key into `-e`: it would sit in the machine's config. If you have to, rotate the bucket credential afterwards (section 1).
- The two counts and the cent sum should equal section 4's numbers taken at the same time.

### 5b. Real recovery: the volume is gone

1. Stop and destroy the machine: `fly machine destroy <machine id> -a divvy-strawb`.
2. Create a new, empty volume with the same name: `fly volumes create divvy_data --region syd --size <size> -a divvy-strawb`.
3. Delete the old `divvy` node from the tailnet admin console (Machines page), or the new one registers as `divvy-1` (deploy.md section 7). The lost volume took `/data/tailscale` with it, so the machine registers again with `TS_AUTHKEY`, which must still be valid (deploy.md section 3).
4. Deploy: `fly deploy --ha=false --no-public-ips -a divvy-strawb`.
5. On boot `fly logs` should show, before `Listening on 127.0.0.1:3005`, Litestream's `attempting restore before replication` and `restore completed`. Then run section 4 to compare.

If the logs show `no backup found, starting fresh` instead, the replica was empty at that URL (often a wrong path in `LITESTREAM_REPLICA_URL`): the app started with a new, empty database. Stop the machine at once (section 7).

## 6. Point in time

To restore the state as it was before something went wrong, list the transactions Litestream has and pick one:

```sh
LITESTREAM_REPLICA_URL=<replica url> LITESTREAM_ACCESS_KEY_ID=<key id> LITESTREAM_SECRET_ACCESS_KEY=<secret key> \
  litestream ltx -level all <replica url>
```

Each line has a `max_txid` (16 hex digits) and a `created` time. Then restore to one of them with either variable, never both:

```sh
RESTORE_TXID=<16 hex digits> scripts/restore.sh <empty directory>
RESTORE_TIMESTAMP=<time, e.g. 2026-01-31T09:00:00Z> scripts/restore.sh <empty directory>
```

with the replica URL and keys set as in section 4. `restore.sh` refuses a malformed value (exit 2) before Litestream runs.

## 7. A fresh volume booted before anyone restored

If the machine came up on an empty volume and the replica was empty or unreachable at that moment, or someone deleted the database by hand, the app started a new, empty database and Litestream is now replicating **that** as the newest state, continuing the same history. The old data is still in the replica, but only by transaction id, and only until retention prunes it (snapshots are kept for about 24 hours by default; REASONED from Litestream's defaults, not measured).

1. Stop the machine now, so nothing more is written: `fly machine stop <machine id> -a divvy-strawb`.
2. Find the last good transaction: `litestream ltx -level all` (section 6) and look for the `created` time just before the empty boot.
3. Restore it into a side directory on a laptop with `RESTORE_TXID=<that txid> scripts/restore.sh <empty directory>`, and check it with section 4.
4. Act the same day.

**UNVERIFIED:** putting that file back onto the volume. Before any of it, snapshot the live volume, so a wrong delete can be undone: `fly volumes snapshots create <volume id> -a divvy-strawb` (**UNVERIFIED (flyctl -h only)**: the syntax is from `fly volumes snapshots create -h`, flyctl v0.4.122; get the volume id from `fly volumes list -a divvy-strawb`). One route is to stop the machine, run a `fly machine run` on the `divvy_data` volume as in 5a that removes the empty `/data/divvy.sqlite3*` and `/data/.divvy.sqlite3-litestream`, then `litestream restore -txid <that txid> -o /data/divvy.sqlite3 "$LITESTREAM_REPLICA_URL"`, then start the machine. Write the steps you actually ran here.

## 8. Troubleshooting

- **Boot hangs: no `Listening on` line, Litestream's `attempting restore before replication` is the last thing in `fly logs`.** The volume has no database and Litestream cannot reach the replica (wrong endpoint, network, provider down). It retries rather than starting the app on an empty database. Check the URL and credentials (section 1); the app starts once the replica answers.
- **`no matching backup files available`** (from `restore.sh`, exit 1, or a hand-run `litestream restore`). The replica has no backup at that URL: the URL or path is wrong, or nothing has replicated yet.
- **`no backup found, starting fresh`** (at boot). The same thing on the machine, and worse: it started a new, empty database and is replicating it (section 7).
- **`cannot restore, output path already exists`.** A hand-run `litestream restore` found a file at `-o`. Pick an empty path. Do not add `-force`.
- **`restore.sh: ERROR: … already exists`.** The target holds a database or one of its files. Use an empty directory.
- **`restore.sh: ERROR: litestream restore failed; nothing was written`.** Litestream's own error is on the line before. `invalid ltx file` means the replica's files are damaged; an integrity-check failure means the restored database failed `PRAGMA quick_check`. Either way no database was left behind.
- **`must specify either 'path' or 'dir'`.** `DATABASE_PATH` is unset where Litestream ran. The image sets it; a hand-run `litestream replicate -config litestream.yml` needs it exported.
- **`file replica path required`.** `LITESTREAM_REPLICA_URL` is unset or empty. Set the secret (section 1).
