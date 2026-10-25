import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'

import connection from '../../db/connection.ts'
import {
  closeDb,
  freshApp,
  serveOnLoopback,
  type LoopbackApi,
} from '../../test-utils/app.ts'
import {
  SETTING_KEYS,
  SETTINGS_DEFAULTS,
  type SettingsResponse,
} from '../../../shared/contracts.ts'

// /api/v1/settings (issue 46; prd-02 Rulings 2, 9, 10, 11): the settings
// panel's reads and writes, and account roles, on the real app over an
// in-memory database. There is no `users` row, as in production. Every value
// below is invented.

let served: LoopbackApi | undefined
let api: LoopbackApi['api']

beforeEach(async () => {
  served = await serveOnLoopback(await freshApp())
  api = served.api
})

afterEach(async () => {
  await served?.close() // beforeEach can fail before the server listens
  served = undefined
  vi.restoreAllMocks()
})

afterAll(closeDb)

const NOW = '2026-10-25T00:00:00.000Z'

// SETTINGS_DEFAULTS, by API field, through SETTING_KEYS.
const DEFAULTS = Object.fromEntries(
  Object.entries(SETTING_KEYS).map(([field, key]) => [
    field,
    SETTINGS_DEFAULTS[key],
  ]),
) as unknown as SettingsResponse
const FIELDS = Object.keys(SETTING_KEYS).sort()

// The cents cap: the largest profit safe-to-spend can multiply by 10000 basis
// points and stay a safe integer. Worked out here, not imported.
const CAP = Math.floor(Number.MAX_SAFE_INTEGER / 10000)

function store(rows: Record<string, string>) {
  return connection('settings').insert(
    Object.entries(rows).map(([key, value]) => ({
      key,
      value,
      updated_at: NOW,
    })),
  )
}

async function stored() {
  const rows: { key: string; value: string }[] = await connection('settings')
    .orderBy('key')
    .select('key', 'value')
  return Object.fromEntries(rows.map((r) => [r.key, r.value]))
}

async function insertAccount(
  fields: Record<string, unknown> = {},
): Promise<number> {
  const [id] = await connection('accounts').insert({
    source: 'akahu',
    scope: 'personal',
    name: 'Invented account',
    balance_cents: 4321,
    created_at: NOW,
    updated_at: NOW,
    ...fields,
  })
  return id
}

describe('GET /api/v1/settings', () => {
  it('answers exactly the defaults on an empty table', async () => {
    const res = await api.get('/api/v1/settings')

    expect(res.status).toBe(200)
    expect(Object.keys(res.body).sort()).toEqual(FIELDS)
    expect(res.body).toStrictEqual(DEFAULTS)
  })

  it('answers stored values as numbers', async () => {
    await store({
      tax_rate_bp: '1050',
      profit_cents: '123456',
      payday_weekday: '4',
      personal_tax_owed_cents: '25000',
      currency: '£',
    })

    const res = await api.get('/api/v1/settings')

    expect(res.status).toBe(200)
    expect(res.body).toStrictEqual({
      taxRateBasisPoints: 1050,
      profitCents: 123456,
      paydayWeekday: 4,
      personalTaxOwedCents: 25000,
      currency: '£',
    })
  })

  it('answers 200 with defaults for corrupt stored rows', async () => {
    await store({
      tax_rate_bp: '25%',
      profit_cents: '12.50',
      payday_weekday: '9',
      personal_tax_owed_cents: '-1',
      currency: 'NZD',
    })

    const res = await api.get('/api/v1/settings')

    expect(res.status).toBe(200)
    expect(res.body).toStrictEqual(DEFAULTS)
  })
})

