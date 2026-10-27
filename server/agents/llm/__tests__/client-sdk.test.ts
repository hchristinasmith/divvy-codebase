import { afterAll, beforeEach, expect, it, vi } from 'vitest'

import connection from '../../../db/connection.ts'
import { assertInMemory } from '../../../test-utils/app.ts'
import { startModelRun } from '../client.ts'
import { params, reply } from './fakes.ts'

// The default transport (#429): the SDK is built only when a call is sent,
// once per run, with the key from config passed explicitly. The SDK is
// replaced here, so nothing reaches the network; every value is invented.

const sdk = vi.hoisted(() => ({
  options: [] as unknown[],
  bodies: [] as unknown[],
}))

vi.mock('@anthropic-ai/sdk', async (importOriginal) => {
  const real = await importOriginal<typeof import('@anthropic-ai/sdk')>()
  class FakeAnthropic {
    static APIError = real.APIError
    messages = {
      create: async (body: unknown) => {
        sdk.bodies.push(body)
        return reply(10, 2)
      },
    }
    constructor(options: unknown) {
      sdk.options.push(options)
    }
  }
  return { ...real, default: FakeAnthropic }
})

beforeEach(async () => {
  assertInMemory(connection)
  await connection.migrate.rollback(undefined, true)
  await connection.migrate.latest()
  sdk.options.length = 0
  sdk.bodies.length = 0
})

afterAll(async () => {
  await connection.destroy()
})

const KEY = 'sk-ant-test-0f3c9e1a-invented'
const START = { kind: 'category', trigger: 'manual' } as const

it('builds the SDK on the first sent call, once, with only the key', async () => {
  const run = await startModelRun(START, { env: { ANTHROPIC_API_KEY: KEY }, db: connection })
  expect(sdk.options).toHaveLength(0)
  await run.complete(params)
  await run.complete(params)
  expect(sdk.options).toEqual([{ apiKey: KEY }])
  expect(sdk.bodies).toHaveLength(2)
  await run.finish({ outcome: 'success', consideredCount: 1, writtenCount: 0 })
})

it('never builds the SDK when the kill switch blocks', async () => {
  vi.spyOn(console, 'info').mockImplementation(() => {})
  const run = await startModelRun(START, {
    env: { ANTHROPIC_API_KEY: KEY, AGENT_KILL_SWITCH: '1' },
    db: connection,
  })
  expect((await run.complete(params)).status).toBe('blocked')
  expect(sdk.options).toHaveLength(0)
  expect(sdk.bodies).toHaveLength(0)
})
