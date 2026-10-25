# prd-03 wave 1 spike: stdio over SSH to a hello-world MCP server

Answers prd-03 open question 1 (Ruling 3): does Claude desktop reach an MCP
server on the Fly machine over Tailscale SSH as `divvy-mcp`, or does it need
the `fly ssh console` fallback? Everything below is done by hand on the running
machine. No repo script, no Dockerfile edit, no fly.toml edit, no Fly secret.
Record the result in the table at the end; amending the PRD is Hannah's act.

Placeholders, fill in once:

| Placeholder | Meaning |
|---|---|
| `<app>` | the Fly app name (`fly apps list`) |
| `<machine>.<tailnet>.ts.net` | the machine's MagicDNS name (`tailscale status`) |

Run everything from the repo root on your Mac unless it says otherwise.

## 0. Preflight

Tailscale runs inside the app machine. `scripts/start.sh` step 2 starts
`tailscaled` in userspace networking mode, and step 3 runs `tailscale up`
without `--ssh`, so Tailscale SSH is off. Until a separate change enables
`--ssh` (docs/deploy.md section 9), run path B only and record path A as
**"not testable yet, Tailscale SSH off"**.

```bash
fly status -a <app>
fly ssh console -a <app> -C "sh -c 'command -v useradd; command -v su; command -v node; command -v tailscale; node --version'"
tailscale status
```

- `fly status` shows no started machine: stop, there is nothing to test against.
- `node --version` must be v22 (the bundle targets node22).
- `command -v` is one name per call: the machine's `sh` is dash, which
  ignores every name after the first.
- If `tailscale` is listed, record how prd-01 runs it. The slim image has no
  `ps`, so this reads each process's command line from `/proc`:

  ```bash
  fly ssh console -a <app> -C "sh -c 'for f in /proc/[0-9]*/cmdline; do xargs -0 < \$f; done | grep [t]ailscaled; tailscale status --self'"
  ```

  Note userspace-networking (`--tun=userspace-networking`) or a tun device, and
  whether `tailscale up` was given `--ssh`.
- Path A also needs a tailnet ACL `ssh` rule letting only your devices in as
  `divvy-mcp`, with `"action": "accept"` (a `check` rule wants a browser
  re-auth, which a launcher cannot do):

  ```json
  "ssh": [
    { "action": "accept", "src": ["<you>@<idp>"], "dst": ["tag:<machine-tag>"], "users": ["divvy-mcp"] }
  ]
  ```

## 1. Bundle

One self-contained file. Do **not** add `--packages=external`: with it the
bundle needs `node_modules` beside it and dies with `ERR_MODULE_NOT_FOUND`.

```bash
npx esbuild --platform=node --format=esm --bundle --target=node22 \
  --outfile=/tmp/divvy-mcp-spike/hello.mjs mcp/spike/hello.ts
```

Local sanity check, from a directory with no `node_modules` and an empty
environment. Expect two JSON lines (ids 1 and 2, the second listing `hello`),
then exit 0:

```bash
cd /tmp/divvy-mcp-spike && (printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'; sleep 2) \
  | env -i PATH=/usr/bin:/bin "$(which node)" hello.mjs; echo "exit=$?"; cd -
```

## 2. Upload

`/tmp`, not `/data`: it evaporates when the machine restarts, which is intended.

```bash
fly ssh console -a <app> -C "mkdir -p /tmp/divvy-mcp-spike"
fly ssh sftp shell -a <app>
```

At the sftp prompt:

```
put /tmp/divvy-mcp-spike/hello.mjs /tmp/divvy-mcp-spike/hello.mjs
```

Exit the prompt (Ctrl-D), then:

```bash
fly ssh console -a <app> -C "chmod -R a+rX /tmp/divvy-mcp-spike"
fly ssh console -a <app> -C "ls -l /tmp/divvy-mcp-spike"
```

The sftp syntax is not verified here (flyctl was not installed where this was
written). If `put` is refused, check `fly ssh sftp --help` and
`fly ssh sftp shell --help` for the current form.

## 3. Create the `divvy-mcp` user

The base image is `node:22-bookworm-slim` (Debian). The user also evaporates on
restart or deploy, since only `/data` persists.

```bash
fly ssh console -a <app> -C "useradd --system --create-home --shell /bin/sh divvy-mcp"
fly ssh console -a <app> -C "su -s /bin/sh divvy-mcp -c 'id; /usr/local/bin/node --version'"
```

