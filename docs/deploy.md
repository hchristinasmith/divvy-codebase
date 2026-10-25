# Deploying Divvy to Fly

The operator runbook for the first deploy (prd-01 w4) and every one after it. Every command here is run by Hannah; no agent runs a `fly` command that changes the app.

## 1. What this deploys

- One machine, Fly app `divvy-strawb`, region `syd` (D1; prd-01 Ruling 6).
- The volume `divvy_data`, mounted at `/data`. It holds the database (`/data/divvy.sqlite3`) and Tailscale's state (`/data/tailscale`), so a restart keeps the same tailnet node.
- No public IP and no Fly service (prd-01 Ruling 7; D4), so Fly's proxy routes nothing from the internet to the machine.
- The server binds `127.0.0.1:3005`, and `start.sh` refuses to boot with `HOST` set to anything else. That bind is what keeps `fly proxy` and the rest of Fly's private network from reaching the app. `tailscale serve`, in the same machine, proxies the tailnet to it.
- In userspace networking mode, `tailscaled` forwards a tailnet connection on *any* port to the same port on loopback. So the bind does nothing against tailnet peers: the tailnet policy is what decides which devices reach the app and on which port. Without the section 2 policy, every device on the tailnet reaches `http://divvy:3005` (plain HTTP, no TLS) as well as 443 (checked in section 8).

The image's CMD is `scripts/start.sh`. It refuses to start without `TS_AUTHKEY`, or with `HOST` set to anything but `127.0.0.1`, starts `tailscaled` in userspace networking mode with none of the app's environment (only `PATH`), joins the tailnet, publishes the app with `tailscale serve`, checks that the serve config proxies to the app with Funnel off, and only then runs `npm start` (migrations, then the server), under Litestream if `/app/litestream.yml` exists. If any tailnet step fails, the app never starts.

## 2. Prerequisites

