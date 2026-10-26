import { afterEach, describe, expect, it, vi } from 'vitest'

import { MAX_PAGES } from '../http.ts'
import { createXeroClient, XeroClientError } from '../index.ts'
import type { XeroClient } from '../index.ts'
import {
  clientWith,
  fixture,
  recordingFetch,
  SENTINEL_TENANT,
  SENTINEL_TOKEN,
} from './fakeXero.ts'
import type { Reply } from './fakeXero.ts'

// Issue #34 done-when 6–9: pagination to the end, GET only, credentials on
// every call and never logged, and failures as typed errors.

/** One happy run of each client function, in order, with the replies it needs. */
const EVERY_FUNCTION: [string, Reply[], (c: XeroClient) => Promise<unknown>][] =
  [
    [
      'getReceivableInvoices',
      [fixture('invoices-accrec-page1.json'), fixture('invoices-empty.json')],
      (c) => c.getReceivableInvoices(),
    ],
    [
      'getPayableBills',
      [
        fixture('invoices-accpay-page1.json'),
        fixture('invoices-accpay-page2.json'),
      ],
      (c) => c.getPayableBills(),
    ],
    [
      'getPayRuns',
      [fixture('payruns-page1.json'), fixture('payruns-page2.json')],
      (c) => c.getPayRuns(),
    ],
    [
      'getProfitLoss',
      [fixture('profit-and-loss.json')],
      (c) => c.getProfitLoss({ from: '2026-04-01', to: '2026-09-30' }),
    ],
  ]

describe('pagination', () => {
  it('follows pages until an empty one, not stopping at a short page', async () => {
    const { client, calls } = clientWith([
      fixture('invoices-accrec-page1.json'),
      fixture('invoices-accrec-page2.json'),
      fixture('invoices-empty.json'),
    ])

    const invoices = await client.getReceivableInvoices()

    expect(calls.map((c) => c.url.searchParams.get('page'))).toEqual([
      '1',
      '2',
      '3',
    ])
    expect(invoices.map((i) => i.invoiceNumber)).toEqual([
      'INV-0101',
      'INV-0102',
      'INV-0107',
      null,
    ])
  })

  it('stops once pagination.pageCount is reached', async () => {
    // A third page would add a bill; asking for it is the failure.
    const { client, calls } = clientWith(
      [
        fixture('invoices-accpay-page1.json'),
        fixture('invoices-accpay-page2.json'),
      ],
      () => fixture('invoices-accpay-page1.json'),
    )

    const bills = await client.getPayableBills()

    expect(calls).toHaveLength(2)
    expect(bills).toHaveLength(3)
  })

  it('stops pay runs once pagination.pageCount is reached', async () => {
    const { client, calls } = clientWith(
      [fixture('payruns-page1.json'), fixture('payruns-page2.json')],
      () => fixture('payruns-page1.json'),
    )

    expect(await client.getPayRuns()).toHaveLength(3)
    expect(calls.map((c) => c.url.searchParams.get('page'))).toEqual(['1', '2'])
  })

  it('treats an unending invoice listing as bad_response, not as the full list', async () => {
    const { client, calls } = clientWith([], () =>
      fixture('invoices-accrec-page2.json'),
    )

    await expect(client.getReceivableInvoices()).rejects.toMatchObject({
      code: 'bad_response',
    })
    expect(calls).toHaveLength(MAX_PAGES)
  })

  it('treats an unending pay-run listing as bad_response', async () => {
    const unpaged = fixture('payruns-page2.json').replace(
      /"pagination": \{[^}]*\},/,
      '',
    )
    const { client, calls } = clientWith([], () => unpaged)

    await expect(client.getPayRuns()).rejects.toMatchObject({
      code: 'bad_response',
    })
    expect(calls).toHaveLength(MAX_PAGES)
  })

  it('rejects a malformed pageCount', async () => {
    const page = fixture('invoices-accpay-page1.json').replace(
      '"pageCount": 2',
      '"pageCount": 2.5',
    )
    const { client } = clientWith([page])

    await expect(client.getPayableBills()).rejects.toMatchObject({
      code: 'bad_response',
      message: 'pagination.pageCount is not a whole number',
    })
  })
})

