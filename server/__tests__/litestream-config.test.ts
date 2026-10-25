import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

// Litestream is the only copy of the database off the Fly volume (D2; prd-01
// Done-when 6; #24). Nothing at runtime notices a config that replicates the
// wrong file, names a bucket in a public repo, or opens a listener: Litestream
// would still start and the app would still answer. So the config is pinned
// here as text, against the other files that name the database path. And
// scripts/restore.sh is run for real against a fake litestream, so "never
// overwrites a database" is executed, not just read.

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
const read = (rel: string): string => readFileSync(join(root, rel), 'utf8')

const litestreamYml = read('litestream.yml')
const dockerfile = read('Dockerfile')
const dockerignore = read('.dockerignore')
const flyToml = read('fly.toml')
const knexfile = read('server/db/knexfile.js')
const startSh = read('scripts/start.sh')
const restoreScript = join(root, 'scripts/restore.sh')
const restoreSh = readFileSync(restoreScript, 'utf8')

// Full-line and trailing `#` comments. The config's comments explain what is
// absent, so they name the very words the assertions below forbid.
function stripComments(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/(^|\s)#.*$/, ''))
    .join('\n')
}

const codeLines = (text: string): string[] =>
  stripComments(text)
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== '')

// The first capture group of `pattern` in `text`. Throws while the describe
// blocks are collected, so a file that stops matching fails loudly.
function capture(text: string, pattern: RegExp, what: string): string {
  const match = text.match(pattern)
  if (!match?.[1]) throw new Error(`could not find ${what}`)
  return match[1]
}

// Shapes that would mean a real credential landed in a file: an AWS access
// key id, a Tailscale auth key, a long base64 run (a secret access key).
const KEY_SHAPED: [string, RegExp][] = [
  ['an AWS access key id', /AKIA[0-9A-Z]{16}/],
  ['a Tailscale auth key', /tskey-/],
  ['a long base64 run', /[A-Za-z0-9+/]{40,}/],
]

describe('litestream.yml', () => {
  it('is exactly one database at DATABASE_PATH, restored when missing, with one replica from LITESTREAM_REPLICA_URL', () => {
    expect(codeLines(litestreamYml)).toEqual([
      'dbs:',
      '  - path: ${DATABASE_PATH}',
      '    restore-if-db-not-exists: true',
      '    replica:',
      '      url: ${LITESTREAM_REPLICA_URL}',
    ])
  })

  it.each([
    'addr',
    'socket',
    'metrics',
    'access-key-id',
    'secret-access-key',
    'endpoint',
    'bucket',
    'region',
    'replicas',
  ])('has no %s outside its comments', (word) => {
    expect(stripComments(litestreamYml)).not.toMatch(
      new RegExp(`(^|[^A-Za-z-])${word}([^A-Za-z-]|$)`, 'm'),
    )
  })

  it('names no replica location of its own (no literal URL)', () => {
    expect(litestreamYml).not.toContain('://')
  })

  it.each(KEY_SHAPED)('holds nothing shaped like %s', (_label, shape) => {
    expect(litestreamYml).not.toMatch(shape)
  })

  // Litestream expands variables over the whole file, comments included, and
  // has no default syntax. A stray dollar sign in a comment would expand to
  // whatever that variable holds, or to nothing.
  it('expands only DATABASE_PATH and LITESTREAM_REPLICA_URL, and nowhere else', () => {
    const dollars = [...litestreamYml.matchAll(/\$(\{[^}]*\}|[A-Za-z_]\w*|.)?/g)]
      .map((m) => m[0])

    expect(dollars.sort()).toEqual(
      ['${DATABASE_PATH}', '${LITESTREAM_REPLICA_URL}'].sort(),
    )
  })
})

