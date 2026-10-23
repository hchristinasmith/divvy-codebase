import type { XeroPayRun } from '../../../models/xero.ts'
import { getAllPages, readPageCount } from './http.ts'
import type { XeroContext, XeroPage } from './http.ts'
import {
  readArray,
  readCents,
  readDate,
  readRecord,
  readString,
} from './json.ts'

// Pay runs from Xero Payroll NZ (prd-05 done-when 7; stored, not matched).
//
// The payroll API is a different product from accounting: camelCase keys, a
// `payRuns` list and its own `pagination` block. Its field names here are
// from memory of Xero's NZ payroll docs and are UNVERIFIED against a live
// tenant; a missing or renamed field fails the whole call as `bad_response`
// rather than producing a pay run with a hole in it. Every pay run is
// returned whatever its status; the status word is passed through.
//
// Whether the organisation's subscription and the read-only scope set cover
// payroll is checked on the real tenant, not here: a 403 or 404 surfaces as a
// typed error (conductor ruling 3 on #34), never as "no pay runs".

function readPayRunPage(body: unknown): XeroPage {
  const record = readRecord(body, 'PayRuns response')
  return {
    items: readArray(record, 'payRuns'),
    pageCount: readPageCount(record),
  }
}

function mapPayRun(row: unknown): XeroPayRun {
  const raw = readRecord(row, 'payRun')
  return {
    payRunId: readString(raw, 'payRunID'),
    periodStart: readDate(raw, 'periodStartDate'),
    periodEnd: readDate(raw, 'periodEndDate'),
    paymentDate: readDate(raw, 'paymentDate'),
    status: readString(raw, 'payRunStatus'),
    totalCostCents: readCents(raw, 'totalCost'),
    totalPayCents: readCents(raw, 'totalPay'),
  }
}

export async function getPayRuns(ctx: XeroContext): Promise<XeroPayRun[]> {
  const rows = await getAllPages(
    ctx,
    '/payroll.xro/2.0/PayRuns',
    {},
    readPayRunPage,
  )
  return rows.map(mapPayRun)
}