describe('PATCH /api/v1/settings', () => {
  it('stores one key and answers the full settings, which GET agrees with', async () => {
    const res = await api
      .patch('/api/v1/settings')
      .send({ taxRateBasisPoints: 1050 })

    expect(res.status).toBe(200)
    expect(Object.keys(res.body).sort()).toEqual(FIELDS)
    expect(res.body).toStrictEqual({ ...DEFAULTS, taxRateBasisPoints: 1050 })
    expect((await api.get('/api/v1/settings')).body).toStrictEqual(res.body)
    expect(await stored()).toStrictEqual({ tax_rate_bp: '1050' })
  })

  it('leaves other keys on successive patches', async () => {
    await api
      .patch('/api/v1/settings')
      .send({ profitCents: 50000, currency: 'NZ$' })
    const res = await api.patch('/api/v1/settings').send({ paydayWeekday: 5 })

    expect(res.body).toStrictEqual({
      ...DEFAULTS,
      profitCents: 50000,
      currency: 'NZ$',
      paydayWeekday: 5,
    })
    expect(await stored()).toStrictEqual({
      currency: 'NZ$',
      payday_weekday: '5',
      profit_cents: '50000',
    })
  })

  it('stores integers as their exact decimal strings', async () => {
    await api
      .patch('/api/v1/settings')
      .send({ profitCents: CAP, personalTaxOwedCents: 0 })

    expect(await stored()).toStrictEqual({
      profit_cents: '900719925474',
      personal_tax_owed_cents: '0',
    })
  })

  it('treats {} as a no-op', async () => {
    const res = await api.patch('/api/v1/settings').send({})

    expect(res.status).toBe(200)
    expect(res.body).toStrictEqual(DEFAULTS)
    expect(await stored()).toStrictEqual({})
  })

  it('writes nothing when one value is valid and another is not', async () => {
    await store({ tax_rate_bp: '1000' })

    const res = await api
      .patch('/api/v1/settings')
      .send({ taxRateBasisPoints: 2000, currency: 'EUR' })

    expect(res.status).toBe(400)
    expect(res.body).toStrictEqual({
      error: 'currency must be one of $, NZ$, £',
    })
    expect(await stored()).toStrictEqual({ tax_rate_bp: '1000' })
  })

  const TAX = 'taxRateBasisPoints must be a whole number from 0 to 10000'
  const PROFIT =
    'profitCents must be a whole number of cents from 0 to 900719925474'
  const WEEKDAY =
    'paydayWeekday must be a whole number from 0 (Sunday) to 6 (Saturday)'
  const OWED =
    'personalTaxOwedCents must be a whole number of cents from 0 to 900719925474'
  const CURRENCY = 'currency must be one of $, NZ$, £'

  it.each([
    [{ taxRateBasisPoints: -1 }, TAX],
    [{ taxRateBasisPoints: 10001 }, TAX],
    [{ taxRateBasisPoints: 12.5 }, TAX],
    [{ taxRateBasisPoints: '2500' }, TAX],
    [{ taxRateBasisPoints: null }, TAX],
    [{ taxRateBasisPoints: true }, TAX],
    [{ profitCents: -1 }, PROFIT],
    [{ profitCents: 1.5 }, PROFIT],
    [{ profitCents: CAP + 1 }, PROFIT],
    [{ profitCents: Number.MAX_SAFE_INTEGER }, PROFIT],
    [{ profitCents: 2 ** 53 }, PROFIT],
    [{ paydayWeekday: -1 }, WEEKDAY],
    [{ paydayWeekday: 7 }, WEEKDAY],
    [{ paydayWeekday: 1.5 }, WEEKDAY],
    [{ personalTaxOwedCents: -1 }, OWED],
    [{ personalTaxOwedCents: CAP + 1 }, OWED],
    [{ currency: 'EUR' }, CURRENCY],
    [{ currency: 'NZD' }, CURRENCY],
    [{ currency: '' }, CURRENCY],
    [{ currency: 1 }, CURRENCY],
    [{ dark_mode: true }, 'Unknown setting: dark_mode'],
    [{ tax_rate_bp: 2500 }, 'Unknown setting: tax_rate_bp'],
    [[1], 'Body must be a JSON object'],
  ])('refuses %j with 400 and writes nothing', async (body, error) => {
    const res = await api.patch('/api/v1/settings').send(body)

    expect(res.status).toBe(400)
    expect(res.body).toStrictEqual({ error })
    expect(await stored()).toStrictEqual({})
  })

  it.each([
    { taxRateBasisPoints: 0 },
    { taxRateBasisPoints: 10000 },
    { profitCents: 0 },
    { profitCents: CAP },
    { paydayWeekday: 0 },
    { paydayWeekday: 6 },
    { personalTaxOwedCents: 0 },
    { personalTaxOwedCents: CAP },
    { currency: '$' },
  ])('accepts the boundary %j', async (body) => {
    const res = await api.patch('/api/v1/settings').send(body)

    expect(res.status).toBe(200)
    expect(res.body).toStrictEqual({ ...DEFAULTS, ...body })
  })
})

describe('GET /api/v1/settings/accounts', () => {
  it('lists Akahu accounts with id, name, scope and role only', async () => {
    const a = await insertAccount({ akahu_id: 'acc_inv_1', name: 'Everyday E' })
    const b = await insertAccount({
      akahu_id: 'acc_inv_2',
      name: 'Pot F',
      scope: 'strawb',
    })
    await insertAccount({ source: 'xero', akahu_id: null, name: 'Xero G' })
    await connection('account_settings').insert({
      account_id: b,
      role: 'tax_pot',
      updated_at: NOW,
    })

    const res = await api.get('/api/v1/settings/accounts')

    expect(res.status).toBe(200)
    expect(Object.keys(res.body)).toEqual(['items'])
    for (const item of res.body.items) {
      expect(Object.keys(item).sort()).toEqual(['id', 'name', 'role', 'scope'])
    }
    expect(res.body.items).toStrictEqual([
      { id: String(a), name: 'Everyday E', scope: 'personal', role: null },
      { id: String(b), name: 'Pot F', scope: 'strawb', role: 'tax_pot' },
    ])
  })
})

