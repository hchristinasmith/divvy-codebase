import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

// The deploy has no public surface (prd-01 Ruling 7; D1, D4) and exactly one
// machine (Ruling 6). Nothing at runtime would notice a stray service block
// or a boot path that skips Tailscale: the image would still build and the app
// would still answer, just to the wrong network. So the config files are
// pinned here as text, and scripts/start.sh is run for real against fake
// binaries, so "never serves off the tailnet" is executed, not just read.

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
const read = (rel: string): string => readFileSync(join(root, rel), 'utf8')

const flyToml = read('fly.toml')
const dockerfile = read('Dockerfile')
const startScript = join(root, 'scripts/start.sh')
const startSh = readFileSync(startScript, 'utf8')
const deployMd = read('docs/deploy.md')

// Full-line and trailing `#` comments. The comments in fly.toml and the
// Dockerfile explain what is absent, so they name the very words the
// assertions below forbid.
function stripComments(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/(^|\s)#.*$/, ''))
    .join('\n')
}

// Each table header (`''` for the top level) mapped to its `key = value`
// pairs, values as written. Enough TOML for a flat file like fly.toml.
function tomlShape(text: string): Map<string, Map<string, string>> {
  const tables = new Map<string, Map<string, string>>([['', new Map()]])
  let current = ''
  for (const raw of stripComments(text).split('\n')) {
    const line = raw.trim()
    if (line === '') continue
    if (line.startsWith('[')) {
      current = line
      tables.set(current, tables.get(current) ?? new Map())
      continue
    }
    const pair = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.+)$/)
    if (pair) tables.get(current)?.set(pair[1], pair[2])
  }
  return tables
}

const sorted = (xs: Iterable<string>): string[] => [...xs].sort()

describe('fly.toml', () => {
  const shape = tomlShape(flyToml)
  const keys = (table: string): string[] =>
    sorted(shape.get(table)?.keys() ?? [])

  it('names the app, the Sydney region and the divvy_data volume at /data', () => {
    expect(shape.get('')?.get('app')).toBe('"divvy-strawb"')
    expect(shape.get('')?.get('primary_region')).toBe('"syd"')
    expect(shape.get('[mounts]')?.get('source')).toBe('"divvy_data"')
    expect(shape.get('[mounts]')?.get('destination')).toBe('"/data"')
  })

  it('stops with SIGTERM, waits 30s for it, and builds from the Dockerfile', () => {
    expect(shape.get('')?.get('kill_signal')).toBe('"SIGTERM"')
    expect(shape.get('')?.get('kill_timeout')).toBe('"30s"')
    expect(keys('[build]')).toEqual(['dockerfile'])
    expect(shape.get('[build]')?.get('dockerfile')).toBe('"Dockerfile"')
  })

  it('declares no table that could publish or multiply the machine', () => {
    expect(keys('')).toEqual(
      sorted(['app', 'primary_region', 'kill_signal', 'kill_timeout']),
    )
    expect(sorted(shape.keys())).toEqual(
      sorted(['', '[build]', '[env]', '[mounts]', '[[vm]]']),
    )
  })

  it('sets no environment beyond the three the server reads (no HOST, no TS_*)', () => {
    expect(keys('[env]')).toEqual(sorted(['DATABASE_PATH', 'NODE_ENV', 'PORT']))
  })

  it.each(['force_https', 'handlers', 'release_command', 'HOST', 'TS_AUTHKEY'])(
    'has no %s outside its comments',
    (word) => {
      expect(stripComments(flyToml)).not.toMatch(new RegExp(`\\b${word}\\b`))
    },
  )
})

