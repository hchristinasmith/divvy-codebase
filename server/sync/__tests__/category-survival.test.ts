import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import { runSync } from '../run.ts'
import type { CorrectionSource } from '../../../models/sync.ts'
import {
  at,
  closeDb,
  DAY_MS,
  db,
  fakeAkahu,
  freshDb,
  MINUTE_MS,
  NOW,
  page,
} from './harness.ts'

// Issue #21, Done-when 5 and 6 (prd-01 Ruling 4, Done-when 7): a category
// a user, rule or Claude set survives every later sync, with its
// `category_source` and its `category_corrections` row, while
// `akahu_category_*` keeps recording what Akahu sent. A category Akahu
// still owns follows Akahu, including to no category at all.

beforeEach(async () => {
  await freshDb()
})
afterAll(closeDb)

const fixed = (date: Date) => () => date

interface Category {
  id: string
  name: string
  groupId: string
  groupName: string
}

const CAFES: Category = {
  id: 'nzfcc_fixture0001',
  name: 'Cafes and restaurants',
  groupId: 'group_fixture0001',
  groupName: 'Lifestyle',
}
const TAKEAWAYS: Category = {
  id: 'nzfcc_fixture_takeaways',
  name: 'Takeaways',
  groupId: 'group_fixture_food',
  groupName: 'Food',
}

/** A settled item as raw JSON, with or without an Akahu category. */
function item(id: string, category: Category | null): string {
  const cat =
    category === null
      ? ''
      : `,"category":{"_id":"${category.id}","name":"${category.name}","groups":{"personal_finance":{"_id":"${category.groupId}","name":"${category.groupName}"}}}`
  return `{"_id":"${id}","_account":"acc_fixture0001everyday","_connection":"conn_fixture0001","amount":-12.5,"date":"2026-10-20T00:00:00.000Z","description":"EXAMPLE ${id}","type":"EFTPOS","created_at":"2026-10-20T01:00:00.000Z","updated_at":"2026-10-20T01:00:00.000Z"${cat}}`
}

function syncWith(items: string[], minutes: number) {
  return runSync({
    client: fakeAkahu({ transactions: page(items), pending: page([]) }).client,
    db,
    now: fixed(at(minutes * MINUTE_MS)),
  })
}

function categoryOf(akahuId: string) {
  return db('transactions')
    .where({ akahu_id: akahuId })
    .first(
      'id',
      'category',
      'category_source',
      'akahu_category_id',
      'akahu_category_name',
      'akahu_category_group_id',
      'akahu_category_group_name',
    )
}

describe('a row the M1 app already holds', () => {
  // Regression: a row written before sync existed, with the user's category,
  // is adopted by the first sync rather than duplicated or overwritten.
  it('keeps its user category, legacy columns and correction when the first sync adopts it', async () => {
    const [id] = await db('transactions').insert({
      akahu_id: 'trans_fixture0001',
      account_id: 'acc_fixture0001everyday',
      date: '2026-10-20T00:00:00.000Z',
      description: 'EXAMPLE CAFE 12 HIGH ST',
      amount_cents: -1999,
      category_id: 'nzfcc_fixture_legacy',
      category_name: 'Legacy name',
      category_group_id: 'group_fixture_legacy',
      category_group_name: 'Legacy group',
      akahu_category_id: 'nzfcc_fixture_legacy',
      akahu_category_name: 'Legacy name',
      akahu_category_group_id: 'group_fixture_legacy',
      akahu_category_group_name: 'Legacy group',
      category: 'Bakeries',
      category_source: 'user',
    })
    await db('category_corrections').insert({
      transaction_id: id,
      from_category: 'Legacy name',
      to_category: 'Bakeries',
      corrected_at: at(-DAY_MS).toISOString(),
      source: 'user',
    })
    const corrections = await db('category_corrections').select()

    const result = await runSync({ client: fakeAkahu().client, db, now: fixed(NOW) })

    expect(result).toMatchObject({
      outcome: 'success',
      insertedCount: 7,
      updatedCount: 1,
    })
    const rows = await db('transactions')
      .where({ akahu_id: 'trans_fixture0001' })
      .select()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      id,
      status: 'settled',
      source: 'akahu',
      category: 'Bakeries',
      category_source: 'user',
      category_id: 'nzfcc_fixture_legacy',
      category_name: 'Legacy name',
      category_group_id: 'group_fixture_legacy',
      category_group_name: 'Legacy group',
      akahu_category_id: CAFES.id,
      akahu_category_name: CAFES.name,
      akahu_category_group_id: CAFES.groupId,
      akahu_category_group_name: CAFES.groupName,
      description: 'EXAMPLE CAFE 12 HIGH ST',
      balance_cents: 121457,
    })
    expect(await db('category_corrections').select()).toEqual(corrections)
  })
})

