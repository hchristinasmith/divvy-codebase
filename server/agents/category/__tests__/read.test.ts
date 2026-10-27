import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import connection from '../../../db/connection.ts'
import { assertInMemory } from '../../../test-utils/app.ts'
import { loadCandidates, loadEvidence } from '../read.ts'

// The category agent's reads (#42; prd-04 Rulings 2 and 7). Each test starts
// from an empty, freshly migrated in-memory database; every merchant,
// account, reference and category text is invented.

beforeEach(async () => {
  assertInMemory(connection)
  await connection.migrate.rollback(undefined, true)
  await connection.migrate.latest()
  seq = 0
})

afterAll(async () => {
  await connection.destroy()
})

const STAMP = '2026-10-01T00:00:00.000Z'
const BAKERY = 'Bakeries'
const GROCER = 'Supermarkets and grocery stores'

const CANDIDATE_KEYS = ['category', 'id', 'key', 'scope']
const CORRECTION_KEYS = ['at', 'from', 'id', 'key', 'scope', 'to', 'transactionId']
const REJECTION_KEYS = ['category', 'key', 'scope', 'transactionId']

// Values no read may return.
const SENTINELS = ['SENTINEL REF', 'SENTINEL PART', 'SENTINEL CODE', '4242', 'acc_fixture_p']

async function seedAccounts(): Promise<void> {
  await connection('accounts').insert([
    { akahu_id: 'acc_fixture_p', source: 'akahu', scope: 'personal', name: 'Invented', created_at: STAMP, updated_at: STAMP },
    { akahu_id: 'acc_fixture_s', source: 'akahu', scope: 'strawb', name: 'Invented', created_at: STAMP, updated_at: STAMP },
    // An account not from Akahu that happens to share the join column.
    { akahu_id: 'acc_fixture_x', source: 'xero', scope: 'strawb', name: 'Invented', created_at: STAMP, updated_at: STAMP },
  ])
}

let seq = 0

async function tx(over: Record<string, unknown> = {}): Promise<number> {
  seq += 1
  const [row]: { id: number }[] = await connection('transactions')
    .insert({
      akahu_id: `trans_fixture_${seq}`,
      account_id: 'acc_fixture_p',
      date: STAMP,
      amount_cents: -1000,
      merchant_id: 'merchant_fixture_one',
      merchant_name: 'Invented Bakery',
      description: 'INVENTED BAKERY 4242',
      category: GROCER,
      category_source: 'akahu',
      status: 'settled',
      source: 'akahu',
      reference: 'SENTINEL REF',
      particulars: 'SENTINEL PART',
      code: 'SENTINEL CODE',
      card_suffix: '4242',
      ...over,
    })
    .returning('id')
  return row.id
}

async function correction(transactionId: number, to: string, source: string, minutes = 0, from: string | null = null) {
  const [row]: { id: number }[] = await connection('category_corrections')
    .insert({
      transaction_id: transactionId,
      from_category: from,
      to_category: to,
      corrected_at: new Date(Date.UTC(2026, 9, 2, 0, minutes)).toISOString(),
      source,
    })
    .returning('id')
  return row.id
}

async function proposal(transactionId: number, category: string, status: string) {
  await connection('category_proposals').insert({
    transaction_id: transactionId,
    current_category: GROCER,
    proposed_category: category,
    confidence: 0.5,
    reason: 'Invented reason.',
    origin: 'rule',
    status,
    created_at: STAMP,
  })
}

