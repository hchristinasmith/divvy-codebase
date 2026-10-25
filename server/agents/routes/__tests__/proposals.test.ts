import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import connection from '../../../db/connection.ts'
import {
  closeDb,
  freshApp,
  serveOnLoopback,
  type LoopbackApi,
} from '../../../test-utils/app.ts'
import { TRANSACTION_COLUMNS } from '../../../db/__tests__/transactionColumns.ts'
import { insertProposal, type NewProposal } from '../../db/proposals.ts'
import { runSync } from '../../../sync/run.ts'
import { at, db, fakeAkahu, MINUTE_MS, page } from '../../../sync/__tests__/harness.ts'

// /api/v1/agents/proposals (prd-04 Rulings 2 and 7, #51), over HTTP against
// the real app and a fresh in-memory database. Accept writes the category
// through setUserCategory with source `rule`, inside one transaction with
// the decision. Every value is invented.

let served: LoopbackApi | undefined
let api: LoopbackApi['api']

beforeEach(async () => {
  served = await serveOnLoopback(await freshApp())
  api = served.api
})

afterEach(async () => {
  await served?.close() // beforeEach can fail before the server listens
  served = undefined
  vi.restoreAllMocks()
})

afterAll(closeDb)

type Row = Record<string, unknown>

const MERCHANT = 'EXAMPLE MERCHANT'
const NOW = new Date('2026-10-25T03:00:00.000Z')
const LATER = new Date('2026-10-25T04:30:00.000Z')

