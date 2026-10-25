# Deploying Divvy to Fly

The operator runbook for the first deploy (prd-01 w4) and every one after it. Every command here is run by Hannah; no agent runs a `fly` command that changes the app.

## 1. What this deploys

- One machine, Fly app `divvy-strawb`, region `syd` (D1; prd-01 Ruling 6).
- The volume `divvy_data`, mounted at `/data`. It holds the database (`/data/divvy.sqlite3`) and Tailscale's state (`/data/tailscale`), so a restart keeps the same tailnet node.
- No public IP and no Fly service (prd-01 Ruling 7; D4). The only way in is the tailnet.
- The server binds `127.0.0.1:3005`. `tailscale serve`, in the same machine, proxies the tailnet to it. `fly proxy` and the rest of Fly's private network cannot reach the app, by design.
- In userspace networking mode, `tailscaled` forwards a tailnet connection on *any* port to the same port on loopback. So the tailnet policy, not the bind address, is what keeps `http://divvy:3005` (plain HTTP, no TLS) closed: it must allow only port 443 (section 2, checked in section 8).

The image's CMD is `scripts/start.sh`. It refuses to start without `TS_AUTHKEY`, or with `HOST` set to anything but `127.0.0.1`, starts `tailscaled` in userspace networking mode, joins the tailnet, publishes the app with `tailscale serve`, checks that the serve config proxies to the app with Funnel off, and only then runs `npm start` (migrations, then the server). If any tailnet step fails, the app never starts.

## 2. Prerequisites

- The Fly app exists: `fly apps list` shows `divvy-strawb`.
- The volume exists in `syd`: `fly volumes list -a divvy-strawb` shows `divvy_data`.
- On the tailnet admin console's DNS page, **MagicDNS** is on and **HTTPS certificates** are enabled. `tailscale serve --https=443` needs both.
- The tailnet policy file has a `tagOwners` entry for `tag:divvy`, and an access rule letting your own devices reach `tag:divvy:443`. That must be the only rule that reaches `tag:divvy`: the default allow-all rule (`"dst": ["*:*"]`) also opens `tag:divvy:3005` (section 1).

## 3. The auth key

Generate one key in the admin console (Settings, Keys) with these options:

- **Tagged `tag:divvy`**, so the node has no user key expiry.
- **Reusable**, because a lost volume loses `/data/tailscale` and the machine must be able to register again.
- **Not ephemeral**, because a restart or a deploy gap must not delete the node and its name.
- **Pre-approved**, if device approval is on for the tailnet.

The key is a standing credential, held only as a Fly secret. Never paste it into a file, an issue or a chat. Do not revoke it until a `fly machine restart -a divvy-strawb` has been seen to bring the node back. Whether a revoked or expired reusable key still lets a machine reboot with its state intact is unverified; record what you see here.

## 4. Set the secret

```sh
fly secrets set TS_AUTHKEY=<key from admin console> -a divvy-strawb
```

With no machines yet, this only stages the secret for the next deploy. Keep the key out of your shell history: start the line with a space (zsh `HIST_IGNORE_SPACE`), or clear the line from history afterwards.

## 5. Deploy

```sh
fly deploy --ha=false --no-public-ips -a divvy-strawb
```

- `--ha=false` creates one machine, not two.
- `--no-public-ips` stops Fly from allocating an address.
- The build runs on Fly's remote builder, so no local Docker is needed.

**This image has never been built before this deploy.** No `docker build` ran while it was written, so the first `fly deploy` is the first build. Read its output for errors in the `tools` stage (downloads and sha256 checks).

Never run `fly launch`: it can write an `[http_service]` into `fly.toml` from the Dockerfile's `EXPOSE`.

## 6. Verify the machine

```sh
fly ips list -a divvy-strawb            # must print no addresses
fly machines list -a divvy-strawb       # must show exactly one machine
fly volumes list -a divvy-strawb        # divvy_data attached to that machine
fly logs -a divvy-strawb
```