describe('PUT /api/v1/settings/accounts/:id', () => {
  it('sets, changes and clears a role, and never changes the account', async () => {
    const id = await insertAccount({ akahu_id: 'acc_inv_1', name: 'Card H' })
    const accountBefore = await connection('accounts').where({ id }).first()

    const set = await api
      .put(`/api/v1/settings/accounts/${id}`)
      .send({ role: 'current' })
    expect(set.status).toBe(200)
    expect(Object.keys(set.body).sort()).toEqual([
      'id',
      'name',
      'role',
      'scope',
    ])
    expect(set.body).toStrictEqual({
      id: String(id),
      name: 'Card H',
      scope: 'personal',
      role: 'current',
    })

    const changed = await api
      .put(`/api/v1/settings/accounts/${id}`)
      .send({ role: 'credit_card' })
    expect(changed.body.role).toBe('credit_card')
    expect(
      await connection('account_settings').where({ account_id: id }),
    ).toHaveLength(1)

    const cleared = await api
      .put(`/api/v1/settings/accounts/${id}`)
      .send({ role: null })
    expect(cleared.status).toBe(200)
    expect(cleared.body.role).toBeNull()
    expect(await connection('account_settings')).toEqual([])

    expect(
      (await api.get('/api/v1/settings/accounts')).body.items,
    ).toStrictEqual([cleared.body])
    expect(await connection('accounts').where({ id }).first()).toStrictEqual(
      accountBefore,
    )
  })

  it('answers 404 for an unknown account and for a Xero account', async () => {
    const xero = await insertAccount({ source: 'xero', akahu_id: null })

    for (const id of [999999, xero]) {
      const res = await api
        .put(`/api/v1/settings/accounts/${id}`)
        .send({ role: 'current' })
      expect(res.status).toBe(404)
      expect(res.body).toStrictEqual({ error: 'Account not found' })
    }
    expect(await connection('account_settings')).toEqual([])
  })

  it.each(['01', '1e3', '1.5', '0', '-1', 'abc', '9007199254740993'])(
    'refuses the id %j with 400',
    async (id) => {
      await insertAccount({ akahu_id: 'acc_inv_1' })

      const res = await api
        .put(`/api/v1/settings/accounts/${id}`)
        .send({ role: 'current' })

      expect(res.status).toBe(400)
      expect(res.body).toStrictEqual({ error: 'id must be a positive integer' })
    },
  )

  const ROLE =
    'role must be one of current, savings, tax_pot, credit_card, or null'

  it.each([
    [{}, ROLE],
    [{ role: 'Tax pot' }, ROLE],
    [{ role: 'credit card' }, ROLE],
    [{ role: 'CURRENT' }, ROLE],
    [{ role: 1 }, ROLE],
    [{ role: 'current', scope: 'strawb' }, 'Unknown field: scope'],
    [[{ role: 'current' }], 'Body must be a JSON object'],
  ])(
    'refuses the body %j with 400 and changes nothing',
    async (body, error) => {
      const id = await insertAccount({ akahu_id: 'acc_inv_1' })
      const accountBefore = await connection('accounts').where({ id }).first()

      const res = await api.put(`/api/v1/settings/accounts/${id}`).send(body)

      expect(res.status).toBe(400)
      expect(res.body).toStrictEqual({ error })
      expect(await connection('account_settings')).toEqual([])
      expect(await connection('accounts').where({ id }).first()).toStrictEqual(
        accountBefore,
      )
    },
  )
})

it('an unlisted settings path is the JSON 404', async () => {
  const res = await api.get('/api/v1/settings/nope/1')

  expect(res.status).toBe(404)
  expect(res.body).toStrictEqual({ error: 'Not found' })
})

describe('a failing database', () => {
  // Each route's catch block, reached by moving the table it needs aside
  // (rather than dropping it, so the next freshApp() can roll back).
  it.each([
    {
      route: 'GET /api/v1/settings',
      table: 'settings',
      label: 'Error reading settings:',
      send: () => api.get('/api/v1/settings'),
    },
    {
      route: 'PATCH /api/v1/settings',
      table: 'settings',
      label: 'Error updating settings:',
      send: () => api.patch('/api/v1/settings').send({ profitCents: 424242 }),
    },
    {
      route: 'GET /api/v1/settings/accounts',
      table: 'account_settings',
      label: 'Error listing account roles:',
      send: () => api.get('/api/v1/settings/accounts'),
    },
    {
      route: 'PUT /api/v1/settings/accounts/:id',
      table: 'account_settings',
      label: 'Error setting account role:',
      send: async () => {
        const id = await insertAccount({ akahu_id: 'acc_inv_1' })
        return api
          .put(`/api/v1/settings/accounts/${id}`)
          .send({ role: 'current' })
      },
    },
  ])(
    '$route answers 500 with a fixed error and logs only the stack',
    async ({ table, label, send }) => {
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
      await connection.schema.renameTable(table, `${table}_aside`)
      try {
        const res = await send()

        expect(res.status).toBe(500)
        expect(res.body).toStrictEqual({ error: 'Internal server error' })
        // The stack as a string, as server.ts logs a 500: never the error
        // object, whose own fields (errno, code) Node would print beside it.
        expect(logged).toHaveBeenCalledTimes(1)
        const [first, second, ...rest] = logged.mock.calls[0]
        expect(first).toBe(label)
        expect(typeof second).toBe('string')
        expect(second).toMatch(/^Error: /)
        expect(rest).toEqual([])
      } finally {
        await connection.schema.renameTable(`${table}_aside`, table)
      }
    },
  )
})
