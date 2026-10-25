import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import knex, { Knex } from 'knex'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as Path from 'node:path'
import config from '../../knexfile.js'
import { dollarsToCents } from '../../../../shared/money.ts'
import { TRANSACTION_COLUMNS } from '../../__tests__/transactionColumns.ts'
import fixture from '../../fixtures/transactions.json'

// The user-facing flow is `npm run knex migrate:latest && npm run knex
// seed:run` on a fresh clone; these tests run the same migrator and seed
// runner against a fresh in-memory database.

let db: Knex
let scratch: string

beforeEach(async () => {
  db = knex(config.test)
  await db.migrate.latest()
  scratch = await mkdtemp(Path.join(tmpdir(), 'divvy-seed-'))
  delete process.env.DIVVY_SEED_TRANSACTIONS
})

afterEach(async () => {
  delete process.env.DIVVY_SEED_TRANSACTIONS
  await db.destroy()
  await rm(scratch, { recursive: true, force: true })
})

function akahuTxn(
  id: string,
  amount: number,
  extra: { balance?: number; meta?: Record<string, unknown> } = {},
) {
  return {
    _id: id,
    _account: 'acc_override',
    _user: 'user_override',
    _connection: 'conn_override',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    date: '2026-01-01T00:00:00.000Z',
    description: `override ${id}`,
    amount,
    type: 'EFTPOS',
    meta: {},
    ...extra,
  }
}

describe('transactions seed', () => {
  it('seeds every fixture row with no private file present', async () => {
    await db.seed.run()

    const rows = await db('transactions').select().orderBy('akahu_id')
    expect(rows.map((r) => r.akahu_id)).toEqual(
      fixture.items.map((t) => t._id).sort(),
    )
  })

  it('maps the Akahu shape onto the transactions columns', async () => {
    await db.seed.run()

    const source = fixture.items.find((t) => t._id === 'trans_fixture_002')!
    const row = await db('transactions')
      .where({ akahu_id: 'trans_fixture_002' })
      .first()

    expect(row).toMatchObject({
      akahu_id: source._id,
      account_id: source._account,
      user_id: source._user,
      connection_id: source._connection,
      description: source.description,
      amount_cents: dollarsToCents(source.amount),
      balance_cents: dollarsToCents(source.balance),
      type: source.type,
      hash: source.hash,
      category_id: source.category!._id,
      category_name: source.category!.name,
      category_group_id: source.category!.groups.personal_finance._id,
      category_group_name: source.category!.groups.personal_finance.name,
      akahu_category_id: source.category!._id,
      akahu_category_name: source.category!.name,
      akahu_category_group_id: source.category!.groups.personal_finance._id,
      akahu_category_group_name: source.category!.groups.personal_finance.name,
      merchant_id: source.merchant!._id,
      merchant_name: source.merchant!.name,
      merchant_website: source.merchant!.website,
      // Seeded rows are Akahu data: the effective category is Akahu's.
      category: source.category!.name,
      category_source: 'akahu',
    })
    // Pin the key set too: toMatchObject cannot see a column that appeared
    // or vanished.
    expect(Object.keys(row).sort()).toEqual([...TRANSACTION_COLUMNS].sort())
  })

  it('every seeded row has akahu_category_* equal to its legacy category_*', async () => {
    await db.seed.run()

    const rows = await db('transactions')
      .select(
        'akahu_id',
        'category_id',
        'category_name',
        'category_group_id',
        'category_group_name',
        'akahu_category_id',
        'akahu_category_name',
        'akahu_category_group_id',
        'akahu_category_group_name',
      )
      .orderBy('akahu_id')

    // Non-vacuity: without this, an all-NULL legacy column would make the
    // comparison below pass with nothing compared.
    expect(rows.filter((r) => r.category_id !== null).length).toBeGreaterThan(0)

    // Whole-set comparison: a mismatch shows the row's akahu_id in the diff.
    expect(
      rows.map((r) => ({
        akahu_id: r.akahu_id,
        id: r.akahu_category_id,
        name: r.akahu_category_name,
        group_id: r.akahu_category_group_id,
        group_name: r.akahu_category_group_name,
      })),
    ).toEqual(
      rows.map((r) => ({
        akahu_id: r.akahu_id,
        id: r.category_id,
        name: r.category_name,
        group_id: r.category_group_id,
        group_name: r.category_group_name,
      })),
    )
  })

  it('reads a private JSON dump when DIVVY_SEED_TRANSACTIONS points at one', async () => {
    const path = Path.join(scratch, 'private.json')
    await writeFile(
      path,
      JSON.stringify({ items: [akahuTxn('a1', -1.5), akahuTxn('a2', 2)] }),
    )
    process.env.DIVVY_SEED_TRANSACTIONS = path

    await db.seed.run()

    const ids = (await db('transactions').select('akahu_id')).map(
      (r) => r.akahu_id,
    )
    expect(ids.sort()).toEqual(['a1', 'a2'])
  })

  it('reads a private JS module exporting `spending`, the old private file shape', async () => {
    const path = Path.join(scratch, 'spending.js')
    await writeFile(
      path,
      `export const spending = ${JSON.stringify({ items: [akahuTxn('m1', -3)] })}\n`,
    )
    process.env.DIVVY_SEED_TRANSACTIONS = path

    await db.seed.run()

    const ids = (await db('transactions').select('akahu_id')).map(
      (r) => r.akahu_id,
    )
    expect(ids).toEqual(['m1'])
  })

  it('refuses a source with no items array', async () => {
    const path = Path.join(scratch, 'empty.json')
    await writeFile(path, JSON.stringify({ success: true }))
    process.env.DIVVY_SEED_TRANSACTIONS = path

    await expect(db.seed.run()).rejects.toThrow(/has no "items" array/)
  })
})

