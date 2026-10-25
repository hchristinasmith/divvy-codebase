import { readFileSync, readdirSync } from 'node:fs'
import { posix, sep } from 'node:path'
import ts from 'typescript'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import connection from '../../db/connection.ts'
import { assertInMemory, closeDb } from '../../test-utils/app.ts'

// prd-04 Done-when 2 and CLAUDE.md (Architecture): nothing under
// server/agents/ writes money state. Agents write only the inbox tables;
// the one way an agent's output reaches money state is the accept route
// calling `setUserCategory` with source `rule` (#51, decision 3cb449c6).
//
// A sibling of the db guard in server/agents/db/__tests__/proposals.test.ts,
// which pins what server/agents/db/ may name and import. This one covers the
// whole tree and flags writes, not names: modules outside db/ may read
// `transactions` and `category_corrections`. Modules are parsed with the
// TypeScript compiler, so a comment is never code.
//
// What counts as a write, for every module:
//   1. importing a writer: anything under server/sync/, server/xero/ or
//      server/routes/; a server/db/*.ts module that itself contains a write
//      (found by running rule 2 over server/db/); a database driver; knex as
//      a value;
//   2. a knex write (`insert`, `update`, `del`, ...) whose chain does not
//      start at a call naming an inbox table as a literal, or that starts at
//      the knex instance itself (`trx.insert(row).into(...)`). A name is
//      followed to what it was declared as, and a parameter typed
//      `Knex…` or of a `.transaction(...)` callback is a handle, so
//      `const q = db('t'); q.update()` and `(tx) => tx.insert(r).into('t')`
//      are writes to `t`;
//   3. raw SQL, knex's schema, migrate and seed APIs, a computed member access
//      that could reach a write or raw SQL, and every way of loading a module
//      the import rule cannot see.
// A table name built at run time is out of reach of any source check, this
// one included.
//
// The one exemption is the accept route. It may import exactly the names in
// `EXEMPTION.names` from `EXEMPTION.module`, must pass the literal `'rule'`
// as setUserCategory's source, may use it only by direct, unaliased call,
// and may name no table outside the inbox. It
// is asserted to be used, so it cannot outlive the route.

const REPO = new URL('../../../', import.meta.url)
const AGENTS = 'server/agents/'

const INBOX = ['category_proposals', 'insights', 'agent_runs']
const WRITES = new Set([
  'insert',
  'update',
  'upsert',
  'del',
  'delete',
  'truncate',
  'increment',
  'decrement',
  'merge',
])
const DB_HANDLES = new Set(['db', 'trx', 'knex', 'connection'])
const WRITER_DIRS = ['server/sync/', 'server/xero/', 'server/routes/']
const DRIVERS = new Set(['sqlite3', 'better-sqlite3'])
const NAMED = /\b(transactions|category_corrections|budgets|bills|goals|settings)\b/
const RAW = /\.raw\b|[a-z]Raw\b/
const ADMIN = new Set(['schema', 'migrate', 'seed'])

const EXEMPTION = {
  file: 'server/agents/routes/proposals.ts',
  module: 'server/db/transactions.ts',
  names: ['setUserCategory'],
} as const

interface Context {
  // Repo-relative paths of the server/db/*.ts modules that write.
  writers: Set<string>
  // Every table outside the inbox, from the migrated schema.
  others: string[]
}

interface SourceFile {
  path: string
  text: string
}

const read = (path: string) => readFileSync(new URL(path, REPO), 'utf8')

const parse = (path: string, text: string) =>
  ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)

const isCode = (f: string) =>
  /\.[cm]?[jt]sx?$/.test(f) &&
  !f.split('/').includes('__tests__') &&
  !/\.test\.[cm]?[jt]sx?$/.test(f)

// Every non-test module under `dir` (repo-relative, ending in `/`).
function modulesUnder(dir: string, recursive = true): string[] {
  return readdirSync(new URL(dir, REPO), { recursive, encoding: 'utf8' })
    .map((f) => f.split(sep).join('/'))
    .filter(isCode)
    .map((f) => dir + f)
    .sort()
}

