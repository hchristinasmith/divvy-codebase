import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import connection from '../connection.ts'
import { assertInMemory } from '../../test-utils/app.ts'
import {
  BillsDataError,
  createBill,
  deleteBill,
  isPaymentConflict,
  listBills,
  markBillPaid,
  updateBill,
  validateBillPatch,
  validateCreateBill,
  type NewBill,
} from '../bills.ts'
import { billOccurrencesThrough } from '../overview.ts'
import type { BillRepeat } from '../../../models/planning.ts'
import type { BillResponse } from '../../../shared/contracts.ts'

// The bills data module (prd-02, issue #49). Each test starts from an empty,
// freshly migrated in-memory database and inserts the rows it needs. The
// clock is passed in: 23:30 UTC on Tuesday 27 October 2026 is 12:30 NZDT on
// Wednesday the 28th, so with payday on Tuesdays (the default) the next
// payday is 2026-11-03. Every value is invented.

beforeEach(async () => {
  assertInMemory(connection)
  await connection.migrate.rollback(undefined, true)
  await connection.migrate.latest()
})

afterAll(async () => {
  await connection.destroy()
})

const NOW = new Date('2026-10-27T23:30:00.000Z')
const NOW_ISO = NOW.toISOString()
const NEXT_PAYDAY = '2026-11-03'
const STAMP = '2026-10-20T00:00:00.000Z'
const SENTINEL = 'zz-sentinel-4b7e'

type Row = Record<string, unknown>

const ERR = {
  body: 'Body must be a JSON object',
  unknown: 'Unknown field in body',
  scope: 'scope must be personal or strawb',
  name: 'name must be 1 to 255 characters',
  amountCents:
    'amountCents must be a whole number of cents from 1 to 1000000000',
  firstDueDate:
    'firstDueDate must be a YYYY-MM-DD date from 2000-01-01 to 2099-12-31',
  repeat: 'repeat must be none, weekly, monthly or yearly',
  accountId: 'accountId must be an account id as a string, or null',
}

const VALID = {
  scope: 'personal',
  name: 'Invented power',
  amountCents: 4500,
  firstDueDate: '2026-11-02',
  repeat: 'monthly',
}

const BILL_ROW_KEYS = [
  'id',
  'scope',
  'name',
  'amount_cents',
  'repeat',
  'first_due_date',
  'account_id',
  'created_at',
  'updated_at',
]
const PAYMENT_ROW_KEYS = [
  'id',
  'bill_id',
  'due_date',
  'amount_cents',
  'paid_at',
]

let accountSeq = 0

// An Akahu account unless `fields` says `source: 'xero'`, which has no
// Akahu id.
async function insertAccount(fields: Row): Promise<number> {
  accountSeq += 1
  const [id]: number[] = await connection('accounts').insert({
    source: 'akahu',
    akahu_id: fields.source === 'xero' ? null : `acc_invented_${accountSeq}`,
    scope: 'personal',
    name: 'Invented account',
    balance_cents: 10000,
    created_at: STAMP,
    updated_at: STAMP,
    ...fields,
  })
  return id
}

async function insertBill(fields: Row = {}): Promise<number> {
  const [id]: number[] = await connection('bills').insert({
    scope: 'personal',
    name: 'Invented bill',
    amount_cents: 1000,
    repeat: 'weekly',
    first_due_date: '2026-10-21',
    created_at: STAMP,
    updated_at: STAMP,
    ...fields,
  })
  return id
}

function insertPayments(
  billId: number,
  dueDates: readonly string[],
  fields: Row = {},
) {
  if (dueDates.length === 0) return Promise.resolve()
  return connection('bill_payments').insert(
    dueDates.map((due_date) => ({
      bill_id: billId,
      due_date,
      amount_cents: 1000,
      paid_at: STAMP,
      ...fields,
    })),
  )
}

async function snapshot() {
  return {
    bills: await connection('bills').select().orderBy('id'),
    payments: await connection('bill_payments').select().orderBy('id'),
  }
}

async function itemFor(id: number, now = NOW): Promise<BillResponse> {
  const { items } = await listBills('all', now)
  const item = items.find((i) => i.id === String(id))
  if (item === undefined) throw new Error(`bill ${id} not listed`)
  return item
}

function newBill(fields: Partial<NewBill> = {}): NewBill {
  return {
    scope: 'personal',
    name: 'Invented bill',
    amountCents: 1000,
    firstDueDate: '2026-10-21',
    repeat: 'weekly',
    accountId: null,
    ...fields,
  }
}

// The weekly anchor with exactly 1000 occurrences through the next payday:
// 11-03 is occurrence 999 when the anchor is 999 weeks earlier.
const ANCHOR_1000 = new Date(Date.UTC(2026, 10, 3) - 6993 * 86400000)
  .toISOString()
  .slice(0, 10)
const ANCHOR_1001 = new Date(Date.UTC(2026, 10, 3) - 7000 * 86400000)
  .toISOString()
  .slice(0, 10)

