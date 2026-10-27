import { describe, expect, it } from 'vitest'
import { groupSources } from '../sources.ts'

// One Sync row per bank connection (issue 59). Every name is invented.

describe('groupSources', () => {
  it('gives one row per connection, in first-seen order, with its account names', () => {
    // Fails if rows are sorted, or same-named connections stay apart.
    const rows = groupSources([
      { name: 'Sample Everyday', connectionName: 'Test Bank' },
      { name: 'Sample Business', connectionName: 'Other Test Bank' },
      { name: 'Sample Savings', connectionName: 'Test Bank' },
    ])
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(['accounts', 'name'])
    }
    expect(rows).toEqual([
      { name: 'Test Bank', accounts: ['Sample Everyday', 'Sample Savings'] },
      { name: 'Other Test Bank', accounts: ['Sample Business'] },
    ])
  })

  it('makes an account with no connection its own row, titled by its name', () => {
    // Fails if connection-less accounts merge together, or merge into a
    // connection that shares the name.
    expect(
      groupSources([
        { name: 'Test Bank', connectionName: null },
        { name: 'Sample Card', connectionName: 'Test Bank' },
        { name: 'Sample Cash', connectionName: null },
      ]),
    ).toEqual([
      { name: 'Test Bank', accounts: ['Test Bank'] },
      { name: 'Test Bank', accounts: ['Sample Card'] },
      { name: 'Sample Cash', accounts: ['Sample Cash'] },
    ])
  })

  it('gives no rows for no accounts', () => {
    // The screen draws its own empty row; fails if one is invented here.
    expect(groupSources([])).toEqual([])
  })
})