function resolve(from: string, specifier: string): string {
  return specifier.startsWith('.')
    ? posix.normalize(posix.join(posix.dirname(from), specifier))
    : specifier
}

const literalText = (node: ts.Node | undefined): string | undefined =>
  node !== undefined && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    ? node.text
    : undefined

// Where a method chain starts: `trx('t').where({}).update()` starts at the
// call `trx('t')`; `trx.insert(x).into('t')` at the identifier `trx`.
function chainRoot(start: ts.Expression): ts.Expression {
  let node = start
  for (;;) {
    if (ts.isCallExpression(node)) {
      const callee = node.expression
      if (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) {
        node = callee.expression
        continue
      }
      return node
    }
    if (
      ts.isPropertyAccessExpression(node) ||
      ts.isElementAccessExpression(node) ||
      ts.isParenthesizedExpression(node) ||
      ts.isNonNullExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isSatisfiesExpression(node) ||
      ts.isAwaitExpression(node)
    ) {
      node = node.expression
      continue
    }
    return node
  }
}

// Names that hold a knex handle or builder without being called one: a
// parameter typed `Knex…` or of a `.transaction(...)` callback is a handle,
// and each variable is what it was initialised to, so `const q = db('t')`
// then `q.update()` is judged as `db('t').update()`.
interface Names {
  handles: Set<string>
  declared: Map<string, ts.Expression[]>
}

function namesIn(source: ts.SourceFile): Names {
  const handles = new Set(DB_HANDLES)
  const declared = new Map<string, ts.Expression[]>()
  const declare = (name: string, init: ts.Expression) =>
    declared.set(name, [...(declared.get(name) ?? []), init])
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      declare(node.name.text, node.initializer)
    }
    if (ts.isParameter(node) && ts.isIdentifier(node.name)) {
      const fn = node.parent
      const call = fn.parent
      const inTransaction =
        (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) &&
        ts.isCallExpression(call) &&
        ts.isPropertyAccessExpression(call.expression) &&
        call.expression.name.text === 'transaction'
      if (inTransaction || (node.type !== undefined && /\bKnex\b/.test(node.type.getText()))) {
        handles.add(node.name.text)
      }
      if (node.initializer) declare(node.name.text, node.initializer)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return { handles, declared }
}

// A write's chain root, judged. Through a declaration, a call counts only
// when a handle makes it, so `const m = index(rows); m.delete(k)` passes.
function judge(
  method: string,
  root: ts.Expression,
  names: Names,
  seen = new Set<string>(),
): string | undefined {
  if (ts.isCallExpression(root)) {
    if (seen.size > 0 && !(ts.isIdentifier(root.expression) && names.handles.has(root.expression.text))) {
      return undefined
    }
    const table = literalText(root.arguments[0])
    if (table === undefined) return `${method} on a table not named by a literal`
    return INBOX.includes(table) ? undefined : `${method} on ${table}`
  }
  if (!ts.isIdentifier(root)) return undefined
  if (names.handles.has(root.text)) return `${method} through ${root.text}`
  if (seen.has(root.text)) return undefined
  seen.add(root.text)
  for (const init of names.declared.get(root.text) ?? []) {
    const problem = judge(method, chainRoot(init), names, seen)
    if (problem !== undefined) return problem
  }
  return undefined
}