describe.each<CorrectionSource>(['user', 'rule', 'claude'])(
  'a category set by %s',
  (owner) => {
    it('survives syncs that change Akahu’s category, which is still recorded', async () => {
      await syncWith([item('trans_owned', CAFES)], 0)
      const { id } = await categoryOf('trans_owned')
      await db('transactions')
        .where({ id })
        .update({ category: 'Bakeries', category_source: owner })
      await db('category_corrections').insert({
        transaction_id: id,
        from_category: CAFES.name,
        to_category: 'Bakeries',
        corrected_at: at(5 * MINUTE_MS).toISOString(),
        source: owner,
      })
      const corrections = await db('category_corrections').select()
      expect(corrections).toHaveLength(1)

      const second = await syncWith([item('trans_owned', TAKEAWAYS)], 15)

      expect(second).toMatchObject({ outcome: 'success', updatedCount: 1 })
      expect(await categoryOf('trans_owned')).toEqual({
        id,
        category: 'Bakeries',
        category_source: owner,
        akahu_category_id: TAKEAWAYS.id,
        akahu_category_name: TAKEAWAYS.name,
        akahu_category_group_id: TAKEAWAYS.groupId,
        akahu_category_group_name: TAKEAWAYS.groupName,
      })
      expect(await db('category_corrections').select()).toEqual(corrections)

      // Akahu dropping its category changes only Akahu's columns.
      const third = await syncWith([item('trans_owned', null)], 30)
      expect(third).toMatchObject({ outcome: 'success', updatedCount: 1 })
      expect(await categoryOf('trans_owned')).toEqual({
        id,
        category: 'Bakeries',
        category_source: owner,
        akahu_category_id: null,
        akahu_category_name: null,
        akahu_category_group_id: null,
        akahu_category_group_name: null,
      })

      // Nothing Akahu sends differs now, so nothing is written.
      const fourth = await syncWith([item('trans_owned', null)], 45)
      expect(fourth).toMatchObject({ outcome: 'success', updatedCount: 0 })
      expect(await db('category_corrections').select()).toEqual(corrections)
    })
  },
)

describe('a category Akahu still owns', () => {
  it('follows Akahu’s change, and Akahu dropping the category', async () => {
    await syncWith([item('trans_akahu', CAFES)], 0)
    const { id } = await categoryOf('trans_akahu')
    expect(await categoryOf('trans_akahu')).toEqual({
      id,
      category: CAFES.name,
      category_source: 'akahu',
      akahu_category_id: CAFES.id,
      akahu_category_name: CAFES.name,
      akahu_category_group_id: CAFES.groupId,
      akahu_category_group_name: CAFES.groupName,
    })

    const second = await syncWith([item('trans_akahu', TAKEAWAYS)], 15)
    expect(second).toMatchObject({ outcome: 'success', updatedCount: 1 })
    expect(await categoryOf('trans_akahu')).toEqual({
      id,
      category: TAKEAWAYS.name,
      category_source: 'akahu',
      akahu_category_id: TAKEAWAYS.id,
      akahu_category_name: TAKEAWAYS.name,
      akahu_category_group_id: TAKEAWAYS.groupId,
      akahu_category_group_name: TAKEAWAYS.groupName,
    })

    const third = await syncWith([item('trans_akahu', null)], 30)
    expect(third).toMatchObject({ outcome: 'success', updatedCount: 1 })
    expect(await categoryOf('trans_akahu')).toEqual({
      id,
      category: null,
      category_source: 'akahu',
      akahu_category_id: null,
      akahu_category_name: null,
      akahu_category_group_id: null,
      akahu_category_group_name: null,
    })
  })

  it('takes Akahu’s category for a row whose effective category was empty', async () => {
    // A row Akahu owns whose category the Akahu columns never filled:
    // only the effective category differs from what Akahu sends.
    await syncWith([item('trans_akahu', CAFES)], 0)
    await db('transactions')
      .where({ akahu_id: 'trans_akahu' })
      .update({ category: null })

    const second = await syncWith([item('trans_akahu', CAFES)], 15)

    expect(second).toMatchObject({ outcome: 'success', updatedCount: 1 })
    expect(await categoryOf('trans_akahu')).toMatchObject({
      category: CAFES.name,
      category_source: 'akahu',
    })
  })
})
