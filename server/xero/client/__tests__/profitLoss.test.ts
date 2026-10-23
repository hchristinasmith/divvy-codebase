import { describe, expect, it } from 'vitest'

import { createXeroClient } from '../index.ts'
import type { ProfitLossRange } from '../index.ts'
import { clientWith, fixture, recordingFetch } from './fakeXero.ts'

// Issue #34 done-when 4 (prd-05 done-when 6): accrual basis requested
// explicitly, the Net Profit row and no other, and no silent date range.

const RANGE = { from: '2026-04-01', to: '2026-09-30' }

/** A minimal report whose Rows are `rows`, for the shapes Xero should not send. */
function reportWith(rows: unknown[]): string {
  return JSON.stringify({
    Reports: [{ ReportID: 'ProfitAndLoss', Rows: rows }],
  })
}

const section = (rows: unknown[]) => ({
  RowType: 'Section',
  Title: '',
  Rows: rows,
})
const row = (...values: string[]) => ({
  RowType: 'Row',
  Cells: values.map((Value) => ({ Value })),
})

describe('getProfitLoss', () => {
  it('requests the given dates on accrual basis, explicitly', async () => {
    const { client, calls } = clientWith([fixture('profit-and-loss.json')])

    await client.getProfitLoss(RANGE)

    expect(calls).toHaveLength(1)
    const { url } = calls[0]
    expect(url.origin + url.pathname).toBe(
      'https://api.xero.com/api.xro/2.0/Reports/ProfitAndLoss',
    )
    expect(Object.fromEntries(url.searchParams)).toEqual({
      fromDate: '2026-04-01',
      toDate: '2026-09-30',
      paymentsOnly: 'false',
    })
    expect([...url.searchParams.keys()].sort()).toEqual([
      'fromDate',
      'paymentsOnly',
      'toDate',
    ])
  })

  it('returns the nested Net Profit row in cents, not Total Income or Gross Profit', async () => {
    const { client } = clientWith([fixture('profit-and-loss.json')])

    const result = await client.getProfitLoss(RANGE)

    expect(Object.keys(result).sort()).toEqual([
      'basis',
      'from',
      'netProfitCents',
      'to',
    ])
    expect(result).toEqual({
      from: '2026-04-01',
      to: '2026-09-30',
      basis: 'accrual',
      netProfitCents: 1842530,
    })
  })

  it('returns a net loss as negative cents', async () => {
    const { client } = clientWith([fixture('profit-and-loss-net-loss.json')])

    const result = await client.getProfitLoss({
      from: '2026-10-01',
      to: '2026-10-22',
    })

    expect(result.netProfitCents).toBe(-152045)
  })

  it('finds Net Profit however deep the section nesting is', async () => {
    const body = reportWith([section([section([row('Net Profit', '12.34')])])])
    const { client } = clientWith([body])

    expect((await client.getProfitLoss(RANGE)).netProfitCents).toBe(1234)
  })

  it.each([
    [
      'no Net Profit row',
      [section([row('Gross Profit', '100.00')])],
      /found 0/,
    ],
    [
      'two Net Profit rows',
      [
        section([row('Net Profit', '1.00')]),
        section([row('Net Profit', '2.00')]),
      ],
      /found 2/,
    ],
    [
      'a three-cell Net Profit row',
      [section([row('Net Profit', '1.00', '2.00')])],
      /found 3 cells/,
    ],
    ['an empty Net Profit value', [section([row('Net Profit', '')])], /Value/],
  ])('rejects %s as bad_response, never 0', async (_label, rows, message) => {
    const { client } = clientWith([reportWith(rows)])

    const error = await client.getProfitLoss(RANGE).catch((e: unknown) => e)

    expect(error).toMatchObject({ code: 'bad_response' })
    expect((error as Error).message).toMatch(message)
  })

  it('rejects a body with no Reports as bad_response', async () => {
    const { client } = clientWith(['{"Status": "OK"}'])

    await expect(client.getProfitLoss(RANGE)).rejects.toMatchObject({
      code: 'bad_response',
    })
  })

  it.each([
    ['a missing from', { to: '2026-09-30' }],
    ['a missing to', { from: '2026-04-01' }],
    ['a non-ISO date', { from: '01/04/2026', to: '2026-09-30' }],
    ['a date with a time', { from: '2026-04-01T00:00:00', to: '2026-09-30' }],
    ['an impossible date', { from: '2026-02-30', to: '2026-09-30' }],
    ['from after to', { from: '2026-10-01', to: '2026-09-30' }],
  ])('throws RangeError for %s before any request', async (_label, range) => {
    const recorder = recordingFetch([])
    let tokenCalls = 0
    const client = createXeroClient({
      getAccessToken: async () => {
        tokenCalls += 1
        return 'unused'
      },
      tenantId: 'unused',
      fetch: recorder.fetch,
    })

    await expect(
      client.getProfitLoss(range as unknown as ProfitLossRange),
    ).rejects.toBeInstanceOf(RangeError)
    expect(recorder.calls).toHaveLength(0)
    expect(tokenCalls).toBe(0)
  })

  it('accepts a single-day range', async () => {
    const { client } = clientWith([fixture('profit-and-loss.json')])

    const result = await client.getProfitLoss({
      from: '2026-09-30',
      to: '2026-09-30',
    })

    expect(result.from).toBe('2026-09-30')
  })
})
