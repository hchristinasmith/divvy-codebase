import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Litestream is the only copy of the database off the Fly volume (D2; prd-01
// Done-when 6; #24). Nothing at runtime notices a config that replicates the
// wrong file, names a bucket in a public repo, or opens a listener: Litestream
// would still start and the app would still answer. So the config is pinned
// here as text, against the other files that name the database path.

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
const read = (rel: string): string => readFileSync(join(root, rel), 'utf8')

const litestreamYml = read('litestream.yml')
const dockerfile = read('Dockerfile')
const dockerignore = read('.dockerignore')
const flyToml = read('fly.toml')
const knexfile = read('server/db/knexfile.js')
const startSh = read('scripts/start.sh')

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
