// `get_budgets` (prd-03 Ruling 1).
// The handler is a stub until a later prd-03 lane fills it; the input
// schema is fixed here and pinned by the registry test.

import { z } from 'zod'
import { READ_ONLY_ANNOTATIONS } from '../contracts.ts'
import { defineTool, notImplemented, scopeSchema } from './common.ts'

const NAME = 'get_budgets'

export const getBudgets = defineTool({
  name: NAME,
  title: 'Budgets',
  description:
    'The budgets in a scope with their limits and spend so far, in integer cents. Read-only.',
  inputSchema: z.strictObject({ scope: scopeSchema }),
  annotations: READ_ONLY_ANNOTATIONS,
  async handler() {
    return notImplemented()
  },
})
