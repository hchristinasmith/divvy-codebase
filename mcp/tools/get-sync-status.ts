// `get_sync_status` (prd-03 Ruling 1).
// The handler is a stub until a later prd-03 lane fills it; the input
// schema is fixed here and pinned by the registry test.

import { READ_ONLY_ANNOTATIONS } from '../contracts.ts'
import { defineTool, noInputSchema, notImplemented } from './common.ts'

const NAME = 'get_sync_status'

export const getSyncStatus = defineTool({
  name: NAME,
  title: 'Sync status',
  description:
    'When the bank data was last synced and how old the advisor copy is. Takes no input. Read-only.',
  inputSchema: noInputSchema,
  annotations: READ_ONLY_ANNOTATIONS,
  async handler() {
    return notImplemented()
  },
})