describe('the 1000-occurrence anchors', () => {
  it('are worked out right', () => {
    const weekly = (first_due_date: string) =>
      billOccurrencesThrough({ repeat: 'weekly', first_due_date }, NEXT_PAYDAY)
    expect(weekly(ANCHOR_1000)).toHaveLength(1000)
    expect(weekly(ANCHOR_1000)[999]).toBe(NEXT_PAYDAY)
    expect(weekly(ANCHOR_1001)).toHaveLength(1001)
  })
})

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe('validateCreateBill', () => {
  it('parses a valid body, trimming the name; an omitted accountId is null', () => {
    const result = validateCreateBill({ ...VALID, name: '  Invented power  ' })

    expect(result).toStrictEqual({
      bill: { ...VALID, name: 'Invented power', accountId: null },
    })
  })

  it('parses accountId from a string id', () => {
    expect(validateCreateBill({ ...VALID, accountId: '3' })).toStrictEqual({
      bill: { ...VALID, accountId: 3 },
    })
    expect(validateCreateBill({ ...VALID, accountId: null })).toStrictEqual({
      bill: { ...VALID, accountId: null },
    })
  })

  it.each([null, [], 'a bill', 5, true])('refuses a body of %j', (body) => {
    expect(validateCreateBill(body)).toStrictEqual({ error: ERR.body })
  })

  it('refuses an unknown key, even beside valid fields', () => {
    expect(validateCreateBill({ ...VALID, paid: true })).toStrictEqual({
      error: ERR.unknown,
    })
    expect(
      validateCreateBill(JSON.parse(`{"__proto__": {}, "scope": "personal"}`)),
    ).toStrictEqual({ error: ERR.unknown })
  })

  it.each(['scope', 'name', 'amountCents', 'firstDueDate', 'repeat'] as const)(
    'refuses a body missing %s with that field’s message',
    (field) => {
      const body: Row = { ...VALID }
      delete body[field]
      expect(validateCreateBill(body)).toStrictEqual({ error: ERR[field] })
    },
  )

  const BAD: [keyof typeof ERR, unknown][] = [
    ['scope', 'all'],
    ['scope', 'Personal'],
    ['scope', null],
    ['scope', 1],
    ['name', null],
    ['name', 5],
    ['name', ''],
    ['name', '   '],
    ['name', 'a'.repeat(256)],
    ['name', ` ${'a'.repeat(256)} `],
    ['amountCents', '1000'],
    ['amountCents', 10.5],
    ['amountCents', 0],
    ['amountCents', -1],
    ['amountCents', 1_000_000_001],
    ['amountCents', null],
    ['firstDueDate', '2026-02-30'],
    ['firstDueDate', '2027-02-29'],
    ['firstDueDate', '2026-2-3'],
    ['firstDueDate', '2026-13-01'],
    ['firstDueDate', '2026-00-10'],
    ['firstDueDate', '1999-12-31'],
    ['firstDueDate', '2100-01-01'],
    ['firstDueDate', '2026-10-01T00:00:00.000Z'],
    ['firstDueDate', 20261001],
    ['firstDueDate', null],
    ['repeat', 'daily'],
    ['repeat', 'Weekly'],
    ['repeat', ''],
    ['repeat', null],
    ['accountId', 3],
    ['accountId', '01'],
    ['accountId', '0'],
    ['accountId', ''],
    ['accountId', '-1'],
    ['accountId', '1e3'],
    ['accountId', ' 3'],
    ['accountId', '9007199254740993'],
    ['accountId', true],
  ]

  it.each(BAD)('refuses %s = %j', (field, value) => {
    expect(validateCreateBill({ ...VALID, [field]: value })).toStrictEqual({
      error: ERR[field],
    })
  })

  it.each([
    ['name', 'a'.repeat(255), 'a'.repeat(255)],
    ['name', ` ${'a'.repeat(255)} `, 'a'.repeat(255)],
    ['name', 'x', 'x'],
    ['amountCents', 1, 1],
    ['amountCents', 1_000_000_000, 1_000_000_000],
    ['firstDueDate', '2000-01-01', '2000-01-01'],
    ['firstDueDate', '2099-12-31', '2099-12-31'],
    ['firstDueDate', '2028-02-29', '2028-02-29'],
    ['repeat', 'none', 'none'],
    ['repeat', 'weekly', 'weekly'],
    ['repeat', 'yearly', 'yearly'],
    ['scope', 'strawb', 'strawb'],
  ] as const)('accepts %s = %j at its boundary', (field, sent, parsed) => {
    const result = validateCreateBill({ ...VALID, [field]: sent })
    expect(result).toStrictEqual({
      bill: { ...VALID, accountId: null, [field]: parsed },
    })
  })

  it('checks fields in a fixed order, not the body’s key order', () => {
    const result = validateCreateBill({
      accountId: 7,
      repeat: 'daily',
      firstDueDate: 'soon',
      amountCents: 0,
      name: '',
      scope: 'all',
    })
    expect(result).toStrictEqual({ error: ERR.scope })

    // accountId comes first in the body and is wrong too.
    const later = validateCreateBill({
      accountId: 7,
      ...VALID,
      repeat: 'daily',
      firstDueDate: 'soon',
    })
    expect(later).toStrictEqual({ error: ERR.firstDueDate })
  })

  it('never echoes what was sent', () => {
    for (const field of Object.keys(ERR)) {
      for (const result of [
        validateCreateBill({ ...VALID, [field]: SENTINEL }),
        validateCreateBill({ ...VALID, [SENTINEL]: 1 }),
        validateBillPatch({ [field]: SENTINEL }),
        validateBillPatch({ [SENTINEL]: 1 }),
      ]) {
        if ('error' in result) expect(result.error).not.toContain(SENTINEL)
      }
    }
  })
})