describe('loadCandidates', () => {
  it('returns id, scope, key and category only: no text field leaves the read', async () => {
    await seedAccounts()
    const id = await tx()
    const rows = await loadCandidates(connection)
    expect(rows).toEqual([{ id, scope: 'personal', key: 'm:merchant_fixture_one', category: GROCER }])
    expect(Object.keys(rows[0]).sort()).toEqual([...CANDIDATE_KEYS].sort())
    const text = JSON.stringify(rows)
    for (const s of SENTINELS) expect(text).not.toContain(s)
  })

  it('keys by normalised description when there is no merchant id, and keeps a keyless row with key null', async () => {
    await seedAccounts()
    const byDescription = await tx({ merchant_id: null, description: 'Invented Corner Store 0042' })
    const keyless = await tx({ merchant_id: null, description: '0042 / 9' })
    expect(await loadCandidates(connection)).toEqual([
      { id: byDescription, scope: 'personal', key: 'd:invented corner store', category: GROCER },
      { id: keyless, scope: 'personal', key: null, category: GROCER },
    ])
  })

  it('takes scope from the account, and keeps a null category as null', async () => {
    await seedAccounts()
    const id = await tx({ account_id: 'acc_fixture_s', category: null })
    expect(await loadCandidates(connection)).toEqual([
      { id, scope: 'strawb', key: 'm:merchant_fixture_one', category: null },
    ])
  })

  it('reads only settled Akahu rows on Akahu accounts whose category Akahu set', async () => {
    await seedAccounts()
    const eligible = await tx()
    await tx({ status: 'pending', akahu_id: null })
    await tx({ category_source: 'user' })
    await tx({ category_source: 'rule' })
    await tx({ category_source: 'claude' })
    await tx({ source: 'xero' })
    await tx({ account_id: 'acc_fixture_x' })
    await tx({ account_id: 'acc_fixture_none' })
    expect((await loadCandidates(connection)).map((r) => r.id)).toEqual([eligible])
  })

  it('orders by id and honours afterId and limit', async () => {
    await seedAccounts()
    const ids = [await tx(), await tx(), await tx(), await tx()]
    expect((await loadCandidates(connection)).map((r) => r.id)).toEqual(ids)
    expect((await loadCandidates(connection, { afterId: ids[0], limit: 2 })).map((r) => r.id)).toEqual(ids.slice(1, 3))
    expect((await loadCandidates(connection, { afterId: ids[3] })).map((r) => r.id)).toEqual([])
  })

  it('reads exactly the given ids, still only the eligible ones, past any batch size', async () => {
    await seedAccounts()
    const ids: number[] = []
    for (let i = 0; i < 1200; i += 1) ids.push(await tx())
    const user = await tx({ category_source: 'user' })
    const picked = [ids[1199], ids[0], ids[600], user, 999_999]
    expect((await loadCandidates(connection, { ids: picked })).map((r) => r.id)).toEqual([ids[0], ids[600], ids[1199]])
    // Read in chunks: none is lost or repeated at a chunk boundary.
    expect((await loadCandidates(connection, { ids })).map((r) => r.id)).toEqual(ids)
  })
})

describe('loadEvidence', () => {
  it("reads only the user's corrections: rule and claude corrections never count (#280)", async () => {
    await seedAccounts()
    const one = await tx()
    const two = await tx({ account_id: 'acc_fixture_s', merchant_id: null, description: 'Invented Corner Store 0042' })
    const userId = await correction(one, BAKERY, 'user', 1, GROCER)
    await correction(one, BAKERY, 'rule', 2)
    await correction(two, BAKERY, 'claude', 3)
    const strawbId = await correction(two, GROCER, 'user', 4)
    const { corrections } = await loadEvidence(connection)
    expect(corrections).toEqual([
      {
        id: userId,
        transactionId: one,
        scope: 'personal',
        key: 'm:merchant_fixture_one',
        from: GROCER,
        to: BAKERY,
        at: '2026-10-02T00:01:00.000Z',
      },
      {
        id: strawbId,
        transactionId: two,
        scope: 'strawb',
        key: 'd:invented corner store',
        from: null,
        to: GROCER,
        at: '2026-10-02T00:04:00.000Z',
      },
    ])
    expect(Object.keys(corrections[0]).sort()).toEqual([...CORRECTION_KEYS].sort())
    const text = JSON.stringify(corrections)
    for (const s of SENTINELS) expect(text).not.toContain(s)
  })

  it('drops a correction on a row with no key', async () => {
    await seedAccounts()
    const keyless = await tx({ merchant_id: null, description: '0042' })
    await correction(keyless, BAKERY, 'user')
    expect((await loadEvidence(connection)).corrections).toEqual([])
  })

  it('reads rejected proposals only, keyed like the corrections', async () => {
    await seedAccounts()
    const one = await tx()
    const two = await tx()
    await proposal(one, BAKERY, 'rejected')
    await proposal(two, BAKERY, 'pending')
    await proposal(two, 'Cafes and restaurants', 'accepted')
    const { rejections } = await loadEvidence(connection)
    expect(rejections).toEqual([
      { transactionId: one, scope: 'personal', key: 'm:merchant_fixture_one', category: BAKERY },
    ])
    expect(Object.keys(rejections[0]).sort()).toEqual([...REJECTION_KEYS].sort())
  })
})
