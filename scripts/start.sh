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
# file the app would open. `-e` follows symlinks, as Litestream's os.Stat
# does, so a dangling link at the database counts as missing, which is what
# Litestream will act on; a sidecar counts if anything is there, a dangling
# link included (-L).
db="${DATABASE_PATH:-/data/divvy.sqlite3}"
if [ ! -e "$db" ]; then
  leftovers=""
  for sidecar in "$db-wal" "$db-shm" "$db-journal"; do
    if [ -e "$sidecar" ] || [ -L "$sidecar" ]; then
      leftovers="$leftovers $sidecar"
    fi
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
#    Every tailscale and timeout call below starts the same way, with PATH
#    alone (#319), so none of them holds those secrets either. They need
#    nothing more: the socket goes by flag, the auth key by argv, and each
#    call only talks to tailscaled over the socket; tailscaled, not the CLI,
#    reaches the control plane. env execs, so each call's exit status is the
#    command's own and `|| die` sees it unchanged.
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
env -i PATH="$PATH" tailscale --socket="$socket" up \
  --auth-key="$authkey" --hostname="$ts_hostname" \
  --accept-dns=false --reset --timeout=60s \
  || die "tailscale up failed or timed out; not starting the app"
unset authkey

# 4. Publish on the tailnet. `serve` can exit 0 having configured nothing when
#    HTTPS certs are off, so bound it and verify the result. The proxy match
#    ends at a newline, so a target that merely starts with ours (:30050) fails.
#    timeout runs inside `env -i`, so the tailscale it execs inherits only PATH.
env -i PATH="$PATH" timeout 30 tailscale --socket="$socket" serve reset \
  || die "tailscale serve reset failed"
env -i PATH="$PATH" timeout 30 tailscale --socket="$socket" serve --bg --https=443 "$serve_target" \
  || die "tailscale serve failed or timed out (are MagicDNS and HTTPS certificates enabled on the tailnet?)"
status="$(env -i PATH="$PATH" tailscale --socket="$socket" serve status 2>&1)" \
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
#    app each step execs (sh, a second sh, then node), so the server is the
#    process Litestream passes the signal to, or the one Fly signals directly.
#    Under npm, node got SIGTERM only if npm's script shell had exec'd it, as
#    dash does and bash does not (#255). The -exec string is split by
#    Litestream's shellwords, not a shell: everything sh must see is inside
#    the single quotes, and nothing outside them is special to either.
#
#    The scrub keeps the backup credential, which can delete every backup, out
#    of the app in both branches (#254). It runs inside the command, so after
#    Litestream has copied its keys into the AWS_ names, and unsets every
#    variable `env` lists under either prefix, LITESTREAM_CONFIG included: the
#    app needs none of them (#291). Then it reads `env` again and refuses to
#    start the app if a line still starts with either prefix, if there is no
#    PATH line (so env did not show the environment), or if env fails. A value
#    holding a newline can show a line that looks like a variable: removing
#    that name is harmless, and the check refusing on it is the safe misreading.
#    A name that is not an identifier cannot be unset: dash (the image's sh)
#    never passes one on, and a shell that does, as bash does, is refused by
#    the check. The scrub sets what its children inherit, but a shell's own
#    /proc/<pid>/environ keeps what it started with, so the scrubbed shell
#    execs a fresh sh for the app: the shell that runs npm, and node after
#    it, start from the scrubbed environment. Litestream's own environ still
#    holds its keys. The scrub's working variables are unset first, so one
#    that arrived exported cannot carry the env dump into the app. The
#    newline is made without a backslash, so an echo of the -exec string
#    cannot turn it into a line break.
fail='fail() { echo "start.sh: ERROR: $* Refusing to start the app." >&2; exit 1; }'
# A replica on a non-S3 provider needs this scrub extended first: see docs/restore.md, section 1.
# shellcheck disable=SC2016 # sh -c expands these, not start.sh
scrub='unset scrub_nl scrub_env scrub_line scrub_name; scrub_nl=$(echo; echo x); scrub_nl=${scrub_nl%x}; IFS=$scrub_nl; set -f; scrub_env=$(env) || fail "env failed, so the LITESTREAM_ and AWS_ variables were not removed."; for scrub_line in $scrub_env; do scrub_name=${scrub_line%%=*}; case $scrub_name in *[!A-Za-z0-9_]*) ;; LITESTREAM_* | AWS_*) unset "$scrub_name" || fail "unset failed on a LITESTREAM_ or AWS_ variable."; esac; done'
# shellcheck disable=SC2016 # sh -c expands these, not start.sh
check='scrub_env=$(env) || fail "env failed, so the scrub was not checked."; case "$scrub_nl$scrub_env" in *"${scrub_nl}LITESTREAM_"* | *"${scrub_nl}AWS_"*) fail "a LITESTREAM_ or AWS_ variable is still set after the scrub." ;; *"${scrub_nl}PATH="*) ;; *) fail "env showed no PATH, so the scrub was not checked." ;; esac'
app='npm run migrate:latest && exec node dist/server.js'
# $app holds no ", $, ` or \, so double quotes pass it through unchanged.
cmd="$fail; $scrub; $check; exec sh -c \"$app\""
if [ -f "$litestream_config" ]; then
  log "backups ON (litestream, $litestream_config)"
  exec litestream replicate -config "$litestream_config" -exec "sh -c '$cmd'"
fi
echo "start.sh: WARNING: backups are OFF: no $litestream_config, so nothing replicates the database off the volume (D2, #24)" >&2
exec sh -c "$cmd"