- The Fly app exists: `fly apps list` shows `divvy-strawb`.
- The volume exists in `syd`: `fly volumes list -a divvy-strawb` shows `divvy_data`.
- On the tailnet admin console's DNS page, **MagicDNS** is on and **HTTPS certificates** are enabled. `tailscale serve --https=443` needs both.
- The tailnet policy file (admin console, Access controls) has exactly these `tagOwners` and `acls`; this is the policy the tailnet runs. It is mandatory, not a suggestion: the loopback bind does not limit tailnet peers (section 1).

  ```json
  {
    "tagOwners": {
      "tag:divvy": ["autogroup:admin"]
    },
    "acls": [
      {
        "action": "accept",
        "src": ["autogroup:member"],
        "dst": ["tag:divvy:443"]
      },
      {
        "action": "accept",
        "src": ["autogroup:member"],
        "dst": ["autogroup:self:*"]
      }
    ]
  }
  ```

  - `autogroup:admin` (the tailnet's admins: you) may apply `tag:divvy`, which the tagged key in section 3 needs. `autogroup:member` is the devices of the tailnet's users (you); a tagged node is not one of them.
  - These two rules **replace** the default `{"action": "accept", "src": ["*"], "dst": ["*:*"]}` rule; delete that one. Left in, it opens every port on `tag:divvy` (`3005` included) to every device. If the file uses `grants` instead of `acls`, an allow-all grant (`"src": ["*"]`, `"dst": ["*"]`) does the same and must go too.
  - The `autogroup:self:*` rule keeps your own devices talking to each other, which deleting the default rule would otherwise end. It does not reach `tag:divvy`, because a tagged node belongs to no user.
  - There must be no rule with `tag:divvy` in its `src`, so the node cannot dial out to the rest of the tailnet.
  - There must be no `nodeAttrs` entry granting `funnel` to `tag:divvy`. (`start.sh` also refuses to start the app if `serve status` shows Funnel on.)

## 3. The auth key

Generate one key in the admin console (Settings, Keys) with these options:

- **Tagged `tag:divvy`**, so the node has no user key expiry.
- **Reusable**, because a lost volume loses `/data/tailscale` and the machine must be able to register again.
- **Not ephemeral**, because a restart or a deploy gap must not delete the node and its name.
- **Pre-approved**, if device approval is on for the tailnet.
- **The shortest expiry that fits.** Auth keys expire; the admin console allows up to 90 days. The key is needed only for the first registration, or again after a lost volume, so it does not need to outlive the deploy you are about to do by much.

The key is a standing credential, held only as a Fly secret. Never paste it into a file, an issue or a chat. Short of a leak, do not revoke it until a `fly machine restart -a divvy-strawb` has been seen to bring the node back. Whether a revoked or expired reusable key still lets a machine reboot with its state intact is unverified; record what you see here.

**If the secret leaks.** Whoever holds the key can register more `tag:divvy` nodes, because it is reusable and pre-approved. Under the section 2 policy those nodes reach nothing: `tag:divvy` is on the `src` side of no rule. Under the default allow-all policy they reach every device on the tailnet. On a suspected leak:

1. Revoke the key in the admin console (Settings, Keys).
2. Delete every `tag:divvy` node you did not register (Machines page). A tagged node has no key expiry, so revoking the key does not remove nodes already registered with it.
3. Generate a new key with the options above, and set it again with `fly secrets set` (section 4).

## 4. Set the secret

```sh
fly secrets set TS_AUTHKEY=<key from admin console> -a divvy-strawb
```

This has been done once: `TS_AUTHKEY` is staged on `divvy-strawb`. Run it again only with a new key (section 3). With no machines yet, it only stages the secret for the next deploy. Keep the key out of your shell history: start the line with a space (zsh `HIST_IGNORE_SPACE`), or clear the line from history afterwards.

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

Once the certificate is issued, the name `divvy.<tailnet>.ts.net` appears in public Certificate Transparency logs. The name is public from then on; the app behind it is not.

If a stale node named `divvy` already exists on the tailnet (from an earlier attempt), delete it in the admin console first, or the new node registers as `divvy-1`.

## 8. Prove nothing else answers (prd-01 Done-when 5)

- From a device off the tailnet (the phone on cellular with Tailscale switched off): `https://divvy-strawb.fly.dev` gets no answer.
- `dig +short divvy-strawb.fly.dev` prints nothing.
- From that same device, the `.ts.net` name does not load either.
- From a device the section 2 policy allows: `https://divvy.<tailnet>.ts.net` loads.
- From that same device: `curl -m 5 http://divvy:3005/` fails to connect, because the policy allows only 443. If it answers, fix the policy (section 2).

## 9. Facts to record for the prd-03 spike

- Networking is userspace (`tailscaled --tun=userspace-networking`).
- Run `fly ssh console -a divvy-strawb -C "ls -l /dev/net/tun"` and record whether the machine has a tun device.
- Tailscale SSH (`--ssh`) is not enabled. `mcp/spike/RUNBOOK.md` path A needs it, so enabling it is a separate change.

## 10. Troubleshooting

- **`start.sh: ERROR: HOST=... would bind the app off loopback`.** A `HOST` secret is set. Remove it with `fly secrets unset HOST -a divvy-strawb`.
- **`start.sh: ERROR: TS_AUTHKEY is not set`.** The secret is missing. The machine exits 1, and Fly retries it a limited number of times before giving up. Set the secret (section 4); setting it restarts the machine.
- **`tailscale up failed or timed out`.** The key is wrong, revoked or expired, or the tag is not in `tagOwners`. Generate a new key (section 3) and set it again.
- **`tailscale serve failed or timed out`.** Usually HTTPS certificates or MagicDNS are off for the tailnet (section 2).
- **`tailscaled socket ... did not appear`.** `tailscaled` was still running but never created its socket within the wait (30 seconds). Look at the lines before it in `fly logs`.
- **`tailscaled exited before its socket appeared`.** `tailscaled` crashed at startup. Look at the lines before it in `fly logs` for its own error.
- **`tailscale serve reset failed`.** `start.sh` clears the serve config on every boot, and that command failed or ran past its 30 second limit, so `tailscaled` was not answering. The app does not start. Read the lines before it in `fly logs`, then `fly machine restart -a divvy-strawb`.
- **`tailscale serve status failed`.** The command that reads the serve config back failed, so `start.sh` cannot confirm the proxy or that Funnel is off, and it does not start the app. Read the lines before it in `fly logs`, then `fly machine restart -a divvy-strawb`.
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