describe('the database path, everywhere it is named', () => {
  // The production knexfile's fallback is the path the app opens when nothing
  // overrides it; every other file must agree with it.
  const knexPath = capture(
    knexfile,
    /process\.env\.DATABASE_PATH \|\| '([^']+)'/,
    "the production knexfile's DATABASE_PATH fallback",
  )

  it('is /data/divvy.sqlite3 in the production knexfile', () => {
    expect(knexPath).toBe('/data/divvy.sqlite3')
  })

  it('is what the runtime image sets DATABASE_PATH to', () => {
    const instructions = stripComments(dockerfile).replace(/\\\n/g, ' ')
    const runtimeStage = instructions.slice(instructions.lastIndexOf('\nFROM '))
    const envLine = runtimeStage
      .split('\n')
      .find((line) => /^ENV\s.*\bDATABASE_PATH=/.test(line))

    expect(envLine).toBeDefined()
    expect(capture(envLine ?? '', /\bDATABASE_PATH=(\S+)/, 'ENV DATABASE_PATH')).toBe(
      knexPath,
    )
  })

  it("is what fly.toml's [env] sets DATABASE_PATH to", () => {
    const env = stripComments(flyToml).split(/^\[/m).find((t) => t.startsWith('env]'))

    expect(env).toBeDefined()
    expect(capture(env ?? '', /^\s*DATABASE_PATH\s*=\s*"([^"]*)"\s*$/m, 'fly.toml DATABASE_PATH')).toBe(
      knexPath,
    )
  })

  // restore.sh refuses to restore into the live database's directory, which
  // it finds from DATABASE_PATH or, when that is unset, from this fallback.
  it("is restore.sh's fallback for the live database", () => {
    expect(
      capture(
        restoreSh,
        /^live_dir="\$\(dirname "\$\{DATABASE_PATH:-([^}]+)\}"\)"$/m,
        "restore.sh's DATABASE_PATH fallback",
      ),
    ).toBe(knexPath)
  })
})

