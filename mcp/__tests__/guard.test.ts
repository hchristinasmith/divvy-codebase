// The read-only guard (prd-03 Ruling 1, Ruling 3, Ruling 6; Done when 3, 4,
// 5). This test fails if:
//   (a) the tool list differs from the fixed seven, in process or over stdio;
//   (b) any file under mcp/ imports server/** (or client/, src/), directly,
//       by a relative path, or through a shared/ or models/ module;
//   (c) non-test source under mcp/ loads a network module, an HTTP client,
//       an SDK network transport, or calls .listen(;
//   (d) the entry does not exit non-zero, naming but not printing them, when
//       the environment holds a secret-shaped variable;
//   (e) the lint rule that forbids mcp/ importing server/ goes missing.
//
// Run it; never edit it to make a change pass. A change here is a finding
// (prd-03, "The one risk worth watching").

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { afterAll, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { AUDIT_PATH_ENV, REPLICA_PATH_ENV } from '../contracts.ts'
import { ForbiddenEnvError, assertCleanEnv, findForbiddenEnvNames } from '../guard-env.ts'
import { TOOL_NAMES } from '../tools/registry.ts'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const MCP_DIR = join(ROOT, 'mcp')
const ENTRY = 'mcp/index.ts'
const TSX_CLI = join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs')
const ESLINT_CLI = join(ROOT, 'node_modules', 'eslint', 'bin', 'eslint.js')
const PROCESS_TIMEOUT_MS = 30_000

// Every spawned entry gets its replica and audit paths in a scratch dir, never
// the PRD defaults under /app, so wiring the real sink in wave 2 neither breaks
// these tests nor writes to a real audit file.
const SCRATCH = mkdtempSync(join(tmpdir(), 'divvy-mcp-guard-'))
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }))
const CLEAN_ENV: Record<string, string> = {
  PATH: process.env.PATH ?? '',
  [REPLICA_PATH_ENV]: join(SCRATCH, 'replica.sqlite3'),
  [AUDIT_PATH_ENV]: join(SCRATCH, 'audit.sqlite3'),
}

// Written out here, independently of the registry and its own test.
const FIXED_TOOLS = [
  'get_safe_to_spend',
  'list_transactions',
  'get_budgets',
  'get_bills',
  'get_goals',
  'get_habits',
  'get_sync_status',
]

// ---- Source scanning ----

const SOURCE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs)$/

function sourceFilesUnder(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules') continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...sourceFilesUnder(full))
    else if (SOURCE_EXT.test(entry)) out.push(full)
  }
  return out
}

function isTestFile(file: string): boolean {
  return file.split(sep).includes('__tests__')
}

/** Import, export-from, dynamic import and require specifiers; comments and strings ignored. */
function specifiersOf(source: string): string[] {
  return ts.preProcessFile(source, true, true).importedFiles.map((f) => f.fileName)
}

const FORBIDDEN_ROOTS = ['server', 'client', 'src']
const FORBIDDEN_BARE = /^(server|client|src)(\/|$)|^@\//

function underForbiddenRoot(absolute: string): string | undefined {
  const rel = relative(ROOT, absolute)
  return FORBIDDEN_ROOTS.find((root) => rel === root || rel.startsWith(root + sep))
}

/** Where a relative specifier lands on disk, trying the usual extensions. */
function resolveRelative(fromFile: string, spec: string): string {
  const base = resolve(dirname(fromFile), spec)
  const candidates = [
    base,
    ...['.ts', '.tsx', '.js', '.mjs', '.cjs'].map((ext) => base + ext),
    join(base, 'index.ts'),
    join(base, 'index.js'),
  ]
  return candidates.find((c) => existsSync(c) && statSync(c).isFile()) ?? base
}

/** (b) Every way `source` at `file` reaches server/, client/ or src/ directly. */
function forbiddenImports(file: string, source: string): string[] {
  const problems: string[] = []
  for (const spec of specifiersOf(source)) {
    if (FORBIDDEN_BARE.test(spec)) problems.push(spec)
    else if (spec.startsWith('.') && underForbiddenRoot(resolveRelative(file, spec))) problems.push(spec)
  }
  return problems
}

