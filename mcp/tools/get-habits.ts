// `get_habits` (prd-03 Ruling 1).
// The handler is a stub until a later prd-03 lane fills it; the input
// schema is fixed here and pinned by the registry test.

import { READ_ONLY_ANNOTATIONS } from '../contracts.ts'
import { defineTool, noInputSchema, notImplemented } from './common.ts'

const NAME = 'get_habits'

export const getHabits = defineTool({
  name: NAME,
  title: 'Habits',
  description:
    'Runway, streaks and the freedom date once it exists. Takes no input. Read-only.',
  inputSchema: noInputSchema,
  annotations: READ_ONLY_ANNOTATIONS,
  async handler() {
    return notImplemented(NAME)
  },
})
