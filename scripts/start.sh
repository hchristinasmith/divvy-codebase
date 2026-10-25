#!/bin/sh
# Boot path for the Fly machine (D1, D4): join the tailnet, publish the app on
# it (tailnet only), then run migrations + the app (`node dist/server.js`),
# under Litestream when #24's config is present. Fails closed: if any tailnet
# step fails the app never starts. Never `set -x` here: the auth key is in argv.
set -eu

log() { echo "start.sh: $*" >&2; }
die() { echo "start.sh: ERROR: $*" >&2; exit 1; }

# 1. Take the key out of the environment first so no child inherits it.
authkey="${TS_AUTHKEY:-}"
unset TS_AUTHKEY
[ -n "$authkey" ] || die "TS_AUTHKEY is not set. Refusing to start: the app must be reachable only over the tailnet. Set it with: fly secrets set TS_AUTHKEY=<key from admin console>"

# The server binds HOST, else 127.0.0.1 (#149). Any other address would put the
# app on Fly's private network beside the tailnet, so a stray HOST secret stops
# the boot rather than being obeyed.
case "${HOST:-}" in
  "" | 127.0.0.1) ;;
  *) die "HOST=$HOST would bind the app off loopback. Refusing to start: only tailscaled, on this machine, may reach it. Unset it with: fly secrets unset HOST" ;;
esac

# A -wal, -shm or -journal with no database beside it belongs to a database
# that is gone. Litestream restores only when the database file is missing,
# SQLite then replays a leftover WAL onto the restored copy, and that mix
# replicates as the newest backup (#253; docs/restore.md). With backups off it
# lands on a new, empty database instead. Refuse rather than move them, so the
# volume is left as found, and before the tailnet steps, so a refused boot
# starts nothing. The default is the production knexfile's: this checks the
# file the app would open.
db="${DATABASE_PATH:-/data/divvy.sqlite3}"
if [ ! -e "$db" ]; then
  leftovers=""
  for sidecar in "$db-wal" "$db-shm" "$db-journal"; do
    [ ! -e "$sidecar" ] || leftovers="$leftovers $sidecar"
  done
  [ -z "$leftovers" ] || die "leftover database files with no database:$leftovers. Refusing to start: they would be replayed onto the restored or new database. Move them off the volume (keep them), then restart. See docs/restore.md"
fi

state_dir="${TS_STATE_DIR:-/data/tailscale}"
socket="${TS_SOCKET:-/var/run/tailscale/tailscaled.sock}"
ts_hostname="${TS_HOSTNAME:-divvy}"
wait_secs="${TS_WAIT_SECS:-30}"
port="${PORT:-3005}"
litestream_config="${LITESTREAM_CONFIG:-/app/litestream.yml}"
serve_target="http://127.0.0.1:${port}"

mkdir -p "$state_dir" "$(dirname "$socket")"
chmod 700 "$state_dir"

# 2. tailscaled: userspace networking (no /dev/net/tun, no iptables); state and
#    TLS certs live on the volume so restarts keep identity and cert cache.
#    `env -i` keeps AKAHU_*, XERO_* and the Litestream credentials out of
#    tailscaled's /proc/<pid>/environ; env execs, so $! is tailscaled itself.
env -i PATH="$PATH" tailscaled --tun=userspace-networking --statedir="$state_dir" --socket="$socket" &
tsd_pid=$!

i=0
while [ ! -S "$socket" ]; do
  kill -0 "$tsd_pid" 2>/dev/null || die "tailscaled exited before its socket appeared"
  i=$((i + 1))
  [ "$i" -le "$wait_secs" ] || die "tailscaled socket $socket did not appear within ${wait_secs}s"
  sleep 1
done

# 3. Join. Flags are not remembered: restate every boot; --reset makes this
#    line the single source of config. --accept-dns=false keeps Fly's resolv.conf.
tailscale --socket="$socket" up \
  --auth-key="$authkey" --hostname="$ts_hostname" \
  --accept-dns=false --reset --timeout=60s \
  || die "tailscale up failed or timed out; not starting the app"
unset authkey

# 4. Publish on the tailnet. `serve` can exit 0 having configured nothing when
#    HTTPS certs are off, so bound it and verify the result. The proxy match
#    ends at a newline, so a target that merely starts with ours (:30050) fails.
timeout 30 tailscale --socket="$socket" serve reset \
  || die "tailscale serve reset failed"
timeout 30 tailscale --socket="$socket" serve --bg --https=443 "$serve_target" \
  || die "tailscale serve failed or timed out (are MagicDNS and HTTPS certificates enabled on the tailnet?)"
status="$(tailscale --socket="$socket" serve status 2>&1)" \
  || die "tailscale serve status failed"
case "$status" in
  *"Funnel on"*) die "Funnel is on: that would publish the app to the internet" ;;
esac
case "$status
" in
  *" proxy $serve_target
"*) ;;
  *) die "serve status does not show a proxy to $serve_target" ;;
esac
log "serving $serve_target on the tailnet as $ts_hostname"

# 5. The app: migrations, then the server. Migrations run inside the command
#    Litestream starts, after its restore-if-db-not-exists: run here, before
#    Litestream, they would create an empty database on a fresh volume and
#    the backup would never be restored. start.sh execs Litestream, or the
#    app when backups are off, so Fly's SIGTERM lands on this process. In the
#    app each step execs (env, then sh, then node), so the server is the
#    process Litestream passes the signal to, or the one Fly signals
#    directly. Under npm, node got SIGTERM only if npm's script shell had
#    exec'd it, as dash does and bash does not (#255). `env -u` keeps
#    the backup credential, which can delete every backup, out of the app in
#    both branches (#254); Litestream copies the LITESTREAM_ keys into the AWS_
#    names before it starts the app, so both sets go. The -exec string is
#    split by Litestream's shellwords, not a shell: everything sh must see is
#    inside the single quotes, and nothing outside them is special to either.
app='npm run migrate:latest && exec node dist/server.js'
scrub="-u LITESTREAM_ACCESS_KEY_ID -u LITESTREAM_SECRET_ACCESS_KEY -u LITESTREAM_REPLICA_URL -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY -u AWS_SESSION_TOKEN"
if [ -f "$litestream_config" ]; then
  log "backups ON (litestream, $litestream_config)"
  exec litestream replicate -config "$litestream_config" -exec "env $scrub sh -c '$app'"
fi
echo "start.sh: WARNING: backups are OFF: no $litestream_config, so nothing replicates the database off the volume (D2, #24)" >&2
# $scrub unquoted on purpose: one word per flag and per name.
# shellcheck disable=SC2086
exec env $scrub sh -c "$app"