/** (b) Files reachable from `start` by relative imports, outside node_modules. */
function reachableFrom(start: string): Set<string> {
  const seen = new Set<string>()
  const queue = [start]
  while (queue.length > 0) {
    const file = queue.pop() as string
    if (seen.has(file) || !existsSync(file)) continue
    seen.add(file)
    for (const spec of specifiersOf(readFileSync(file, 'utf8'))) {
      if (spec.startsWith('.')) queue.push(resolveRelative(file, spec))
    }
  }
  return seen
}

const NETWORK_MODULES = ['net', 'http', 'https', 'http2', 'dgram', 'tls', 'dns']
const NETWORK_PACKAGES = ['express', 'cors', 'superagent', 'axios', 'undici', 'ws', 'node-fetch', 'dotenv']
const SDK_NETWORK_SUBPATH = /sse|streamablehttp|express|websocket|auth|middleware|http/i
const NETWORK_GLOBALS = new Set(['fetch', 'WebSocket', 'EventSource', 'XMLHttpRequest'])
const GLOBAL_OBJECTS = new Set(['globalThis', 'global', 'self', 'window'])

/** (c) Every network capability non-test `source` reaches for. */
function networkUses(source: string): string[] {
  const problems: string[] = []
  for (const spec of specifiersOf(source)) {
    const bare = spec.replace(/^node:/, '')
    const pkg = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]
    if (NETWORK_MODULES.includes(bare.split('/')[0])) problems.push(`import ${spec}`)
    else if (NETWORK_PACKAGES.includes(pkg)) problems.push(`import ${spec}`)
    else if (pkg === '@modelcontextprotocol/sdk' && SDK_NETWORK_SUBPATH.test(spec.slice(pkg.length))) {
      problems.push(`import ${spec}`)
    }
  }
  const sf = ts.createSourceFile('scan.ts', source, ts.ScriptTarget.Latest, true)
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && node.name.text === 'listen') problems.push('.listen(')
    if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) {
      if (node.argumentExpression.text === 'listen') problems.push("['listen']")
      if (NETWORK_GLOBALS.has(node.argumentExpression.text)) problems.push(node.argumentExpression.text)
    }
    if (
      ts.isPropertyAccessExpression(node) &&
      NETWORK_GLOBALS.has(node.name.text) &&
      ts.isIdentifier(node.expression) &&
      GLOBAL_OBJECTS.has(node.expression.text)
    ) {
      problems.push(`${node.expression.text}.${node.name.text}`)
    }
    if (ts.isIdentifier(node) && NETWORK_GLOBALS.has(node.text)) {
      const parent = node.parent
      const isMemberName = ts.isPropertyAccessExpression(parent) && parent.name === node
      const isKey = ts.isPropertyAssignment(parent) && parent.name === node
      if (!isMemberName && !isKey) problems.push(node.text)
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression
      const dynamic =
        callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === 'require')
      const literal = node.arguments.length === 1 && ts.isStringLiteralLike(node.arguments[0])
      if (dynamic && !literal) problems.push('non-literal import()/require()')
      if (ts.isIdentifier(callee) && callee.text === 'eval') problems.push('eval(')
    }
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'Function') {
      problems.push('new Function(')
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return problems
}

const mcpFiles = sourceFilesUnder(MCP_DIR)
const mcpSourceFiles = mcpFiles.filter((f) => !isTestFile(f))

// ---- (a) the tool list ----

describe('(a) the tool list is the fixed seven', () => {
  it('in process', () => {
    expect([...TOOL_NAMES]).toEqual(FIXED_TOOLS)
  })

  it(
    'over stdio from the entry, as Claude desktop would see it',
    async () => {
      expect(existsSync(TSX_CLI), `tsx not found at ${TSX_CLI}`).toBe(true)
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [TSX_CLI, ENTRY],
        cwd: ROOT,
        env: CLEAN_ENV,
        stderr: 'pipe',
      })
      const client = new Client({ name: 'guard-test', version: '0.0.0' })
      try {
        await client.connect(transport)
        const { tools } = await client.listTools()
        expect(tools.map((t) => t.name)).toEqual(FIXED_TOOLS)
      } finally {
        await client.close()
      }
    },
    PROCESS_TIMEOUT_MS,
  )
})

// ---- (b) no server/ import ----

