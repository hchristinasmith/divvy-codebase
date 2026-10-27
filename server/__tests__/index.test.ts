import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'

// server/index.ts calls `listen` when it is imported, so it cannot be imported
// by a test as it is. Its dependencies are replaced here: the server is a stub
// whose `listen` records its arguments, keeps the callback and returns a fake
// http server whose `close` runs its callback; the schedulers are stubs whose
// `start` and `stop` are spies and whose `whenIdle` returns a promise the test
// controls. Each test imports index.ts fresh, so the module-level `listen` call
// and its signal listeners run once per test.
const mocks = vi.hoisted(() => {
  const state = {
    listenCallback: undefined as (() => void) | undefined,
    syncIdle: Promise.resolve(),
    agentIdle: Promise.resolve(),
  }
  // The fake http server. Its `close` runs the callback, as a real close does
  // once the socket is shut.
  const close = vi.fn((callback?: () => void) => callback?.())
  const closeAllConnections = vi.fn()
  return {
    state,
    server: { close },
    close,
    closeAllConnections,
    listen: vi.fn((...args: unknown[]) => {
      // The callback is the last argument. It is held, not run, so the test
      // decides when "the socket is listening" happens.
      state.listenCallback = args[args.length - 1] as () => void
      return { close, closeAllConnections }
    }),
    syncStart: vi.fn(),
    syncStop: vi.fn(),
    agentStart: vi.fn(),
    agentStop: vi.fn(),
  }
})

vi.mock('../server.ts', () => ({
  default: { listen: mocks.listen },
}))

vi.mock('../sync/scheduler.ts', () => ({
  syncScheduler: {
    start: mocks.syncStart,
    stop: mocks.syncStop,
    whenIdle: () => mocks.state.syncIdle,
  },
}))

