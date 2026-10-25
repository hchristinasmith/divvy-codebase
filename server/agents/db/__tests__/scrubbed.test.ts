import { describe, expect, it } from 'vitest'

import { scrubbed } from '../scrubbed.ts'

// The shared write wrapper on its own, for the errors no table here can raise.
describe('scrubbed', () => {
  const SECRET = 'Fixture Merchant 6603'
  const refusal = (message: string, code?: string) => () =>
    Promise.reject(Object.assign(new Error(message), code === undefined ? {} : { code }))
  const CASES: [name: string, write: () => Promise<never>, message: string][] = [
    [
      "SQLite's text after the last ` - `, past a value holding one",
      refusal(
        `insert into x values ('${SECRET} - Ltd') - SQLITE_CONSTRAINT: NOT NULL constraint failed: x.a`,
        'SQLITE_CONSTRAINT',
      ),
      'op failed: SQLITE_CONSTRAINT: NOT NULL constraint failed: x.a',
    ],
    [
      "the code alone when the message's tail is not SQLite's",
      refusal(`insert into x values ('${SECRET}')`, 'SQLITE_BUSY'),
      'op failed: SQLITE_BUSY',
    ],
    [
      'a fixed word when there is no code',
      refusal(`Undefined binding(s) detected: '${SECRET}'`),
      'op failed: database error',
    ],
    ['a fixed word for a thrown non-error', () => Promise.reject(SECRET), 'op failed: database error'],
  ]

  it.each(CASES)('keeps %s', async (_, write, message) => {
    const thrown: unknown = await scrubbed('op', write()).catch((e: unknown) => e)
    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).message).toBe(message)
    // A logger prints a cause, and the original holds the SQL.
    expect(Object.keys(thrown as Error)).toEqual([])
    expect('cause' in (thrown as Error)).toBe(false)
  })

  it('passes a write that succeeds straight through', async () => {
    expect(await scrubbed('op', Promise.resolve([7]))).toEqual([7])
  })
})
