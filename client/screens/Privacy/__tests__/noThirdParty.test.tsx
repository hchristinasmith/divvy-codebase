import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { Routes } from 'react-router'
import ScreenHeader from '../../../components/Shell/ScreenHeader.tsx'
import Shell from '../../../components/Shell/Shell.tsx'
import { renderWithProviders } from '../../../components/Shell/__tests__/renderWithProviders.tsx'
import { screenRoutes } from '../../routes.tsx'

// Issue Done-when 4: neither screen makes a third-party request. Every way
// a page can reach the network from script is recorded (fetch,
// XMLHttpRequest, sendBeacon, WebSocket, EventSource), both screens are
// rendered inside the shell and left to settle, and every URL must be
// same-origin. What the shell and the screen header call on their own is
// measured here by rendering them with no screen, never written down by hand. Every value is
// invented.

const requests: string[] = []

function record(input: unknown) {
  requests.push(
    input instanceof Request ? input.url : String(input as string | URL),
  )
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

class RecordingXhr {
  open(_method: string, url: string | URL) {
    record(url)
  }
  setRequestHeader() {}
  send() {}
  abort() {}
  addEventListener() {}
}

class RecordingSocket {
  constructor(url: string | URL) {
    record(url)
  }
  close() {}
  addEventListener() {}
}

beforeEach(() => {
  requests.length = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown) => {
      record(input)
      const url = new URL(
        input instanceof Request ? input.url : String(input as string | URL),
        document.baseURI,
      )
      if (url.pathname === '/api/v1/sync/status') {
        return json({
          running: false,
          lastRun: null,
          lastSuccessAt: '2026-10-25T02:41:00.000Z',
          nextRunAt: '2026-10-25T02:56:00.000Z',
        })
      }
      return json({ error: 'not stubbed' }, 404)
    }),
  )
  vi.stubGlobal('XMLHttpRequest', RecordingXhr)
  vi.stubGlobal('WebSocket', RecordingSocket)
  vi.stubGlobal('EventSource', RecordingSocket)
  Object.defineProperty(navigator, 'sendBeacon', {
    configurable: true,
    value: (url: string | URL) => {
      record(url)
      return true
    },
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  Reflect.deleteProperty(navigator, 'sendBeacon')
})

// The shell chrome plus a screen header, with no screen body: what every
// screen pays before it asks for anything of its own (the sidebar's alert
// badge and the header's sync pill).
function Chrome() {
  return <ScreenHeader title="Probe" />
}

async function settled(ui: ReactNode, path: string): Promise<URL[]> {
  const { client } = renderWithProviders(ui, { path })
  await waitFor(() => expect(client.isFetching()).toBe(0))
  // One more turn, so anything scheduled after the first replies is seen.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  await waitFor(() => expect(client.isFetching()).toBe(0))
  return requests.map((r) => new URL(r, document.baseURI))
}

const atRoute = (path: string) =>
  settled(
    <Shell>
      <Routes>{screenRoutes}</Routes>
    </Shell>,
    path,
  )

const chrome = () =>
  settled(
    <Shell>
      <Chrome />
    </Shell>,
    '/',
  )

const paths = (urls: URL[]) => new Set(urls.map((u) => u.pathname))

async function chromePaths(): Promise<Set<string>> {
  const urls = await chrome()
  cleanup()
  requests.length = 0
  return paths(urls)
}

describe('no third-party request', () => {
  it('measures the shell and header’s own requests, and they are same-origin', async () => {
    const urls = await chrome()
    expect(urls.length).toBeGreaterThan(0)
    for (const url of urls) expect(url.origin).toBe(window.location.origin)
  })

  it('Privacy calls only its own origin, and only the sync status route beyond the chrome', async () => {
    const shell = await chromePaths()
    const urls = await atRoute('/privacy')
    expect(document.querySelector('[data-server-state="ready"]')).not.toBeNull()
    for (const url of urls) expect(url.origin).toBe(window.location.origin)
    const allowed = new Set([...shell, '/api/v1/sync/status'])
    expect([...paths(urls)].filter((p) => !allowed.has(p))).toEqual([])
  })

  it('Advisor calls nothing beyond what the chrome calls, all same-origin', async () => {
    const shell = await chromePaths()
    const urls = await atRoute('/advisor')
    expect(urls.length).toBeGreaterThan(0)
    for (const url of urls) expect(url.origin).toBe(window.location.origin)
    expect([...paths(urls)].filter((p) => !shell.has(p))).toEqual([])
  })
})
