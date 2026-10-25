import type { XeroBill, XeroInvoice } from '../../../models/xero.ts'
import { sumCents } from '../../../shared/money.ts'
import { getAllPages, readPageCount } from './http.ts'
import type { XeroContext, XeroPage } from './http.ts'
import {
  readArray,
  readCents,
  readDate,
  readOptionalDate,
  readOptionalString,
  readRecord,
  readString,
} from './json.ts'

// Outstanding receivables (ACCREC) and payables (ACCPAY) (prd-05 done-when 1).
//
// Outstanding means: the wanted type, status AUTHORISED, and an amount due
// above zero. The request asks Xero for exactly that type and status, and the
// rule is applied again here to every row returned, so a draft, voided,
// deleted, submitted or paid document can never reach a caller even if Xero's
// filter is looser than this client assumes. Totals sum `AmountDue`, never
// `Total`: a part-paid invoice is owed only its remainder.
//
// Only NZD is ever summed (prd-05 Ruling 7). A document in any other currency
// is totalled with its own currency alone and returned beside the NZD figure,
// never converted with a rate and never added to it.

type InvoiceType = 'ACCREC' | 'ACCPAY'

function readInvoicePage(body: unknown): XeroPage {
  const record = readRecord(body, 'Invoices response')
  return {
    items: readArray(record, 'Invoices'),
    pageCount: readPageCount(record),
  }
}

function mapDocument<T extends InvoiceType>(
  raw: Record<string, unknown>,
  type: T,
) {
  const contact = readRecord(raw.Contact, 'Contact')
  return {
    invoiceId: readString(raw, 'InvoiceID'),
    invoiceNumber: readOptionalString(raw, 'InvoiceNumber'),
    contactName: readString(contact, 'Name'),
    type,
    status: 'AUTHORISED' as const,
    date: readDate(raw, 'DateString'),
    dueDate: readOptionalDate(raw, 'DueDateString'),
    currency: readString(raw, 'CurrencyCode'),
    totalCents: readCents(raw, 'Total'),
    amountDueCents: readCents(raw, 'AmountDue'),
    amountPaidCents: readCents(raw, 'AmountPaid'),
  }
}

async function getOutstanding<T extends InvoiceType>(
  ctx: XeroContext,
  type: T,
) {
  const rows = await getAllPages(
    ctx,
    '/api.xro/2.0/Invoices',
    {
      where: `Type=="${type}" AND Status=="AUTHORISED"`,
      Statuses: 'AUTHORISED',
    },
    readInvoicePage,
  )
  // Type and Status are read, not just compared: a row without them is a
  // shape this client does not know, and dropping it would look like "none
  // owed".
  return rows
    .map((row) => readRecord(row, 'Invoice'))
    .filter(
      (raw) =>
        readString(raw, 'Type') === type &&
        readString(raw, 'Status') === 'AUTHORISED',
    )
    .map((raw) => mapDocument(raw, type))
    .filter((doc) => doc.amountDueCents > 0)
}

export function getReceivableInvoices(
  ctx: XeroContext,
): Promise<XeroInvoice[]> {
  return getOutstanding(ctx, 'ACCREC')
}

export function getPayableBills(ctx: XeroContext): Promise<XeroBill[]> {
  return getOutstanding(ctx, 'ACCPAY')
}

const CURRENCY_CODE = /^[A-Z]{3}$/

/**
 * The outstanding total of a list of invoices or bills, in cents, kept per
 * currency (prd-05 Ruling 7). `nzdCents` sums only documents whose currency
 * is exactly `NZD`; every other code sums alone under its own key in
 * `otherCurrencies`, which is `{}` when there are none and never has an `NZD`
 * key. A currency that is not three capital letters throws rather than being
 * guessed at, so `nzd` can neither join the NZD total nor sit beside it.
 */
export function sumAmountDueCents(
  documents: readonly Pick<
    XeroInvoice | XeroBill,
    'amountDueCents' | 'currency'
  >[],
): { nzdCents: number; otherCurrencies: Record<string, number> } {
  const byCurrency = new Map<string, number[]>()
  for (const { amountDueCents, currency } of documents) {
    if (!CURRENCY_CODE.test(currency)) {
      throw new TypeError(
        `${JSON.stringify(currency)} is not a three-letter currency code`,
      )
    }
    const amounts = byCurrency.get(currency) ?? []
    amounts.push(amountDueCents)
    byCurrency.set(currency, amounts)
  }

  const otherCurrencies: Record<string, number> = {}
  for (const [currency, amounts] of byCurrency) {
    if (currency !== 'NZD') {
      otherCurrencies[currency] = sumCents(amounts)
    }
  }
  return {
    nzdCents: sumCents(byCurrency.get('NZD') ?? []),
    otherCurrencies,
  }
}
