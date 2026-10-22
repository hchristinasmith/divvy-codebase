// `list_transactions` (prd-03 Ruling 1, Done when 7). The handler is a stub
// until a later prd-03 lane fills it; the input schema is fixed here and
// pinned by the registry test.
//
// Bounded twice over: `limit` is at most `MAX_LIMIT` and a larger value is
// rejected, never clamped; `from` and `to` are required and may span at most
// `MAX_RANGE_DAYS`. There is no default limit in the schema; the handler
// applies one, so the published schema never changes when it does.

import { z } from 'zod'
import { READ_ONLY_ANNOTATIONS } from '../contracts.ts'
import {
  MAX_CATEGORY_LENGTH,
  MAX_LIMIT,
  MAX_RANGE_DAYS,
  dateRangeIssues,
  defineTool,
  isoDateSchema,
  notImplemented,
  scopeSchema,
} from './common.ts'

const NAME = 'list_transactions'

const inputSchema = z
  .strictObject({
    scope: scopeSchema,
    from: isoDateSchema.describe('First day to include, YYYY-MM-DD.'),
    to: isoDateSchema.describe(
      `Last day to include, YYYY-MM-DD; on or after from, at most ${MAX_RANGE_DAYS} days after it inclusive.`,
    ),
    category: z.string().min(1).max(MAX_CATEGORY_LENGTH).optional(),
    limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
  })
  .superRefine((input, ctx) => {
    for (const message of dateRangeIssues(input.from, input.to)) {
      ctx.addIssue({ code: 'custom', path: ['to'], message })
    }
  })

export const listTransactions = defineTool({
  name: NAME,
  title: 'Transactions',
  description: `Transactions in a scope between two dates, with the effective category and its source. At most ${MAX_LIMIT} rows. Read-only.`,
  inputSchema,
  annotations: READ_ONLY_ANNOTATIONS,
  async handler() {
    return notImplemented(NAME)
  },
})
