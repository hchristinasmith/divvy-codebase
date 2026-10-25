import { describe, expect, it } from 'vitest'

import { sumAmountDueCents, XeroClientError } from '../index.ts'
import { clientWith, fixture } from './fakeXero.ts'

// Issue #34 done-when 2 and 3 (prd-05 done-when 1).
//
// The fixtures are deliberately adversarial: the voided and deleted invoices
// carry a non-zero AmountDue, an ACCPAY bill sits among the receivables, and
// one AUTHORISED invoice has nothing left due. Xero's own filter would not
// normally return those; the client must drop them anyway.

const INVOICE_KEYS = [
  'amountDueCents',
  'amountPaidCents',
  'contactName',
  'currency',
  'date',
  'dueDate',
  'invoiceId',
  'invoiceNumber',
  'status',
  'totalCents',
  'type',
]

const receivablePages = () => [
  fixture('invoices-accrec-page1.json'),
  fixture('invoices-accrec-page2.json'),
  fixture('invoices-empty.json'),
]

describe('getReceivableInvoices', () => {
  it('returns only AUTHORISED ACCREC invoices with an amount due above zero', async () => {
    const { client } = clientWith(receivablePages())

    const invoices = await client.getReceivableInvoices()

    expect(invoices.map((i) => i.invoiceId)).toEqual([
      '3f2b8c41-0000-4000-8000-000000000101',
      '3f2b8c41-0000-4000-8000-000000000102',
      '3f2b8c41-0000-4000-8000-000000000107',
      '3f2b8c41-0000-4000-8000-000000000111',
    ])
    for (const invoice of invoices) {
      expect(invoice.type).toBe('ACCREC')
      expect(invoice.status).toBe('AUTHORISED')
      expect(invoice.amountDueCents).toBeGreaterThan(0)
    }
  })

  it('totals the amount due, not the invoice total', async () => {
    const { client } = clientWith(receivablePages())

    const invoices = await client.getReceivableInvoices()

    // 1150.00 + 800.50 (of a 2300.00 invoice) + 1234567.89 + 19.99
    const sum = sumAmountDueCents(invoices)
    expect(sum.nzdCents).toBe(123653838)
    expect(sum.otherCurrencies).toEqual({})
    expect(invoices).toHaveLength(4)
  })

  it('maps a part-paid invoice to integer cents with every field', async () => {
    const { client } = clientWith(receivablePages())

    const [, partPaid] = await client.getReceivableInvoices()

    expect(Object.keys(partPaid).sort()).toEqual([...INVOICE_KEYS].sort())
    expect(partPaid).toEqual({
      invoiceId: '3f2b8c41-0000-4000-8000-000000000102',
      invoiceNumber: 'INV-0102',
      contactName: 'Harbourside Florist',
      type: 'ACCREC',
      status: 'AUTHORISED',
      date: '2026-08-15',
      dueDate: '2026-09-14',
      currency: 'NZD',
      totalCents: 230000,
      amountDueCents: 80050,
      amountPaidCents: 149950,
    })
  })

  it('keeps an invoice with no number or due date, and an escaped contact name', async () => {
    const { client } = clientWith(receivablePages())

    const invoices = await client.getReceivableInvoices()
    const last = invoices[invoices.length - 1]

    expect(last.invoiceNumber).toBeNull()
    expect(last.dueDate).toBeNull()
    expect(last.contactName).toBe('Rimu "Corner 24" Store')
    expect(last.amountDueCents).toBe(1999)
  })

  it('asks Xero for authorised receivables only', async () => {
    const { client, calls } = clientWith(receivablePages())

    await client.getReceivableInvoices()

    for (const { url } of calls) {
      expect(url.origin + url.pathname).toBe(
        'https://api.xero.com/api.xro/2.0/Invoices',
      )
      expect(url.searchParams.get('where')).toBe(
        'Type=="ACCREC" AND Status=="AUTHORISED"',
      )
      expect(url.searchParams.get('Statuses')).toBe('AUTHORISED')
    }
  })

  it('rejects a response without an Invoices list instead of returning none', async () => {
    const { client } = clientWith(['{"Status": "OK"}'])

    await expect(client.getReceivableInvoices()).rejects.toMatchObject({
      code: 'bad_response',
    })
  })

  it.each([
    ['Type', '"Type": "ACCREC"'],
    ['Status', '"Status": "AUTHORISED"'],
  ])(
    'rejects a row with no %s instead of filtering it out to none',
    async (key, field) => {
      // Only the first invoice loses the key, so the call must fail, not
      // quietly return the rest.
      const page = fixture('invoices-accrec-page1.json').replace(
        field,
        `"${key.toLowerCase()}": "x"`,
      )
      const { client } = clientWith([page, fixture('invoices-empty.json')])

      await expect(client.getReceivableInvoices()).rejects.toMatchObject({
        code: 'bad_response',
        message: `${key} is missing or not text`,
      })
    },
  )

  it('rejects an amount it cannot convert exactly, rather than rounding', async () => {
    const page = fixture('invoices-accrec-page1.json').replace(
      '"AmountDue": 1150.00',
      '"AmountDue": 1150.005',
    )
    const { client } = clientWith([page, fixture('invoices-empty.json')])

    const error = await client.getReceivableInvoices().catch((e: unknown) => e)

    expect(error).toBeInstanceOf(XeroClientError)
    expect(error).toMatchObject({
      code: 'bad_response',
      message: 'AmountDue is not an amount in cents',
    })
  })
})

