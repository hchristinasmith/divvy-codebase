import { readFileSync, readdirSync } from 'node:fs'
import { sep } from 'node:path'
import ts from 'typescript'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import connection from '../../../db/connection.ts'
import { assertInMemory } from '../../../test-utils/app.ts'
import type { CategoryProposal, ProposalStatus } from '../../contracts.ts'
import {
  getProposal,
  insertProposal,
  listProposals,
  setStatus,
  type NewProposal,
} from '../proposals.ts'

// The category agent's inbox accessors (#31; prd-04 Rulings 2, 6, 7,
// Done-when 2 and 3). Each test starts from an empty, freshly migrated
// in-memory database and inserts the rows it needs; every value is invented.

beforeEach(async () => {
  assertInMemory(connection)
  await connection.migrate.rollback(undefined, true)
  await connection.migrate.latest()
})

afterAll(async () => {
  await connection.destroy()
})

const AT = '2026-10-25T03:00:00.000Z'
const NOW = new Date(AT)
const LATER = new Date('2026-10-25T04:30:00.000Z')

const PROPOSAL_COLUMNS = [
  'id',
  'transaction_id',
  'current_category',
  'proposed_category',
  'confidence',
  'reason',
  'origin',
  'status',
  'created_at',
]

async function transaction(name: string): Promise<number> {
  const [id] = await connection('transactions').insert({
    akahu_id: `trans_fixture_${name}`,
    account_id: 'acc_fixture_everyday',
    amount_cents: -450,
  })
  return id
}

const proposal = (transactionId: number, fields: Partial<NewProposal> = {}): NewProposal => ({
  transaction_id: transactionId,
  current_category: null,
  proposed_category: 'Bakeries',
  confidence: 0.9,
  reason: 'Moved to Bakeries twice',
  origin: 'rule',
  ...fields,
})

async function inserted(p: NewProposal, now: Date = NOW): Promise<number> {
  const result = await insertProposal(p, now)
  if (!result.inserted) throw new Error(`expected an insert, got ${result.reason}`)
  return result.id
}

async function rows(): Promise<CategoryProposal[]> {
  return connection('category_proposals').orderBy('id')
}