describe('validateBillPatch', () => {
  it('accepts {} as an empty patch', () => {
    expect(validateBillPatch({})).toStrictEqual({ patch: {} })
  })

  it('carries only the fields sent', () => {
    const result = validateBillPatch({ name: ' Renamed ', accountId: null })

    expect(result).toStrictEqual({
      patch: { name: 'Renamed', accountId: null },
    })
    if (!('patch' in result)) throw new Error('refused')
    expect(Object.keys(result.patch).sort()).toEqual(['accountId', 'name'])
  })

  it('parses every field', () => {
    expect(validateBillPatch({ ...VALID, accountId: '12' })).toStrictEqual({
      patch: { ...VALID, accountId: 12 },
    })
  })

  it.each([null, [], 'x'])('refuses a body of %j', (body) => {
    expect(validateBillPatch(body)).toStrictEqual({ error: ERR.body })
  })

  it('refuses an unknown key', () => {
    expect(validateBillPatch({ id: '1' })).toStrictEqual({
      error: ERR.unknown,
    })
  })

  it.each([
    ['scope', 'all'],
    ['name', '  '],
    ['amountCents', '1000'],
    ['firstDueDate', '2026-02-30'],
    ['repeat', 'daily'],
    ['accountId', 3],
  ] as const)('refuses %s = %j', (field, value) => {
    expect(validateBillPatch({ [field]: value })).toStrictEqual({
      error: ERR[field],
    })
  })
})

// ---------------------------------------------------------------------------
// The current occurrence
// ---------------------------------------------------------------------------

describe('the current occurrence', () => {
  async function current(fields: Row, paid: string[] = [], paidFields?: Row) {
    const id = await insertBill(fields)
    await insertPayments(id, paid, paidFields)
    return itemFor(id)
  }

  it.each(['weekly', 'monthly', 'yearly', 'none'])(
    'an unpaid %s bill is due on its anchor',
    async (repeat) => {
      const item = await current({ repeat, first_due_date: '2026-10-21' })
      expect(item).toMatchObject({
        dueDate: '2026-10-21',
        paid: false,
        paidAt: null,
      })
    },
  )

  it('a paid one-off shows its anchor and the payment', async () => {
    const item = await current(
      { repeat: 'none', first_due_date: '2026-10-20' },
      ['2026-10-20'],
      { paid_at: '2026-10-21T01:02:03.000Z' },
    )
    expect(item).toMatchObject({
      dueDate: '2026-10-20',
      paid: true,
      paidAt: '2026-10-21T01:02:03.000Z',
    })
  })

  it('a repeating bill paid through today moves to its next cycle, never shown paid', async () => {
    const item = await current({ first_due_date: '2026-10-14' }, [
      '2026-10-14',
      '2026-10-21',
      '2026-10-28',
    ])
    expect(item).toMatchObject({
      dueDate: '2026-11-04',
      paid: false,
      paidAt: null,
    })
  })

  it('an overdue bill shows its earliest unpaid occurrence', async () => {
    const item = await current({ first_due_date: '2026-10-07' }, ['2026-10-14'])
    expect(item.dueDate).toBe('2026-10-07')
  })

  it.each([
    ['monthly', '2026-01-31', ['2026-01-31'], '2026-02-28'],
    ['monthly', '2026-01-31', ['2026-01-31', '2026-02-28'], '2026-03-31'],
    ['yearly', '2028-02-29', ['2028-02-29'], '2029-02-28'],
    [
      'yearly',
      '2028-02-29',
      ['2028-02-29', '2029-02-28', '2030-02-28'],
      '2031-02-28',
    ],
    [
      'yearly',
      '2028-02-29',
      ['2028-02-29', '2029-02-28', '2030-02-28', '2031-02-28'],
      '2032-02-29',
    ],
    [
      'weekly',
      '2026-12-02',
      ['2026-12-02', '2026-12-09', '2026-12-16', '2026-12-23', '2026-12-30'],
      '2027-01-06',
    ],
    ['yearly', '2026-12-31', ['2026-12-31'], '2027-12-31'],
    ['monthly', '2026-12-15', ['2026-12-15'], '2027-01-15'],
  ])('%s from %s, paid %j: due %s', async (repeat, first, paid, due) => {
    const item = await current({ repeat, first_due_date: first }, paid)
    expect(item.dueDate).toBe(due)
  })

  describe('agrees with the full schedule after k paid occurrences', () => {
    const ANCHORS = [
      '2026-01-31',
      '2028-02-29',
      '2026-12-31',
      '2027-01-01',
      '2026-10-15',
    ]

    it.each(
      ANCHORS.flatMap((a) =>
        ['weekly', 'monthly', 'yearly'].map((r) => [a, r]),
      ),
    )('from %s, %s', async (first, repeat) => {
      const schedule = billOccurrencesThrough(
        { repeat: repeat as BillRepeat, first_due_date: first },
        '2099-12-31',
      )
      const ids: number[] = []
      for (let k = 0; k <= 5; k += 1) {
        const id = await insertBill({ repeat, first_due_date: first })
        await insertPayments(id, schedule.slice(0, k))
        ids.push(id)
      }
      const { items } = await listBills('all', NOW)
      for (let k = 0; k <= 5; k += 1) {
        const item = items.find((i) => i.id === String(ids[k]))
        expect(item?.dueDate, `k = ${k}`).toBe(schedule[k])
        expect(item?.paid).toBe(false)
      }
    })

    it.each(ANCHORS)('from %s, none', async (first) => {
      const unpaid = await insertBill({ repeat: 'none', first_due_date: first })
      const paid = await insertBill({ repeat: 'none', first_due_date: first })
      await insertPayments(paid, [first])

      expect(await itemFor(unpaid)).toMatchObject({
        dueDate: first,
        paid: false,
      })
      expect(await itemFor(paid)).toMatchObject({ dueDate: first, paid: true })
    })
  })
})

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------

