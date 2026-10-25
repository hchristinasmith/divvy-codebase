import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'

// server/index.ts calls `listen` when it is imported, so it cannot be imported
// by a test as it is. Both of its dependencies are replaced here: the server
// is a stub whose `listen` records its arguments and keeps the callback, and
// the scheduler is a stub whose `start` is a spy. Each test imports index.ts
// fresh, so the module-level `listen` call runs once per test.
const mocks = vi.hoisted(() => {
  const state = { listenCallback: undefined as (() => void) | undefined }
  return {
    state,
    listen: vi.fn((...args: unknown[]) => {
      // The callback is the last argument. It is held, not run, so the test
      // decides when "the socket is listening" happens.
      state.listenCallback = args[args.length - 1] as () => void
    }),
    start: vi.fn(),
  }
})

vi.mock('../server.ts', () => ({
  default: { listen: mocks.listen },
}))

vi.mock('../sync/scheduler.ts', () => ({
  syncScheduler: { start: mocks.start },
}))

async function importIndex(): Promise<void> {
  vi.resetModules()
  await import('../index.ts')
}

function listeningCallback(): () => void {
  const callback = mocks.state.listenCallback
  if (!callback) throw new Error('index.ts never passed listen a callback')
  return callback
}

let logSpy: MockInstance<Parameters<Console['log']>, ReturnType<Console['log']>>
const developerHost = process.env.HOST

beforeEach(() => {
  // Pin both env vars so a developer's own PORT or HOST never reaches the test.
  // HOST is deleted rather than stubbed: vitest 1.x stores
  // vi.stubEnv('HOST', undefined) as the string "undefined".
  vi.stubEnv('PORT', '4123')
  delete process.env.HOST
  // index.ts logs the address once it is listening; keep the test output quiet.
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllEnvs()
  if (developerHost === undefined) delete process.env.HOST
  else process.env.HOST = developerHost
  vi.clearAllMocks()
  mocks.state.listenCallback = undefined
  logSpy.mockRestore()
})

describe('server/index.ts boot', () => {
  it('starts the sync scheduler once, from inside the listen callback', async () => {
    await importIndex()

    expect(mocks.listen).toHaveBeenCalledTimes(1)
    // Not started at module top level: the scheduler waits for the listen callback.
    expect(mocks.start).not.toHaveBeenCalled()

    listeningCallback()()

    expect(mocks.start).toHaveBeenCalledTimes(1)
  })

  it('listens on 127.0.0.1 when HOST is unset', async () => {
    await importIndex()

    expect(mocks.listen).toHaveBeenCalledWith(4123, '127.0.0.1', expect.any(Function))
  })

  it('listens on HOST when set', async () => {
    vi.stubEnv('HOST', '0.0.0.0')

    await importIndex()

    expect(mocks.listen).toHaveBeenCalledWith(4123, '0.0.0.0', expect.any(Function))
  })
})
