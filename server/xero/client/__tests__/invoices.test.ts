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
    expect(sumAmountDueCents(invoices)).toBe(123653838)
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
    expect(sumAmountDueCents(bills)).toBe(30425)
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

describe('sumAmountDueCents', () => {
  it('is 0 for no documents', () => {
    expect(sumAmountDueCents([])).toBe(0)
  })

  it('refuses a non-integer amount instead of drifting', () => {
    expect(() => sumAmountDueCents([{ amountDueCents: 1.5 }])).toThrow(
      /integer number of cents/,
    )
  })
})