// Every knex write in the module that is not to an inbox table.
function writeProblems(source: ts.SourceFile): string[] {
  const found: string[] = []
  const names = namesIn(source)
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      WRITES.has(node.expression.name.text)
    ) {
      const method = node.expression.name.text
      const problem = judge(method, chainRoot(node.expression.expression), names)
      if (problem !== undefined) found.push(problem)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

// The module as code: comments gone, and import specifiers too, so a path
// like '../../db/transactions.ts' is not a table named in code.
function codeOf(source: ts.SourceFile): string {
  const body = ts.factory.updateSourceFile(
    source,
    source.statements.filter((s) => !ts.isImportDeclaration(s)),
  )
  return ts.createPrinter({ removeComments: true }).printFile(body)
}

// Whether a server/db module writes: rule 2 finds a write to any table, or
// it reaches raw SQL. Run over server/db/*.ts to build `Context.writers`.
function containsWrite(path: string, text: string): boolean {
  const source = parse(path, text)
  const anyTable = writeProblems(source).length > 0
  return anyTable || RAW.test(codeOf(source))
}

function isTypeOnly(clause: ts.ImportClause): boolean {
  if (clause.isTypeOnly) return true
  if (clause.name !== undefined) return false
  const bindings = clause.namedBindings
  return (
    bindings !== undefined &&
    ts.isNamedImports(bindings) &&
    bindings.elements.length > 0 &&
    bindings.elements.every((e) => e.isTypeOnly)
  )
}

// The names an import binds, if it is named bindings only (no default, no
// namespace); null otherwise.
function namedOnly(clause: ts.ImportClause): string[] | null {
  if (clause.name !== undefined) return null
  const bindings = clause.namedBindings
  if (bindings === undefined || !ts.isNamedImports(bindings)) return null
  return bindings.elements.map((e) => (e.propertyName ?? e.name).text)
}

// Repo-relative paths of the writer modules a module imports or re-exports.
function writerImports(path: string, text: string, ctx: Context): string[] {
  const found: string[] = []
  for (const statement of parse(path, text).statements) {
    if (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) {
      const specifier = literalText(statement.moduleSpecifier)
      if (specifier !== undefined && ctx.writers.has(resolve(path, specifier))) {
        found.push(resolve(path, specifier))
      }
    }
  }
  return found
}

function importProblems(path: string, source: ts.SourceFile, ctx: Context): string[] {
  const found: string[] = []
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue
    const specifier = literalText(statement.moduleSpecifier)
    if (specifier === undefined) continue
    const target = resolve(path, specifier)
    const clause = ts.isImportDeclaration(statement) ? statement.importClause : undefined
    if (ts.isImportDeclaration(statement) && clause === undefined) {
      found.push(`side-effect import of ${specifier}`)
      continue
    }
    if (WRITER_DIRS.some((dir) => target.startsWith(dir))) {
      found.push(`imports writer ${target}`)
    } else if (ctx.writers.has(target)) {
      const names = clause === undefined ? null : namedOnly(clause)
      const exempt =
        path === EXEMPTION.file &&
        target === EXEMPTION.module &&
        names !== null &&
        names.every((n) => (EXEMPTION.names as readonly string[]).includes(n))
      if (!exempt) found.push(`imports writer ${target}`)
    } else if (DRIVERS.has(specifier)) {
      found.push(`imports driver ${specifier}`)
    } else if (specifier === 'knex' && (clause === undefined || !isTypeOnly(clause))) {
      found.push('imports knex as a value')
    }
  }
  return found
}

