import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

// The shared fetch helpers (#438) against a stubbed fetch: every client API
// module's refusal messages come from here, including the fixed message for
// a 200 that is not JSON, which goals, categorise, habits and the Insights
// proposals had no test of. Every value is invented.

let http: typeof import('../http.ts')

beforeAll(async () => {
  // http.ts resolves its base URL from the page when it loads.
  ;(globalThis as { document?: unknown }).document = {
    baseURI: 'http://divvy.invented/',
  }
  http = await import('../http.ts')
})

afterEach(() => {
  vi.unstubAllGlobals()
})

afterAll(() => {
  delete (globalThis as { document?: unknown }).document
})

function stubFetch(reply: () => Promise<Response>) {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    void input
    void init
    return reply()
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('call', () => {
  it('asks /api/v1 plus the path and answers the parsed body', async () => {
    const fetchMock = stubFetch(() =>
      Promise.resolve(new Response(JSON.stringify({ ok: 1 }), { status: 200 })),
    )

    await expect(http.call('/things?x=1', { method: 'POST' })).resolves.toEqual({
      ok: 1,
    })
    expect(fetchMock).toHaveBeenCalledWith(
      'http://divvy.invented/api/v1/things?x=1',
      { method: 'POST' },
    )
  })

  it("rejects with the server's own error text", async () => {
    stubFetch(() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: 'Thing not found' }), {
          status: 404,
        }),
      ),
    )

    await expect(http.call('/things/9')).rejects.toThrow(
      new Error('Thing not found'),
    )
  })

  it('rejects with the status when the server sent no error text', async () => {
    stubFetch(() =>
      Promise.resolve(new Response('<html>oops</html>', { status: 500 })),
    )

    await expect(http.call('/things')).rejects.toThrow(
      new Error('Server error (500)'),
    )
  })

  it('says the server could not be reached when fetch rejects', async () => {
    stubFetch(() => Promise.reject(new TypeError('fetch failed')))

    await expect(http.call('/things')).rejects.toThrow(
      new Error('The server could not be reached'),
    )
  })

  it('rejects a 200 that is not JSON with the fixed message, never the body', async () => {
    stubFetch(() =>
      Promise.resolve(new Response('<html>proxy</html>', { status: 200 })),
    )

    const error = await http.call('/things').catch((e: unknown) => e)
    expect(error).toEqual(
      new Error('The server sent a reply Divvy could not read'),
    )
    expect(String(error)).not.toContain('proxy')
  })
})

describe('request', () => {
  it('answers the checked response for a 204, which has no body to parse', async () => {
    stubFetch(() => Promise.resolve(new Response(null, { status: 204 })))

    const response = await http.request('/things/9', { method: 'DELETE' })
    expect(response.status).toBe(204)
  })

  it("rejects a refused request with the server's own error text", async () => {
    stubFetch(() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: 'Thing not found' }), {
          status: 404,
        }),
      ),
    )

    await expect(
      http.request('/things/9', { method: 'DELETE' }),
    ).rejects.toThrow(new Error('Thing not found'))
  })
})
