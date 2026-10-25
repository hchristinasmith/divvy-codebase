import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import connection from '../../../server/db/connection.ts'
import {
  closeDb,
  freshApp,
  serveOnLoopback,
  type LoopbackApi,
} from '../../../server/test-utils/app.ts'

// Contract test (issue 46): the settings panel's real request functions
// against the real Express app over an in-memory database, so the method,
// path and payload the client sends are the ones the server accepts, and a
// refusal reaches the panel as the server's own message. Every value is
// invented.

let served: LoopbackApi | undefined
let api: typeof import('../settings.ts')

beforeAll(async () => {
  served = await serveOnLoopback(await freshApp())
  const { address, port } = served.address
  // settings.ts resolves its base URL from the page; give it this server.
  ;(globalThis as { document?: unknown }).document = {
    baseURI: `http://${address}:${port}/`,
  }
  api = await import('../settings.ts')
})

beforeEach(async () => {
  await freshApp()
})

afterAll(async () => {
  await served?.close()
  await closeDb()
  delete (globalThis as { document?: unknown }).document
})

async function insertAccount(): Promise<string> {
  const [id] = await connection('accounts').insert({
    source: 'akahu',
    akahu_id: 'acc_inv_1',
    scope: 'strawb',
    name: 'Invented pot',
    created_at: '2026-10-25T00:00:00.000Z',
    updated_at: '2026-10-25T00:00:00.000Z',
  })
  return String(id)
}

describe('settings', () => {
  it('round-trips a PATCH through grabSettings', async () => {
    const after = await api.updateSettings({
      taxRateBasisPoints: 1050,
      paydayWeekday: 4,
    })

    expect(after.taxRateBasisPoints).toBe(1050)
    expect(after.paydayWeekday).toBe(4)
    expect(await api.grabSettings()).toStrictEqual(after)
  })

  it("rejects a refused PATCH with the server's message", async () => {
    await expect(api.updateSettings({ profitCents: -1 })).rejects.toThrow(
      new Error('profitCents must be a whole number of cents, 0 or more'),
    )
  })
})

describe('account roles', () => {
  it('round-trips a PUT through grabSettingsAccounts', async () => {
    const id = await insertAccount()

    const row = await api.updateAccountRole(id, 'tax_pot')

    expect(row).toStrictEqual({
      id,
      name: 'Invented pot',
      scope: 'strawb',
      role: 'tax_pot',
    })
    expect(await api.grabSettingsAccounts()).toStrictEqual({ items: [row] })

    expect((await api.updateAccountRole(id, null)).role).toBeNull()
  })

  it('rejects an unknown account with Account not found', async () => {
    await expect(api.updateAccountRole('999999', 'current')).rejects.toThrow(
      new Error('Account not found'),
    )
  })
})