// Every way of reaching a module or a query that the import rule cannot see.
function reachProblems(source: ts.SourceFile): string[] {
  const found: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isImportEqualsDeclaration(node)) {
      found.push('import = require')
    } else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) found.push('dynamic import(')
      if (ts.isIdentifier(node.expression) && node.expression.text === 'require') {
        found.push('require(')
      }
    } else if (ts.isElementAccessExpression(node)) {
      const key = node.argumentExpression
      const literal = literalText(key)
      // A literal key is a property read like any other unless it names a
      // write or raw SQL (`db['raw']`); any other computed key could.
      if (literal !== undefined) {
        if (WRITES.has(literal) || /^raw$|Raw$/.test(literal)) {
          found.push(`computed member access ['${literal}']`)
        }
      } else if (!ts.isNumericLiteral(key)) {
        found.push(`computed member access [${key.getText()}]`)
      }
    } else if (ts.isPropertyAccessExpression(node) && ADMIN.has(node.name.text)) {
      // `db.schema.dropTable(...)`, `db.migrate.rollback()`: DDL, not a query.
      found.push(`knex admin access .${node.name.text}`)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

// The accept route's extra rules: no table outside the inbox named in code,
// and every setUserCategory call passes the literal source 'rule'.
function exemptionProblems(source: ts.SourceFile, ctx: Context): string[] {
  const found: string[] = []
  const code = codeOf(source)
  const others = new RegExp(`\\b(${ctx.others.join('|')})\\b`)
  for (const pattern of [NAMED, others]) {
    const m = code.match(pattern)
    if (m) found.push(`names ${m[1]}`)
  }
  let calls = 0
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'setUserCategory'
    ) {
      calls += 1
      if (literalText(node.arguments[3]) !== 'rule') {
        found.push("setUserCategory without the literal source 'rule'")
      }
    } else if (ts.isIdentifier(node) && node.text === 'setUserCategory') {
      // Only a direct call is checked for 'rule', so an alias
      // (`import { setUserCategory as w }`, `const f = setUserCategory`)
      // would call it unchecked.
      const p = node.parent
      const callee = ts.isCallExpression(p) && p.expression === node
      const plainImport = ts.isImportSpecifier(p) && p.propertyName === undefined
      if (!callee && !plainImport) found.push('setUserCategory used other than by a direct call')
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  if (calls === 0) found.push('setUserCategory is never called')
  return found
}

/** Everything wrong with one module under server/agents/. */
function problemsFor(path: string, text: string, ctx: Context): string[] {
  const source = parse(path, text)
  const found = [
    ...importProblems(path, source, ctx),
    ...writeProblems(source),
    ...(RAW.test(codeOf(source)) ? ['raw SQL'] : []),
    ...reachProblems(source),
  ]
  if (path === EXEMPTION.file) found.push(...exemptionProblems(source, ctx))
  return found
}

/** The problems of every file, keyed by path; files with none are left out. */
function treeProblems(files: SourceFile[], ctx: Context): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const { path, text } of files) {
    const found = problemsFor(path, text, ctx)
    if (found.length > 0) out[path] = found
  }
  return out
}

const agentModules = (): SourceFile[] =>
  modulesUnder(AGENTS).map((path) => ({ path, text: read(path) }))

let ctx: Context

beforeAll(async () => {
  assertInMemory(connection)
  await connection.migrate.latest()
  const tables: string[] = await connection('sqlite_master')
    .where({ type: 'table' })
    .pluck('name')
  const writers = modulesUnder('server/db/', false).filter((path) =>
    containsWrite(path, read(path)),
  )
  ctx = {
    writers: new Set(writers),
    others: tables.filter((t) => !INBOX.includes(t) && !/^(knex_|sqlite_)/.test(t)),
  }
})

afterAll(closeDb)

describe('the guard’s inputs', () => {
  it('the inbox tables exist, and the other tables include the money state', async () => {
    const tables: string[] = await connection('sqlite_master')
      .where({ type: 'table' })
      .pluck('name')
    expect(tables).toEqual(expect.arrayContaining(INBOX))
    expect(ctx.others).toEqual(
      expect.arrayContaining(['transactions', 'category_corrections', 'settings', 'accounts']),
    )
    for (const inbox of INBOX) expect(ctx.others).not.toContain(inbox)
  })

  it('the writer modules found in server/db/ include the known writers and not the readers', () => {
    expect([...ctx.writers]).toEqual(
      expect.arrayContaining([
        'server/db/transactions.ts',
        'server/db/settings.ts',
        'server/db/overview.ts',
      ]),
    )
    expect(ctx.writers.has('server/db/connection.ts')).toBe(false)
    expect(ctx.writers.has('server/db/categories.ts')).toBe(false)
  })

  it('the exemption names a writer module', () => {
    expect(ctx.writers.has(EXEMPTION.module)).toBe(true)
  })

  it('finds the modules under server/agents/, the routes and the accessors among them', () => {
    expect(agentModules().map((f) => f.path)).toEqual(
      expect.arrayContaining([
        'server/agents/routes/index.ts',
        'server/agents/routes/proposals.ts',
        'server/agents/routes/insights.ts',
        'server/agents/db/proposals.ts',
      ]),
    )
  })
})

