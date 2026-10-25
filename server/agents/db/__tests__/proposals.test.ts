import { readFileSync } from 'node:fs'
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

// Done-when 2 and #31: the accessor modules name only the inbox tables.
describe('the accessor modules touch only the three inbox tables', () => {
  const FILES = ['proposals.ts', 'insights.ts', 'agent-runs.ts'] as const
  const OWN_TABLE: Record<(typeof FILES)[number], string> = {
    'proposals.ts': 'category_proposals',
    'insights.ts': 'insights',
    'agent-runs.ts': 'agent_runs',
  }
  const INBOX = Object.values(OWN_TABLE)
  const IMPORTS = [
    'knex',
    '../../db/connection.ts',
    '../contracts.ts',
    '../../../models/insights.ts',
    '../../../models/sync.ts',
    './proposals.ts',
    './insights.ts',
    './agent-runs.ts',
  ]
  const NAMED = /\b(transactions|category_corrections|budgets|bills|goals|settings)\b/

  const source = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
  const stripComments = (text: string) =>
    text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  const code = (file: string) => stripComments(source(file))

  // Every table but ours, from the migrated schema.
  async function otherTables(): Promise<string[]> {
    const names: string[] = await connection('sqlite_master').where({ type: 'table' }).pluck('name')
    return names.filter((n) => !INBOX.includes(n) && !/^(knex_|sqlite_)/.test(n))
  }
  const anyOf = (names: string[]) => new RegExp(`\\b(${names.join('|')})\\b`)

  it('the patterns catch a table named in code, and not its look-alikes', async () => {
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
    expect(stripComments("a // db('transactions')\nb /* bills */")).toBe('a \nb ')
  })

  it.each(FILES)('%s names no money table and no table outside the inbox', async (file) => {
    const text = code(file)
    expect(text).not.toMatch(NAMED)
    expect(text).not.toMatch(anyOf(await otherTables()))
    expect(text).toContain(`'${OWN_TABLE[file]}'`)
  })

  it.each(FILES)('%s writes no raw SQL', (file) => {
    expect(code(file)).not.toMatch(/\.raw\(|Raw\(/)
  })

  it.each(FILES)('%s imports only the contracts, the connection and its siblings', (file) => {
    const text = source(file)
    const specifiers = [...text.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1])
    expect(specifiers.length).toBeGreaterThan(0)
    for (const s of specifiers) expect(IMPORTS, `${file} imports ${s}`).toContain(s)
    expect(text).not.toMatch(/\bimport\s*\(|\brequire\s*\(/)
    // knex is a type only: the module's queries all go through the connection.
    expect(text).not.toMatch(/import\s+(?!type\b)[^'\n]*from\s+'knex'/)
  })
})
