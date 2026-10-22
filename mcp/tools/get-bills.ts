// `get_bills` (prd-03 Ruling 1).
// The handler is a stub until a later prd-03 lane fills it; the input
// schema is fixed here and pinned by the registry test.

import { z } from 'zod'
import { READ_ONLY_ANNOTATIONS } from '../contracts.ts'
import { defineTool, notImplemented, scopeSchema } from './common.ts'

const NAME = 'get_bills'

export const getBills = defineTool({
  name: NAME,
  title: 'Bills',
  description:
    'The upcoming bills in a scope with amounts in integer cents and due dates. Read-only.',
  inputSchema: z.strictObject({ scope: scopeSchema }),
  annotations: READ_ONLY_ANNOTATIONS,
  async handler() {
    return notImplemented()
  },
})