const PROPOSAL_KEYS = [
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

const CORRECTION_KEYS = [
  'id',
  'transaction_id',
  'from_category',
  'to_category',
  'corrected_at',
  'source',
]

// The exact form `new Date().toISOString()` produces: UTC, milliseconds, Z.
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

async function seedTransaction(name: string, fields: Row = {}): Promise<number> {
  const [id] = await connection('transactions').insert({
    akahu_id: `trans_fixture_${name}`,
    account_id: 'acc_fixture_everyday',
    date: '2026-10-20T00:00:00.000Z',
    description: `${MERCHANT} ${name.toUpperCase()}`,
    amount_cents: -1250,
    category: 'Supermarkets and grocery stores',
    category_source: 'akahu',
    ...fields,
  })
  return id
}

const proposal = (transactionId: number, fields: Partial<NewProposal> = {}): NewProposal => ({
  transaction_id: transactionId,
  current_category: 'Supermarkets and grocery stores',
  proposed_category: 'Bakeries',
  confidence: 0.9,
  reason: `Moved ${MERCHANT} to Bakeries twice`,
  origin: 'rule',
  ...fields,
})

async function seedProposal(p: NewProposal, now: Date = NOW): Promise<number> {
  const result = await insertProposal(p, now)
  if (!result.inserted) throw new Error(`expected an insert, got ${result.reason}`)
  return result.id
}

// A local copy of `snapshotTables` in server/db/__tests__/overview.test.ts:
// every table the migrations made, every row in rowid order.
async function snapshotTables(): Promise<Record<string, Row[]>> {
  const tables: { name: string }[] = await connection('sqlite_master')
    .select('name')
    .where({ type: 'table' })
    .whereNot('name', 'like', 'knex_%')
    .whereNot('name', 'like', 'sqlite_%')
    .orderBy('name')
  const out: Record<string, Row[]> = {}
  for (const { name } of tables) {
    out[name] = await connection(name).select().orderByRaw('rowid')
  }
  return out
}

async function proposalRow(id: number): Promise<Row> {
  return connection('category_proposals').where({ id }).first()
}

async function transactionRow(id: number): Promise<Row> {
  return connection('transactions').where({ id }).first()
}

const accept = (id: number | string) => api.post(`/api/v1/agents/proposals/${id}/accept`)
const reject = (id: number | string) => api.post(`/api/v1/agents/proposals/${id}/reject`)

// Two transactions with a proposal each, an existing correction, an insight
// and a row elsewhere, so a write anywhere it should not be is visible.
async function seedMain() {
  const target = await seedTransaction('a', {
    akahu_category_id: 'nzfcc_fixture_grocery',
    akahu_category_name: 'Supermarkets and grocery stores',
    akahu_category_group_id: 'group_fixture_food',
    akahu_category_group_name: 'Food',
    updated_at: '2026-10-20T01:00:00.000Z',
  })
  const other = await seedTransaction('b', { category: 'Cafes and restaurants' })
  await connection('category_corrections').insert({
    transaction_id: other,
    from_category: 'Supermarkets and grocery stores',
    to_category: 'Cafes and restaurants',
    corrected_at: '2026-10-21T00:00:00.000Z',
    source: 'user',
  })
  const targetProposal = await seedProposal(proposal(target))
  const otherProposal = await seedProposal(
    proposal(other, {
      current_category: 'Cafes and restaurants',
      proposed_category: 'Convenience stores',
    }),
    LATER,
  )
  await connection('insights').insert({
    kind: 'report',
    title: 'Week in review',
    body_md: 'An invented week.',
    chart_spec_json: null,
    scope: 'personal',
    period: '2026-W43',
    created_at: NOW.toISOString(),
    dismissed_at: null,
  })
  await connection('accounts').insert({
    akahu_id: 'acc_fixture_everyday',
    source: 'akahu',
    name: 'Fixture everyday',
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
  })
  return { target, other, targetProposal, otherProposal }
}

describe('the snapshot helper', () => {
  it('covers every table, the money and inbox tables among them', async () => {
    const names: string[] = await connection('sqlite_master')
      .where({ type: 'table' })
      .whereNot('name', 'like', 'knex_%')
      .whereNot('name', 'like', 'sqlite_%')
      .pluck('name')

    const keys = Object.keys(await snapshotTables())

    expect(keys.sort()).toEqual([...names].sort())
    expect(keys).toEqual(
      expect.arrayContaining([
        'transactions',
        'category_corrections',
        'category_proposals',
        'insights',
        'agent_runs',
        'settings',
        'account_settings',
        'accounts',
      ]),
    )
  })
})

describe('POST /api/v1/agents/proposals/:id/accept', () => {
  it('writes only the category as rule, one rule correction and the decision', async () => {
    const { target, targetProposal } = await seedMain()
    const before = await snapshotTables()
    const startedAt = new Date().toISOString()

    const res = await accept(targetProposal)

    expect(res.status).toBe(200)
    const after = await snapshotTables()

    // Every other table is untouched.
    for (const table of Object.keys(before)) {
      if (['transactions', 'category_corrections', 'category_proposals'].includes(table)) {
        continue
      }
      expect(after[table], table).toEqual(before[table])
    }

    // The target transaction: category and its source only. updated_at and
    // Akahu's category columns are as they were.
    expect(after.transactions.map((r) => r.id)).toEqual(before.transactions.map((r) => r.id))
    for (const [i, row] of after.transactions.entries()) {
      expect(row).toEqual(
        row.id === target
          ? { ...before.transactions[i], category: 'Bakeries', category_source: 'rule' }
          : before.transactions[i],
      )
    }
    expect(before.transactions.find((r) => r.id === target)?.category_source).toBe('akahu')

    // Exactly one new correction, appended.
    expect(after.category_corrections).toHaveLength(before.category_corrections.length + 1)
    expect(after.category_corrections.slice(0, -1)).toEqual(before.category_corrections)
    const correction = after.category_corrections[after.category_corrections.length - 1]
    expect(Object.keys(correction).sort()).toEqual([...CORRECTION_KEYS].sort())
    expect(correction).toMatchObject({
      transaction_id: target,
      from_category: 'Supermarkets and grocery stores',
      to_category: 'Bakeries',
      source: 'rule',
    })
    expect(correction.corrected_at).toMatch(ISO_UTC)
    expect(String(correction.corrected_at) >= startedAt).toBe(true)

    // Only that proposal is decided.
    for (const [i, row] of after.category_proposals.entries()) {
      expect(row).toEqual(
        row.id === targetProposal
          ? { ...before.category_proposals[i], status: 'accepted' }
          : before.category_proposals[i],
      )
    }

    // The body: the decided proposal and the stored transaction.
    expect(Object.keys(res.body).sort()).toEqual(['proposal', 'transaction'])
    expect(Object.keys(res.body.proposal).sort()).toEqual([...PROPOSAL_KEYS].sort())
    expect(res.body.proposal).toEqual(await proposalRow(targetProposal))
    expect(res.body.proposal.status).toBe('accepted')
    expect(Object.keys(res.body.transaction).sort()).toEqual([...TRANSACTION_COLUMNS].sort())
    expect(res.body.transaction).toEqual(await transactionRow(target))
  })

  it('a second accept is 409 and writes nothing', async () => {
    const { targetProposal } = await seedMain()
    expect((await accept(targetProposal)).status).toBe(200)
    const afterFirst = await snapshotTables()

    const res = await accept(targetProposal)

    expect(res.status).toBe(409)
    expect(res.body).toStrictEqual({ error: 'Proposal already decided' })
    expect(await snapshotTables()).toEqual(afterFirst)
  })

  it('a concurrent double-submit accepts once: one 200, the rest 409, one correction', async () => {
    const { target, targetProposal } = await seedMain()
    const corrections = (await snapshotTables()).category_corrections.length

    const results = await Promise.all([1, 2, 3].map(() => accept(targetProposal)))

    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409])
    const after = await connection('category_corrections').where({ transaction_id: target })
    expect(after).toHaveLength(1)
    expect((await snapshotTables()).category_corrections).toHaveLength(corrections + 1)
  })

  it('accept after reject is 409 and the rejection stands', async () => {
    const { target, targetProposal } = await seedMain()
    expect((await reject(targetProposal)).status).toBe(200)
    const afterFirst = await snapshotTables()

    const res = await accept(targetProposal)

    expect(res.status).toBe(409)
    expect(res.body).toStrictEqual({ error: 'Proposal already decided' })
    expect(await snapshotTables()).toEqual(afterFirst)
    expect((await proposalRow(targetProposal)).status).toBe('rejected')
    expect((await transactionRow(target)).category_source).toBe('akahu')
  })

  it('a missing id is 404 and writes nothing', async () => {
    await seedMain()
    const before = await snapshotTables()

    const res = await accept(999_999)

    expect(res.status).toBe(404)
    expect(res.body).toStrictEqual({ error: 'Proposal not found' })
    expect(await snapshotTables()).toEqual(before)
  })

  it('a proposed category no longer in data/cats.js is 409, left pending, nothing written', async () => {
    const { target } = await seedMain()
    // Direct insert: insertProposal refuses an unknown category, as it should.
    const [drifted] = await connection('category_proposals').insert({
      transaction_id: target,
      current_category: 'Supermarkets and grocery stores',
      proposed_category: 'Not A Category',
      confidence: 0.8,
      reason: 'An invented reason',
      origin: 'rule',
      status: 'pending',
      created_at: NOW.toISOString(),
    })
    const before = await snapshotTables()

    const res = await accept(drifted)

    expect(res.status).toBe(409)
    expect(res.body).toStrictEqual({
      error: 'Proposed category is no longer in the category list',
    })
    expect(await snapshotTables()).toEqual(before)
    expect((await proposalRow(drifted)).status).toBe('pending')
  })

  it('a pending transaction is 409 with the PATCH route’s wording, left pending, nothing written', async () => {
    const { target, targetProposal } = await seedMain()
    await connection('transactions').where({ id: target }).update({ status: 'pending' })
    const before = await snapshotTables()

    const res = await accept(targetProposal)

    expect(res.status).toBe(409)
    expect(res.body).toStrictEqual({
      error: 'Transaction is still pending; its category can be changed once it settles',
    })
    expect(await snapshotTables()).toEqual(before)
    expect((await proposalRow(targetProposal)).status).toBe('pending')
  })

  // The proposal's foreign key cascades, so the only way to a proposal whose
  // transaction is gone is with the key off. The pool holds one connection,
  // so the pragma applies to the app's queries too. The stale check's read
  // (step 4) is what refuses it: nothing between that read and
  // setUserCategory's own can remove the row inside the same transaction.
  it('a transaction that is gone is 404, and the proposal is left pending', async () => {
    const { target, targetProposal } = await seedMain()
    await connection.raw('PRAGMA foreign_keys = OFF')
    try {
      await connection('transactions').where({ id: target }).del()
      expect(await proposalRow(targetProposal)).toBeDefined()
      const before = await snapshotTables()

      const res = await accept(targetProposal)

      expect(res.status).toBe(404)
      expect(res.body).toStrictEqual({ error: 'Transaction not found' })
      expect((await proposalRow(targetProposal)).status).toBe('pending')
      expect(await snapshotTables()).toEqual(before)
    } finally {
      await connection.raw('PRAGMA foreign_keys = ON')
    }
    expect(await connection.raw('PRAGMA foreign_keys')).toEqual([{ foreign_keys: 1 }])
  })

  describe('a stale proposal is refused', () => {
    const STALE = { error: 'Transaction category has changed since this was proposed' }
    const patch = (id: number, category: string) =>
      api.patch(`/api/v1/transactions/${id}`).send({ category })

    it('when the user changed the category: 409, pending, the user’s category and correction stand', async () => {
      const { target, targetProposal } = await seedMain()
      const before = await snapshotTables()
      expect((await patch(target, 'Convenience stores')).status).toBe(200)
      const afterPatch = await snapshotTables()

      const res = await accept(targetProposal)

      expect(res.status).toBe(409)
      expect(res.body).toStrictEqual(STALE)
      expect(await snapshotTables()).toEqual(afterPatch)
      expect((await proposalRow(targetProposal)).status).toBe('pending')
      expect(await transactionRow(target)).toMatchObject({
        category: 'Convenience stores',
        category_source: 'user',
      })
      // Exactly the PATCH's correction, nothing from accept.
      expect(afterPatch.category_corrections.slice(0, -1)).toEqual(before.category_corrections)
      const ours = await connection('category_corrections').where({ transaction_id: target })
      expect(ours).toHaveLength(1)
      expect(ours[0]).toMatchObject({
        from_category: 'Supermarkets and grocery stores',
        to_category: 'Convenience stores',
        source: 'user',
      })
    })

    it('when the user re-set the same category by hand: 409, nothing written', async () => {
      const { target, targetProposal } = await seedMain()
      expect((await patch(target, 'Supermarkets and grocery stores')).status).toBe(200)
      // The category is still the one proposed against; only its source moved.
      expect(await transactionRow(target)).toMatchObject({
        category: (await proposalRow(targetProposal)).current_category,
        category_source: 'user',
      })
      const afterPatch = await snapshotTables()

      const res = await accept(targetProposal)

      expect(res.status).toBe(409)
      expect(res.body).toStrictEqual(STALE)
      expect(await snapshotTables()).toEqual(afterPatch)
      expect((await proposalRow(targetProposal)).status).toBe('pending')
    })

    it('a proposal against no category, on a transaction with none, is accepted', async () => {
      await seedMain()
      const bare = await seedTransaction('bare', { category: null })
      const id = await seedProposal(proposal(bare, { current_category: null }))

      const res = await accept(id)

      expect(res.status).toBe(200)
      expect(await transactionRow(bare)).toMatchObject({
        category: 'Bakeries',
        category_source: 'rule',
      })
      const ours = await connection('category_corrections').where({ transaction_id: bare })
      expect(ours).toHaveLength(1)
      expect(ours[0]).toMatchObject({ from_category: null, to_category: 'Bakeries', source: 'rule' })
    })

    it.each([
      ['against no category, on a transaction with one', null, 'Supermarkets and grocery stores'],
      ['against a category, on a transaction with none', 'Supermarkets and grocery stores', null],
      // Not hand-set: sync recategorised it, so only the comparison refuses it.
      [
        'against one category, on a transaction with another',
        'Supermarkets and grocery stores',
        'Cafes and restaurants',
      ],
    ])('a proposal %s: 409, pending, nothing written', async (_why, current, category) => {
      await seedMain()
      const tx = await seedTransaction('drifted', { category })
      const id = await seedProposal(proposal(tx, { current_category: current }))
      const before = await snapshotTables()

      const res = await accept(id)

      expect(res.status).toBe(409)
      expect(res.body).toStrictEqual(STALE)
      expect(await snapshotTables()).toEqual(before)
      expect((await proposalRow(id)).status).toBe('pending')
    })

    it('a second proposal, after another accept moved the category: 409, pending, nothing written', async () => {
      const { target, targetProposal } = await seedMain()
      const second = await seedProposal(
        proposal(target, { proposed_category: 'Convenience stores' }),
        LATER,
      )
      expect((await accept(targetProposal)).status).toBe(200)
      expect(await transactionRow(target)).toMatchObject({
        category: 'Bakeries',
        category_source: 'rule',
      })
      const afterFirst = await snapshotTables()

      const res = await accept(second)

      expect(res.status).toBe(409)
      expect(res.body).toStrictEqual(STALE)
      expect(await snapshotTables()).toEqual(afterFirst)
      expect((await proposalRow(second)).status).toBe('pending')
    })

    it('a proposed category no longer in the list is refused for that, before staleness', async () => {
      const { target } = await seedMain()
      expect((await patch(target, 'Convenience stores')).status).toBe(200)
      // Direct insert: insertProposal refuses an unknown category.
      const [both] = await connection('category_proposals').insert({
        transaction_id: target,
        current_category: 'Supermarkets and grocery stores',
        proposed_category: 'Not A Category',
        confidence: 0.8,
        reason: 'An invented reason',
        origin: 'rule',
        status: 'pending',
        created_at: NOW.toISOString(),
      })
      const before = await snapshotTables()

      const res = await accept(both)

      expect(res.status).toBe(409)
      expect(res.body).toStrictEqual({
        error: 'Proposed category is no longer in the category list',
      })
      expect(await snapshotTables()).toEqual(before)
    })

    it('a stale proposal can still be rejected', async () => {
      const { target, targetProposal } = await seedMain()
      expect((await patch(target, 'Convenience stores')).status).toBe(200)
      const afterPatch = await snapshotTables()

      const res = await reject(targetProposal)

      expect(res.status).toBe(200)
      expect(res.body.proposal).toMatchObject({ id: targetProposal, status: 'rejected' })
      const after = await snapshotTables()
      expect({
        ...after,
        category_proposals: after.category_proposals.map((r) =>
          r.id === targetProposal ? { ...r, status: 'pending' } : r,
        ),
      }).toEqual(afterPatch)
    })
  })

  describe('a failed write rolls back the decision with it', () => {
    it.each([
      [
        'the correction',
        `CREATE TRIGGER refuse_corrections BEFORE INSERT ON category_corrections
         BEGIN SELECT RAISE(ABORT, 'invented correction failure'); END`,
      ],
      [
        'the category',
        `CREATE TRIGGER refuse_category_writes BEFORE UPDATE ON transactions
         BEGIN SELECT RAISE(ABORT, 'invented category write failure'); END`,
      ],
    ])('when %s cannot be written: 500, fixed text, only the class logged', async (_what, trigger) => {
      const { target, targetProposal } = await seedMain()
      // Dropped with its table by the next freshApp's rollback.
      await connection.raw(trigger)
      const before = await snapshotTables()
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {})

      const res = await accept(targetProposal)

      expect(res.status).toBe(500)
      expect(res.body).toStrictEqual({ error: 'Could not accept proposal' })
      expect(await snapshotTables()).toEqual(before)
      expect((await proposalRow(targetProposal)).status).toBe('pending')
      expect((await transactionRow(target)).category_source).toBe('akahu')
      expect(logged.mock.calls).toEqual([['agents: could not accept proposal', 'Error']])
      const said = JSON.stringify(logged.mock.calls) + res.text
      expect(said).not.toContain('invented')
      expect(said).not.toContain(MERCHANT)
    })
  })

  it('survives a later sync that changes Akahu’s category', async () => {
    // A copy of item()/syncWith() in server/sync/__tests__/category-survival.test.ts.
    const item = (id: string, category: { id: string; name: string }) =>
      `{"_id":"${id}","_account":"acc_fixture0001everyday","_connection":"conn_fixture0001","amount":-12.5,"date":"2026-10-20T00:00:00.000Z","description":"${MERCHANT} ${id}","type":"EFTPOS","created_at":"2026-10-20T01:00:00.000Z","updated_at":"2026-10-20T01:00:00.000Z","category":{"_id":"${category.id}","name":"${category.name}","groups":{"personal_finance":{"_id":"group_fixture_food","name":"Food"}}}}`
    const syncWith = (items: string[], minutes: number) =>
      runSync({
        client: fakeAkahu({ transactions: page(items), pending: page([]) }).client,
        db,
        now: () => at(minutes * MINUTE_MS),
      })
    const CAFES = { id: 'nzfcc_fixture_cafes', name: 'Cafes and restaurants' }
    const GROCERY = { id: 'nzfcc_fixture_grocery', name: 'Supermarkets and grocery stores' }

    expect(await syncWith([item('trans_fixture_synced', CAFES)], 0)).toMatchObject({
      outcome: 'success',
    })
    const synced = await connection('transactions')
      .where({ akahu_id: 'trans_fixture_synced' })
      .first()
    expect(synced).toMatchObject({ category: CAFES.name, category_source: 'akahu' })
    const id = await seedProposal(
      proposal(synced.id, { current_category: CAFES.name, proposed_category: 'Bakeries' }),
    )

    expect((await accept(id)).status).toBe(200)
    expect(await syncWith([item('trans_fixture_synced', GROCERY)], 15)).toMatchObject({
      outcome: 'success',
      updatedCount: 1,
    })

    expect(await transactionRow(synced.id)).toMatchObject({
      category: 'Bakeries',
      category_source: 'rule',
      akahu_category_id: GROCERY.id,
      akahu_category_name: GROCERY.name,
    })
    const corrections = await connection('category_corrections').select()
    expect(corrections).toHaveLength(1)
    expect(corrections[0]).toMatchObject({ transaction_id: synced.id, source: 'rule' })
  })
})