describe('insertProposal', () => {
  it('stores a pending rule proposal stamped with now, and round-trips current_category', async () => {
    const txId = await transaction('a')
    const first = await inserted(proposal(txId))
    const second = await inserted(
      proposal(txId, {
        current_category: 'Supermarkets and grocery stores',
        proposed_category: 'Cafes and restaurants',
        confidence: 0.5,
      }),
    )

    const stored = await rows()
    expect(Object.keys(stored[0]).sort()).toEqual([...PROPOSAL_COLUMNS].sort())
    expect(stored).toStrictEqual([
      {
        id: first,
        transaction_id: txId,
        current_category: null,
        proposed_category: 'Bakeries',
        confidence: 0.9,
        reason: 'Moved to Bakeries twice',
        origin: 'rule',
        status: 'pending',
        created_at: AT,
      },
      {
        id: second,
        transaction_id: txId,
        current_category: 'Supermarkets and grocery stores',
        proposed_category: 'Cafes and restaurants',
        confidence: 0.5,
        reason: 'Moved to Bakeries twice',
        origin: 'rule',
        status: 'pending',
        created_at: AT,
      },
    ])
    expect(typeof stored[0].confidence).toBe('number')
  })

  it.each([['Bakery'], [' Bakeries'], ['bakeries'], ['Bakeries '], [''], [42]])(
    'discards %j, which is not exactly a data/cats.js category (Ruling 6)',
    async (category) => {
      const txId = await transaction('a')
      const result = await insertProposal(
        proposal(txId, { proposed_category: category as unknown as string }),
        NOW,
      )
      expect(result).toStrictEqual({ inserted: false, reason: 'unknown_category' })
      expect(await rows()).toEqual([])
    },
  )

  it.each(['pending', 'accepted', 'rejected'] as const)(
    'is a no-op for a pair already stored as %s',
    async (status) => {
      const txId = await transaction('a')
      const id = await inserted(proposal(txId))
      if (status !== 'pending') expect(await setStatus(id, status)).toBe(true)
      const before = await rows()

      const again = await insertProposal(
        proposal(txId, { confidence: 0.2, reason: 'A later rule', current_category: 'Bakeries' }),
        LATER,
      )

      expect(again).toStrictEqual({ inserted: false, reason: 'duplicate' })
      expect(await rows()).toStrictEqual(before)
    },
  )

  it('never brings a rejected pair back as pending (Done-when 3)', async () => {
    const txId = await transaction('a')
    const id = await inserted(proposal(txId))
    expect(await setStatus(id, 'rejected')).toBe(true)

    for (let i = 0; i < 3; i++) {
      expect(await insertProposal(proposal(txId), LATER)).toStrictEqual({
        inserted: false,
        reason: 'duplicate',
      })
    }
    expect(await listProposals({ status: 'pending' })).toEqual([])
    const stored = await rows()
    expect(stored.map((r) => [r.id, r.status, r.created_at])).toEqual([[id, 'rejected', AT]])
  })

  it('stores another category for the same transaction, and the same category for another', async () => {
    const a = await transaction('a')
    const b = await transaction('b')
    await inserted(proposal(a))
    await inserted(proposal(a, { proposed_category: 'Cafes and restaurants' }))
    await inserted(proposal(b))
    expect((await rows()).map((r) => [r.transaction_id, r.proposed_category])).toEqual([
      [a, 'Bakeries'],
      [a, 'Cafes and restaurants'],
      [b, 'Bakeries'],
    ])
  })

  // A reason is merchant text; the message names the field and never echoes it.
  const SENTINEL = 'Fixture Merchant 7731'
  const BAD: [field: string, fields: Partial<NewProposal>, message: RegExp][] = [
    ['transaction_id 0', { transaction_id: 0 }, /^transaction_id must be a positive integer$/],
    ['transaction_id -1', { transaction_id: -1 }, /^transaction_id must be a positive integer$/],
    ['transaction_id 1.5', { transaction_id: 1.5 }, /^transaction_id must be a positive integer$/],
    ['transaction_id NaN', { transaction_id: NaN }, /^transaction_id must be a positive integer$/],
    ['confidence -0.1', { confidence: -0.1 }, /^confidence must be a number from 0 to 1$/],
    ['confidence 1.1', { confidence: 1.1 }, /^confidence must be a number from 0 to 1$/],
    ['confidence NaN', { confidence: NaN }, /^confidence must be a number from 0 to 1$/],
    ['confidence Infinity', { confidence: Infinity }, /^confidence must be a number from 0 to 1$/],
    [
      'confidence "0.5"',
      { confidence: '0.5' as unknown as number },
      /^confidence must be a number from 0 to 1$/,
    ],
    ['reason empty', { reason: '' }, /^reason must not be blank$/],
    ['reason spaces', { reason: '   ' }, /^reason must not be blank$/],
    [
      'origin claude',
      { origin: 'claude' as unknown as NewProposal['origin'] },
      /^origin is not a known proposal origin$/,
    ],
  ]

  it.each(BAD)('throws on %s, naming only the field, and writes nothing', async (_, fields, message) => {
    const txId = await transaction('a')
    const attempt = insertProposal(proposal(txId, { reason: SENTINEL, ...fields }), NOW)
    await expect(attempt).rejects.toThrow(message)
    await expect(attempt).rejects.not.toThrow(SENTINEL)
    expect(await rows()).toEqual([])
  })

  it('lets the foreign key refuse a transaction that does not exist', async () => {
    const txId = await transaction('a')
    await expect(insertProposal(proposal(txId + 1000), NOW)).rejects.toThrow(
      /FOREIGN KEY constraint failed$/,
    )
    expect(await rows()).toEqual([])
  })

  // knex's error message holds the SQL with its bound values, reason and all.
  it('lets the foreign key refuse it without echoing the reason', async () => {
    const txId = await transaction('a')
    const attempt = insertProposal(proposal(txId + 1000, { reason: SENTINEL }), NOW)
    await expect(attempt).rejects.toThrow(
      /^insertProposal failed: SQLITE_CONSTRAINT: FOREIGN KEY constraint failed$/,
    )
    await expect(attempt).rejects.not.toThrow(SENTINEL)
  })

  // The reason cap (#313) is counted in code points. The constant is not
  // exported, so the cap is pinned here as a literal. Non-BMP characters are
  // two UTF-16 units each, so these strings are over the cap by `.length`.
  it('accepts a reason of exactly 2000 code points, and stores it whole', async () => {
    const txId = await transaction('a')
    const reason = '\u{20000}'.repeat(2_000)
    expect(Array.from(reason)).toHaveLength(2_000)
    expect(reason.length).toBeGreaterThan(2_000)

    const result = await insertProposal(proposal(txId, { reason }), NOW)
    expect(result).toStrictEqual({ inserted: true, id: expect.any(Number) })

    const stored = await rows()
    expect(stored).toHaveLength(1)
    expect(Object.keys(stored[0]).sort()).toEqual([...PROPOSAL_COLUMNS].sort())
    expect(stored[0].reason).toBe(reason)
  })

  it('counts a reason in code points, not UTF-16 units: 1,001 non-BMP code points (2,002 units) is accepted', async () => {
    const txId = await transaction('a')
    const reason = '\u{20000}'.repeat(1_001)
    expect(Array.from(reason)).toHaveLength(1_001)
    expect(reason.length).toBe(2_002)

    const result = await insertProposal(proposal(txId, { reason }), NOW)
    expect(result).toStrictEqual({ inserted: true, id: expect.any(Number) })
    expect((await rows())[0].reason).toBe(reason)
  })

  // The refusal names the field and the cap, never the value. The value here
  // holds a sentinel, so the not.toContain assertion has something to find.
  it('refuses a reason one code point over the cap, naming the field and the cap but not the value, and writes nothing', async () => {
    const txId = await transaction('a')
    const reason = SENTINEL + '\u{20000}'.repeat(2_001 - Array.from(SENTINEL).length)
    expect(Array.from(reason)).toHaveLength(2_001)

    const error = await insertProposal(proposal(txId, { reason }), NOW).then(
      () => new Error('expected a refusal'),
      (e: unknown) => e,
    )
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('reason must be at most 2000 characters')
    expect((error as Error).message).not.toContain(SENTINEL)
    expect(await rows()).toEqual([])
  })
})

