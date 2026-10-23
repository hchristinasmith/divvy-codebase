import type { XeroProfitLoss } from '../../../models/xero.ts'
import { badResponse } from './errors.ts'
import { xeroGet } from './http.ts'
import type { XeroContext } from './http.ts'
import { isRecord, readArray, readCents, readRecord } from './json.ts'
import type { JsonRecord } from './json.ts'

// Net profit for a date range, accrual basis (prd-05 done-when 6; prd-02
// Ruling 2's profit input).
//
// The range is required and checked before any request: no default, no
// "this month" when a date is missing. Accrual is requested explicitly with
// `paymentsOnly=false` rather than trusting Xero's default. No `periods` or
// `timeframe` is sent, so every row has one label cell and one value cell.
//
// The report is a tree of sections. The answer is the single row, anywhere in
// it, whose first cell reads exactly "Net Profit". No match, two matches, or
// a row of any other width is `bad_response`; it is never 0, and never a
// neighbouring row such as Total Income or Gross Profit.

export interface ProfitLossRange {
  /** First day, `YYYY-MM-DD`, inclusive. */
  from: string
  /** Last day, `YYYY-MM-DD`, inclusive. */
  to: string
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/

function assertIsoDate(value: unknown, name: string): asserts value is string {
  const match = typeof value === 'string' ? ISO_DATE.exec(value) : null
  if (!match) throw new RangeError(`${name} must be a YYYY-MM-DD date`)
  const [, y, m, d] = match.map((part) => parseInt(part, 10))
  const date = new Date(Date.UTC(y, m - 1, d))
  if (
    date.getUTCFullYear() !== y ||
    date.getUTCMonth() !== m - 1 ||
    date.getUTCDate() !== d
  ) {
    throw new RangeError(`${name} is not a calendar date`)
  }
}

const NET_PROFIT = 'Net Profit'

function firstCellValue(row: JsonRecord): unknown {
  const cells = row.Cells
  if (!Array.isArray(cells) || cells.length === 0 || !isRecord(cells[0]))
    return undefined
  return cells[0].Value
}

function collectNetProfitRows(rows: unknown[], found: JsonRecord[]): void {
  for (const row of rows) {
    if (!isRecord(row)) continue
    if (firstCellValue(row) === NET_PROFIT) found.push(row)
    if (Array.isArray(row.Rows)) collectNetProfitRows(row.Rows, found)
  }
}

function readNetProfitCents(body: unknown): number {
  const reports = readArray(
    readRecord(body, 'ProfitAndLoss response'),
    'Reports',
  )
  const report = readRecord(reports[0], 'Reports[0]')
  const found: JsonRecord[] = []
  collectNetProfitRows(readArray(report, 'Rows'), found)
  if (found.length !== 1) {
    throw badResponse(`expected one Net Profit row, found ${found.length}`)
  }
  const cells = readArray(found[0], 'Cells')
  if (cells.length !== 2) {
    throw badResponse(
      `expected a two-cell Net Profit row, found ${cells.length} cells`,
    )
  }
  return readCents(readRecord(cells[1], 'Net Profit value cell'), 'Value')
}

export async function getProfitLoss(
  ctx: XeroContext,
  range: ProfitLossRange,
): Promise<XeroProfitLoss> {
  const { from, to } = range
  assertIsoDate(from, 'from')
  assertIsoDate(to, 'to')
  if (from > to) throw new RangeError('from must not be after to')
  const body = await xeroGet(ctx, '/api.xro/2.0/Reports/ProfitAndLoss', {
    fromDate: from,
    toDate: to,
    paymentsOnly: 'false',
  })
  return {
    from,
    to,
    basis: 'accrual',
    netProfitCents: readNetProfitCents(body),
  }
}
