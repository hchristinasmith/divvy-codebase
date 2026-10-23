import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'

import {
  closeDb,
  freshApp,
  serveOnLoopback,
  type LoopbackApi,
} from '../../test-utils/app.ts'

// The route calls Akahu through superagent. Replace it so no test reaches
// the network and every upstream URL the route builds is recorded.
// supertest loads its own copy of superagent from node_modules, outside
// vitest's module graph, so it is unaffected by this mock.
const upstream = vi.hoisted(() => {
  const body = { success: true, items: [] as unknown[] }
  const chain = {
    set: () => chain,
    then: (resolve: (value: { body: unknown }) => unknown) =>
      Promise.resolve({ body }).then(resolve),
  }
  return { body, get: vi.fn<[url: string], typeof chain>(() => chain) }
})

vi.mock('superagent', () => ({ default: { get: upstream.get } }))

let served: LoopbackApi | undefined
let api: LoopbackApi['api']

beforeEach(async () => {
  served = await serveOnLoopback(await freshApp())
  api = served.api
  upstream.get.mockClear()
  vi.stubEnv('AKAHU_USER_TOKEN', 'test-user-token')
  vi.stubEnv('AKAHU_APP_ID', 'test-app-id')
})

// beforeEach can fail before this test's server is listening.
afterEach(async () => {
  vi.unstubAllEnvs()
  await served?.close()
  served = undefined
})

afterAll(closeDb)

describe('GET /api/v1/accounts/:accountId/transactions', () => {
  it('refuses a path-traversal accountId with 400 and never calls Akahu', async () => {
    const res = await api.get(
      '/api/v1/accounts/..%2F..%2Fusers/transactions',
    )

    expect(res.status).toBe(400)
    expect(res.headers['content-type']).toMatch(/^application\/json/)
    expect(Object.keys(res.body)).toEqual(['error'])
    expect(upstream.get).not.toHaveBeenCalled()
  })

  it.each([
    ['a trailing traversal', 'acc_abc%2F..%2F..'],
    ['an injected query string', 'acc_abc%3Fpage%3D2'],
    ['an injected fragment', 'acc_abc%23x'],
    ['an encoded dot segment', '%2E%2E'],
    ['the bare prefix', 'acc_'],
    ['another Akahu id type', 'user_abc123'],
    ['a space', 'acc_abc%20def'],
    ['a valid id after a traversal', '..%2Facc_abc'],
    ['a valid id after another segment', 'x%2Facc_abc'],
    ['a trailing newline', 'acc_abc%0A'],
    ['an injected header line', 'acc_abc%0D%0AX-Injected:1'],
    ['an underscore after the prefix', 'acc_a_b'],
    ['an upper-case prefix', 'ACC_abc'],
  ])('refuses %s with 400 and never calls Akahu', async (_label, segment) => {
    const res = await api.get(
      `/api/v1/accounts/${segment}/transactions`,
    )

    expect(res.status).toBe(400)
    expect(upstream.get).not.toHaveBeenCalled()
  })

  it('forwards a well-formed account id to that account on Akahu', async () => {
    const res = await api.get(
      '/api/v1/accounts/acc_ck1a2b3c4d5e6f/transactions',
    )

    expect(res.status).toBe(200)
    expect(Object.keys(res.body).sort()).toEqual(['items', 'success'])
    expect(res.body).toEqual(upstream.body)
    expect(upstream.get).toHaveBeenCalledTimes(1)
    expect(upstream.get).toHaveBeenCalledWith(
      'https://api.akahu.io/v1/accounts/acc_ck1a2b3c4d5e6f/transactions',
    )
  })
})