describe('litestream.yml reaches the container', () => {
  const instructions = stripComments(dockerfile)
  const runtimeStage = instructions.slice(instructions.lastIndexOf('\nFROM '))
  const copyTo = capture(
    runtimeStage,
    /^COPY litestream\.yml (\S+)$/m,
    'the runtime-stage COPY of litestream.yml',
  )

  it('is copied into the runtime stage at /app/litestream.yml', () => {
    expect(copyTo).toBe('/app/litestream.yml')
    expect(dockerfile).not.toContain('#24 adds')
  })

  it("is where start.sh looks for it by default", () => {
    expect(
      capture(
        startSh,
        /^litestream_config="\$\{LITESTREAM_CONFIG:-([^}]+)\}"$/m,
        "start.sh's default Litestream config path",
      ),
    ).toBe(copyTo)
  })

  // A .dockerignore pattern matching the file keeps it out of the build
  // context, and the COPY then fails the build (or, under a builder that
  // ignores the miss, start.sh boots with backups OFF).
  it('is not excluded from the build context by .dockerignore', () => {
    const patterns = codeLines(dockerignore)
      .map((line) => line.trim())
      .filter((line) => !line.startsWith('!'))
    // Enough of Docker's glob syntax for this file: `**/`, `*`, `?`; a match
    // on a directory also excludes everything under it.
    const toRegExp = (glob: string): RegExp => {
      const body = glob
        .replace(/^\//, '')
        .split('**/')
        .map((part) =>
          part
            .replace(/[.+^${}()|[\]\\]/g, '\\$&')
            .replace(/\*/g, '[^/]*')
            .replace(/\?/g, '[^/]'),
        )
        .join('(.*/)?')
      return new RegExp(`^${body}(/.*)?$`)
    }

    // The matcher must see what the file does exclude, or a broken matcher
    // would pass the last line for every file.
    for (const excluded of ['server/db/dev.sqlite3', '.env', 'node_modules']) {
      expect(patterns.some((p) => toRegExp(p).test(excluded))).toBe(true)
    }
    expect(patterns.filter((p) => toRegExp(p).test('litestream.yml'))).toEqual([])
  })
})

describe('scripts/restore.sh, as a file', () => {
  // Comment lines go: the header names `set -x` to forbid it.
  const code = restoreSh.replace(/^\s*#.*$/gm, '')

  it('is an executable POSIX sh script with no bash-only syntax and no tracing', () => {
    expect(statSync(restoreScript).mode & 0o111).not.toBe(0)
    expect(restoreSh.startsWith('#!/bin/sh\n')).toBe(true)
    expect(spawnSync('sh', ['-n', restoreScript]).status).toBe(0)
    expect(code).not.toMatch(/\[\[/)
    expect(code).not.toMatch(/^\s*(local|function)\s/m)
    expect(code).not.toContain('<<<')
    expect(code).not.toMatch(/\[ [^\]]*==/)
    expect(code).not.toMatch(/set\s+-[a-z]*x/)
  })

  // Each of these is a way for a restore to replace a database: overwrite
  // the output, skip quietly over one, or create a directory to land in.
  it.each(['-force', '-if-db-not-exists', 'mkdir'])('never uses %s', (word) => {
    expect(code).not.toContain(word)
  })
})

// ---- restore.sh, run against a fake litestream ----

const URL_SENTINEL = 'file:///nonexistent/url-sentinel-replica'
const ID_SENTINEL = 'not-a-real-key-id-sentinel'
const SECRET_SENTINEL = 'not-a-real-secret-sentinel'
const RUN_TIMEOUT_MS = 15000

// Logs its argv, dumps its environment, and writes to the -o path what a
// restore would: the database (`ok`), nothing (`fail`), a partial file then a
// failure (`partial`), or the database while something else creates the
// final name beside it (`race`).
const FAKE_LITESTREAM = `#!/bin/sh
echo "$*" >> "$FAKE_DIR/calls.log"
env > "$FAKE_DIR/litestream.env"
out=
prev=
for arg in "$@"; do
  if [ "$prev" = "-o" ]; then out="$arg"; fi
  prev="$arg"
done
case "\${FAKE_LITESTREAM:-ok}" in
  fail) echo "fake litestream: no matching backup files available" >&2; exit 1 ;;
  partial) printf PARTIAL > "$out"; exit 1 ;;
  race) printf RESTORED > "$out"; printf INTRUDER > "\${out%-restoring}"; exit 0 ;;
  *) printf RESTORED > "$out"; exit 0 ;;
esac
`

let tmp: string
let fakeDir: string
let area: string
let target: string
let live: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'dv-'))
  fakeDir = join(tmp, 'bin')
  area = join(tmp, 'area')
  target = join(area, 'restored')
  live = join(area, 'live')
  for (const dir of [fakeDir, area, target, live]) mkdirSync(dir)
  writeFileSync(join(fakeDir, 'litestream'), FAKE_LITESTREAM)
  chmodSync(join(fakeDir, 'litestream'), 0o755)
  // The live database, so the script's live-directory check has a real
  // directory to resolve; every run points DATABASE_PATH here.
  writeFileSync(join(live, 'divvy.sqlite3'), 'LIVE')
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

// Every entry under `dir`, symlinks not followed: a file by its content, a
// link by its target, a directory by its own entries.
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name)
    const st = lstatSync(path)
    if (st.isSymbolicLink()) out[name] = `link:${readlinkSync(path)}`
    else if (st.isDirectory())
      out[name] = `dir:${JSON.stringify(snapshot(path))}`
    else out[name] = `file:${readFileSync(path, 'utf8')}`
  }
  return out
}

interface RestoreRun {
  status: number | null
  stdout: string
  stderr: string
  calls: string[]
}

interface RestoreOptions {
  env?: Record<string, string | undefined>
  path?: string
  cwd?: string
}

