#!/bin/sh
# Restore Divvy's database from its Litestream replica into a side directory
# (D2; prd-01 Done-when 6; #24). Usage:
#
#   LITESTREAM_REPLICA_URL=<url> scripts/restore.sh <target-dir>
#
# Writes <target-dir>/divvy.sqlite3 and nothing else. It never overwrites: it
# refuses, before Litestream runs and having written nothing, when the target
# is missing (it never creates directories), when anything Divvy's database or
# Litestream would leave is already there (any name starting divvy.sqlite3 or
# .divvy.sqlite3: the database, its -wal, -shm or -journal, a half-finished
# restore and its sidecars, Litestream's state directory), or when
# the target is the live database's own directory. A restore lands in a
# temporary name and is moved into place only after Litestream's integrity
# check passes, so a failure leaves the directory as it found it.
#
# The source is the LITESTREAM_REPLICA_URL variable, read straight from the
# replica (no config file, no live database path). Litestream reads
# LITESTREAM_ACCESS_KEY_ID and LITESTREAM_SECRET_ACCESS_KEY from the
# environment itself; this script never prints them or the URL. For a point in
# time set RESTORE_TXID (16 lowercase hex digits, as `litestream ltx` prints
# them) or RESTORE_TIMESTAMP (RFC 3339, e.g. 2026-01-31T09:00:00Z), not both.
#
# Exit status: 0 restored; 1 Litestream or its integrity check failed (nothing
# written); 2 refused or misused (nothing written). Operator steps:
# docs/restore.md. Never `set -x` here: the environment holds the credentials.
set -eu
unset CDPATH
# The restored file is bank data: readable by its owner only, from creation.
umask 077

log() { echo "restore.sh: $*" >&2; }
die() { echo "restore.sh: ERROR: $*" >&2; exit 2; }

[ "$#" -eq 1 ] || die "usage: scripts/restore.sh <target-dir>, one existing directory with no Divvy database in it"
target="$1"
[ -n "$target" ] || die "the target directory is an empty string"
[ -e "$target" ] || die "target $target does not exist. Create an empty directory first; restore.sh never creates one"
[ -d "$target" ] || die "target $target is not a directory"

[ -n "${LITESTREAM_REPLICA_URL:-}" ] || die "LITESTREAM_REPLICA_URL is not set. Export the replica URL (docs/restore.md) and run again"

txid="${RESTORE_TXID:-}"
timestamp="${RESTORE_TIMESTAMP:-}"
if [ -n "$txid" ] && [ -n "$timestamp" ]; then
  die "RESTORE_TXID and RESTORE_TIMESTAMP are both set. Set one of them, or neither for the latest backup"
fi
if [ -n "$txid" ]; then
  case "$txid" in
    *[!0-9a-f]*) die "RESTORE_TXID must be 16 lowercase hex digits, as litestream ltx prints them" ;;
  esac
  [ "${#txid}" -eq 16 ] || die "RESTORE_TXID must be 16 lowercase hex digits, as litestream ltx prints them"
fi
if [ -n "$timestamp" ]; then
  case "$timestamp" in
    *[!0-9TZ:.+-]*) die "RESTORE_TIMESTAMP must be an RFC 3339 time such as 2026-01-31T09:00:00Z" ;;
  esac
fi

db="$target/divvy.sqlite3"
part="$db-restoring"
# Every name the database, SQLite or Litestream leaves starts with
# divvy.sqlite3 or .divvy.sqlite3, including what Litestream makes beside the
# temporary name: it writes through a symlink at its -restoring.tmp, and its
# integrity check replays a stale -restoring-wal into the restored copy. An
# unmatched pattern stays literal and does not exist.
for existing in "$target"/divvy.sqlite3* "$target"/.divvy.sqlite3*; do
  if [ -e "$existing" ] || [ -L "$existing" ]; then
    die "$existing already exists. Refusing: restore.sh never overwrites a database. Restore into an empty directory"
  fi
done

# The live database's directory (the volume, on the machine) is never a
# target: a restore goes beside it and a person decides what to do next. When
# that directory does not exist here, as on a laptop, there is nothing to hit.
live_dir="$(dirname "${DATABASE_PATH:-/data/divvy.sqlite3}")"
if live_real="$(cd -- "$live_dir" 2>/dev/null && pwd -P)"; then
  target_real="$(cd -- "$target" && pwd -P)"
  [ "$target_real" != "$live_real" ] || die "target $target is the live database's directory. Restore into a separate directory"
fi

command -v litestream >/dev/null 2>&1 \
  || die "litestream is not on PATH. Install the version pinned in the Dockerfile (ARG LITESTREAM_VERSION)"

set -- restore -integrity-check quick
if [ -n "$txid" ]; then set -- "$@" -txid "$txid"; fi
if [ -n "$timestamp" ]; then set -- "$@" -timestamp "$timestamp"; fi
set -- "$@" -o "$part" "$LITESTREAM_REPLICA_URL"

# From here on the temporary name is ours (the loop above proved it was
# absent), so any exit removes it. After the move it no longer exists.
trap 'rm -f "$part"' EXIT
trap 'exit 1' INT TERM

log "restoring from the replica into $part"
if ! litestream "$@"; then
  echo "restore.sh: ERROR: litestream restore failed; nothing was written to $target" >&2
  exit 1
fi

if [ -e "$db" ] || [ -L "$db" ]; then
  die "$db appeared while restoring. Refusing to replace it; the restored copy is discarded and nothing was written"
fi
mv "$part" "$db"

echo "restored: $db"
# Litestream restores in WAL mode, which `sqlite3 -readonly` cannot open
# without a -shm file beside it; immutable=1 reads it and writes nothing.
log "check it without writing to it: sqlite3 \"file:$db?immutable=1\""