describe('listBills', () => {
  it('answers an empty list with every key', async () => {
    const body = await listBills('all', NOW)

    expect(Object.keys(body).sort()).toEqual(
      [
        'dueBeforePaydayCents',
        'items',
        'nextBill',
        'paidThisMonthCents',
      ].sort(),
    )
    expect(body).toStrictEqual({
      items: [],
      dueBeforePaydayCents: 0,
      nextBill: null,
      paidThisMonthCents: 0,
    })
  })

  it('maps a bill field by field, with its account’s name', async () => {
    const accountId = await insertAccount({ name: 'Invented everyday' })
    const id = await insertBill({
      name: 'Invented rent',
      amount_cents: 32100,
      repeat: 'monthly',
      first_due_date: '2026-11-01',
      account_id: accountId,
    })

    const item = await itemFor(id)

    expect(Object.keys(item).sort()).toEqual(
      [
        'accountName',
        'amountCents',
        'dueDate',
        'firstDueDate',
        'id',
        'name',
        'paid',
        'paidAt',
        'repeat',
        'scope',
      ].sort(),
    )
    expect(item).toStrictEqual({
      id: String(id),
      scope: 'personal',
      name: 'Invented rent',
      amountCents: 32100,
      dueDate: '2026-11-01',
      repeat: 'monthly',
      firstDueDate: '2026-11-01',
      paid: false,
      paidAt: null,
      accountName: 'Invented everyday',
    })
  })

  it('shows no account name once the account is deleted', async () => {
    const accountId = await insertAccount({})
    const id = await insertBill({ account_id: accountId })
    await connection('accounts').where({ id: accountId }).delete()

    expect((await itemFor(id)).accountName).toBeNull()
  })

  it('orders unpaid first, then by due date, then by numeric id; nextBill is the first unpaid', async () => {
    await insertBill({ id: 2, first_due_date: '2026-10-21' })
    await insertBill({ id: 10, first_due_date: '2026-10-21' })
    await insertBill({ id: 9, first_due_date: '2026-10-14' })
    await insertBill({ id: 3, repeat: 'none', first_due_date: '2026-10-01' })
    await insertPayments(3, ['2026-10-01'])

    const body = await listBills('all', NOW)

    expect(body.items.map((i) => i.id)).toEqual(['9', '2', '10', '3'])
    expect(body.nextBill).toStrictEqual(body.items[0])
  })

  it('has no nextBill when every bill is paid', async () => {
    const id = await insertBill({
      repeat: 'none',
      first_due_date: '2026-10-01',
    })
    await insertPayments(id, ['2026-10-01'])

    const body = await listBills('all', NOW)
    expect(body.items).toHaveLength(1)
    expect(body.nextBill).toBeNull()
  })

  it('writes nothing', async () => {
    const id = await insertBill({ first_due_date: '2026-10-07' })
    await insertPayments(id, ['2026-10-07'])
    const before = await snapshot()

    await listBills('all', NOW)

    expect(await snapshot()).toStrictEqual(before)
  })

  describe('dueBeforePaydayCents', () => {
    it('counts every unpaid occurrence of an overdue weekly bill; a payment removes exactly one', async () => {
      // 10-07, 10-14, 10-21 and 10-28; 11-04 is after the next payday.
      const id = await insertBill({
        amount_cents: 2500,
        first_due_date: '2026-10-07',
      })

      expect((await listBills('all', NOW)).dueBeforePaydayCents).toBe(10000)

      await insertPayments(id, ['2026-10-14'])
      expect((await listBills('all', NOW)).dueBeforePaydayCents).toBe(7500)
    })

    it('counts a bill due on the next payday and not one due the day after', async () => {
      await insertBill({
        repeat: 'none',
        amount_cents: 700,
        first_due_date: NEXT_PAYDAY,
      })
      await insertBill({
        repeat: 'none',
        amount_cents: 900,
        first_due_date: '2026-11-04',
      })

      expect((await listBills('all', NOW)).dueBeforePaydayCents).toBe(700)
    })

    it('counts only the scope asked for', async () => {
      await insertBill({
        scope: 'personal',
        amount_cents: 1100,
        first_due_date: '2026-10-30',
        repeat: 'none',
      })
      await insertBill({
        scope: 'strawb',
        amount_cents: 2200,
        first_due_date: '2026-10-30',
        repeat: 'none',
      })

      const totals = await Promise.all(
        (['all', 'personal', 'strawb'] as const).map(
          async (scope) => (await listBills(scope, NOW)).dueBeforePaydayCents,
        ),
      )
      expect(totals).toEqual([3300, 1100, 2200])
      for (const cents of totals) expect(Number.isSafeInteger(cents)).toBe(true)
    })

    it('reads the payday weekday from settings', async () => {
      await insertBill({
        repeat: 'none',
        amount_cents: 900,
        first_due_date: '2026-11-04',
      })
      await connection('settings').insert({
        key: 'payday_weekday',
        value: '3',
        updated_at: STAMP,
      })

      // Wednesday payday: today is payday, so the next one is a week out.
      expect((await listBills('all', NOW)).dueBeforePaydayCents).toBe(900)
    })

    it('a stored payday that is not valid reads as the default Tuesday', async () => {
      await insertBill({
        repeat: 'none',
        amount_cents: 700,
        first_due_date: NEXT_PAYDAY,
      })
      await insertBill({
        repeat: 'none',
        amount_cents: 900,
        first_due_date: '2026-11-04',
      })
      await connection('settings').insert({
        key: 'payday_weekday',
        value: 'x',
        updated_at: STAMP,
      })

      expect((await listBills('all', NOW)).dueBeforePaydayCents).toBe(700)
    })
  })

  describe('paidThisMonthCents', () => {
    // A one-off paid once, at `paid_at`, for `amount_cents`.
    async function paidAt(paid_at: string, amount_cents: number) {
      const id = await insertBill({
        repeat: 'none',
        first_due_date: '2026-10-01',
      })
      await insertPayments(id, ['2026-10-01'], { paid_at, amount_cents })
    }

    it('counts by the Pacific/Auckland month of paid_at (NZDT is UTC+13)', async () => {
      await paidAt('2026-09-30T10:59:59.000Z', 100) // 30 September, 23:59:59
      await paidAt('2026-09-30T11:00:00.000Z', 1) // 1 October, 00:00
      await paidAt('2026-10-31T10:59:59.999Z', 20) // 31 October, 23:59:59.999
      await paidAt('2026-10-31T11:00:00.000Z', 4000) // 1 November, 00:00

      expect((await listBills('all', NOW)).paidThisMonthCents).toBe(21)
      expect(
        (await listBills('all', new Date('2026-11-01T00:00:00.000Z')))
          .paidThisMonthCents,
      ).toBe(4000)
      expect(
        (await listBills('all', new Date('2026-09-15T00:00:00.000Z')))
          .paidThisMonthCents,
      ).toBe(100)
    })

    it('sums the amount paid, not the bill’s amount now', async () => {
      const id = await insertBill({
        amount_cents: 5000,
        repeat: 'none',
        first_due_date: '2026-10-01',
      })
      await insertPayments(id, ['2026-10-01'], {
        amount_cents: 1234,
        paid_at: '2026-10-02T00:00:00.000Z',
      })

      expect((await listBills('all', NOW)).paidThisMonthCents).toBe(1234)
    })

    it('counts a payment made ahead by when it was paid', async () => {
      const id = await insertBill({ first_due_date: '2026-12-02' })
      await insertPayments(id, ['2026-12-02'], {
        amount_cents: 300,
        paid_at: '2026-10-25T00:00:00.000Z',
      })

      expect((await listBills('all', NOW)).paidThisMonthCents).toBe(300)
    })

    it('counts only the scope asked for', async () => {
      const personal = await insertBill({ scope: 'personal' })
      const strawb = await insertBill({ scope: 'strawb' })
      await insertPayments(personal, ['2026-10-21'], {
        amount_cents: 11,
        paid_at: '2026-10-22T00:00:00.000Z',
      })
      await insertPayments(strawb, ['2026-10-21'], {
        amount_cents: 22,
        paid_at: '2026-10-22T00:00:00.000Z',
      })

      expect((await listBills('personal', NOW)).paidThisMonthCents).toBe(11)
      expect((await listBills('strawb', NOW)).paidThisMonthCents).toBe(22)
      expect((await listBills('all', NOW)).paidThisMonthCents).toBe(33)
    })

    it('refuses a payment whose paid_at is not a time', async () => {
      const id = await insertBill({})
      await insertPayments(id, ['2026-10-21'], { paid_at: SENTINEL })

      const read = listBills('all', NOW)
      await expect(read).rejects.toBeInstanceOf(BillsDataError)
      await expect(read).rejects.toThrow('a stored bill is not valid')
    })
  })
})

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

