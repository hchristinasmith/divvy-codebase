import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import knex, { Knex } from 'knex'
import config from '../../knexfile.js'
import fixture from '../../fixtures/transactions.json'
import { dollarsToCents, sumCents } from '../../../../shared/money.ts'

const MIGRATION = '20261023120000_money_as_cents.js'

let db: Knex

// Runs every migration before this one, so tests can write rows in the
// pre-cents (float dollar) schema and then step this migration up or down.
async function migrateToJustBefore() {
  const [, pending] = (await db.migrate.list()) as [
    unknown,
    { file: string }[],
  ]
  const index = pending.findIndex((m) => m.file === MIGRATION)
  expect(index).toBeGreaterThan(0)
  for (let i = 0; i < index; i++) await db.migrate.up()
}

async function columns(table: string): Promise<Record<string, string>> {
  const info = (await db.raw(`PRAGMA table_info(${table})`)) as {
    name: string
    type: string
    notnull: number
  }[]
  return Object.fromEntries(
    info.map((c) => [c.name, `${c.type.toLowerCase()}${c.notnull ? ' not null' : ''}`]),
  )
}

// What the old schema held for the fixture: float dollars, as the seed wrote
// them before this migration.
function legacyRows() {
  return fixture.items.map((t) => ({
    akahu_id: t._id,
    description: t.description,
    category_group_name: t.category?.groups.personal_finance.name ?? null,
    amount: t.amount,
    balance: t.balance,
    conversion_amount: null,
  }))
}

function groupTotalsCents(rows: { group: string | null; cents: number }[]) {
  const totals: Record<string, number[]> = {}
  for (const r of rows) (totals[r.group ?? 'Uncategorized'] ??= []).push(r.cents)
  return Object.fromEntries(
    Object.entries(totals).map(([g, cs]) => [g, sumCents(cs)]),
  )
}

beforeEach(async () => {
  db = knex(config.test)
  await migrateToJustBefore()
})

afterEach(async () => {
  await db.destroy()
})

describe(MIGRATION, () => {
  it('replaces every float money column with an integer cents column', async () => {
    await db.migrate.up()

    const txn = await columns('transactions')
    expect(txn).toMatchObject({
      amount_cents: 'integer',
      balance_cents: 'integer',
      conversion_amount_cents: 'integer',
    })
    expect(Object.keys(txn)).not.toContain('amount')
    expect(Object.keys(txn)).not.toContain('balance')
    expect(Object.keys(txn)).not.toContain('conversion_amount')

    const targets = await columns('targets')
    expect(targets.target_amount_cents).toBe('integer not null')
    expect(Object.keys(targets)).not.toContain('target_amount')

    // No money column may stay a float. conversion_rate is a rate, and
    // conversion_currency is a pre-existing mistyped currency code (flagged,
    // not money).
    const floats = Object.entries(txn)
      .filter(([, type]) => type.startsWith('float') || type.startsWith('real'))
      .map(([name]) => name)
      .sort()
    expect(floats).toEqual(['conversion_currency', 'conversion_rate'])
  })

  it('backfills cents from the fixture dollars and keeps the totals', async () => {
    await db.batchInsert('transactions', legacyRows(), 25)

    await db.migrate.up()

    const rows = await db('transactions')
      .select('akahu_id', 'amount_cents', 'balance_cents', 'category_group_name')
      .orderBy('akahu_id')
    const expected = [...fixture.items].sort((a, b) => a._id.localeCompare(b._id))
    expect(rows.map((r) => [r.akahu_id, r.amount_cents, r.balance_cents])).toEqual(
      expected.map((t) => [t._id, dollarsToCents(t.amount), dollarsToCents(t.balance)]),
    )

    // The Dashboard's spending breakdown totals expenses per category group;
    // the same totals must come out of the cents column.
    const expenses = fixture.items.filter((t) => t.amount < 0)
    expect(
      groupTotalsCents(
        rows
          .filter((r) => r.amount_cents < 0)
          .map((r) => ({ group: r.category_group_name, cents: -r.amount_cents })),
      ),
    ).toEqual(
      groupTotalsCents(
        expenses.map((t) => ({
          group: t.category?.groups.personal_finance.name ?? null,
          cents: -dollarsToCents(t.amount),
        })),
      ),
    )
    expect(sumCents(rows.map((r) => r.amount_cents))).toBe(
      sumCents(fixture.items.map((t) => dollarsToCents(t.amount))),
    )
  })

  it('rounds float noise onto the intended cent and keeps nulls null', async () => {
    await db('transactions').insert([
      { akahu_id: 'noise', amount: 0.1 + 0.2, balance: -64.37, conversion_amount: 12.34 },
      { akahu_id: 'nulls', amount: -5, balance: null, conversion_amount: null },
    ])

    await db.migrate.up()

    const rows = await db('transactions')
      .select('akahu_id', 'amount_cents', 'balance_cents', 'conversion_amount_cents')
      .orderBy('akahu_id')
    expect(rows).toEqual([
      { akahu_id: 'noise', amount_cents: 30, balance_cents: -6437, conversion_amount_cents: 1234 },
      { akahu_id: 'nulls', amount_cents: -500, balance_cents: null, conversion_amount_cents: null },
    ])
  })

  it('converts budget targets and keeps their constraints', async () => {
    await db('users').insert({ id: 1, email: 'fixture@example.com', password: 'x' })
    await db('targets').insert({ user_id: 1, category: 'Food', target_amount: 500.1, period: 'monthly' })

    await db.migrate.up()

    expect(await db('targets').pluck('target_amount_cents')).toEqual([50010])
    // unique (user_id, category, period) survived the table rebuild
    await expect(
      db('targets').insert({ user_id: 1, category: 'Food', target_amount_cents: 1, period: 'monthly' }),
    ).rejects.toThrow(/UNIQUE/)
    // NOT NULL survived
    await expect(
      db('targets').insert({ user_id: 1, category: 'Rent', period: 'monthly' }),
    ).rejects.toThrow(/NOT NULL/)
    // the foreign key to users survived
    await expect(
      db('targets').insert({ user_id: 99, category: 'Rent', target_amount_cents: 1, period: 'monthly' }),
    ).rejects.toThrow(/FOREIGN KEY/)
  })

  it('keeps akahu_id unique on transactions', async () => {
    await db.migrate.up()
    await db('transactions').insert({ akahu_id: 'dup', amount_cents: 1 })
    await expect(
      db('transactions').insert({ akahu_id: 'dup', amount_cents: 2 }),
    ).rejects.toThrow(/UNIQUE/)
  })

  it('rolls back to the same dollar values', async () => {
    await db.batchInsert('transactions', legacyRows(), 25)
    await db('users').insert({ id: 1, email: 'fixture@example.com', password: 'x' })
    await db('targets').insert({ user_id: 1, category: 'Food', target_amount: 500.1, period: 'monthly' })
    const before = await db('transactions').select('akahu_id', 'amount', 'balance').orderBy('akahu_id')

    await db.migrate.up()
    await db.migrate.down()

    expect(await db('transactions').select('akahu_id', 'amount', 'balance').orderBy('akahu_id')).toEqual(before)
    expect(await db('targets').pluck('target_amount')).toEqual([500.1])
    expect((await columns('targets')).target_amount).toBe('float not null')
  })
})