describe('POST /api/v1/agents/proposals/:id/reject', () => {
  it('rejects a pending proposal and writes only its status', async () => {
    const { targetProposal } = await seedMain()
    const before = await snapshotTables()

    const res = await reject(targetProposal)

    expect(res.status).toBe(200)
    expect(Object.keys(res.body)).toEqual(['proposal'])
    expect(Object.keys(res.body.proposal).sort()).toEqual([...PROPOSAL_KEYS].sort())
    expect(res.body.proposal).toEqual(await proposalRow(targetProposal))
    expect(res.body.proposal.status).toBe('rejected')
    const after = await snapshotTables()
    expect({
      ...after,
      category_proposals: after.category_proposals.map((r) =>
        r.id === targetProposal ? { ...r, status: 'pending' } : r,
      ),
    }).toEqual(before)
  })

  it('a second reject is 409 and writes nothing', async () => {
    const { targetProposal } = await seedMain()
    expect((await reject(targetProposal)).status).toBe(200)
    const afterFirst = await snapshotTables()

    const res = await reject(targetProposal)

    expect(res.status).toBe(409)
    expect(res.body).toStrictEqual({ error: 'Proposal already decided' })
    expect(await snapshotTables()).toEqual(afterFirst)
  })

  it('reject after accept is 409 and the acceptance stands', async () => {
    const { target, targetProposal } = await seedMain()
    expect((await accept(targetProposal)).status).toBe(200)
    const afterFirst = await snapshotTables()

    const res = await reject(targetProposal)

    expect(res.status).toBe(409)
    expect(res.body).toStrictEqual({ error: 'Proposal already decided' })
    expect(await snapshotTables()).toEqual(afterFirst)
    expect((await proposalRow(targetProposal)).status).toBe('accepted')
    expect((await transactionRow(target)).category_source).toBe('rule')
  })

  it('a missing id is 404 and writes nothing', async () => {
    await seedMain()
    const before = await snapshotTables()

    const res = await reject(999_999)

    expect(res.status).toBe(404)
    expect(res.body).toStrictEqual({ error: 'Proposal not found' })
    expect(await snapshotTables()).toEqual(before)
  })

  it('a rejected pair is never pending again, and a re-proposal of it is refused', async () => {
    const { target, targetProposal } = await seedMain()
    expect((await reject(targetProposal)).status).toBe(200)

    const pending = await api.get('/api/v1/agents/proposals?status=pending')
    const rejected = await api.get('/api/v1/agents/proposals?status=rejected')
    expect(pending.body.items.map((p: Row) => p.id)).not.toContain(targetProposal)
    expect(rejected.body.items.map((p: Row) => p.id)).toEqual([targetProposal])

    const count = (await connection('category_proposals').count({ n: '*' }))[0].n
    expect(await insertProposal(proposal(target), LATER)).toEqual({
      inserted: false,
      reason: 'duplicate',
    })
    expect((await connection('category_proposals').count({ n: '*' }))[0].n).toBe(count)
    expect((await proposalRow(targetProposal)).status).toBe('rejected')
  })

  it('a database failure is 500 with fixed text, only the class logged', async () => {
    const { targetProposal } = await seedMain()
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    await connection.raw('ALTER TABLE category_proposals RENAME TO category_proposals_x')
    try {
      const res = await reject(targetProposal)

      expect(res.status).toBe(500)
      expect(res.body).toStrictEqual({ error: 'Could not reject proposal' })
      expect(logged.mock.calls).toEqual([['agents: could not reject proposal', 'Error']])
    } finally {
      await connection.raw('ALTER TABLE category_proposals_x RENAME TO category_proposals')
    }
    expect((await proposalRow(targetProposal)).status).toBe('pending')
  })
})