describe('createBill', () => {
  it('stores the bill and answers it resolved', async () => {
    const accountId = await insertAccount({ name: 'Invented everyday' })

    const result = await createBill(
      newBill({ name: 'Invented water', amountCents: 2600, accountId }),
      NOW,
    )

    if (!result.ok) throw new Error(result.refusal)
    const rows = await connection('bills').select()
    expect(rows).toHaveLength(1)
    expect(Object.keys(rows[0]).sort()).toEqual([...BILL_ROW_KEYS].sort())
    expect(rows[0]).toStrictEqual({
      id: Number(result.value.id),
      scope: 'personal',
      name: 'Invented water',
      amount_cents: 2600,
      repeat: 'weekly',
      first_due_date: '2026-10-21',
      account_id: accountId,
      created_at: NOW_ISO,
      updated_at: NOW_ISO,
    })
    expect(result.value).toMatchObject({
      name: 'Invented water',
      dueDate: '2026-10-21',
      accountName: 'Invented everyday',
    })
  })

  it.each([
    ['no such account', 'missing', 'account_not_found'],
    ['a Xero account', 'xero', 'account_not_found'],
    ['an account in the other scope', 'strawb', 'account_scope_mismatch'],
  ] as const)('refuses %s, writing nothing', async (_why, kind, refusal) => {
    const xero = await insertAccount({ source: 'xero', scope: 'personal' })
    const strawb = await insertAccount({ scope: 'strawb' })
    const accountId = kind === 'missing' ? 999 : kind === 'xero' ? xero : strawb

    const result = await createBill(newBill({ accountId }), NOW)

    expect(result).toStrictEqual({ ok: false, refusal })
    expect(await connection('bills').select()).toStrictEqual([])
  })

  it('takes a schedule with 1000 unpaid occurrences and refuses 1001', async () => {
    const at1000 = await createBill(newBill({ firstDueDate: ANCHOR_1000 }), NOW)
    expect(at1000.ok).toBe(true)
    const before = await snapshot()

    const at1001 = await createBill(newBill({ firstDueDate: ANCHOR_1001 }), NOW)

    expect(at1001).toStrictEqual({ ok: false, refusal: 'too_many_unpaid' })
    expect(await snapshot()).toStrictEqual(before)
  })

  it('refuses the account before the schedule', async () => {
    const result = await createBill(
      newBill({ firstDueDate: ANCHOR_1001, accountId: 999 }),
      NOW,
    )
    expect(result).toStrictEqual({ ok: false, refusal: 'account_not_found' })
  })
})