// The environment is built from scratch so nothing from the developer's shell
// (a real replica URL or key, a real litestream) reaches the script. An `env`
// value of undefined removes that variable.
function runRestore(
  args: string[],
  { env = {}, path, cwd }: RestoreOptions = {},
): RestoreRun {
  const merged: Record<string, string | undefined> = {
    PATH: path ?? `${fakeDir}:/usr/bin:/bin`,
    FAKE_DIR: fakeDir,
    LITESTREAM_REPLICA_URL: URL_SENTINEL,
    LITESTREAM_ACCESS_KEY_ID: ID_SENTINEL,
    LITESTREAM_SECRET_ACCESS_KEY: SECRET_SENTINEL,
    DATABASE_PATH: join(live, 'divvy.sqlite3'),
    ...env,
  }
  const childEnv: Record<string, string> = {}
  for (const [key, value] of Object.entries(merged)) {
    if (value !== undefined) childEnv[key] = value
  }
  // Under a laptop's usual umask, so the mode test below means something.
  const command = ['-c', 'umask 022 && exec /bin/sh "$@"', 'sh', restoreScript, ...args]
  const result = spawnSync('/bin/sh', command, {
    env: childEnv,
    cwd,
    encoding: 'utf8',
    timeout: RUN_TIMEOUT_MS,
  })
  const log = join(fakeDir, 'calls.log')
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    calls: existsSync(log)
      ? readFileSync(log, 'utf8').split('\n').filter(Boolean)
      : [],
  }
}

// A PATH holding only the utilities the script itself runs, so litestream
// cannot be found however the machine running the test is set up.
function pathWithoutLitestream(): string {
  const dir = join(tmp, 'bare')
  mkdirSync(dir)
  for (const tool of ['dirname', 'mv', 'rm']) {
    const found = spawnSync('/bin/sh', ['-c', `command -v ${tool}`], {
      encoding: 'utf8',
    }).stdout.trim()
    symlinkSync(found, join(dir, tool))
  }
  return dir
}

const restoreCall = (extra = ''): string =>
  `restore -integrity-check quick ${extra}-o ${target}/divvy.sqlite3-restoring ${URL_SENTINEL}`

type Setup = () => { args: string[]; options?: RestoreOptions }

