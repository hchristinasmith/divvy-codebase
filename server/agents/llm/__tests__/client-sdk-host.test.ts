import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest'

import connection from '../../../db/connection.ts'
import { assertInMemory } from '../../../test-utils/app.ts'
import { startModelRun } from '../client.ts'
import { params, reply } from './fakes.ts'

// The default transport against the real SDK (#429): the environment cannot
// move the key to another host or turn on the SDK's logging. Only `fetch` is
// replaced, so the SDK's own option handling is what is tested and nothing
// reaches the network; every value is invented.

const wire = vi.hoisted(() => ({
  requests: [] as { url: string; headers: Headers }[],
}))

vi.mock('@anthropic-ai/sdk', async (importOriginal) => {
  const real = await importOriginal<typeof import('@anthropic-ai/sdk')>()
  const fetch = async (url: string | URL | Request, init?: RequestInit) => {
    wire.requests.push({ url: String(url), headers: new Headers(init?.headers) })
    return new Response(JSON.stringify(reply(10, 2)), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  class WithFakeFetch extends real.default {
    constructor(options: ConstructorParameters<typeof real.default>[0]) {
      super({ ...options, fetch })
    }
  }
  return { ...real, default: WithFakeFetch }
})

beforeEach(async () => {
  assertInMemory(connection)
  await connection.migrate.rollback(undefined, true)
  await connection.migrate.latest()
  wire.requests.length = 0
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

afterAll(async () => {
  await connection.destroy()
})

const KEY = 'sk-ant-test-7a41c0de-invented'

it('sends the key only to api.anthropic.com, whatever ANTHROPIC_BASE_URL says, and logs nothing', async () => {
  vi.stubEnv('ANTHROPIC_BASE_URL', 'https://attacker.invalid')
  vi.stubEnv('ANTHROPIC_LOG', 'debug')
  const methods = ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const
  const spies = methods.map((m) => vi.spyOn(console, m).mockImplementation(() => {}))

  const run = await startModelRun(
    { kind: 'category', trigger: 'manual' },
    { env: { ANTHROPIC_API_KEY: KEY }, db: connection },
  )
  expect((await run.complete(params)).status).toBe('ok')

  expect(wire.requests).toHaveLength(1)
  const [request] = wire.requests
  expect(new URL(request.url).origin).toBe('https://api.anthropic.com')
  // This SDK sends the key as a bearer token.
  expect(request.headers.get('authorization')).toBe(`Bearer ${KEY}`)
  for (const spy of spies) expect(spy).not.toHaveBeenCalled()
})
