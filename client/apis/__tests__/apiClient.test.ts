import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import server from '../../../server/server.ts'
import connection from '../../../server/db/connection.ts'

// Contract test: the client's real request functions against the real
// Express app (in-memory SQLite), so the method, path and payload the client
// sends are the ones the server accepts. This is the PATCH/PUT mismatch M1
// #9 fixed; a unit test with a mocked HTTP layer could not catch it again.

let http: Server
let api: typeof import('../apiClient.ts')

beforeAll(async () => {
  // Loopback only: another process can bind 127.0.0.1 on the same port (#97/#105).
  http = await new Promise<Server>((resolve, reject) => {
    const listening = server
      .listen(0, '127.0.0.1', () => {
        listening.off('error', reject)
        resolve(listening)
      })
      .once('error', reject)
  })
  const { address, port } = http.address() as AddressInfo
  // apiClient resolves its base URL from the page; give it this server.
  ;(globalThis as { document?: unknown }).document = {
    baseURI: `http://${address}:${port}/`,
  }
  api = await import('../apiClient.ts')
})

beforeEach(async () => {
  delete process.env.DIVVY_SEED_TRANSACTIONS
  await connection.migrate.rollback(undefined, true)
  await connection.migrate.latest()
  await connection.seed.run()
})

afterAll(async () => {
  await new Promise((resolve) => http.close(resolve))
  await connection.destroy()
  delete (globalThis as { document?: unknown }).document
})

describe('updateTransactionCategory', () => {
  it("sets the user's category through the server and it survives a re-read", async () => {
    const { id } = await connection('transactions')
      .where({ akahu_id: 'trans_fixture_002' })
      .first('id')

    const res = await api.updateTransactionCategory(id, 'Convenience stores')

    expect(res.transaction).toMatchObject({
      id,
      category: 'Convenience stores',
      category_source: 'user',
    })
    expect(
      await connection('transactions').where({ id }).first('category', 'category_source'),
    ).toEqual({ category: 'Convenience stores', category_source: 'user' })
  })

  it('offers, through grabCategories, only categories the update accepts', async () => {
    const { items } = await api.grabCategories()
    const { id } = await connection('transactions').first('id')
    const first = items[0].categories[0]
    const last = items.at(-1)!.categories.at(-1)!

    for (const category of [first, last]) {
      const res = await api.updateTransactionCategory(id, category)
      expect(res.transaction.category).toBe(category)
    }
  })
})