describe('scripts/restore.sh, run', { timeout: RUN_TIMEOUT_MS * 3 }, () => {
  const existing = (name: string): Setup => () => {
    writeFileSync(join(target, name), 'OLD')
    return { args: [target] }
  }
  const badTxid = (txid: string): Setup => () => ({
    args: [target],
    options: { env: { RESTORE_TXID: txid } },
  })
  const badTimestamp = (timestamp: string): Setup => () => ({
    args: [target],
    options: { env: { RESTORE_TIMESTAMP: timestamp } },
  })

  it.each<[string, Setup, string]>([
    ['no argument', () => ({ args: [] }), 'usage:'],
    ['two arguments', () => ({ args: [target, live] }), 'usage:'],
    ['an empty argument', () => ({ args: [''] }), 'empty string'],
    [
      'a target that does not exist',
      () => ({ args: [join(area, 'missing')] }),
      'does not exist',
    ],
    [
      'a target that is a file',
      () => {
        writeFileSync(join(area, 'a-file'), 'FILE')
        return { args: [join(area, 'a-file')] }
      },
      'is not a directory',
    ],
    [
      'LITESTREAM_REPLICA_URL unset',
      () => ({
        args: [target],
        options: { env: { LITESTREAM_REPLICA_URL: undefined } },
      }),
      'LITESTREAM_REPLICA_URL is not set',
    ],
    [
      'LITESTREAM_REPLICA_URL empty',
      () => ({ args: [target], options: { env: { LITESTREAM_REPLICA_URL: '' } } }),
      'LITESTREAM_REPLICA_URL is not set',
    ],
    ['a database already in the target', existing('divvy.sqlite3'), 'divvy.sqlite3 already exists'],
    ['a -wal in the target', existing('divvy.sqlite3-wal'), 'divvy.sqlite3-wal already exists'],
    ['a -shm in the target', existing('divvy.sqlite3-shm'), 'divvy.sqlite3-shm already exists'],
    [
      'a -journal in the target',
      existing('divvy.sqlite3-journal'),
      'divvy.sqlite3-journal already exists',
    ],
    [
      'a half-finished restore in the target',
      existing('divvy.sqlite3-restoring'),
      'divvy.sqlite3-restoring already exists',
    ],
    // Litestream's integrity check opens the restored copy with SQLite, which
    // replays a stale -wal beside it into the result (seen in review on
    // Litestream 0.5.17: the "restored" file held the stale WAL's rows).
    [
      'a stale -wal beside the temporary name',
      existing('divvy.sqlite3-restoring-wal'),
      'divvy.sqlite3-restoring-wal already exists',
    ],
    // Litestream writes its -o path plus .tmp with a create-and-truncate that
    // follows a symlink, so a link there would overwrite the file it points at.
    [
      "a symlink at Litestream's own temporary file",
      () => {
        writeFileSync(join(area, 'elsewhere.sqlite3'), 'ELSEWHERE')
        symlinkSync(join(area, 'elsewhere.sqlite3'), join(target, 'divvy.sqlite3-restoring.tmp'))
        return { args: [target] }
      },
      'divvy.sqlite3-restoring.tmp already exists',
    ],
    [
      'a dangling symlink at the database name',
      () => {
        symlinkSync(join(area, 'gone'), join(target, 'divvy.sqlite3'))
        return { args: [target] }
      },
      'divvy.sqlite3 already exists',
    ],
    [
      "Litestream's state directory in the target",
      () => {
        mkdirSync(join(target, '.divvy.sqlite3-litestream'))
        return { args: [target] }
      },
      '.divvy.sqlite3-litestream already exists',
    ],
    [
      "the live database's directory as the target",
      () => {
        rmSync(join(live, 'divvy.sqlite3'))
        return { args: [live] }
      },
      "is the live database's directory",
    ],
    [
      "a symlink to the live database's directory as the target",
      () => {
        rmSync(join(live, 'divvy.sqlite3'))
        symlinkSync(live, join(area, 'alias'))
        return { args: [join(area, 'alias')] }
      },
      "is the live database's directory",
    ],
    [
      'both RESTORE_TXID and RESTORE_TIMESTAMP',
      () => ({
        args: [target],
        options: {
          env: {
            RESTORE_TXID: '0000000000000002',
            RESTORE_TIMESTAMP: '2026-01-31T09:00:00Z',
          },
        },
      }),
      'both set',
    ],
    ['a short RESTORE_TXID', badTxid('2'), 'RESTORE_TXID must be'],
    ['a 0x RESTORE_TXID', badTxid('0x00000000000002'), 'RESTORE_TXID must be'],
    ['an uppercase RESTORE_TXID', badTxid('000000000000000A'), 'RESTORE_TXID must be'],
    ['a 17-digit RESTORE_TXID', badTxid('00000000000000002'), 'RESTORE_TXID must be'],
    ['a RESTORE_TXID with a flag in it', badTxid('0000000000000002 -force'), 'RESTORE_TXID must be'],
    ['a word as RESTORE_TIMESTAMP', badTimestamp('yesterday'), 'RESTORE_TIMESTAMP must be'],
    [
      'a RESTORE_TIMESTAMP with a space',
      badTimestamp('2026-01-31 09:00:00Z'),
      'RESTORE_TIMESTAMP must be',
    ],
    [
      'a RESTORE_TIMESTAMP with a command in it',
      badTimestamp('2026-01-31T09:00:00Z;rm'),
      'RESTORE_TIMESTAMP must be',
    ],
    [
      'litestream not on PATH',
      () => ({ args: [target], options: { path: pathWithoutLitestream() } }),
      'litestream is not on PATH',
    ],
  ])('refuses %s: exit 2, litestream never runs, nothing changes', (_label, setup, reason) => {
    const { args, options } = setup()
    const before = snapshot(area)
    const run = runRestore(args, options)

    expect(run.status).toBe(2)
    expect(run.calls).toEqual([])
    const errors = run.stderr
      .split('\n')
      .filter((line) => line.startsWith('restore.sh: ERROR: '))
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain(reason)
    expect(run.stdout).toBe('')
    expect(snapshot(area)).toEqual(before)
  })

  it('restores the latest backup into the target through a temporary name', () => {
    const run = runRestore([target])

    expect(run.status).toBe(0)
    expect(run.calls).toEqual([restoreCall()])
    expect(readdirSync(target)).toEqual(['divvy.sqlite3'])
    expect(readFileSync(join(target, 'divvy.sqlite3'), 'utf8')).toBe('RESTORED')
    expect(run.stdout).toBe(`restored: ${target}/divvy.sqlite3\n`)
    expect(readFileSync(join(live, 'divvy.sqlite3'), 'utf8')).toBe('LIVE')
  })

  // A restored file is the bank data; runRestore runs under umask 022.
  it('leaves the restored database readable by its owner only', () => {
    const run = runRestore([target])

    expect(run.status).toBe(0)
    expect(statSync(join(target, 'divvy.sqlite3')).mode & 0o777).toBe(0o600)
  })

  it('takes a target relative to where it is run', () => {
    const run = runRestore(['restored'], { cwd: area })

    expect(run.status).toBe(0)
    expect(run.calls).toEqual([
      `restore -integrity-check quick -o restored/divvy.sqlite3-restoring ${URL_SENTINEL}`,
    ])
    expect(readdirSync(target)).toEqual(['divvy.sqlite3'])
  })

  it.each([
    ['RESTORE_TXID', '00000000000000a2', '-txid 00000000000000a2 '],
    ['RESTORE_TIMESTAMP', '2026-01-31T09:00:00Z', '-timestamp 2026-01-31T09:00:00Z '],
    ['RESTORE_TIMESTAMP', '2026-01-31T22:00:00.5+13:00', '-timestamp 2026-01-31T22:00:00.5+13:00 '],
  ])('restores to a point in time from %s=%s', (name, value, flags) => {
    const run = runRestore([target], { env: { [name]: value } })

    expect(run.status).toBe(0)
    expect(run.calls).toEqual([restoreCall(flags)])
    expect(readdirSync(target)).toEqual(['divvy.sqlite3'])
  })

  it.each(['fail', 'partial'])(
    'exits 1 and leaves the target empty when litestream fails (%s)',
    (mode) => {
      const run = runRestore([target], { env: { FAKE_LITESTREAM: mode } })

      expect(run.status).toBe(1)
      expect(run.calls).toEqual([restoreCall()])
      expect(readdirSync(target)).toEqual([])
      expect(run.stderr).toContain('nothing was written')
      expect(run.stdout).toBe('')
    },
  )

  it('does not replace a database that appears while it restores', () => {
    const run = runRestore([target], { env: { FAKE_LITESTREAM: 'race' } })

    expect(run.status).toBe(2)
    expect(run.stderr).toContain('appeared while restoring')
    expect(readdirSync(target)).toEqual(['divvy.sqlite3'])
    expect(readFileSync(join(target, 'divvy.sqlite3'), 'utf8')).toBe('INTRUDER')
  })

  it('hands litestream the credentials and never prints them or the replica URL', () => {
    const ok = runRestore([target])
    const okEnv = readFileSync(join(fakeDir, 'litestream.env'), 'utf8')
    rmSync(join(target, 'divvy.sqlite3'))
    const failed = runRestore([target], { env: { FAKE_LITESTREAM: 'fail' } })

    expect(ok.status).toBe(0)
    expect(failed.status).toBe(1)
    expect(okEnv).toMatch(new RegExp(`^LITESTREAM_ACCESS_KEY_ID=${ID_SENTINEL}$`, 'm'))
    expect(okEnv).toMatch(
      new RegExp(`^LITESTREAM_SECRET_ACCESS_KEY=${SECRET_SENTINEL}$`, 'm'),
    )
    const calls = readFileSync(join(fakeDir, 'calls.log'), 'utf8')
    expect(calls).not.toContain(ID_SENTINEL)
    expect(calls).not.toContain(SECRET_SENTINEL)
    for (const run of [ok, failed]) {
      for (const secret of [ID_SENTINEL, SECRET_SENTINEL, URL_SENTINEL]) {
        expect(run.stdout + run.stderr).not.toContain(secret)
      }
    }
  })
})

