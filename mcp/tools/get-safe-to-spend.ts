// `get_safe_to_spend` (prd-03 Ruling 1).
// The handler is a stub until a later prd-03 lane fills it; the input
// schema is fixed here and pinned by the registry test.

import { z } from 'zod'
import { READ_ONLY_ANNOTATIONS } from '../contracts.ts'
import { defineTool, notImplemented, scopeSchema } from './common.ts'

const NAME = 'get_safe_to_spend'

export const getSafeToSpend = defineTool({
  name: NAME,
  title: 'Safe to spend',
  description:
    'How much can be spent today in a scope, in integer cents, as the Divvy Overview shows it. Read-only.',
  inputSchema: z.strictObject({ scope: scopeSchema }),
  annotations: READ_ONLY_ANNOTATIONS,
  async handler() {
    return notImplemented(NAME)
  },
})