vi.mock('../agents/scheduler.ts', () => ({
  agentScheduler: {
    start: mocks.agentStart,
    stop: mocks.agentStop,
    whenIdle: () => mocks.state.agentIdle,
  },
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

/** A promise a test resolves by hand, standing in for a pass in flight. */
function pass(): { promise: Promise<void>; finish: () => void } {
  let finish: () => void = () => {}
  const promise = new Promise<void>((resolve) => {
    finish = resolve
  })
  return { promise, finish }
}

let logSpy: MockInstance<Parameters<Console['log']>, ReturnType<Console['log']>>
const spyOnExit = () =>
  vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
let exitSpy: ReturnType<typeof spyOnExit>
const developerHost = process.env.HOST
let signalListeners: Record<'SIGTERM' | 'SIGINT', NodeJS.SignalsListener[]>

beforeEach(() => {
  // Pin both env vars so a developer's own PORT or HOST never reaches the test.
  // HOST is deleted rather than stubbed: vitest 1.x stores
  // vi.stubEnv('HOST', undefined) as the string "undefined".
  vi.stubEnv('PORT', '4123')
  delete process.env.HOST
  // index.ts logs the address once it is listening; keep the test output quiet.
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  // A test that emits a signal must never really exit the test runner.
  exitSpy = spyOnExit()
  // Record the signal listeners that exist before the test, so afterEach removes
  // only the ones importIndex() adds.
  signalListeners = { SIGTERM: process.listeners('SIGTERM'), SIGINT: process.listeners('SIGINT') }
  mocks.state.syncIdle = Promise.resolve()
  mocks.state.agentIdle = Promise.resolve()
})

afterEach(() => {
  vi.useRealTimers()
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    for (const listener of process.listeners(signal)) {
      if (!signalListeners[signal].includes(listener)) process.removeListener(signal, listener)
    }
  }
  vi.unstubAllEnvs()
  if (developerHost === undefined) delete process.env.HOST
  else process.env.HOST = developerHost
  vi.clearAllMocks()
  mocks.state.listenCallback = undefined
  logSpy.mockRestore()
  exitSpy.mockRestore()
})

describe('server/index.ts boot', () => {
  it('starts both schedulers once, from inside the listen callback', async () => {
    await importIndex()

    expect(mocks.listen).toHaveBeenCalledTimes(1)
    // Not started at module top level: the schedulers wait for the listen callback.
    expect(mocks.syncStart).not.toHaveBeenCalled()
    expect(mocks.agentStart).not.toHaveBeenCalled()

    listeningCallback()()

    expect(mocks.syncStart).toHaveBeenCalledTimes(1)
    expect(mocks.agentStart).toHaveBeenCalledTimes(1)
  })

  it('listens on 127.0.0.1 when HOST is unset', async () => {
    await importIndex()

    expect(mocks.listen).toHaveBeenCalledWith(4123, '127.0.0.1', expect.any(Function))
  })

  it('listens on 127.0.0.1 when HOST is blank', async () => {
    // .env.example ships `HOST=`, which dotenv loads as "". listen(port, '')
    // binds every interface, so a blank HOST must fall back like an unset one.
    vi.stubEnv('HOST', '')

    await importIndex()

    expect(mocks.listen).toHaveBeenCalledWith(4123, '127.0.0.1', expect.any(Function))
  })

  it('listens on HOST when set', async () => {
    vi.stubEnv('HOST', '0.0.0.0')

    await importIndex()

    expect(mocks.listen).toHaveBeenCalledWith(4123, '0.0.0.0', expect.any(Function))
  })
})

describe('server/index.ts shutdown (#454)', () => {
  it.each(['SIGTERM', 'SIGINT'] as const)(
    '%s stops both schedulers, waits for both passes, then closes the server and exits',
    async (signal) => {
      const sync = pass()
      const agent = pass()
      mocks.state.syncIdle = sync.promise
      mocks.state.agentIdle = agent.promise
      await importIndex()
      listeningCallback()()

      process.emit(signal)
      await vi.waitFor(() => expect(mocks.syncStop).toHaveBeenCalledTimes(1))

      expect(mocks.syncStop).toHaveBeenCalledTimes(1)
      expect(mocks.agentStop).toHaveBeenCalledTimes(1)
      // Only the sync pass has ended: the server stays open and the process runs on.
      sync.finish()
      // A macrotask turn, so every promise chained on the sync pass has run.
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(mocks.close).not.toHaveBeenCalled()
      expect(exitSpy).not.toHaveBeenCalled()

      agent.finish()
      await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(0))

      expect(mocks.syncStop.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.close.mock.invocationCallOrder[0],
      )
      expect(mocks.agentStop.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.close.mock.invocationCallOrder[0],
      )
      expect(mocks.close.mock.invocationCallOrder[0]).toBeLessThan(
        exitSpy.mock.invocationCallOrder[0],
      )
      expect(exitSpy).toHaveBeenCalledTimes(1)
      // Both passes ended, so requests in flight are left to finish.
      expect(mocks.closeAllConnections).not.toHaveBeenCalled()
    },
  )

  it('a second signal does not run the shutdown again', async () => {
    await importIndex()
    listeningCallback()()

    process.emit('SIGTERM')
    process.emit('SIGINT')
    process.emit('SIGTERM')

    await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledTimes(1))
    expect(mocks.syncStop).toHaveBeenCalledTimes(1)
    expect(mocks.close).toHaveBeenCalledTimes(1)
  })

  it('closes and exits after 20 seconds when a pass never ends', async () => {
    vi.useFakeTimers()
    mocks.state.syncIdle = new Promise<void>(() => {})
    await importIndex()
    listeningCallback()()

    process.emit('SIGTERM')
    await vi.advanceTimersByTimeAsync(19_999)
    expect(mocks.close).not.toHaveBeenCalled()
    expect(exitSpy).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(mocks.close).toHaveBeenCalledTimes(1)
    // A request waiting on the stuck pass would hold close() open past
    // Fly's SIGKILL, so the timeout drops every connection.
    expect(mocks.closeAllConnections).toHaveBeenCalledTimes(1)
    expect(exitSpy).toHaveBeenCalledWith(0)
  })

  it('clears the drain timeout when both passes end first', async () => {
    vi.useFakeTimers()
    await importIndex()
    listeningCallback()()

    process.emit('SIGTERM')
    await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(0))

    expect(vi.getTimerCount()).toBe(0)
  })
})