describe('getPayableBills', () => {
  const billPages = () => [
    fixture('invoices-accpay-page1.json'),
    fixture('invoices-accpay-page2.json'),
  ]

  it('returns AUTHORISED ACCPAY bills with an amount due, never a paid, voided or draft one', async () => {
    const { client } = clientWith(billPages())

    const bills = await client.getPayableBills()

    expect(bills.map((b) => [b.invoiceId, b.amountDueCents])).toEqual([
      ['8d4e2a90-0000-4000-8000-000000000201', 8625],
      ['8d4e2a90-0000-4000-8000-000000000204', 21000],
      ['8d4e2a90-0000-4000-8000-000000000205', 800],
    ])
    const sum = sumAmountDueCents(bills)
    expect(sum.nzdCents).toBe(30425)
    expect(sum.otherCurrencies).toEqual({})
  })

  it('keeps a foreign-currency bill out of the NZD payables total', async () => {
    // Bill 204 (210.00) becomes AUD; the other two stay NZD.
    const page2 = fixture('invoices-accpay-page2.json').replace(
      '"CurrencyCode": "NZD"',
      '"CurrencyCode": "AUD"',
    )
    const { client } = clientWith([
      fixture('invoices-accpay-page1.json'),
      page2,
    ])

    const bills = await client.getPayableBills()
    const sum = sumAmountDueCents(bills)

    // 86.25 + 8.00 in NZD; 210.00 in AUD, never added in.
    expect(sum.nzdCents).toBe(9425)
    expect(sum.otherCurrencies).toEqual({ AUD: 21000 })
    expect(Object.keys(sum.otherCurrencies)).toEqual(['AUD'])
  })

  it('carries the due date, and keeps an undated bill with dueDate null', async () => {
    const { client } = clientWith(billPages())

    const bills = await client.getPayableBills()

    expect(bills.map((b) => b.dueDate)).toEqual([
      '2026-10-20',
      null,
      '2026-10-23',
    ])
  })

  it('maps a bill with every field', async () => {
    const { client } = clientWith(billPages())

    const [first] = await client.getPayableBills()

    expect(Object.keys(first).sort()).toEqual([...INVOICE_KEYS].sort())
    expect(first).toEqual({
      invoiceId: '8d4e2a90-0000-4000-8000-000000000201',
      invoiceNumber: 'SPS-4410',
      contactName: 'Southern Paper Supplies',
      type: 'ACCPAY',
      status: 'AUTHORISED',
      date: '2026-10-02',
      dueDate: '2026-10-20',
      currency: 'NZD',
      totalCents: 8625,
      amountDueCents: 8625,
      amountPaidCents: 0,
    })
  })

  it('asks Xero for authorised payables only', async () => {
    const { client, calls } = clientWith(billPages())

    await client.getPayableBills()

    for (const { url } of calls) {
      expect(url.searchParams.get('where')).toBe(
        'Type=="ACCPAY" AND Status=="AUTHORISED"',
      )
      expect(url.searchParams.get('Statuses')).toBe('AUTHORISED')
    }
  })
})

describe('sumAmountDueCents (prd-05 Ruling 7)', () => {
  it('is 0 NZD and no other currency for no documents', () => {
    const sum = sumAmountDueCents([])

    expect(sum.nzdCents).toBe(0)
    expect(sum.otherCurrencies).toEqual({})
  })

  it.each(['NZD', 'USD'])(
    'refuses a non-integer %s amount instead of drifting',
    (currency) => {
      expect(() =>
        sumAmountDueCents([{ amountDueCents: 1.5, currency }]),
      ).toThrow(/integer number of cents/)
    },
  )

  it('never adds a foreign currency into the NZD total', async () => {
    const { client } = clientWith([
      fixture('invoices-accrec-mixed-currency.json'),
      fixture('invoices-empty.json'),
    ])

    const invoices = await client.getReceivableInvoices()
    const sum = sumAmountDueCents(invoices)

    // NZD 100.00; USD 250.50 + 49.50 stays USD. Added as one number it
    // would be 40000.
    expect(invoices).toHaveLength(3)
    expect(sum.nzdCents).toBe(10000)
    expect(sum.otherCurrencies).toEqual({ USD: 30000 })
    expect(Object.keys(sum).sort()).toEqual(['nzdCents', 'otherCurrencies'])
    expect(Object.keys(sum.otherCurrencies).sort()).toEqual(['USD'])
  })

  it('keeps each non-NZD currency apart', () => {
    const sum = sumAmountDueCents([
      { amountDueCents: 1000, currency: 'USD' },
      { amountDueCents: 250, currency: 'EUR' },
      { amountDueCents: 75, currency: 'USD' },
      { amountDueCents: 5000, currency: 'NZD' },
    ])

    expect(sum.nzdCents).toBe(5000)
    expect(sum.otherCurrencies).toEqual({ USD: 1075, EUR: 250 })
    expect(Object.keys(sum.otherCurrencies).sort()).toEqual(['EUR', 'USD'])
  })

  it('is 0 NZD when every document is in another currency', () => {
    const sum = sumAmountDueCents([
      { amountDueCents: 1200, currency: 'AUD' },
      { amountDueCents: 300, currency: 'AUD' },
    ])

    expect(sum.nzdCents).toBe(0)
    expect(sum.otherCurrencies).toEqual({ AUD: 1500 })
    expect(Object.keys(sum.otherCurrencies)).toEqual(['AUD'])
  })

  it.each(['nzd', '', 'NZ', 'NZDX', 'XNZD', ' NZD', '__proto__'])(
    'refuses a currency code that is not three capital letters (%j)',
    (currency) => {
      const sum = () =>
        sumAmountDueCents([
          { amountDueCents: 100, currency: 'NZD' },
          { amountDueCents: 100, currency },
        ])

      expect(sum).toThrow(TypeError)
      expect(sum).toThrow(/not a three-letter currency code/)
    },
  )
})