describe('updateBill', () => {
  it('refuses a bill that does not exist', async () => {
    expect(await updateBill(999, { name: 'x' }, NOW)).toStrictEqual({
      ok: false,
      refusal: 'not_found',
    })
    expect(await updateBill(999, {}, NOW)).toStrictEqual({
      ok: false,
      refusal: 'not_found',
    })
  })

  it('answers {} with the bill unchanged and leaves updated_at alone', async () => {
    const id = await insertBill({})
    const before = await snapshot()

    const result = await updateBill(id, {}, NOW)

    expect(result).toStrictEqual({ ok: true, value: await itemFor(id) })
    expect(await snapshot()).toStrictEqual(before)
  })

  it('applies a real change and bumps updated_at', async () => {
    const id = await insertBill({})

    const result = await updateBill(
      id,
      { name: 'Renamed', amountCents: 1500 },
      NOW,
    )

    expect(result.ok && result.value).toMatchObject({
      name: 'Renamed',
      amountCents: 1500,
    })
    const row = await connection('bills').where({ id }).first()
    expect(row).toMatchObject({
      name: 'Renamed',
      amount_cents: 1500,
      created_at: STAMP,
      updated_at: NOW_ISO,
    })
  })

  it('a field resent with its stored value is no change, even with payments', async () => {
    const id = await insertBill({})
    await insertPayments(id, ['2026-10-21'])
    const before = await snapshot()

    const result = await updateBill(
      id,
      {
        name: 'Invented bill',
        firstDueDate: '2026-10-21',
        repeat: 'weekly',
        scope: 'personal',
      },
      NOW,
    )

    expect(result.ok).toBe(true)
    expect(await snapshot()).toStrictEqual(before)
  })

  it.each([
    ['firstDueDate', { firstDueDate: '2026-10-22' }],
    ['repeat', { repeat: 'monthly' }],
  ] as const)(
    'refuses a new %s on a bill with payments, applying nothing',
    async (_field, schedule) => {
      const id = await insertBill({})
      await insertPayments(id, ['2026-10-21'])
      const before = await snapshot()

      const result = await updateBill(
        id,
        { ...schedule, name: 'Renamed', accountId: 999 },
        NOW,
      )

      expect(result).toStrictEqual({
        ok: false,
        refusal: 'cannot_reschedule_paid',
      })
      expect(await snapshot()).toStrictEqual(before)
    },
  )

  it('reschedules a bill with no payments', async () => {
    const id = await insertBill({})

    const result = await updateBill(
      id,
      { firstDueDate: '2026-11-05', repeat: 'monthly' },
      NOW,
    )

    expect(result.ok && result.value).toMatchObject({
      dueDate: '2026-11-05',
      firstDueDate: '2026-11-05',
      repeat: 'monthly',
    })
  })

  it('changes the amount of a bill with payments, leaving the payment’s snapshot', async () => {
    const id = await insertBill({ amount_cents: 1000 })
    await insertPayments(id, ['2026-10-21'], { amount_cents: 1000 })
    const paymentsBefore = (await snapshot()).payments

    const result = await updateBill(id, { amountCents: 1800 }, NOW)

    expect(result.ok && result.value.amountCents).toBe(1800)
    expect((await snapshot()).payments).toStrictEqual(paymentsBefore)
  })

  it('takes a new schedule with 1000 unpaid occurrences and refuses 1001', async () => {
    const id = await insertBill({ repeat: 'monthly' })
    expect(
      (
        await updateBill(
          id,
          { firstDueDate: ANCHOR_1000, repeat: 'weekly' },
          NOW,
        )
      ).ok,
    ).toBe(true)
    const before = await snapshot()

    const result = await updateBill(id, { firstDueDate: ANCHOR_1001 }, NOW)

    expect(result).toStrictEqual({ ok: false, refusal: 'too_many_unpaid' })
    expect(await snapshot()).toStrictEqual(before)
  })

  it('refuses the account before the schedule', async () => {
    const id = await insertBill({})
    const result = await updateBill(
      id,
      { firstDueDate: ANCHOR_1001, accountId: 999 },
      NOW,
    )
    expect(result).toStrictEqual({ ok: false, refusal: 'account_not_found' })
  })

  describe('the account is checked against the final scope', () => {
    let personal: number
    let strawb: number
    let xero: number
    beforeEach(async () => {
      personal = await insertAccount({
        scope: 'personal',
        name: 'Invented personal',
      })
      strawb = await insertAccount({ scope: 'strawb', name: 'Invented strawb' })
      xero = await insertAccount({ scope: 'personal', source: 'xero' })
    })

    it('refuses moving a bill to the other scope while its account stays', async () => {
      const id = await insertBill({ account_id: personal })
      const before = await snapshot()

      expect(await updateBill(id, { scope: 'strawb' }, NOW)).toStrictEqual({
        ok: false,
        refusal: 'account_scope_mismatch',
      })
      expect(await snapshot()).toStrictEqual(before)
    })

    it('moves a bill and its account together', async () => {
      const id = await insertBill({ account_id: personal })

      const result = await updateBill(
        id,
        { scope: 'strawb', accountId: strawb },
        NOW,
      )

      expect(result.ok && result.value).toMatchObject({
        scope: 'strawb',
        accountName: 'Invented strawb',
      })
    })

    it('moves a bill with no account', async () => {
      const id = await insertBill({})
      expect((await updateBill(id, { scope: 'strawb' }, NOW)).ok).toBe(true)
    })

    it('refuses a Xero account and a missing one', async () => {
      const id = await insertBill({})
      for (const accountId of [xero, 999]) {
        expect(await updateBill(id, { accountId }, NOW)).toStrictEqual({
          ok: false,
          refusal: 'account_not_found',
        })
      }
    })

    it('refuses an account in the other scope', async () => {
      const id = await insertBill({})
      expect(await updateBill(id, { accountId: strawb }, NOW)).toStrictEqual({
        ok: false,
        refusal: 'account_scope_mismatch',
      })
    })

    it('clears the account', async () => {
      const id = await insertBill({ account_id: personal })
      const result = await updateBill(id, { accountId: null }, NOW)
      expect(result.ok && result.value.accountName).toBeNull()
      expect(
        (await connection('bills').where({ id }).first()).account_id,
      ).toBeNull()
    })

    it('leaves a bill stored with a mismatched account alone on a name edit', async () => {
      const id = await insertBill({ scope: 'personal', account_id: strawb })

      const result = await updateBill(id, { name: 'Renamed' }, NOW)

      expect(result.ok && result.value).toMatchObject({
        name: 'Renamed',
        accountName: 'Invented strawb',
      })
    })
  })
})