describe('Dockerfile', () => {
  const instructions = stripComments(dockerfile)
  const runtimeStage = instructions.slice(instructions.lastIndexOf('\nFROM '))

  it('boots through scripts/start.sh, not npm start', () => {
    const cmds = instructions.split('\n').filter((line) => /^CMD\s/.test(line))

    expect(cmds.at(-1)).toBe('CMD ["/app/scripts/start.sh"]')
    expect(instructions).not.toContain('CMD ["npm"')
  })

  it('pins Tailscale and Litestream by version and sha256, and checks the sums', () => {
    expect(instructions).toMatch(/^ARG TAILSCALE_VERSION=\d+\.\d+\.\d+$/m)
    expect(instructions).toMatch(/^ARG TAILSCALE_SHA256=[0-9a-f]{64}$/m)
    expect(instructions).toMatch(/^ARG LITESTREAM_VERSION=\d+\.\d+\.\d+$/m)
    expect(instructions).toMatch(/^ARG LITESTREAM_SHA256=[0-9a-f]{64}$/m)
    expect(
      instructions.match(/sha256sum -c/g)?.length ?? 0,
    ).toBeGreaterThanOrEqual(2)
    expect(instructions).toMatch(
      /echo "\$\{TAILSCALE_SHA256\} .*\| sha256sum -c -/,
    )
    expect(instructions).toMatch(
      /echo "\$\{LITESTREAM_SHA256\} .*\| sha256sum -c -/,
    )
    expect(instructions).not.toContain('/latest/')
  })

  it('downloads each tool at its pinned version', () => {
    const urls = instructions.match(/https:\/\/[^"\s]+/g) ?? []

    expect(urls).toHaveLength(2)
    const tailscale = urls.filter((url) => url.startsWith('https://pkgs.tailscale.com/'))
    const litestream = urls.filter((url) =>
      url.startsWith('https://github.com/benbjohnson/litestream/'),
    )
    expect(tailscale).toHaveLength(1)
    expect(litestream).toHaveLength(1)
    expect(tailscale[0]).toContain('${TAILSCALE_VERSION}')
    expect(litestream[0]).toContain('${LITESTREAM_VERSION}')
  })

  it('ships start.sh into the runtime stage, executable, and runs it as root', () => {
    expect(runtimeStage).toMatch(
      /^COPY --from=build \/app\/scripts\/start\.sh \.\/scripts\/start\.sh$/m,
    )
    expect(runtimeStage).toMatch(/^RUN chmod 755 \/app\/scripts\/start\.sh$/m)
    // tailscaled needs root, and Fly mounts the volume root-owned (see the
    // Dockerfile's comment), so no stage may switch user.
    expect(instructions).not.toMatch(/^\s*USER\b/im)
  })

  it('copies the three binaries into the runtime stage and installs CA roots there', () => {
    expect(runtimeStage).toMatch(
      /^COPY --from=tools \/tools\/tailscale \/tools\/tailscaled \/tools\/litestream \/usr\/local\/bin\/$/m,
    )
    expect(runtimeStage).toMatch(
      /apt-get install -y --no-install-recommends ca-certificates/,
    )
  })

  it('carries no HOST, no auth key and no copied .env or database', () => {
    expect(instructions).not.toMatch(/\bHOST\b/)
    expect(instructions).not.toContain('TS_AUTHKEY')
    const copies = instructions
      .split('\n')
      .filter((line) => /^COPY\s/.test(line))
    expect(copies.length).toBeGreaterThan(0)
    for (const copy of copies) {
      expect(copy).not.toMatch(/\.env|\.sqlite3/)
    }
  })
})

describe('scripts/start.sh and docs/deploy.md, as files', () => {
  it('is an executable POSIX sh script with no bash-only syntax and no tracing', () => {
    // Comment lines go: the header names `set -x` to forbid it.
    const code = startSh.replace(/^\s*#.*$/gm, '')

    expect(statSync(startScript).mode & 0o111).not.toBe(0)
    expect(startSh.startsWith('#!/bin/sh\n')).toBe(true)
    expect(spawnSync('sh', ['-n', startScript]).status).toBe(0)
    expect(code).not.toMatch(/\[\[/)
    expect(code).not.toMatch(/^\s*(local|function)\s/m)
    expect(code).not.toContain('<<<')
    expect(code).not.toMatch(/\[ [^\]]*==/)
    expect(code).not.toMatch(/set\s+-[a-z]*x/)
  })

  // The run tests below see a missing `exec` only where sh is bash: dash
  // execs the last command of a -c string by itself, so on a dash host they
  // stay green. Pinned as text so either host catches it (#255).
  it('ends the app command by exec\'ing node, so no shell stays between it and SIGTERM', () => {
    const app = startSh.match(/^app='([^']*)'$/m)

    expect(app).not.toBeNull()
    expect(app?.[1]).toMatch(/ && exec node dist\/server\.js$/)
  })

  it.each(['fly.toml', 'Dockerfile', 'scripts/start.sh', 'docs/deploy.md'])(
    '%s holds nothing shaped like a Tailscale key',
    (rel) => {
      expect(read(rel)).not.toContain('tskey-')
    },
  )

  // Inside a fenced sh block, so prose that merely names the command (`fly
  // ips list` must print nothing) cannot stand in for it.
  it.each([
    'fly secrets set TS_AUTHKEY=',
    'fly deploy --ha=false --no-public-ips',
    'fly ips list',
    'fly machines list',
  ])('docs/deploy.md gives the operator `%s` to run', (command) => {
    const shBlocks = [...deployMd.matchAll(/^ *```sh\n([\s\S]*?)^ *```$/gm)].map(
      (block) => block[1],
    )
    expect(shBlocks.length).toBeGreaterThan(0)
    expect(shBlocks.some((block) => block.includes(command))).toBe(true)
  })
})

// The runbook's sections, by their `## N.` headings. Called while the
// describe blocks are collected, so a missing heading throws, failing the file.
function deploySection(n: number): string {
  const start = deployMd.indexOf(`\n## ${n}. `)
  if (start === -1) throw new Error(`docs/deploy.md has no "## ${n}." section`)
  const end = deployMd.indexOf(`\n## ${n + 1}. `)
  return deployMd.slice(start, end === -1 ? undefined : end)
}

describe('docs/deploy.md, the tailnet policy', () => {
  // The policy the tailnet runs (set by Hannah). The loopback bind does not
  // limit tailnet peers, so this block is the only thing that keeps :3005 and
  // every other port on tag:divvy closed to them.
  const block = deploySection(2).match(/^ *```json\n([\s\S]*?)^ *```$/m)

  it('is plain JSON in section 2', () => {
    expect(block).not.toBeNull()
    expect(() => JSON.parse(block?.[1] ?? '')).not.toThrow()
  })

  it('lets your devices reach tag:divvy on 443 and each other, and nothing else', () => {
    const policy: unknown = JSON.parse(block?.[1] ?? 'null')

    expect(policy).toStrictEqual({
      tagOwners: { 'tag:divvy': ['autogroup:admin'] },
      acls: [
        {
          action: 'accept',
          src: ['autogroup:member'],
          dst: ['tag:divvy:443'],
        },
        {
          action: 'accept',
          src: ['autogroup:member'],
          dst: ['autogroup:self:*'],
        },
      ],
    })
  })

  it('has no rule with tag:divvy as a source', () => {
    const policy = JSON.parse(block?.[1] ?? 'null') as {
      acls?: { src?: string[] }[]
    }

    expect(policy.acls?.length ?? 0).toBeGreaterThan(0)
    for (const rule of policy.acls ?? []) {
      expect(rule.src ?? []).not.toContain('tag:divvy')
    }
  })
})

describe('docs/deploy.md, troubleshooting', () => {
  // A troubleshooting entry the operator matches against `fly logs` is useless
  // if start.sh never prints it. Each bold lead quotes the start of a message
  // start.sh dies with; `...` in the doc and a $variable in start.sh both
  // stand for the part that varies.
  const VARIES = '...'
  const dieMessages = [...startSh.matchAll(/\bdie "([^"]*)"/g)].map((m) =>
    m[1].replace(/\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/g, VARIES),
  )
  const quoted = [...deploySection(10).matchAll(/^- \*\*(.*?)\*\*/gm)]
    .flatMap((lead) => [...lead[1].matchAll(/`([^`]+)`/g)].map((m) => m[1]))
    .map((text) => text.replace(/^start\.sh: ERROR: /, ''))

  it('finds messages on both sides', () => {
    expect(dieMessages.length).toBeGreaterThan(0)
    expect(quoted.length).toBeGreaterThan(0)
  })

  it.each(quoted)('`%s` begins a message start.sh dies with', (text) => {
    expect(dieMessages.some((message) => message.startsWith(text))).toBe(true)
  })
})

// ---- start.sh, run against fake binaries ----

const SENTINEL = 'not-a-real-secret-sentinel'
// How long start.sh waits for the tailscaled socket. The fake is node, which
// took up to 1.7s to create it on a loaded machine (measured 2026-10-25; a 2s
// wait flaked), so every run that expects the socket gets a wait far above
// that. Only the run that expects it never to appear waits briefly.
const SOCKET_WAIT_SECS = 15
const NO_SOCKET_WAIT_SECS = 2
// Above the wait, so a slow socket fails on start.sh's own message, not on
// spawnSync killing it. A test that runs start.sh twice gets two of these.
const RUN_TIMEOUT_MS = (SOCKET_WAIT_SECS + 15) * 1000
const SERVE_OK = '|-- / proxy http://127.0.0.1:3005\n'

// tailscaled is node so it can hold a real unix socket. It is wrapped in sh
// that redirects its stdio before exec'ing node: start.sh backgrounds it, and a
// child that kept start.sh's stdout/stderr pipes would make spawnSync wait
// for it to exit. The wrapper, not node, records the call and the pid (exec
// keeps it), so both exist as soon as start.sh has launched it: node can take
// seconds to start on a loaded machine, and a test that gives up waiting must
// still see that tailscaled ran, and still be able to kill it. start.sh runs
// it under `env -i`, so it takes its directory from its own path and its
// failure mode from a file in that directory, never from the environment; the
// wrapper names node and the script by absolute path, so it needs nothing
// from PATH either.
const FAKE_TAILSCALED_JS = `
const fs = require('node:fs')
const net = require('node:net')
const dir = __dirname
const mode = (name) => fs.existsSync(dir + '/tailscaled.' + name)
fs.writeFileSync(dir + '/tailscaled.env', Object.entries(process.env).map(([k, v]) => k + '=' + v).join('\\n'))
if (mode('fail')) process.exit(1)
const socket = process.argv.find((a) => a.startsWith('--socket='))
if (!mode('no-socket') && socket) {
  net.createServer().listen(socket.slice('--socket='.length))
}
setTimeout(() => process.exit(0), 30000)
`

// Each subcommand exits with its own FAKE_*_EXIT (default 0). tailscale is
// not run under \`env -i\`, so the environment reaches it.
const FAKE_TAILSCALE = `#!/bin/sh
echo "tailscale $*" >> "$FAKE_DIR/calls.log"
case " $* " in
  *" up "*) exit "\${FAKE_UP_EXIT:-0}" ;;
  *" serve reset "*) exit "\${FAKE_RESET_EXIT:-0}" ;;
  *" serve --bg "*) exit "\${FAKE_SERVE_EXIT:-0}" ;;
  *" serve status "*)
    cat "$FAKE_DIR/serve-status"
    exit "\${FAKE_STATUS_EXIT:-0}" ;;
esac
exit 0
`

// macOS has no timeout(1); the container's coreutils does.
const FAKE_TIMEOUT = `#!/bin/sh
echo "timeout $*" >> "$FAKE_DIR/calls.log"
shift
exec "$@"
`

// Exits with FAKE_<NAME>_EXIT (default 0).
const fakeRecorder = (name: string): string => `#!/bin/sh
echo "${name} $*" >> "$FAKE_DIR/calls.log"
env > "$FAKE_DIR/${name}.env"
echo "$$" > "$FAKE_DIR/${name}.pid"
echo "$PPID" > "$FAKE_DIR/${name}.ppid"
exit "\${FAKE_${name.toUpperCase()}_EXIT:-0}"
`

// Litestream 0.5.17 runs its -exec string as a child, not through a shell:
// it splits it with go-shellwords, starts it with exec.Command, passes on the
// signal it gets, and exits once the child has. Before that it copies its
// credential into the AWS_ names, unless they are set already, so the child
// would inherit both sets (applyLitestreamEnv). This does the same, and
// refuses any character outside single quotes that shellwords and sh might
// read differently (shellwords stops at an unquoted & or ;, dropping the rest).
// The sh wrapper records the call and the pid, then execs node, which keeps it.
const FAKE_LITESTREAM_JS = `
const fs = require('node:fs')
const { spawn } = require('node:child_process')
const dir = __dirname
for (const [from, to] of [
  ['LITESTREAM_ACCESS_KEY_ID', 'AWS_ACCESS_KEY_ID'],
  ['LITESTREAM_SECRET_ACCESS_KEY', 'AWS_SECRET_ACCESS_KEY'],
]) {
  if (from in process.env && !(to in process.env)) process.env[to] = process.env[from]
}
fs.writeFileSync(dir + '/litestream.env', Object.entries(process.env).map(([k, v]) => k + '=' + v).join('\\n'))
const at = process.argv.indexOf('-exec')
const line = at === -1 ? '' : process.argv[at + 1] ?? ''
const words = []
let word = null
let quoted = false
for (const ch of line) {
  if (quoted) {
    if (ch === "'") quoted = false
    else word += ch
  } else if (ch === "'") {
    quoted = true
    word = word ?? ''
  } else if (/\\s/.test(ch)) {
    if (word !== null) words.push(word)
    word = null
  } else if (/[\\\\"$\`()<>|&;]/.test(ch)) {
    console.error('fake litestream: -exec has ' + ch + ' outside single quotes')
    process.exit(64)
  } else {
    word = (word ?? '') + ch
  }
}
if (quoted) process.exit(64)
if (word !== null) words.push(word)
if (words.length === 0) process.exit(0)
const child = spawn(words[0], words.slice(1), { stdio: 'inherit' })
fs.writeFileSync(dir + '/litestream.child.pid', String(child.pid))
child.on('exit', (code) => process.exit(code ?? 1))
`

interface Run {
  pid: number
  status: number | null
  stdout: string
  stderr: string
  calls: string[]
}

let tmp: string
let fakeDir: string

function writeExecutable(path: string, body: string): void {
  writeFileSync(path, body)
  chmodSync(path, 0o755)
}

// Short paths under the OS temp dir: the repo path has spaces, and macOS caps
// a unix socket path at about 104 characters.
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'dv-'))
  fakeDir = join(tmp, 'bin')
  mkdirSync(fakeDir)
  writeFileSync(join(fakeDir, 'tailscaled.cjs'), FAKE_TAILSCALED_JS)
  writeExecutable(
    join(fakeDir, 'tailscaled'),
    [
      '#!/bin/sh',
      `echo "tailscaled $*" >>"${fakeDir}/calls.log"`,
      `echo "$$" >"${fakeDir}/tailscaled.pid"`,
      `exec "${process.execPath}" "${fakeDir}/tailscaled.cjs" "$@" >>"${fakeDir}/tailscaled.out" 2>&1 </dev/null`,
      '',
    ].join('\n'),
  )
  writeExecutable(join(fakeDir, 'tailscale'), FAKE_TAILSCALE)
  writeExecutable(join(fakeDir, 'timeout'), FAKE_TIMEOUT)
  writeExecutable(join(fakeDir, 'npm'), fakeRecorder('npm'))
  writeExecutable(join(fakeDir, 'node'), fakeRecorder('node'))
  writeFileSync(join(fakeDir, 'litestream.cjs'), FAKE_LITESTREAM_JS)
  writeExecutable(
    join(fakeDir, 'litestream'),
    [
      '#!/bin/sh',
      `echo "litestream $*" >>"${fakeDir}/calls.log"`,
      `echo "$$" >"${fakeDir}/litestream.pid"`,
      `exec "${process.execPath}" "${fakeDir}/litestream.cjs" "$@"`,
      '',
    ].join('\n'),
  )
  writeFileSync(join(fakeDir, 'serve-status'), SERVE_OK)
})

// The fake tailscaled outlives start.sh (as the real one does), so each run
// ends by killing it and removing its socket.
function stopFakeTailscaled(): void {
  const pidfile = join(fakeDir, 'tailscaled.pid')
  if (existsSync(pidfile)) {
    try {
      process.kill(Number(readFileSync(pidfile, 'utf8')), 'SIGKILL')
    } catch {
      // already exited
    }
    rmSync(pidfile, { force: true })
  }
  rmSync(join(tmp, 's', 'ts.sock'), { force: true })
}

afterEach(() => {
  stopFakeTailscaled()
  rmSync(tmp, { recursive: true, force: true })
})

interface RunOptions {
  authkey?: string | null
  env?: Record<string, string>
  serveStatus?: string
  tailscaled?: 'fail' | 'no-socket'
}

// The environment is built from scratch so nothing from the developer's shell
// (a real TS_AUTHKEY, a HOST) reaches the script.
function runStart({
  authkey = SENTINEL,
  env = {},
  serveStatus,
  tailscaled,
}: RunOptions = {}): Run {
  if (serveStatus !== undefined)
    writeFileSync(join(fakeDir, 'serve-status'), serveStatus)
  if (tailscaled !== undefined)
    writeFileSync(join(fakeDir, `tailscaled.${tailscaled}`), '')
  const base: Record<string, string> = {
    PATH: `${fakeDir}:${process.env.PATH ?? '/usr/bin:/bin'}`,
    FAKE_DIR: fakeDir,
    TS_STATE_DIR: join(tmp, 'state'),
    TS_SOCKET: join(tmp, 's', 'ts.sock'),
    TS_WAIT_SECS: String(SOCKET_WAIT_SECS),
    LITESTREAM_CONFIG: join(tmp, 'litestream.yml'),
    DATABASE_PATH: join(tmp, 'data', 'divvy.sqlite3'),
  }
  if (authkey !== null) base.TS_AUTHKEY = authkey
  const result = spawnSync('sh', [startScript], {
    env: { ...base, ...env },
    encoding: 'utf8',
    timeout: RUN_TIMEOUT_MS,
  })
  const log = join(fakeDir, 'calls.log')
  return {
    pid: result.pid,
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    calls: existsSync(log)
      ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean)
      : [],
  }
}

const ran = (calls: string[], prefix: string): boolean =>
  calls.some((line) => line.startsWith(prefix))
const recorded = (file: string): string =>
  readFileSync(join(fakeDir, file), 'utf8').trim()
const MIGRATE = 'npm run migrate:latest'
const SERVER = 'node dist/server.js'
const dump = (name: string): string => {
  const path = join(fakeDir, `${name}.env`)
  return existsSync(path) ? readFileSync(path, 'utf8') : ''
}

describe('scripts/start.sh, run', { timeout: 2 * RUN_TIMEOUT_MS + 10000 }, () => {
  it.each([
    ['unset', null],
    ['empty', ''],
  ])('refuses to start anything when TS_AUTHKEY is %s', (_label, authkey) => {
    const run = runStart({ authkey })

    expect(run.status).not.toBe(0)
    expect(run.stderr).toContain('TS_AUTHKEY')
    expect(run.calls).toEqual([])
  })

  it('joins the tailnet, publishes the app there, then migrates and runs the server with backups OFF', () => {
    const run = runStart()

    expect(run.status).toBe(0)
    const order = [
      'tailscaled ',
      `tailscale --socket=${join(tmp, 's', 'ts.sock')} up `,
      `tailscale --socket=${join(tmp, 's', 'ts.sock')} serve reset`,
      `tailscale --socket=${join(tmp, 's', 'ts.sock')} serve --bg --https=443 http://127.0.0.1:3005`,
      `tailscale --socket=${join(tmp, 's', 'ts.sock')} serve status`,
      MIGRATE,
      SERVER,
    ].map((prefix) => run.calls.findIndex((line) => line.startsWith(prefix)))
    expect(order.every((index) => index >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)

    const tailscaled =
      run.calls.find((line) => line.startsWith('tailscaled ')) ?? ''
    expect(tailscaled).toContain('--tun=userspace-networking')
    expect(tailscaled).toContain(`--statedir=${join(tmp, 'state')}`)
    const up = run.calls.find((line) => / up /.test(line)) ?? ''
    expect(up).toContain(`--auth-key=${SENTINEL}`)
    expect(up).toContain('--hostname=divvy')
    expect(up).toContain('--accept-dns=false')
    expect(up).toContain('--reset')
    expect(up).toMatch(/ --timeout=\d+s( |$)/)

    // The lines the runbook (section 6) tells the operator to look for in
    // `fly logs`, in its order.
    const lines = run.stderr.split('\n')
    const serving = 'start.sh: serving http://127.0.0.1:3005 on the tailnet as divvy'
    expect(deployMd).toContain(serving)
    expect(lines).toContain(serving)
    const warning = lines.findIndex((line) =>
      line.startsWith('start.sh: WARNING: backups are OFF'),
    )
    expect(warning).toBeGreaterThan(lines.indexOf(serving))
    expect(ran(run.calls, 'litestream')).toBe(false)
    // exec'd all the way down: the server runs in start.sh's own process, so
    // Fly's SIGTERM to that process reaches it, not a wrapper that keeps it.
    expect(recorded('node.pid')).toBe(String(run.pid))
    expect(recorded('npm.ppid')).toBe(String(run.pid))
  })

  it('refuses to start anything when HOST names an address other than loopback', () => {
    const run = runStart({ env: { HOST: '0.0.0.0' } })

    expect(run.status).not.toBe(0)
    expect(run.stderr).toContain('HOST')
    expect(run.calls).toEqual([])
  })

  it('runs migrations and then the server as litestream replicate\'s -exec child when the Litestream config exists', () => {
    const config = join(tmp, 'litestream.yml')
    writeFileSync(config, 'dbs: []\n')
    const run = runStart()

    expect(run.status).toBe(0)
    const litestream = run.calls.filter((line) => line.startsWith('litestream'))
    expect(litestream).toHaveLength(1)
    expect(litestream[0]).toMatch(
      new RegExp(`^litestream replicate -config ${config} -exec `),
    )
    expect(recorded('litestream.pid')).toBe(String(run.pid))
    // After Litestream started (so after its restore-if-db-not-exists), from
    // inside the command it runs, and before the server.
    expect(run.calls.slice(1 + run.calls.indexOf(litestream[0]))).toEqual([
      MIGRATE,
      SERVER,
    ])
    const child = recorded('litestream.child.pid')
    expect(recorded('npm.ppid')).toBe(child)
    // The server is the -exec child itself, so the SIGTERM Litestream passes
    // on lands on it and Litestream waits for it before its final sync.
    expect(recorded('node.pid')).toBe(child)
    expect(recorded('node.ppid')).toBe(String(run.pid))
    expect(run.stderr).not.toContain('WARNING')
  })

  it.each([
    ['backups OFF', false],
    ['under litestream', true],
  ])('does not start the server when migrations fail, %s', (_label, backups) => {
    if (backups) writeFileSync(join(tmp, 'litestream.yml'), 'dbs: []\n')
    const run = runStart({ env: { FAKE_NPM_EXIT: '1' } })

    expect(run.status).not.toBe(0)
    expect(ran(run.calls, MIGRATE)).toBe(true)
    expect(ran(run.calls, 'node')).toBe(false)
  })

  it('bounds tailscale serve reset and serve --bg with a timeout', () => {
    const run = runStart()
    const socket = join(tmp, 's', 'ts.sock')
    const bounded = run.calls.filter((line) => line.startsWith('timeout '))

    expect(bounded).toHaveLength(2)
    expect(bounded[0]).toMatch(
      new RegExp(`^timeout \\d+ tailscale --socket=${socket} serve reset$`),
    )
    expect(bounded[1]).toMatch(
      new RegExp(
        `^timeout \\d+ tailscale --socket=${socket} serve --bg --https=443 http://127\\.0\\.0\\.1:3005$`,
      ),
    )
  })

  it.each([
    ['nothing configured', '', 'does not show a proxy'],
    [
      'a proxy to the wrong port',
      '|-- / proxy http://127.0.0.1:9999\n',
      'does not show a proxy',
    ],
    [
      'a proxy to a port the target is a prefix of',
      '|-- / proxy http://127.0.0.1:30050\n',
      'does not show a proxy',
    ],
    [
      'Funnel on',
      `# Funnel on:\n#     - https://divvy.example.ts.net\n\n${SERVE_OK}`,
      'Funnel is on',
    ],
  ])(
    'does not start the app when serve status shows %s',
    (_label, serveStatus, reason) => {
      const run = runStart({ serveStatus })

      expect(run.status).not.toBe(0)
      expect(run.stderr).toContain(reason)
      expect(
        ran(
          run.calls,
          `tailscale --socket=${join(tmp, 's', 'ts.sock')} serve status`,
        ),
      ).toBe(true)
      expect(ran(run.calls, 'npm')).toBe(false)
      expect(ran(run.calls, 'node')).toBe(false)
    },
  )

  it.each<[string, RunOptions, string, string]>([
    [
      'tailscale up fails',
      { env: { FAKE_UP_EXIT: '1' } },
      'serve',
      'tailscale up failed',
    ],
    [
      'tailscaled exits at once',
      { tailscaled: 'fail' },
      'up',
      'tailscaled exited',
    ],
    [
      'the tailscaled socket never appears',
      {
        tailscaled: 'no-socket',
        env: { TS_WAIT_SECS: String(NO_SOCKET_WAIT_SECS) },
      },
      'up',
      'did not appear',
    ],
    [
      'tailscale serve reset fails',
      { env: { FAKE_RESET_EXIT: '1' } },
      'serve --bg',
      'tailscale serve reset failed',
    ],
    [
      'tailscale serve --bg times out',
      { env: { FAKE_SERVE_EXIT: '124' } },
      'serve status',
      'tailscale serve failed or timed out',
    ],
    [
      'tailscale serve status fails',
      { env: { FAKE_STATUS_EXIT: '1' } },
      MIGRATE,
      'tailscale serve status failed',
    ],
  ])('fails closed when %s', (_label, options, neverReached, reason) => {
    const run = runStart(options)

    expect(run.status).not.toBe(0)
    // One ERROR line, and it is this step's: a later guard failing instead
    // (say, the proxy check on an empty status) would print a different one.
    const errors = run.stderr
      .split('\n')
      .filter((line) => line.startsWith('start.sh: ERROR: '))
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain(reason)
    expect(ran(run.calls, 'tailscaled ')).toBe(true)
    // Any call, \`timeout\` included, that names the next step's words.
    const reached = run.calls.some((line) =>
      ` ${line} `.includes(` ${neverReached} `),
    )
    expect(reached).toBe(false)
    expect(ran(run.calls, 'npm')).toBe(false)
    expect(ran(run.calls, 'node')).toBe(false)
    expect(run.stderr).not.toContain('start.sh: serving ')
  })

  it.each(['-wal', '-shm', '-journal'])(
    'refuses to start anything when %s is on the volume without its database',
    (suffix) => {
      const db = join(tmp, 'data', 'divvy.sqlite3')
      mkdirSync(dirname(db))
      writeFileSync(`${db}${suffix}`, 'not-a-real-database-leftover')
      writeFileSync(join(tmp, 'litestream.yml'), 'dbs: []\n')
      const run = runStart()

      expect(run.status).not.toBe(0)
      const errors = run.stderr
        .split('\n')
        .filter((line) => line.startsWith('start.sh: ERROR: '))
      expect(errors).toHaveLength(1)
      expect(errors[0]).toContain('with no database')
      expect(errors[0]).toContain(`${db}${suffix}`)
      expect(errors[0]).toContain('docs/restore.md')
      expect(run.calls).toEqual([])
      expect(existsSync(`${db}${suffix}`)).toBe(true)
      expect(existsSync(db)).toBe(false)
    },
  )

  it.each([
    ['the database and its sidecars', ['', '-wal', '-shm']],
    ['no database file at all', []],
  ])('boots when the volume holds %s', (_label, files) => {
    const db = join(tmp, 'data', 'divvy.sqlite3')
    mkdirSync(dirname(db))
    for (const suffix of files) writeFileSync(`${db}${suffix}`, '')
    writeFileSync(join(tmp, 'litestream.yml'), 'dbs: []\n')
    const run = runStart()

    expect(run.status).toBe(0)
    expect(run.stderr).not.toContain('ERROR')
    expect(ran(run.calls, 'litestream replicate ')).toBe(true)
  })

  // Litestream needs the credential and the replica URL; the app does not,
  // and the credential can delete every backup. Secrets can be set while the
  // image lacks the config, so the backups-OFF branch must drop them too.
  it.each([
    ['under litestream', true],
    ['backups OFF', false],
  ])(
    'keeps the backup credential out of npm and the server, %s',
    (_label, backups) => {
      const credential = {
        LITESTREAM_ACCESS_KEY_ID: 'not-a-real-secret-key-id',
        LITESTREAM_SECRET_ACCESS_KEY: 'not-a-real-secret-access-key',
        LITESTREAM_REPLICA_URL: 'file:///not-a-real-replica',
        AWS_SESSION_TOKEN: 'not-a-real-secret-session-token',
      }
      const appSecret = 'not-a-real-secret-sentinel-3'
      if (backups) writeFileSync(join(tmp, 'litestream.yml'), 'dbs: []\n')
      const run = runStart({
        env: { ...credential, AKAHU_USER_TOKEN: appSecret },
      })

      expect(run.status).toBe(0)
      if (backups) {
        const litestreamEnv = dump('litestream')
        for (const [name, value] of Object.entries(credential)) {
          expect(litestreamEnv).toMatch(new RegExp(`^${name}=${value}$`, 'm'))
        }
        expect(litestreamEnv).toMatch(
          new RegExp(`^AWS_ACCESS_KEY_ID=${credential.LITESTREAM_ACCESS_KEY_ID}$`, 'm'),
        )
      }
      for (const name of ['npm', 'node']) {
        const env = dump(name)
        expect(env).not.toBe('')
        const names = env
          .split('\n')
          .filter(Boolean)
          .map((line) => line.slice(0, line.indexOf('=')))
        // LITESTREAM_CONFIG is the config's path, which every run here sets
        // (runStart), not a credential.
        expect(
          names.filter(
            (n) => /^(LITESTREAM|AWS)_/.test(n) && n !== 'LITESTREAM_CONFIG',
          ),
        ).toEqual([])
        for (const value of Object.values(credential)) {
          expect(env).not.toContain(value)
        }
      }
      expect(dump('node')).toMatch(
        new RegExp(`^AKAHU_USER_TOKEN=${appSecret}$`, 'm'),
      )
    },
  )

  it('never hands the auth key to tailscaled, npm, node or litestream, and never prints it', () => {
    const plain = runStart()
    const npmEnv = dump('npm')
    const nodeEnv = dump('node')
    const tailscaledEnv = dump('tailscaled')
    stopFakeTailscaled()
    writeFileSync(join(tmp, 'litestream.yml'), 'dbs: []\n')
    const underLitestream = runStart()
    const litestreamEnv = dump('litestream')
    const childEnv = dump('node')

    expect(plain.status).toBe(0)
    expect(underLitestream.status).toBe(0)
    for (const env of [npmEnv, nodeEnv, tailscaledEnv, litestreamEnv, childEnv]) {
      expect(env).not.toBe('')
      expect(env).not.toContain(SENTINEL)
      expect(env).not.toContain('TS_AUTHKEY')
    }
    expect(nodeEnv).not.toMatch(/^HOST=/m)
    for (const out of [plain, underLitestream]) {
      expect(out.stdout + out.stderr).not.toContain(SENTINEL)
    }
  })

  it('starts tailscaled with none of the app secrets, while the server still gets them', () => {
    const appSecret = 'not-a-real-secret-sentinel-2'
    const run = runStart({
      env: { AKAHU_USER_TOKEN: appSecret, XERO_CLIENT_SECRET: appSecret },
    })
    const tailscaledEnv = dump('tailscaled')
    const nodeEnv = dump('node')

    expect(run.status).toBe(0)
    expect(tailscaledEnv).not.toBe('')
    expect(tailscaledEnv).not.toContain(appSecret)
    expect(tailscaledEnv).not.toContain('AKAHU_USER_TOKEN')
    expect(tailscaledEnv).not.toContain('XERO_CLIENT_SECRET')
    // An allowlist, so a scrub that drops only the names above still fails:
    // PATH from start.sh, what the fake's own sh wrapper sets, and the
    // variable macOS adds to every process it starts.
    const names = tailscaledEnv
      .split('\n')
      .filter(Boolean)
      .map((line) => line.slice(0, line.indexOf('=')))
    expect(names).toContain('PATH')
    for (const name of names) {
      expect([
        'PATH',
        'PWD',
        'OLDPWD',
        'SHLVL',
        '_',
        '__CF_USER_TEXT_ENCODING',
      ]).toContain(name)
    }
    expect(nodeEnv).toMatch(new RegExp(`^AKAHU_USER_TOKEN=${appSecret}$`, 'm'))
    expect(nodeEnv).toMatch(new RegExp(`^XERO_CLIENT_SECRET=${appSecret}$`, 'm'))
  })
})