describe('(b) nothing under mcp/ imports server/**', () => {
  it('finds the mcp/ sources to scan', () => {
    expect(mcpSourceFiles.map((f) => relative(ROOT, f))).toContain(join('mcp', 'index.ts'))
    expect(mcpFiles.map((f) => relative(ROOT, f))).toContain(join('mcp', '__tests__', 'guard.test.ts'))
  })

  it('no file under mcp/, tests included, imports server/, client/ or src/', () => {
    const found = mcpFiles.flatMap((file) =>
      forbiddenImports(file, readFileSync(file, 'utf8')).map((spec) => `${relative(ROOT, file)}: ${spec}`),
    )
    expect(found).toEqual([])
  })

  it('no module reachable from mcp/ sources (shared/, models/ included) lives in server/, client/ or src/', () => {
    const reached = new Set<string>()
    for (const file of mcpSourceFiles) for (const r of reachableFrom(file)) reached.add(r)
    const bad = [...reached].filter((f) => underForbiddenRoot(f)).map((f) => relative(ROOT, f))
    expect(bad).toEqual([])
    expect(reached.size).toBeGreaterThanOrEqual(mcpSourceFiles.length)
  })

  it('the scanner catches every import form and passes shared/', () => {
    const at = join(MCP_DIR, 'tools', 'probe.ts')
    const caught = [
      "import { db } from '../../server/db/connection.ts'",
      "import '../../server'",
      "export * from '../../server/routes/index.ts'",
      "const m = await import('../../server/db/connection.ts')",
      "const m = require('../../server/db/connection')",
      "import x from 'server/db/connection'",
      "import x from '@/lib/utils'",
      "import x from '../../client/apis/transactions.ts'",
    ]
    for (const source of caught) expect(forbiddenImports(at, source), source).not.toEqual([])
    const fine = [
      "import { formatCents } from '../../shared/money.ts'",
      "import { Server } from '@modelcontextprotocol/sdk/server/index.js'",
      "// import '../../server/db/connection.ts'",
      "const s = '../../server/db/connection.ts'",
    ]
    for (const source of fine) expect(forbiddenImports(at, source), source).toEqual([])
  })
})

// ---- (c) no network ----

describe('(c) non-test mcp/ source opens no socket and loads no network code', () => {
  it('no non-test file under mcp/ uses a network module, client or listener', () => {
    const found = mcpSourceFiles.flatMap((file) =>
      networkUses(readFileSync(file, 'utf8')).map((use) => `${relative(ROOT, file)}: ${use}`),
    )
    expect(found).toEqual([])
  })

  it('the scanner catches each network form, with or without node:', () => {
    const caught: string[] = []
    for (const mod of ['net', 'http', 'https', 'http2', 'dgram', 'tls']) {
      caught.push(`import x from '${mod}'`, `import x from 'node:${mod}'`, `const x = require('node:${mod}')`)
    }
    caught.push(
      'server.listen(3000)',
      "server['listen'](3000)",
      "await fetch('https://example.com')",
      "new WebSocket('wss://example.com')",
      "await globalThis.fetch('https://example.com')",
      "await globalThis['fetch']('https://example.com')",
      "import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'",
      "import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js'",
      "import express from 'express'",
      "import 'dotenv/config'",
      'const m = await import(name)',
      "eval('1')",
      "new Function('return 1')",
    )
    for (const source of caught) expect(networkUses(source), source).not.toEqual([])
    const fine = [
      "import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'",
      "import { Server } from '@modelcontextprotocol/sdk/server/index.js'",
      "import { z } from 'zod'",
      'const options = { fetch: 1 }; options.fetch',
      '// server.listen(3000)',
    ]
    for (const source of fine) expect(networkUses(source), source).toEqual([])
  })
})

// ---- (d) the environment guard ----