describe.each([
  ['accept', accept],
  ['reject', reject],
])('POST /:id/%s refuses an id that is not a plain positive integer', (_name, send) => {
  it.each(['abc', '0', '-1', '1e3', '0x10', '%207', '99999999999999999999'])(
    '%s is 400 and writes nothing',
    async (bad) => {
      await seedMain()
      const before = await snapshotTables()

      const res = await send(bad)

      expect(res.status).toBe(400)
      expect(res.body).toStrictEqual({ error: 'id must be a positive integer' })
      expect(await snapshotTables()).toEqual(before)
    },
  )
})

describe('only this site may decide a proposal (as POST /api/v1/sync/run)', () => {
  const ownOrigin = () => `http://127.0.0.1:${served?.address.port}`
  const paths = [
    ['accept', (id: number) => `/api/v1/agents/proposals/${id}/accept`],
    ['reject', (id: number) => `/api/v1/agents/proposals/${id}/reject`],
  ] as const

  describe.each(paths)('%s', (_name, path) => {
    it.each(['cross-site', 'same-site'])(
      'Sec-Fetch-Site %s is refused even with this host’s own Origin',
      async (site) => {
        const { targetProposal } = await seedMain()
        const before = await snapshotTables()

        const res = await api
          .post(path(targetProposal))
          .set('Sec-Fetch-Site', site)
          .set('Origin', ownOrigin())

        expect(res.status).toBe(403)
        expect(res.body).toStrictEqual({ error: 'Forbidden' })
        expect(await snapshotTables()).toEqual(before)
      },
    )

    it.each(['http://evil.example', 'null', 'not a url'])(
      'without Sec-Fetch-Site, Origin %s is refused',
      async (origin) => {
        const { targetProposal } = await seedMain()
        const before = await snapshotTables()

        const res = await api.post(path(targetProposal)).set('Origin', origin)

        expect(res.status).toBe(403)
        expect(res.body).toStrictEqual({ error: 'Forbidden' })
        expect(await snapshotTables()).toEqual(before)
      },
    )

    it.each([
      [
        'Sec-Fetch-Site same-origin, behind the dev proxy',
        { 'Sec-Fetch-Site': 'same-origin', Origin: 'http://localhost:5173' },
      ],
      ['Sec-Fetch-Site none', { 'Sec-Fetch-Site': 'none' }],
      ['this host’s own Origin', 'own'],
      ['no headers (curl)', {}],
    ] as const)('%s passes', async (_why, headers) => {
      const { targetProposal } = await seedMain()

      const res = await api
        .post(path(targetProposal))
        .set(headers === 'own' ? { Origin: ownOrigin() } : headers)

      expect(res.status).toBe(200)
      expect((await proposalRow(targetProposal)).status).not.toBe('pending')
    })

    it('a cross-site POST for a missing id is 403, not 404', async () => {
      const res = await api.post(path(999_999)).set('Sec-Fetch-Site', 'cross-site')

      expect(res.status).toBe(403)
      expect(res.body).toStrictEqual({ error: 'Forbidden' })
    })
  })

  it('a cross-site GET of the list is not refused', async () => {
    await seedMain()

    const res = await api.get('/api/v1/agents/proposals').set('Sec-Fetch-Site', 'cross-site')

    expect(res.status).toBe(200)
    expect(res.body.items).toHaveLength(2)
  })
})