describe('setStatus', () => {
  it('decides a pending proposal once, and never overwrites a decision', async () => {
    const txId = await transaction('a')
    const accepted = await inserted(proposal(txId))
    const rejected = await inserted(proposal(txId, { proposed_category: 'Cafes and restaurants' }))

    expect(await setStatus(accepted, 'accepted')).toBe(true)
    expect(await setStatus(accepted, 'rejected')).toBe(false)
    expect(await setStatus(accepted, 'accepted')).toBe(false)
    expect(await setStatus(rejected, 'rejected')).toBe(true)
    expect(await setStatus(rejected, 'accepted')).toBe(false)
    expect(await setStatus(rejected + 1000, 'accepted')).toBe(false)

    expect((await rows()).map((r) => [r.id, r.status])).toEqual([
      [accepted, 'accepted'],
      [rejected, 'rejected'],
    ])
  })

  it('refuses to set a proposal back to pending', async () => {
    const txId = await transaction('a')
    const id = await inserted(proposal(txId))
    await setStatus(id, 'rejected')

    await expect(
      setStatus(id, 'pending' as unknown as Exclude<ProposalStatus, 'pending'>),
    ).rejects.toThrow(/^status must be accepted or rejected$/)
    expect((await getProposal(id))?.status).toBe('rejected')
  })

  // A test-only trigger refuses the update, the way a constraint would.
  it('throws without the SQL when the database refuses the update', async () => {
    const txId = await transaction('a')
    const id = await inserted(proposal(txId))
    await connection.raw(
      "create trigger fixture_refusal before update on category_proposals begin select raise(abort, 'fixture refusal'); end",
    )
    await expect(setStatus(id, 'rejected')).rejects.toThrow(
      /^setStatus failed: SQLITE_CONSTRAINT: fixture refusal$/,
    )
    expect((await getProposal(id))?.status).toBe('pending')
  })

  it("runs inside the caller's transaction: rolled back it leaves the proposal pending", async () => {
    const txId = await transaction('a')
    const id = await inserted(proposal(txId))

    await expect(
      connection.transaction(async (trx) => {
        expect(await setStatus(id, 'accepted', trx)).toBe(true)
        expect((await getProposal(id, trx))?.status).toBe('accepted')
        throw new Error('the category write failed')
      }),
    ).rejects.toThrow('the category write failed')
    expect((await getProposal(id))?.status).toBe('pending')

    await connection.transaction(async (trx) => {
      expect(await setStatus(id, 'accepted', trx)).toBe(true)
    })
    expect((await getProposal(id))?.status).toBe('accepted')
  })
})