describe('GET only (prd-05 done-when 5)', () => {
  it.each(EVERY_FUNCTION)(
    '%s sends only GETs with no body',
    async (_name, replies, run) => {
      const { client, calls } = clientWith(replies)

      await run(client)

      expect(calls.length).toBeGreaterThan(0)
      for (const { init } of calls) {
        expect(Object.keys(init).sort()).toEqual([
          'headers',
          'method',
          'redirect',
        ])
        expect(init.method).toBe('GET')
        expect(init.redirect).toBe('error')
        expect((init as { body?: unknown }).body).toBeUndefined()
      }
    },
  )
})

describe('credentials', () => {
  it.each(EVERY_FUNCTION)(
    '%s sends the tenant id and the bearer on every call',
    async (_name, replies, run) => {
      const { client, calls } = clientWith(replies)

      await run(client)

      for (const { init } of calls) {
        expect(Object.keys(init.headers).sort()).toEqual([
          'Accept',
          'Authorization',
          'Xero-tenant-id',
        ])
        expect(init.headers.Authorization).toBe(`Bearer ${SENTINEL_TOKEN}`)
        expect(init.headers['Xero-tenant-id']).toBe(SENTINEL_TENANT)
        expect(init.headers.Accept).toBe('application/json')
      }
    },
  )

  it('asks for a fresh token on every request, never caching one', async () => {
    const recorder = recordingFetch([
      fixture('invoices-accrec-page1.json'),
      fixture('invoices-accrec-page2.json'),
      fixture('invoices-empty.json'),
    ])
    let n = 0
    const client = createXeroClient({
      getAccessToken: async () => `rotated-token-${(n += 1)}`,
      tenantId: SENTINEL_TENANT,
      fetch: recorder.fetch,
    })

    await client.getReceivableInvoices()

    expect(recorder.calls.map((c) => c.init.headers.Authorization)).toEqual([
      'Bearer rotated-token-1',
      'Bearer rotated-token-2',
      'Bearer rotated-token-3',
    ])
  })
})

describe('no logging (issue #34 done-when 8)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  const OUTCOMES: [string, Reply[]][] = [
    [
      'success',
      [fixture('invoices-accrec-page1.json'), fixture('invoices-empty.json')],
    ],
    ['401', [{ status: 401, body: fixture('error-401.json') }]],
    ['429', [{ status: 429, body: '', headers: { 'Retry-After': '30' } }]],
    ['500', [{ status: 500, body: 'oops' }]],
    ['malformed JSON', ['{"Invoices": [']],
  ]

  it.each(OUTCOMES)(
    'on %s, nothing is logged and the error carries neither secret',
    async (_label, replies) => {
      const methods = ['log', 'info', 'warn', 'error', 'debug'] as const
      const consoleSpies = methods.map((m) => vi.spyOn(console, m))
      const stdout = vi.spyOn(process.stdout, 'write')
      const stderr = vi.spyOn(process.stderr, 'write')
      const { client } = clientWith(replies)

      const outcome = await client
        .getReceivableInvoices()
        .catch((e: unknown) => e)

      for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled()
      const written = [...stdout.mock.calls, ...stderr.mock.calls]
        .map((args) => String(args[0]))
        .join('\n')
      expect(written).not.toContain(SENTINEL_TOKEN)
      expect(written).not.toContain(SENTINEL_TENANT)

      if (outcome instanceof Error) {
        const serialised = `${outcome.message}\n${outcome.stack ?? ''}\n${JSON.stringify(outcome)}`
        expect(serialised).not.toContain(SENTINEL_TOKEN)
        expect(serialised).not.toContain(SENTINEL_TENANT)
      }
    },
  )
})