describe('(d) the entry refuses a secret-bearing environment', () => {
  it('flags every forbidden prefix and secret-shaped name, and nothing else', () => {
    const env = {
      AKAHU_USER_TOKEN: 'v',
      AKAHU_APP_ID: 'v',
      XERO_CLIENT_ID: 'v',
      FLY_APP_NAME: 'v',
      ANTHROPIC_BASE_URL: 'v',
      DB_PASSWORD: 'v',
      OPENAI_API_KEY: 'v',
      my_secret: 'v',
      GITHUB_TOKEN: '',
      PATH: '/usr/bin',
      HOME: '/home/divvy-mcp',
      LANG: 'C',
      DIVVY_REPLICA_PATH: '/app/replica/divvy-ro.sqlite3',
      DIVVY_AUDIT_PATH: '/app/audit/advisor-audit.sqlite3',
    }
    expect(findForbiddenEnvNames(env)).toEqual(
      [
        'AKAHU_USER_TOKEN',
        'AKAHU_APP_ID',
        'XERO_CLIENT_ID',
        'FLY_APP_NAME',
        'ANTHROPIC_BASE_URL',
        'DB_PASSWORD',
        'OPENAI_API_KEY',
        'my_secret',
        'GITHUB_TOKEN',
      ].sort(),
    )
    expect(() => assertCleanEnv({ PATH: '/usr/bin', DIVVY_AUDIT_PATH: '/x' })).not.toThrow()
  })

  it('names the variable and never its value', () => {
    const value = 'akahu-value-9c1e'
    let caught: unknown
    try {
      assertCleanEnv({ AKAHU_USER_TOKEN: value })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(ForbiddenEnvError)
    expect((caught as Error).message).toContain('AKAHU_USER_TOKEN')
    expect((caught as Error).message).not.toContain(value)
  })

  // Each child gets a constructed environment, never `process.env`: the
  // developer's own shell may hold secret-shaped names.
  const SECRET_ENVS: [string, string][] = [
    ['AKAHU_USER_TOKEN', 'sentinel-akahu-4d2b'],
    ['XERO_CLIENT_SECRET', 'sentinel-xero-8e0f'],
    ['FLY_APP_NAME', 'sentinel-fly-1a7c'],
    ['ANTHROPIC_API_KEY', 'sentinel-anthropic-3b9d'],
    ['DATABASE_PASSWORD', 'sentinel-password-6f5e'],
  ]

  it.each(SECRET_ENVS)(
    'the entry exits non-zero with %s set, naming it and printing no value',
    (name, value) => {
      const child = spawnSync(process.execPath, [TSX_CLI, ENTRY], {
        cwd: ROOT,
        env: { ...CLEAN_ENV, [name]: value },
        input: '',
        encoding: 'utf8',
        timeout: PROCESS_TIMEOUT_MS,
      })
      expect(child.status, child.stderr).toBe(1)
      expect(child.stderr).toContain(name)
      expect(child.stderr).not.toContain(value)
      expect(child.stdout).toBe('')
    },
    PROCESS_TIMEOUT_MS,
  )

  it(
    'the entry starts and exits 0 with a clean environment (the positive control)',
    () => {
      const child = spawnSync(process.execPath, [TSX_CLI, ENTRY], {
        cwd: ROOT,
        env: CLEAN_ENV,
        input: '',
        encoding: 'utf8',
        timeout: PROCESS_TIMEOUT_MS,
      })
      expect(child.status, child.stderr).toBe(0)
      expect(child.stdout).toBe('')
    },
    PROCESS_TIMEOUT_MS,
  )
})

// ---- (e) the lint rule ----

describe('(e) the lint rule forbids mcp/ importing server/', () => {
  it(
    'is red for a server/ import under mcp/, and only there',
    () => {
      // The repo's own ESLint and config, fed source on stdin as if it were
      // a file at `file`, so nothing is written to the tree.
      const ruleIds = (text: string, file: string): (string | null)[] => {
        const child = spawnSync(
          process.execPath,
          [ESLINT_CLI, '--stdin', '--stdin-filename', join(ROOT, file), '--format', 'json'],
          { cwd: ROOT, input: text, encoding: 'utf8', timeout: PROCESS_TIMEOUT_MS },
        )
        expect(child.status === 0 || child.status === 1, child.stderr).toBe(true)
        const results = JSON.parse(child.stdout) as { messages: { ruleId: string | null }[] }[]
        return results.flatMap((r) => r.messages.map((m) => m.ruleId))
      }
      const viaRelativePath = "import { db } from '../../server/db/connection.ts'\nexport const x = db\n"

      expect(ruleIds(viaRelativePath, 'mcp/tools/probe.ts')).toContain('no-restricted-imports')
      expect(ruleIds("import x from '../server'\nexport const y = x\n", 'mcp/probe.ts')).toContain(
        'no-restricted-imports',
      )
      const sdk = "import { Server } from '@modelcontextprotocol/sdk/server/index.js'\nexport const s = Server\n"
      expect(ruleIds(sdk, 'mcp/probe.ts')).not.toContain('no-restricted-imports')
      expect(ruleIds(viaRelativePath, 'client/hooks/probe.ts')).not.toContain('no-restricted-imports')
    },
    PROCESS_TIMEOUT_MS,
  )
})
