import { afterEach, describe, expect, it, vi } from 'vitest'

// freshApp() must check the connection before it rolls anything back: the
// rollback is what would wipe a developer's real database. This file swaps
// the connection for a stub that points at a file, so no real database is
// ever opened, and checks that freshApp refuses without touching it.
afterEach(() => {
  vi.doUnmock('../../db/connection.ts')
  vi.resetModules()
})

describe('freshApp on a database that is not in memory', () => {
  it('refuses before rolling anything back', async () => {
    const rollback = vi.fn()
    const latest = vi.fn()
    vi.resetModules()
    vi.doMock('../../db/connection.ts', () => ({
      default: {
        client: { config: { connection: { filename: './dev.sqlite3' } } },
        migrate: { rollback, latest },
      },
    }))

    const { freshApp } = await import('../app.ts')

    await expect(freshApp()).rejects.toThrow(
      /Refusing to run tests against "\.\/dev\.sqlite3"/,
    )
    expect(rollback).not.toHaveBeenCalled()
    expect(latest).not.toHaveBeenCalled()
  })
})