describe('typed errors (issue #34 done-when 9)', () => {
  it.each(EVERY_FUNCTION)(
    '%s rejects a 401 as auth_failed, never an empty result',
    async (_name, _replies, run) => {
      const { client } = clientWith([
        { status: 401, body: fixture('error-401.json') },
      ])

      const error = await run(client).catch((e: unknown) => e)

      expect(error).toBeInstanceOf(XeroClientError)
      const { code, status, retry_after } = error as XeroClientError
      expect({ code, status, retry_after }).toEqual({
        code: 'auth_failed',
        status: 401,
        retry_after: null,
      })
    },
  )

  it('rejects a 429 as rate_limited with retry_after in seconds', async () => {
    const { client } = clientWith([
      { status: 429, headers: { 'Retry-After': '30' } },
    ])

    const error = await client.getPayableBills().catch((e: unknown) => e)

    expect(error).toBeInstanceOf(XeroClientError)
    expect(error).toMatchObject({
      code: 'rate_limited',
      status: 429,
      retry_after: 30,
    })
  })

  it.each([
    ['absent', {}],
    ['an HTTP date', { 'Retry-After': 'Wed, 21 Oct 2026 07:28:00 GMT' }],
    ['fractional', { 'Retry-After': '1.5' }],
  ])(
    'gives retry_after null when Retry-After is %s',
    async (_label, headers) => {
      const { client } = clientWith([{ status: 429, headers }])

      await expect(client.getPayRuns()).rejects.toMatchObject({
        code: 'rate_limited',
        retry_after: null,
      })
    },
  )

  it('rejects a 500 as http_error', async () => {
    const { client } = clientWith([{ status: 500, body: 'oops' }])

    await expect(client.getReceivableInvoices()).rejects.toMatchObject({
      code: 'http_error',
      status: 500,
    })
  })

  it('rejects a body that is not JSON as bad_response', async () => {
    const { client } = clientWith(['<Response><Invoices /></Response>'])

    await expect(client.getReceivableInvoices()).rejects.toMatchObject({
      code: 'bad_response',
      status: 200,
    })
  })

  it('passes a getAccessToken rejection through unchanged, before any fetch', async () => {
    const vaultError = new Error('the vault refused')
    const recorder = recordingFetch([])
    const client = createXeroClient({
      getAccessToken: async () => {
        throw vaultError
      },
      tenantId: SENTINEL_TENANT,
      fetch: recorder.fetch,
    })

    await expect(client.getReceivableInvoices()).rejects.toBe(vaultError)
    expect(recorder.calls).toHaveLength(0)
  })

  it('rejects when fetch itself fails as request_failed, with no status', async () => {
    const client = createXeroClient({
      getAccessToken: async () => SENTINEL_TOKEN,
      tenantId: SENTINEL_TENANT,
      fetch: async () => {
        throw new TypeError('fetch failed')
      },
    })

    const error = await client.getReceivableInvoices().catch((e: unknown) => e)

    expect(error).toBeInstanceOf(XeroClientError)
    expect(error).toMatchObject({ code: 'request_failed', status: null })
  })

  it("does not carry fetch's own error, quoting the token, into the thrown error", async () => {
    // undici quotes the rejected header value, which is the bearer token.
    const client = createXeroClient({
      getAccessToken: async () => SENTINEL_TOKEN,
      tenantId: SENTINEL_TENANT,
      fetch: async () => {
        throw new TypeError(
          `Headers.append: "Bearer ${SENTINEL_TOKEN}" is an invalid header value.`,
        )
      },
    })

    const error = await client.getReceivableInvoices().catch((e: unknown) => e)

    expect(error).toBeInstanceOf(XeroClientError)
    expect('cause' in (error as object)).toBe(false)
    const serialised = [
      (error as Error).message,
      String(error),
      (error as Error).stack ?? '',
      JSON.stringify(error),
    ].join('\n')
    expect(serialised).not.toContain(SENTINEL_TOKEN)
  })

  it('rejects a failure on page 2 instead of returning page 1 alone', async () => {
    const { client } = clientWith([
      fixture('invoices-accrec-page1.json'),
      { status: 429, headers: { 'Retry-After': '5' } },
    ])

    await expect(client.getReceivableInvoices()).rejects.toMatchObject({
      code: 'rate_limited',
      retry_after: 5,
    })
  })
})