describe('getProposal and listProposals', () => {
  it('reads a proposal by id, or undefined', async () => {
    const txId = await transaction('a')
    const id = await inserted(proposal(txId))
    const stored = await getProposal(id)
    expect(Object.keys(stored ?? {}).sort()).toEqual([...PROPOSAL_COLUMNS].sort())
    expect(stored).toStrictEqual((await rows())[0])
    expect(await getProposal(id + 1000)).toBeUndefined()
  })

  it('lists newest first (ties by id), filtered by status and transaction', async () => {
    const a = await transaction('a')
    const b = await transaction('b')
    const older = await inserted(proposal(a), NOW)
    const tieLow = await inserted(proposal(a, { proposed_category: 'Cafes and restaurants' }), LATER)
    const tieHigh = await inserted(proposal(b), LATER)
    await setStatus(tieLow, 'rejected')

    const all = await listProposals()
    expect(all.map((p) => p.id)).toEqual([tieHigh, tieLow, older])
    for (const p of all) expect(Object.keys(p).sort()).toEqual([...PROPOSAL_COLUMNS].sort())

    expect((await listProposals({ status: 'pending' })).map((p) => p.id)).toEqual([tieHigh, older])
    expect((await listProposals({ status: 'rejected' })).map((p) => p.id)).toEqual([tieLow])
    expect((await listProposals({ transactionId: a })).map((p) => p.id)).toEqual([tieLow, older])
    expect(
      (await listProposals({ status: 'pending', transactionId: a })).map((p) => p.id),
    ).toEqual([older])
    expect(await listProposals({ status: 'accepted' })).toEqual([])
  })
})

