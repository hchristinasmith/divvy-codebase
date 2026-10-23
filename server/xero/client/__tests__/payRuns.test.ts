import { describe, expect, it } from 'vitest'

import { XeroClientError } from '../index.ts'
import { clientWith, fixture } from './fakeXero.ts'

// Issue #34 done-when 5: pay runs with period, payment date and totals in
// integer cents. Payroll NZ field names are UNVERIFIED (see payRuns.ts).

const PAY_RUN_KEYS = [
  'payRunId',
  'paymentDate',
  'periodEnd',
  'periodStart',
  'status',
  'totalCostCents',
  'totalPayCents',
]

const payRunPages = () => [
  fixture('payruns-page1.json'),
  fixture('payruns-page2.json'),
]

describe('getPayRuns', () => {
  it('maps a pay run with its period, payment date and totals in cents', async () => {
    const { client } = clientWith(payRunPages())

    const [first] = await client.getPayRuns()

    expect(Object.keys(first).sort()).toEqual([...PAY_RUN_KEYS].sort())
    expect(first).toEqual({
      payRunId: 'e7c1a5d2-0000-4000-8000-000000000301',
      periodStart: '2026-08-01',
      periodEnd: '2026-08-31',
      paymentDate: '2026-09-01',
      status: 'Posted',
      totalCostCents: 512040,
      totalPayCents: 421015,
    })
  })

  it('returns every total as a safe integer, including large and sub-dollar ones', async () => {
    const { client } = clientWith(payRunPages())

    const payRuns = await client.getPayRuns()

    expect(payRuns).toHaveLength(3)
    for (const run of payRuns) {
      expect(Number.isSafeInteger(run.totalCostCents)).toBe(true)
      expect(Number.isSafeInteger(run.totalPayCents)).toBe(true)
    }
    expect(payRuns[2]).toMatchObject({
      status: 'Draft',
      totalCostCents: 123456789,
      totalPayCents: 10,
    })
  })

  it('requests the NZ payroll pay-runs endpoint', async () => {
    const { client, calls } = clientWith(payRunPages())

    await client.getPayRuns()

    expect(calls.map(({ url }) => url.origin + url.pathname)).toEqual([
      'https://api.xero.com/payroll.xro/2.0/PayRuns',
      'https://api.xero.com/payroll.xro/2.0/PayRuns',
    ])
  })

  it('returns an empty list only when Xero sends an empty one', async () => {
    const { client, calls } = clientWith([fixture('payruns-empty.json')])

    expect(await client.getPayRuns()).toEqual([])
    expect(calls).toHaveLength(1)
  })

  it('surfaces a 403 (scope not granted, or no payroll) as forbidden, never as no pay runs', async () => {
    const { client } = clientWith([
      { status: 403, body: '{"title":"Forbidden"}' },
    ])

    const error = await client.getPayRuns().catch((e: unknown) => e)

    expect(error).toBeInstanceOf(XeroClientError)
    expect(error).toMatchObject({
      code: 'forbidden',
      status: 403,
      retry_after: null,
    })
  })

  it('surfaces a 404 as http_error', async () => {
    const { client } = clientWith([{ status: 404, body: '' }])

    await expect(client.getPayRuns()).rejects.toMatchObject({
      code: 'http_error',
      status: 404,
    })
  })

  it('rejects a pay run missing a total instead of storing a hole', async () => {
    const page = fixture('payruns-page2.json').replace('"totalPay": 0.10,', '')
    const { client } = clientWith([fixture('payruns-page1.json'), page])

    await expect(client.getPayRuns()).rejects.toMatchObject({
      code: 'bad_response',
      message: 'totalPay is missing or not an amount',
    })
  })
})