describe('GET /api/v1/agents/proposals', () => {
  async function seedEveryStatus() {
    const { targetProposal, otherProposal, target } = await seedMain()
    const third = await seedProposal(
      proposal(target, { proposed_category: 'Convenience stores' }),
      new Date('2026-10-25T05:00:00.000Z'),
    )
    expect((await accept(targetProposal)).status).toBe(200)
    const fourth = await seedProposal(
      proposal(target, { proposed_category: 'Cafes and restaurants' }),
      new Date('2026-10-25T06:00:00.000Z'),
    )
    expect((await reject(fourth)).status).toBe(200)
    return { accepted: targetProposal, pending: [third, otherProposal], rejected: fourth }
  }

  it('lists pending proposals by default, newest first, as full rows', async () => {
    const { pending } = await seedEveryStatus()

    const res = await api.get('/api/v1/agents/proposals')

    expect(res.status).toBe(200)
    expect(Object.keys(res.body)).toEqual(['items'])
    expect(res.body.items.map((p: Row) => p.id)).toEqual(pending)
    for (const item of res.body.items) {
      expect(Object.keys(item).sort()).toEqual([...PROPOSAL_KEYS].sort())
      expect(item.status).toBe('pending')
      expect(item).toEqual(await proposalRow(item.id as number))
    }
  })

  it('filters by each status', async () => {
    const ids = await seedEveryStatus()

    for (const [status, expected] of [
      ['pending', ids.pending],
      ['accepted', [ids.accepted]],
      ['rejected', [ids.rejected]],
    ] as const) {
      const res = await api.get(`/api/v1/agents/proposals?status=${status}`)
      expect(res.status, status).toBe(200)
      expect(res.body.items.map((p: Row) => p.id), status).toEqual(expected)
    }
  })

  it.each([
    ['an unknown status', '?status=nope'],
    ['an empty status', '?status='],
    ['a repeated status', '?status=pending&status=rejected'],
  ])('%s is 400', async (_why, query) => {
    const res = await api.get(`/api/v1/agents/proposals${query}`)

    expect(res.status).toBe(400)
    expect(res.body).toStrictEqual({ error: 'status must be pending, accepted or rejected' })
  })

  it('a database failure is 500 with fixed text, only the class logged', async () => {
    await seedMain()
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    await connection.raw('ALTER TABLE category_proposals RENAME TO category_proposals_x')
    try {
      const res = await api.get('/api/v1/agents/proposals')

      expect(res.status).toBe(500)
      expect(res.body).toStrictEqual({ error: 'Could not list proposals' })
      expect(logged.mock.calls).toEqual([['agents: could not list proposals', 'Error']])
    } finally {
      await connection.raw('ALTER TABLE category_proposals_x RENAME TO category_proposals')
    }
  })
})