describe('transactions fixture', () => {
  // Guards against real bank data being pasted into the committed fixture:
  // every identifier must be one of the synthetic fixture ids.
  it('is synthetic: every id is a fixture id', () => {
    expect(fixture.items.length).toBeGreaterThan(0)
    for (const t of fixture.items) {
      expect(t._id).toMatch(/^trans_fixture_\d{3}$/)
      expect(t._account).toMatch(/^acc_fixture_/)
      expect(t._user).toBe('user_fixture')
      expect(t._connection).toBe('conn_fixture_bank')
      if (t.merchant) {
        expect(t.merchant._id).toMatch(/^merchant_fixture_/)
        expect(t.merchant.website).toMatch(/^https:\/\/example\.com\//)
      }
    }
  })

  it('has amounts with at most two decimal places', () => {
    for (const t of fixture.items) {
      expect(Math.abs(t.amount * 100 - Math.round(t.amount * 100))).toBeLessThan(1e-6)
    }
  })
})

describe('transactions seed, edge cases', () => {
  it('converts a zero balance to 0 cents, not null, and converts conversion amounts', async () => {
    const path = Path.join(scratch, 'edge.json')
    await writeFile(
      path,
      JSON.stringify({
        items: [
          akahuTxn('zero', -4.35, { balance: 0, meta: { conversion_amount: 12.34 } }),
          akahuTxn('none', 1),
        ],
      }),
    )
    process.env.DIVVY_SEED_TRANSACTIONS = path

    await db.seed.run()

    expect(
      await db('transactions')
        .select('akahu_id', 'amount_cents', 'balance_cents', 'conversion_amount_cents')
        .orderBy('akahu_id'),
    ).toEqual([
      { akahu_id: 'none', amount_cents: 100, balance_cents: null, conversion_amount_cents: null },
      { akahu_id: 'zero', amount_cents: -435, balance_cents: 0, conversion_amount_cents: 1234 },
    ])
  })

  it('reads a private JS module with a default export', async () => {
    const path = Path.join(scratch, 'default.js')
    await writeFile(
      path,
      `export default ${JSON.stringify({ items: [akahuTxn('d1', -3)] })}\n`,
    )
    process.env.DIVVY_SEED_TRANSACTIONS = path

    await db.seed.run()

    expect(await db('transactions').pluck('akahu_id')).toEqual(['d1'])
  })

  it('replaces rather than duplicates when run twice', async () => {
    await db.seed.run()
    await db.seed.run()

    const [{ n }] = await db('transactions').count({ n: '*' })
    expect(n).toBe(fixture.items.length)
  })
})