- If `fly ips list` shows any address, release it: `fly ips release <address> -a divvy-strawb`.
- If there is more than one machine, run `fly scale count 1 -a divvy-strawb`. A second machine would get a fresh, empty volume and a second database.
- `fly logs` should show, in this order:
  - `start.sh: serving http://127.0.0.1:3005 on the tailnet as divvy`
  - `start.sh: WARNING: backups are OFF: ...` (until #24 ships the Litestream config)
  - `Listening on 127.0.0.1:3005`

Check the node from inside the machine:

```sh
fly ssh console -a divvy-strawb -C "tailscale --socket=/var/run/tailscale/tailscaled.sock status"
fly ssh console -a divvy-strawb -C "tailscale --socket=/var/run/tailscale/tailscaled.sock serve status"
```

`serve status` should show `(tailnet only)` and `proxy http://127.0.0.1:3005`, and no Funnel line.

## 7. Reach the app

Open `https://divvy.<tailnet>.ts.net` from the phone and the laptop, with `<tailnet>` taken from the admin console's DNS page. The first request is slow while the certificate is issued.

If a stale node named `divvy` already exists on the tailnet (from an earlier attempt), delete it in the admin console first, or the new node registers as `divvy-1`.

## 8. Prove nothing else answers (prd-01 Done-when 5)

- From a device off the tailnet (the phone on cellular with Tailscale switched off): `https://divvy-strawb.fly.dev` gets no answer.
- `dig +short divvy-strawb.fly.dev` prints nothing.
- From that same device, the `.ts.net` name does not load either.
- From a device on the tailnet: `curl -m 5 http://divvy:3005/` fails to connect, because the policy allows only 443. If it answers, fix the policy (section 2).

## 9. Facts to record for the prd-03 spike

- Networking is userspace (`tailscaled --tun=userspace-networking`).
- Run `fly ssh console -a divvy-strawb -C "ls -l /dev/net/tun"` and record whether the machine has a tun device.
- Tailscale SSH (`--ssh`) is not enabled. `mcp/spike/RUNBOOK.md` path A needs it, so enabling it is a separate change.

## 10. Troubleshooting

- **`start.sh: ERROR: HOST=... would bind the app off loopback`.** A `HOST` secret is set. Remove it with `fly secrets unset HOST -a divvy-strawb`.
- **`start.sh: ERROR: TS_AUTHKEY is not set`.** The secret is missing. The machine exits 1, and Fly retries it a limited number of times before giving up. Set the secret (section 4); setting it restarts the machine.
- **`tailscale up failed or timed out`.** The key is wrong, revoked or expired, or the tag is not in `tagOwners`. Generate a new key (section 3) and set it again.
- **`tailscale serve failed or timed out`.** Usually HTTPS certificates or MagicDNS are off for the tailnet (section 2).
- **`tailscaled socket ... did not appear`.** `tailscaled` failed to start. Look at the lines before it in `fly logs`.
- **`serve status does not show a proxy` or `Funnel is on`.** The serve config is not what `start.sh` set. It resets the config on every boot, so this means something else changed it; check `serve status` (section 6).

## 11. Bumping Tailscale or Litestream

Each tool is pinned in the Dockerfile's `tools` stage by two `ARG`s: a version and the sha256 of the amd64 download.

- Tailscale: the sums are on `https://pkgs.tailscale.com/stable/` beside each tarball (`tailscale_<version>_amd64.tgz.sha256`).
- Litestream: the sums are in the GitHub release's `checksums.txt`, on the `litestream-<version>-linux-x86_64.deb` line.

Change both `ARG`s for the tool, and check the new sum against a download of your own before deploying. A wrong sum fails the build, which is the point.

## 12. Teardown and rollback

```sh
fly releases --image -a divvy-strawb                          # past releases and their images
fly deploy --image <image from an earlier release> --ha=false --no-public-ips -a divvy-strawb
fly machine stop <machine id> -a divvy-strawb                 # stop without deleting
fly machine destroy <machine id> -a divvy-strawb              # the volume survives
```

`fly volumes destroy` and `fly apps destroy` delete the volume, which holds the database and the node's identity. That is data loss, and until #24 there is no backup.
