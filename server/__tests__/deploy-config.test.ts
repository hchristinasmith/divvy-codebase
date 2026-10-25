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

  it.each(['fly.toml', 'Dockerfile', 'scripts/start.sh', 'docs/deploy.md'])(
    '%s holds nothing shaped like a Tailscale key',
    (rel) => {
      expect(read(rel)).not.toContain('tskey-')
    },
  )

  it.each([
    'fly secrets set TS_AUTHKEY=',
    'fly deploy --ha=false --no-public-ips',
    'fly ips list',
    'fly machines list',
  ])('docs/deploy.md gives the operator `%s`', (command) => {
    expect(deployMd).toContain(command)
  })
})

// ---- start.sh, run against fake binaries ----

const SENTINEL = 'not-a-real-secret-sentinel'
const SERVE_OK = '|-- / proxy http://127.0.0.1:3005\n'

// tailscaled is node so it can hold a real unix socket. It is wrapped in sh
// that redirects its stdio before exec'ing node: start.sh backgrounds it, and a
// child that kept start.sh's stdout/stderr pipes would make spawnSync wait
// for it to exit. It logs before listening, so a test can see it ran even
// when it then fails.
const FAKE_TAILSCALED_JS = `
const fs = require('node:fs')
const net = require('node:net')
const dir = process.env.FAKE_DIR
fs.appendFileSync(dir + '/calls.log', ['tailscaled', ...process.argv.slice(2)].join(' ') + '\\n')
fs.writeFileSync(dir + '/tailscaled.env', Object.entries(process.env).map(([k, v]) => k + '=' + v).join('\\n'))
fs.writeFileSync(dir + '/tailscaled.pid', String(process.pid))
if (process.env.FAKE_TAILSCALED_FAIL === '1') process.exit(1)
const socket = process.argv.find((a) => a.startsWith('--socket='))
if (process.env.FAKE_TAILSCALED_NO_SOCKET !== '1' && socket) {
  net.createServer().listen(socket.slice('--socket='.length))
}
setTimeout(() => process.exit(0), 30000)
`

const FAKE_TAILSCALE = `#!/bin/sh
echo "tailscale $*" >> "$FAKE_DIR/calls.log"
case " $* " in
  *" up "*) exit "\${FAKE_UP_EXIT:-0}" ;;
  *" serve status "*) cat "$FAKE_DIR/serve-status" ;;
esac
exit 0
`

// macOS has no timeout(1); the container's coreutils does.
const FAKE_TIMEOUT = `#!/bin/sh
echo "timeout $*" >> "$FAKE_DIR/calls.log"
shift
exec "$@"
`

const fakeRecorder = (name: string): string => `#!/bin/sh
echo "${name} $*" >> "$FAKE_DIR/calls.log"
env > "$FAKE_DIR/${name}.env"
exit 0
`

interface Run {
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
    `#!/bin/sh\nexec "${process.execPath}" "$FAKE_DIR/tailscaled.cjs" "$@" >>"$FAKE_DIR/tailscaled.out" 2>&1 </dev/null\n`,
  )
  writeExecutable(join(fakeDir, 'tailscale'), FAKE_TAILSCALE)
  writeExecutable(join(fakeDir, 'timeout'), FAKE_TIMEOUT)
  writeExecutable(join(fakeDir, 'npm'), fakeRecorder('npm'))
  writeExecutable(join(fakeDir, 'litestream'), fakeRecorder('litestream'))
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
}