The shell is `/bin/sh`, not `nologin`: Tailscale SSH needs a login shell to run
the command. If wave 2 hardens it to `nologin`, path A must be retested.

Always call node by its absolute path, `/usr/local/bin/node`: the SSH session's
`PATH` need not be the image's.

## 4. Smoke test each path before Claude desktop

Pipe the raw JSON-RPC through the path first. This catches a pty corrupting the
stream, a login banner or MOTD on stdout, and echoed input. The only stdout must
be the two JSON lines from step 1's check.

```bash
smoke() { printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'; sleep 2; }
```

### Path A: Tailscale SSH as `divvy-mcp`

Accept the host key once, interactively (`BatchMode` refuses an unknown key):

```bash
ssh divvy-mcp@<machine>.<tailnet>.ts.net true
```

Then:

```bash
smoke | ssh -T -o BatchMode=yes divvy-mcp@<machine>.<tailnet>.ts.net \
  /usr/local/bin/node /tmp/divvy-mcp-spike/hello.mjs; echo "exit=$?"
```

### Path B: `fly ssh console` through `su`

```bash
smoke | fly ssh console -a <app> \
  -C "su -s /bin/sh divvy-mcp -c '/usr/local/bin/node /tmp/divvy-mcp-spike/hello.mjs'"; echo "exit=$?"
```

If extra lines appear on stdout (for example a "Connecting to ..." line), note
them: Claude desktop will see them too.

## 5. Claude desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json`. Use
absolute paths; the launcher does not read your shell profile. Get the fly path
with `which fly`.

```json
{
  "mcpServers": {
    "divvy-spike-tailscale": {
      "command": "/usr/bin/ssh",
      "args": [
        "-T", "-o", "BatchMode=yes",
        "divvy-mcp@<machine>.<tailnet>.ts.net",
        "/usr/local/bin/node", "/tmp/divvy-mcp-spike/hello.mjs"
      ]
    },
    "divvy-spike-fly": {
      "command": "<absolute path from `which fly`>",
      "args": [
        "ssh", "console", "-a", "<app>",
        "-C", "su -s /bin/sh divvy-mcp -c '/usr/local/bin/node /tmp/divvy-mcp-spike/hello.mjs'"
      ]
    }
  }
}
```

Fully quit Claude desktop (Cmd-Q, not just close the window) and reopen it.
In a new chat, check each server is connected and ask it to call `hello`.
Expect `hello from the divvy-mcp spike`. Launcher logs:
`~/Library/Logs/Claude/mcp-server-divvy-spike-*.log`.

## Facts to record

| Fact | Result | Evidence (command, output, log line) |
|---|---|---|
| Tailscale SSH works as `divvy-mcp` in the mode prd-01 runs Tailscale (userspace networking, `scripts/start.sh` step 2; `--ssh` once enabled) | yes / no / not testable yet, Tailscale SSH off | |
| Claude desktop's launcher works through `ssh` (path A) | yes / no / not testable yet | |
| If not, which fallback: path B (needs flyctl on the Mac), or Streamable HTTP on loopback, which tailscaled forwards tailnet connections to on the same port (docs/deploy.md section 1; needs a new ruling and a tailnet policy rule that lets only your devices reach that port, since section 2 allows only 443) | B / HTTP / none needed | |

### Extra observation for wave 2

`su` without `-l` keeps the caller's environment, so `FLY_*` variables and any
secrets in the session reach the child, and the real entry's `assertCleanEnv`
would refuse to start. Record the variable names (never values) the server
would see under each path, and try `su -l`:

```bash
ssh -T divvy-mcp@<machine>.<tailnet>.ts.net 'env | cut -d= -f1 | sort'
fly ssh console -a <app> -C "su -s /bin/sh divvy-mcp -c 'env | cut -d= -f1 | sort'"
fly ssh console -a <app> -C "su -l -s /bin/sh divvy-mcp -c 'env | cut -d= -f1 | sort'"
```

Hand the lists to the issue "prd03 w2: the MCP runs as its own OS user with no
secrets and no live-file access".

## Cleanup

First remove the `divvy-spike-*` entries from `claude_desktop_config.json` and
restart Claude desktop: while it holds a spike session open, a process runs as
`divvy-mcp` and `userdel` refuses. Then:

```bash
fly ssh console -a <app> -C "userdel -r divvy-mcp"
fly ssh console -a <app> -C "rm -rf /tmp/divvy-mcp-spike"
rm -rf /tmp/divvy-mcp-spike
```

Remove the ACL `ssh` rule if it was added only for this.