// ---- the runbook ----

const restoreMd = read('docs/restore.md')
const deployMd = read('docs/deploy.md')
const SECRETS = [
  'LITESTREAM_REPLICA_URL',
  'LITESTREAM_ACCESS_KEY_ID',
  'LITESTREAM_SECRET_ACCESS_KEY',
]

// Fenced sh blocks only, so prose that merely names a command cannot stand
// in for the command the operator copies.
const shBlocks = (markdown: string): string[] =>
  [...markdown.matchAll(/^ *```sh\n([\s\S]*?)^ *```$/gm)].map((b) => b[1])

describe('docs/restore.md', () => {
  const blocks = shBlocks(restoreMd)

  it('gives the operator one fly secrets set line with all three secrets', () => {
    const lines = blocks.flatMap((block) => block.split('\n'))
    const set = lines.filter((line) => line.includes('fly secrets set '))

    expect(set).toHaveLength(1)
    for (const name of SECRETS) expect(set[0]).toContain(` ${name}=`)
    expect(set[0]).toContain('-a divvy-strawb')
  })

  // The listing is run with the URL set as a prefix on the same line, and the
  // shell expands an argument before that prefix applies, so "$VAR" there is
  // empty and Litestream fails ("database path or replica URL required").
  it('gives litestream ltx the replica URL literally, not as a variable', () => {
    const ltx = blocks
      .flatMap((block) => block.split('\n'))
      .filter((line) => line.includes('litestream ltx '))

    expect(ltx.length).toBeGreaterThan(0)
    for (const line of ltx) expect(line).not.toContain('$')
  })

  it('gives the operator scripts/restore.sh to run', () => {
    expect(blocks.some((block) => block.includes('scripts/restore.sh '))).toBe(true)
  })

  // A restored database is in WAL mode with no -shm, which `sqlite3
  // -readonly` refuses to open (found by the #24 drill).
  it('never tells the operator to open a restored database with sqlite3 -readonly', () => {
    expect(blocks.length).toBeGreaterThan(0)
    for (const block of blocks) expect(block).not.toContain('sqlite3 -readonly')
  })

  // Each bold lead quoting `restore.sh: ERROR: ...` must begin a message the
  // script really dies with; `…` in the doc stands for the part that varies.
  it('quotes only messages restore.sh prints', () => {
    const printed = [
      ...restoreSh.matchAll(/(?:\bdie|restore\.sh: ERROR:) "?([^"\n]*)"?/g),
    ].map((m) => m[1].replace(/\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/g, '…'))
    const quoted = [...restoreMd.matchAll(/^- \*\*`restore\.sh: ERROR: ([^`]+)`/gm)]
      .map((m) => m[1])

    expect(quoted.length).toBeGreaterThan(0)
    for (const text of quoted) {
      const fixed = text.split('…').map((part) => part.trim()).filter(Boolean)
      expect(
        printed.some((message) => fixed.every((part) => message.includes(part))),
      ).toBe(true)
    }
  })
})

describe('docs/deploy.md, the backup', () => {
  it('links the restore runbook and names the three secrets', () => {
    expect(deployMd).toContain('](restore.md)')
    for (const name of SECRETS) expect(deployMd).toContain(`\`${name}\``)
  })
})

describe.each(['docs/restore.md', 'docs/deploy.md'])('%s', (rel) => {
  it.each(KEY_SHAPED)('holds nothing shaped like %s', (_label, shape) => {
    expect(read(rel)).not.toMatch(shape)
  })
})