describe('deleteBill', () => {
  it('deletes a bill with no payments', async () => {
    const id = await insertBill({})
    const other = await insertBill({})

    expect(await deleteBill(id)).toStrictEqual({ ok: true, value: null })
    expect((await connection('bills').select('id')).map((r) => r.id)).toEqual([
      other,
    ])
  })

  it('refuses a bill with payments, leaving it and them', async () => {
    const id = await insertBill({})
    await insertPayments(id, ['2026-10-21'])
    const before = await snapshot()

    expect(await deleteBill(id)).toStrictEqual({
      ok: false,
      refusal: 'cannot_delete_paid',
    })
    expect(await snapshot()).toStrictEqual(before)
  })

  it('refuses a bill that does not exist', async () => {
    expect(await deleteBill(999)).toStrictEqual({
      ok: false,
      refusal: 'not_found',
    })
  })
})

describe('markBillPaid', () => {
  it('refuses a bill that does not exist', async () => {
    expect(await markBillPaid(999, NOW)).toStrictEqual({
      ok: false,
      refusal: 'not_found',
    })
  })

  it('stores one payment row for the current occurrence, at the bill’s amount', async () => {
    const id = await insertBill({
      amount_cents: 2300,
      first_due_date: '2026-10-14',
    })

    const result = await markBillPaid(id, NOW)

    const rows = await connection('bill_payments').select()
    expect(rows).toHaveLength(1)
    expect(Object.keys(rows[0]).sort()).toEqual([...PAYMENT_ROW_KEYS].sort())
    expect(rows[0]).toStrictEqual({
      id: rows[0].id,
      bill_id: id,
      due_date: '2026-10-14',
      amount_cents: 2300,
      paid_at: NOW_ISO,
    })
    expect(result.ok && result.value).toMatchObject({
      dueDate: '2026-10-21',
      paid: false,
      paidAt: null,
    })
  })

  it('pays the earliest unpaid occurrence each time, never touching earlier rows', async () => {
    const id = await insertBill({ first_due_date: '2026-10-07' })
    await insertPayments(id, ['2026-10-14'], { amount_cents: 999 })
    const earlier = (await snapshot()).payments

    const dues: string[] = []
    for (let i = 0; i < 3; i += 1) {
      const result = await markBillPaid(id, NOW)
      if (!result.ok) throw new Error(result.refusal)
      dues.push(result.value.dueDate)
    }

    expect(dues).toEqual(['2026-10-21', '2026-10-28', '2026-11-04'])
    const payments = await connection('bill_payments').select().orderBy('id')
    expect(payments.slice(0, 1)).toStrictEqual(earlier)
    expect(payments.map((p) => p.due_date)).toEqual([
      '2026-10-14',
      '2026-10-07',
      '2026-10-21',
      '2026-10-28',
    ])
  })

  it('pays ahead past the next payday with no limit', async () => {
    const id = await insertBill({ first_due_date: '2026-10-28' })

    for (const due of [
      '2026-10-28',
      '2026-11-04',
      '2026-11-11',
      '2026-11-18',
      '2026-11-25',
    ]) {
      const result = await markBillPaid(id, NOW)
      expect(result.ok).toBe(true)
      const stored = await connection('bill_payments')
        .max('due_date as d')
        .first()
      expect(stored?.d).toBe(due)
    }
    expect((await itemFor(id)).dueDate).toBe('2026-12-02')
  })

  it('pays a one-off once', async () => {
    const id = await insertBill({
      repeat: 'none',
      first_due_date: '2026-10-30',
    })

    const first = await markBillPaid(id, NOW)
    expect(first.ok && first.value).toMatchObject({
      dueDate: '2026-10-30',
      paid: true,
      paidAt: NOW_ISO,
    })
    const before = await snapshot()

    expect(await markBillPaid(id, NOW)).toStrictEqual({
      ok: false,
      refusal: 'already_paid',
    })
    expect(await snapshot()).toStrictEqual(before)
  })

  it('two presses at once on a one-off store one payment', async () => {
    const id = await insertBill({
      repeat: 'none',
      first_due_date: '2026-10-30',
    })

    const results = await Promise.all([
      markBillPaid(id, NOW),
      markBillPaid(id, NOW),
    ])

    expect(results.filter((r) => r.ok)).toHaveLength(1)
    expect(results.filter((r) => !r.ok)).toStrictEqual([
      { ok: false, refusal: 'already_paid' },
    ])
    expect(await connection('bill_payments').select()).toHaveLength(1)
  })

  it.each([
    ['yearly', '2099-06-15', '2100-06-15'],
    ['weekly', '2099-12-31', '2100-01-07'],
    ['monthly', '2099-12-31', '2100-01-31'],
  ])(
    'pays a %s bill up to 2099-12-31 and refuses the next press, writing nothing',
    async (repeat, first, after) => {
      const id = await insertBill({ repeat, first_due_date: first })

      expect((await markBillPaid(id, NOW)).ok).toBe(true)
      const before = await snapshot()

      expect(await markBillPaid(id, NOW)).toStrictEqual({
        ok: false,
        refusal: 'paid_too_far_ahead',
      })
      expect(await snapshot()).toStrictEqual(before)
      expect((await itemFor(id)).dueDate).toBe(after)
    },
  )

  it('refuses a stored one-off due after 2099-12-31', async () => {
    const id = await insertBill({
      repeat: 'none',
      first_due_date: '2100-01-01',
    })

    expect(await markBillPaid(id, NOW)).toStrictEqual({
      ok: false,
      refusal: 'paid_too_far_ahead',
    })
    expect(await connection('bill_payments').select()).toStrictEqual([])
  })

  it('a paid one-off answers already paid before too far ahead', async () => {
    const id = await insertBill({
      repeat: 'none',
      first_due_date: '2100-01-01',
    })
    await insertPayments(id, ['2100-01-01'])
    const before = await snapshot()

    expect(await markBillPaid(id, NOW)).toStrictEqual({
      ok: false,
      refusal: 'already_paid',
    })
    expect(await snapshot()).toStrictEqual(before)
  })

  it('a yearly bill paid ahead to 2099 still lists', async () => {
    const id = await insertBill({
      repeat: 'yearly',
      first_due_date: '2026-12-01',
    })
    const years = Array.from(
      { length: 2099 - 2026 + 1 },
      (_, i) => `${2026 + i}-12-01`,
    )
    await insertPayments(id, years)

    const body = await listBills('all', NOW)

    expect(body.items[0].dueDate).toBe('2100-12-01')
    expect(body.dueBeforePaydayCents).toBe(0)
    expect(await markBillPaid(id, NOW)).toStrictEqual({
      ok: false,
      refusal: 'paid_too_far_ahead',
    })
  })
})

describe('isPaymentConflict', () => {
  async function caught(write: () => Promise<unknown>): Promise<unknown> {
    try {
      await write()
    } catch (err) {
      return err
    }
    throw new Error('the write did not fail')
  }

  it('is true for a second payment of the same occurrence', async () => {
    const id = await insertBill({})
    await insertPayments(id, ['2026-10-21'])

    const err = await caught(() => insertPayments(id, ['2026-10-21']))

    expect(isPaymentConflict(err)).toBe(true)
  })

  it('is false for another constraint, and for a plain Error', async () => {
    const fk = await caught(() => insertPayments(999, ['2026-10-21']))
    const check = await caught(async () =>
      insertPayments(await insertBill({}), ['2026-10-21'], { amount_cents: 0 }),
    )

    expect(isPaymentConflict(fk)).toBe(false)
    expect(isPaymentConflict(check)).toBe(false)
    expect(
      isPaymentConflict(
        new Error(
          'UNIQUE constraint failed: bill_payments.bill_id, bill_payments.due_date',
        ),
      ),
    ).toBe(false)
    expect(isPaymentConflict('SQLITE_CONSTRAINT')).toBe(false)
  })
})