// #31: no module under server/agents/db/ names a table outside the inbox,
// writes raw SQL, or imports past its directory's allow-list. The modules are
// parsed with the TypeScript compiler rather than grepped, so a comment is
// never code and a string is never a comment.
//
// The scope is db/ because the accessors there are the agents' only writers.
// Agents elsewhere under server/agents/ may read `transactions` and
// `category_corrections` (Done-when 2 forbids writing money state, not
// reading it), so naming those tables is not wrong there; that they never
// write them is for an eslint rule and review.
//
// A table name built at run time (`'trans' + 'actions'`, or one read from a
// variable) is out of reach of any source check, this one included. The sound
// guard is an eslint rule on server/agents/**, which lives in package.json,
// outside #31's fence, and is a follow-up.
describe('every module under server/agents/db/ touches only the inbox tables', () => {
  const ROOT = new URL('../', import.meta.url)
  const OWN_TABLE: Record<string, string> = {
    'proposals.ts': 'category_proposals',
    'insights.ts': 'insights',
    'agent-runs.ts': 'agent_runs',
  }
  const INBOX = Object.values(OWN_TABLE)
  // Per directory under server/agents/db/, exactly what its modules import.
  // A module in a directory with no entry fails, and so does an entry nothing
  // imports, so the list cannot drift wider than the code.
  const IMPORTS: Record<string, string[]> = {
    '.': [
      '../../../models/insights.ts',
      '../../db/connection.ts',
      '../contracts.ts',
      './scrubbed.ts',
    ],
  }
  const NAMED = /\b(transactions|category_corrections|budgets|bills|goals|settings)\b/
  const RAW = /\.raw\b|[a-z]Raw\b/

  // Every non-test module under server/agents/db/, relative to it.
  const modules = (): string[] =>
    readdirSync(ROOT, { recursive: true, encoding: 'utf8' })
      .filter((f) => /\.[cm]?[jt]sx?$/.test(f))
      .filter((f) => !f.split(sep).includes('__tests__') && !/\.test\.[cm]?[jt]sx?$/.test(f))
      .map((f) => f.split(sep).join('/'))
      .sort()
  const source = (file: string) => readFileSync(new URL(file, ROOT), 'utf8')

  const parse = (text: string, name = 'fixture.ts') =>
    ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true)
  // The module as code, with every comment gone and every string kept.
  const stripComments = (text: string) =>
    ts.createPrinter({ removeComments: true }).printFile(parse(text))

  // Every string the module holds, template text included.
  function strings(text: string): string[] {
    const found: string[] = []
    const visit = (node: ts.Node): void => {
      if (ts.isStringLiteralLike(node) || ts.isTemplateLiteralToken(node)) found.push(node.text)
      ts.forEachChild(node, visit)
    }
    visit(parse(text))
    return found
  }

  // What a module imports, and every way of reaching a module or a query that
  // the allow-list cannot see.
  function imports(text: string): { specifiers: string[]; problems: string[] } {
    const specifiers: string[] = []
    const problems: string[] = []
    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
        const spec = node.moduleSpecifier
        if (spec !== undefined && ts.isStringLiteral(spec)) {
          specifiers.push(spec.text)
          if (ts.isImportDeclaration(node) && node.importClause === undefined) {
            problems.push(`side-effect import of ${spec.text}`)
          }
        }
      } else if (ts.isImportEqualsDeclaration(node)) {
        problems.push('import = require')
      } else if (ts.isCallExpression(node)) {
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword) problems.push('dynamic import(')
        if (ts.isIdentifier(node.expression) && node.expression.text === 'require') {
          problems.push('require(')
        }
      } else if (ts.isElementAccessExpression(node) && !ts.isNumericLiteral(node.argumentExpression)) {
        problems.push(`computed member access [${node.argumentExpression.getText()}]`)
      }
      ts.forEachChild(node, visit)
    }
    visit(parse(text))
    return { specifiers, problems }
  }

  // Every table but ours, from the migrated schema.
  async function otherTables(): Promise<string[]> {
    const names: string[] = await connection('sqlite_master').where({ type: 'table' }).pluck('name')
    return names.filter((n) => !INBOX.includes(n) && !/^(knex_|sqlite_)/.test(n))
  }
  const anyOf = (names: string[]) => new RegExp(`\\b(${names.join('|')})\\b`)

  // Everything wrong with one module's text.
  function problems(text: string, allowed: string[], others: string[]): string[] {
    const code = stripComments(text)
    const found: string[] = []
    for (const pattern of [NAMED, anyOf(others)]) {
      const m = code.match(pattern)
      if (m) found.push(`names ${m[1]}`)
    }
    if (RAW.test(code)) found.push('raw SQL')
    const { specifiers, problems: reached } = imports(text)
    for (const s of specifiers) if (!allowed.includes(s)) found.push(`imports ${s}`)
    return [...found, ...reached]
  }

  it('finds the modules, the accessors among them', () => {
    expect(modules()).toEqual(expect.arrayContaining([...Object.keys(OWN_TABLE), 'scrubbed.ts']))
  })

  it('the table patterns catch a table named in code, and not its look-alikes', async () => {
    const others = await otherTables()
    expect(others).toEqual(expect.arrayContaining(['transactions', 'category_corrections', 'sync_runs']))
    for (const pattern of [NAMED, anyOf(others)]) {
      expect("db('transactions')").toMatch(pattern)
      for (const benign of ['transaction_id', 'Knex.Transaction', 'trx', 'transactionId', "'insights'"]) {
        expect(benign).not.toMatch(pattern)
      }
    }
    expect('sync_run_id').not.toMatch(anyOf(others))
    expect("db('sync_runs')").toMatch(anyOf(others))
  })

  // Each bypass found against the earlier regex guard, and its neighbours.
  const BYPASSES: [name: string, text: string, problem: string][] = [
    ['a URL before a table on one line', "const u = 'http://x'; db('transactions')", 'names transactions'],
    ['a table in a template', 'db(`category_corrections`).insert(row)', 'names category_corrections'],
    ['a double-quoted import', 'import { upsert } from "../../sync/upsert.ts"', 'imports ../../sync/upsert.ts'],
    ['a type-only import outside the list', "import type { Knex } from 'knex'", 'imports knex'],
    ['a re-export', "export * from '../../sync/upsert.ts'", 'imports ../../sync/upsert.ts'],
    ['a side-effect import', "import '../../db/connection.ts'", 'side-effect import of ../../db/connection.ts'],
    ['a dynamic import', "await import('../../sync/upsert.ts')", 'dynamic import('],
    ['a require', "const m = require('../../sync/upsert.ts')", 'require('],
    ['import = require', "import m = require('../../sync/upsert.ts')", 'import = require'],
    ["db['raw']", "db['raw']('select 1')", "computed member access ['raw']"],
    ['db["raw"]', 'db["raw"]("select 1")', 'computed member access ["raw"]'],
    ['a computed key in a variable', 'db[method]()', 'computed member access [method]'],
    ['db.raw', "db.raw('select 1')", 'raw SQL'],
    ['whereRaw', "db('insights').whereRaw('1 = 1')", 'raw SQL'],
  ]

  it.each(BYPASSES)('catches %s', async (_, text, problem) => {
    expect(problems(text, IMPORTS['.'], await otherTables())).toContain(problem)
  })

  it('passes code that names only the inbox, and ignores comments', async () => {
    const text = [
      "import connection from '../../db/connection.ts'",
      "// db('transactions'), the 'http://x' kind",
      "/* bills */ const url = 'http://x' // goals",
      "await connection('category_proposals').where({ transaction_id: 1 }).first()",
      'const first = ids[0]',
    ].join('\n')
    expect(problems(text, IMPORTS['.'], await otherTables())).toEqual([])
    expect(stripComments("a // db('transactions')\nb /* bills */")).not.toMatch(NAMED)
  })

  it('each module names no table outside the inbox, writes no raw SQL, and imports within its list', async () => {
    const others = await otherTables()
    for (const file of modules()) {
      const dir = file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '.'
      const allowed = IMPORTS[dir]
      expect(allowed, `server/agents/db/${dir} has no import allow-list`).toBeDefined()
      expect(problems(source(file), allowed, others), file).toEqual([])
    }
  })

  it('each allow-list is exactly what its directory imports', () => {
    const used: Record<string, Set<string>> = {}
    for (const file of modules()) {
      const dir = file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '.'
      used[dir] ??= new Set()
      for (const s of imports(source(file)).specifiers) used[dir].add(s)
    }
    for (const [dir, allowed] of Object.entries(IMPORTS)) {
      expect([...(used[dir] ?? [])].sort(), dir).toEqual([...allowed].sort())
    }
  })

  it.each(Object.entries(OWN_TABLE))('%s names its own table, %s', (file, table) => {
    expect(strings(source(file))).toContain(table)
  })
})