// The environment is built from scratch so nothing from the developer's shell
// (a real TS_AUTHKEY, a HOST) reaches the script.
function runStart({
  authkey = SENTINEL,
  env = {},
  serveStatus,
}: RunOptions = {}): Run {
  if (serveStatus !== undefined)
    writeFileSync(join(fakeDir, 'serve-status'), serveStatus)
  const base: Record<string, string> = {
    PATH: `${fakeDir}:${process.env.PATH ?? '/usr/bin:/bin'}`,
    FAKE_DIR: fakeDir,
    TS_STATE_DIR: join(tmp, 'state'),
    TS_SOCKET: join(tmp, 's', 'ts.sock'),
    TS_WAIT_SECS: '2',
    LITESTREAM_CONFIG: join(tmp, 'litestream.yml'),
  }
  if (authkey !== null) base.TS_AUTHKEY = authkey
  const result = spawnSync('sh', [startScript], {
    env: { ...base, ...env },
    encoding: 'utf8',
    timeout: 20000,
  })
  const log = join(fakeDir, 'calls.log')
  return {
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
const dump = (name: string): string => {
  const path = join(fakeDir, `${name}.env`)
  return existsSync(path) ? readFileSync(path, 'utf8') : ''
}

describe('scripts/start.sh, run', { timeout: 20000 }, () => {
  it.each([
    ['unset', null],
    ['empty', ''],
  ])('refuses to start anything when TS_AUTHKEY is %s', (_label, authkey) => {
    const run = runStart({ authkey })

    expect(run.status).not.toBe(0)
    expect(run.stderr).toContain('TS_AUTHKEY')
    expect(run.calls).toEqual([])
  })

  it('joins the tailnet, publishes the app there, then runs npm start with backups OFF', () => {
    const run = runStart()

    expect(run.status).toBe(0)
    const order = [
      'tailscaled ',
      `tailscale --socket=${join(tmp, 's', 'ts.sock')} up `,
      `tailscale --socket=${join(tmp, 's', 'ts.sock')} serve reset`,
      `tailscale --socket=${join(tmp, 's', 'ts.sock')} serve --bg --https=443 http://127.0.0.1:3005`,
      `tailscale --socket=${join(tmp, 's', 'ts.sock')} serve status`,
      'npm start',
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

    expect(run.stderr).toContain('WARNING: backups are OFF')
    expect(ran(run.calls, 'litestream')).toBe(false)
  })

  it('runs npm start under litestream replicate when the Litestream config exists', () => {
    const config = join(tmp, 'litestream.yml')
    writeFileSync(config, 'dbs: []\n')
    const run = runStart()

    expect(run.status).toBe(0)
    expect(run.calls.filter((line) => line.startsWith('litestream'))).toEqual([
      `litestream replicate -config ${config} -exec npm start`,
    ])
    expect(ran(run.calls, 'npm')).toBe(false)
    expect(run.stderr).not.toContain('WARNING')
  })

  it('bounds tailscale serve with a timeout', () => {
    const run = runStart()

    expect(
      run.calls.some(
        (line) => line.startsWith('timeout ') && line.includes('serve --bg'),
      ),
    ).toBe(true)
  })

  it.each([
    ['nothing configured', '', 'does not show a proxy'],
    [
      'a proxy to the wrong port',
      '|-- / proxy http://127.0.0.1:9999\n',
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
    },
  )

  it.each([
    [
      'tailscale up fails',
      { FAKE_UP_EXIT: '1' },
      'serve',
      'tailscale up failed',
    ],
    [
      'tailscaled exits at once',
      { FAKE_TAILSCALED_FAIL: '1' },
      'up',
      'tailscaled exited',
    ],
    [
      'the tailscaled socket never appears',
      { FAKE_TAILSCALED_NO_SOCKET: '1' },
      'up',
      'did not appear',
    ],
  ])('fails closed when %s', (_label, env, neverReached, reason) => {
    const run = runStart({ env })

    expect(run.status).not.toBe(0)
    expect(run.stderr).toContain(reason)
    expect(ran(run.calls, 'tailscaled ')).toBe(true)
    const reached = run.calls.some(
      (line) =>
        line.startsWith('tailscale ') &&
        `${line} `.includes(` ${neverReached} `),
    )
    expect(reached).toBe(false)
    expect(ran(run.calls, 'npm')).toBe(false)
  })

  it('never hands the auth key to tailscaled, npm or litestream, and never prints it', () => {
    const plain = runStart()
    const npmEnv = dump('npm')
    const tailscaledEnv = dump('tailscaled')
    stopFakeTailscaled()
    writeFileSync(join(tmp, 'litestream.yml'), 'dbs: []\n')
    const underLitestream = runStart()
    const litestreamEnv = dump('litestream')

    expect(plain.status).toBe(0)
    expect(underLitestream.status).toBe(0)
    for (const env of [npmEnv, tailscaledEnv, litestreamEnv]) {
      expect(env).not.toBe('')
      expect(env).not.toContain(SENTINEL)
      expect(env).not.toContain('TS_AUTHKEY')
    }
    expect(npmEnv).not.toMatch(/^HOST=/m)
    for (const out of [plain, underLitestream]) {
      expect(out.stdout + out.stderr).not.toContain(SENTINEL)
    }
  })
})