describe('the real tree', () => {
  it('no module under server/agents/ writes outside the inbox', () => {
    expect(treeProblems(agentModules(), ctx)).toEqual({})
  })

  it('the exemption is used, by the accept route alone', () => {
    const importers = agentModules()
      .filter(({ path, text }) => writerImports(path, text, ctx).length > 0)
      .map((f) => f.path)
    expect(importers).toEqual([EXEMPTION.file])
  })

  it('goes red when a module in the list writes money state', () => {
    const planted: SourceFile = {
      path: 'server/agents/category/rules.ts',
      text: "import connection from '../../db/connection.ts'\nawait connection('transactions').where({ id: 1 }).update({ category: 'Bakeries' })",
    }
    expect(treeProblems([...agentModules(), planted], ctx)).toEqual({
      [planted.path]: ['update on transactions'],
    })
  })
})

describe('planted violations', () => {
  const RULES = 'server/agents/category/rules.ts'
  const INSIGHTS = 'server/agents/routes/insights.ts'

  it.each([
    ['../../db/transactions.ts', 'server/db/transactions.ts'],
    ['../../db/settings.ts', 'server/db/settings.ts'],
    ['../../db/overview.ts', 'server/db/overview.ts'],
    ['../../sync/upsert.ts', 'server/sync/upsert.ts'],
    ['../../xero/client/index.ts', 'server/xero/client/index.ts'],
    ['../../routes/transactions.ts', 'server/routes/transactions.ts'],
  ])('importing %s from category/ is flagged', (specifier, target) => {
    expect(problemsFor(RULES, `import { x } from '${specifier}'`, ctx)).toContain(
      `imports writer ${target}`,
    )
  })

  it('re-exporting a writer is flagged', () => {
    expect(problemsFor(RULES, "export { setUserCategory } from '../../db/transactions.ts'", ctx)).toContain(
      'imports writer server/db/transactions.ts',
    )
  })

  it('the exempt import, made from any other route, is flagged', () => {
    expect(
      problemsFor(INSIGHTS, "import { setUserCategory } from '../../db/transactions.ts'", ctx),
    ).toContain('imports writer server/db/transactions.ts')
  })

  describe('in the accept route', () => {
    const accept = (lines: string[]) =>
      problemsFor(
        EXEMPTION.file,
        [...lines, "await setUserCategory(1, 'Bakeries', trx, 'rule')"].join('\n'),
        ctx,
      )
    const allowed = "import { setUserCategory } from '../../db/transactions.ts'"

    it('the allowed import and call pass', () => {
      expect(accept([allowed])).toEqual([])
    })

    it.each([
      ['a second binding', "import { setUserCategory, getTxns } from '../../db/transactions.ts'"],
      ['a namespace import', "import * as t from '../../db/transactions.ts'"],
      ['a default import', "import t from '../../db/transactions.ts'"],
      ['an aliased other binding', "import { getTxns as setUserCategory } from '../../db/transactions.ts'"],
    ])('%s is flagged', (_why, line) => {
      expect(accept([line])).toContain('imports writer server/db/transactions.ts')
    })

    it('naming a table in code is flagged, in a comment is not', () => {
      expect(accept([allowed, "await db('transactions').where({ id: 1 }).first()"])).toContain(
        'names transactions',
      )
      expect(accept([allowed, "// db('transactions')"])).toEqual([])
    })

    it.each([
      ['no source', "await setUserCategory(1, 'Bakeries', trx)"],
      ['source user', "await setUserCategory(1, 'Bakeries', trx, 'user')"],
      ['a source in a variable', "await setUserCategory(1, 'Bakeries', trx, source)"],
    ])("a call with %s is flagged", (_why, call) => {
      expect(problemsFor(EXEMPTION.file, [allowed, call].join('\n'), ctx)).toContain(
        "setUserCategory without the literal source 'rule'",
      )
    })

    it.each([
      ['an aliased import', "import { setUserCategory as write } from '../../db/transactions.ts'"],
      [
        'a second, aliased binding',
        "import { setUserCategory, setUserCategory as write } from '../../db/transactions.ts'",
      ],
      ['a reference held in a const', allowed + '\nconst f = setUserCategory'],
    ])('%s is flagged', (_why, lines) => {
      expect(accept([lines])).toContain('setUserCategory used other than by a direct call')
    })

    it('a route that never calls setUserCategory is flagged', () => {
      expect(problemsFor(EXEMPTION.file, allowed, ctx)).toContain('setUserCategory is never called')
    })
  })

  it('every table outside the inbox is flagged as a write target', () => {
    for (const table of ctx.others) {
      expect(problemsFor(RULES, `await db('${table}').insert({})`, ctx), table).toContain(
        `insert on ${table}`,
      )
      expect(
        problemsFor(RULES, `await trx('${table}').where({}).update({})`, ctx),
        table,
      ).toContain(`update on ${table}`)
    }
  })

  it.each([
    ['a table in a variable', 'await db(name).insert({})', 'insert on a table not named by a literal'],
    [
      'a template with a substitution',
      'await db(`trans${x}`).insert({})',
      'insert on a table not named by a literal',
    ],
    ['a write through the handle', "await trx.insert(row).into('transactions')", 'insert through trx'],
    ['a delete', "await db('transactions').where({ id: 1 }).del()", 'del on transactions'],
    ['an upsert via merge', "await db('accounts').insert(row).onConflict('id').merge()", 'insert on accounts'],
    ['db.raw', "await db.raw('delete from transactions')", 'raw SQL'],
    ['whereRaw', "await db('insights').whereRaw('1 = 1')", 'raw SQL'],
    ["db['raw']", "db['raw']('select 1')", "computed member access ['raw']"],
    ["db['insert']", "db('transactions')['insert']({})", "computed member access ['insert']"],
    ['a computed key', 'db[method]()', 'computed member access [method]'],
    [
      'a builder held in a const',
      "const q = connection('transactions').where({ id: 1 })\nawait q.update({})",
      'update on transactions',
    ],
    ['an aliased handle', "const q = connection\nawait q.insert(row).into('transactions')", 'insert through connection'],
    [
      'a transaction callback’s handle',
      "await connection.transaction(async (tx) => { await tx.insert(row).into('transactions') })",
      'insert through tx',
    ],
    [
      'a parameter typed Knex',
      "async function f(t: Knex.Transaction) { await t.table('transactions').del() }",
      'del through t',
    ],
    ['knex.schema', "await connection.schema.dropTable('budgets')", 'knex admin access .schema'],
    ['knex.migrate', 'await connection.migrate.rollback()', 'knex admin access .migrate'],
    ['a value import of knex', "import knex from 'knex'", 'imports knex as a value'],
    ['a named value import of knex', "import { knex } from 'knex'", 'imports knex as a value'],
    ['sqlite3', "import sqlite3 from 'sqlite3'", 'imports driver sqlite3'],
    ['better-sqlite3', "import Database from 'better-sqlite3'", 'imports driver better-sqlite3'],
    ['a side-effect import', "import '../../db/connection.ts'", 'side-effect import of ../../db/connection.ts'],
    ['a dynamic import', "await import('../../db/transactions.ts')", 'dynamic import('],
    ['a require', "const m = require('../../db/transactions.ts')", 'require('],
    ['import = require', "import m = require('../../db/transactions.ts')", 'import = require'],
  ])('%s is flagged', (_why, text, problem) => {
    expect(problemsFor(RULES, text, ctx)).toContain(problem)
  })

  it.each([
    ['a read of a money table', "await db('transactions').where({ id: 1 }).first()"],
    ['a write to the inbox', "await db('category_proposals').insert(row)"],
    ['a write to the inbox in a template', 'await trx(`agent_runs`).where({ id: 1 }).update({})'],
    ['a builder for the inbox held in a const', "const q = db('insights').where({ id: 1 })\nawait q.update({})"],
    ['a Map held in a const', 'const seen = new Map()\nseen.delete(k)'],
    ['a Map from a helper', 'const index = buildIndex(rows)\nindex.delete(k)'],
    ['a Map delete', 'cache.delete(k)'],
    ['a Set delete on a member', 'this.seen.delete(k)'],
    ['a header read', "const site = req.headers['sec-fetch-site']"],
    ['an array index', 'const first = ids[0]'],
    ['a type import of knex', "import type { Knex } from 'knex'"],
    ['an inline type import of knex', "import { type Knex } from 'knex'"],
    ['a comment about writes', "// db('transactions').update({}) and db.raw()"],
  ])('%s passes', (_why, text) => {
    expect(problemsFor(RULES, text, ctx)).toEqual([])
  })
})
