import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import connection from '../connection.ts'
import { assertInMemory } from '../../test-utils/app.ts'
import {
  getSettings,
  listAccountRoles,
  setAccountRole,
  updateSettings,
  validateSettingsPatch,
} from '../settings.ts'
import {
  SETTING_KEYS,
  SETTINGS_DEFAULTS,
  type SettingsResponse,
  type UpdateSettingsRequest,
} from '../../../shared/contracts.ts'
import { safeToSpend } from '../../../shared/safe-to-spend.ts'

// The settings data module (issue 46). Each test starts from an empty,
// freshly migrated in-memory database and inserts the rows it needs; there
// is no `users` row, as in production. Every value is invented.

beforeEach(async () => {
  assertInMemory(connection)
  await connection.migrate.rollback(undefined, true)
  await connection.migrate.latest()
})

afterAll(async () => {
  await connection.destroy()
})

const NOW = '2026-10-25T00:00:00.000Z'
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

const DEFAULTS: SettingsResponse = {
  taxRateBasisPoints: SETTINGS_DEFAULTS.tax_rate_bp,
  profitCents: SETTINGS_DEFAULTS.profit_cents,
  paydayWeekday: SETTINGS_DEFAULTS.payday_weekday,
  personalTaxOwedCents: SETTINGS_DEFAULTS.personal_tax_owed_cents,
  currency: SETTINGS_DEFAULTS.currency,
}
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

async function storedRows() {
  return connection('settings')
    .orderBy('key')
    .select('key', 'value', 'updated_at')
}

function insertAccount(fields: Record<string, unknown>) {
  return connection('accounts').insert({
    source: 'akahu',
    scope: 'personal',
    name: 'Invented account',
    balance_cents: 12345,
    created_at: NOW,
    updated_at: NOW,
    ...fields,
  })
}

describe('getSettings', () => {
  it('answers every default on an empty table', async () => {
    const settings = await getSettings()

    expect(Object.keys(settings).sort()).toEqual(FIELDS)
    expect(settings).toStrictEqual(DEFAULTS)
  })

  it('parses stored strings into numbers', async () => {
    await store({
      tax_rate_bp: '1050',
      profit_cents: '123456',
      payday_weekday: '0',
      personal_tax_owed_cents: '9900',
      currency: 'NZ$',
    })

    expect(await getSettings()).toStrictEqual({
      taxRateBasisPoints: 1050,
      profitCents: 123456,
      paydayWeekday: 0,
      personalTaxOwedCents: 9900,
      currency: 'NZ$',
    })
  })

  it('ignores keys that are not settings', async () => {
    await store({ dark_mode: 'true', tax_rate_bp: '3000' })

    const settings = await getSettings()
    expect(Object.keys(settings).sort()).toEqual(FIELDS)
    expect(settings.taxRateBasisPoints).toBe(3000)
  })

  it.each([
    ['tax_rate_bp', 'abc', 'taxRateBasisPoints'],
    ['tax_rate_bp', '12.5', 'taxRateBasisPoints'],
    ['tax_rate_bp', '-1', 'taxRateBasisPoints'],
    ['tax_rate_bp', '10001', 'taxRateBasisPoints'],
    ['tax_rate_bp', '1e3', 'taxRateBasisPoints'],
    ['tax_rate_bp', ' 5', 'taxRateBasisPoints'],
    ['tax_rate_bp', '05', 'taxRateBasisPoints'],
    ['tax_rate_bp', '', 'taxRateBasisPoints'],
    ['payday_weekday', '7', 'paydayWeekday'],
    ['payday_weekday', '-1', 'paydayWeekday'],
    ['profit_cents', '12.5', 'profitCents'],
    ['profit_cents', '9007199254740992', 'profitCents'],
    ['profit_cents', '9007199254740991', 'profitCents'],
    ['profit_cents', String(CAP + 1), 'profitCents'],
    ['personal_tax_owed_cents', '-100', 'personalTaxOwedCents'],
    ['personal_tax_owed_cents', String(CAP + 1), 'personalTaxOwedCents'],
    ['currency', 'EUR', 'currency'],
    ['currency', 'NZD', 'currency'],
    ['currency', '', 'currency'],
  ] as const)(
    'falls back to the default when %s is stored as %j (%s), and leaves the others',
    async (key, bad, field) => {
      // Every other setting holds a valid non-default value.
      const valid: Record<string, string> = {
        tax_rate_bp: '1000',
        profit_cents: '500',
        payday_weekday: '5',
        personal_tax_owed_cents: '700',
        currency: '£',
      }
      await store({ ...valid, [key]: bad })

      const settings = await getSettings()

      expect(settings[field]).toBe(DEFAULTS[field])
      expect(settings).toStrictEqual({
        taxRateBasisPoints: 1000,
        profitCents: 500,
        paydayWeekday: 5,
        personalTaxOwedCents: 700,
        currency: '£',
        [field]: DEFAULTS[field],
      })
    },
  )
})

describe('the cents cap', () => {
  it('reads a stored profit and tax owed at the cap', async () => {
    await store({
      profit_cents: String(CAP),
      personal_tax_owed_cents: String(CAP),
    })

    const settings = await getSettings()
    expect(settings.profitCents).toBe(CAP)
    expect(settings.personalTaxOwedCents).toBe(CAP)
  })

  it('keeps safe-to-spend from throwing at the cap and the top tax rate', async () => {
    // safeToSpend refuses a rate × profit that is not a safe integer; the
    // largest profit settings can answer must still pass.
    await updateSettings({ taxRateBasisPoints: 10000, profitCents: CAP })
    const settings = await getSettings()

    const result = safeToSpend({
      scope: 'strawb',
      today: '2026-10-25',
      paydayWeekday: settings.paydayWeekday,
      taxRateBasisPoints: settings.taxRateBasisPoints,
      profitCents: settings.profitCents,
      personalTaxOwedCents: settings.personalTaxOwedCents,
      accounts: [],
      bills: [],
      budgets: [],
      transactions: [],
    })
    expect(result.strawbTaxHoldCents).toBe(CAP)
  })
})

describe('updateSettings', () => {
  it('stores each value as its exact string and answers the full settings', async () => {
    const after = await updateSettings({
      profitCents: 123456,
      paydayWeekday: 2,
      currency: 'NZ$',
    })

    expect(after).toStrictEqual({
      ...DEFAULTS,
      profitCents: 123456,
      paydayWeekday: 2,
      currency: 'NZ$',
    })
    const rows = await storedRows()
    expect(rows.map(({ key, value }) => ({ key, value }))).toEqual([
      { key: 'currency', value: 'NZ$' },
      { key: 'payday_weekday', value: '2' },
      { key: 'profit_cents', value: '123456' },
    ])
    for (const row of rows) expect(row.updated_at).toMatch(ISO)
  })

  it('upserts on a second patch, one row per key, and leaves omitted keys', async () => {
    await updateSettings({
      taxRateBasisPoints: 1500,
      personalTaxOwedCents: 2000,
    })
    const after = await updateSettings({ taxRateBasisPoints: 2800 })

    expect(after).toStrictEqual({
      ...DEFAULTS,
      taxRateBasisPoints: 2800,
      personalTaxOwedCents: 2000,
    })
    expect(
      (await storedRows()).map(({ key, value }) => ({ key, value })),
    ).toEqual([
      { key: 'personal_tax_owed_cents', value: '2000' },
      { key: 'tax_rate_bp', value: '2800' },
    ])
  })

  it('skips a field that is present but undefined', async () => {
    await updateSettings({ taxRateBasisPoints: undefined, profitCents: 1 })

    expect((await storedRows()).map((row) => row.key)).toEqual(['profit_cents'])
  })

  it('writes nothing when any value fails its rule', async () => {
    await expect(
      updateSettings({ profitCents: 100, paydayWeekday: 7 }),
    ).rejects.toThrow(
      new RangeError(
        'paydayWeekday must be a whole number from 0 (Sunday) to 6 (Saturday)',
      ),
    )
    expect(await storedRows()).toEqual([])
  })

  it('writes nothing when a key is not a setting', async () => {
    const patch = {
      profitCents: 100,
      tax_rate_bp: 1000,
    } as UpdateSettingsRequest
    await expect(updateSettings(patch)).rejects.toThrow(
      new RangeError('Unknown setting: tax_rate_bp'),
    )
    expect(await storedRows()).toEqual([])
  })
})

describe('validateSettingsPatch', () => {
  it('passes a valid subset through unchanged, and {} as an empty patch', () => {
    expect(
      validateSettingsPatch({ currency: '£', paydayWeekday: 6 }),
    ).toStrictEqual({
      patch: { currency: '£', paydayWeekday: 6 },
    })
    expect(validateSettingsPatch({})).toStrictEqual({ patch: {} })
  })

  it('reports the first failure in key order', () => {
    expect(
      validateSettingsPatch({ paydayWeekday: 9, currency: 'EUR' }),
    ).toStrictEqual({
      error:
        'paydayWeekday must be a whole number from 0 (Sunday) to 6 (Saturday)',
    })
    expect(
      validateSettingsPatch({ dark_mode: true, paydayWeekday: 9 }),
    ).toStrictEqual({
      error: 'Unknown setting: dark_mode',
    })
  })

  it('treats __proto__ and constructor as unknown settings', () => {
    expect(validateSettingsPatch(JSON.parse('{"__proto__": 1}'))).toStrictEqual(
      {
        error: 'Unknown setting: __proto__',
      },
    )
    expect(validateSettingsPatch({ constructor: 1 })).toStrictEqual({
      error: 'Unknown setting: constructor',
    })
  })

  it.each([null, [], 'x', 5, undefined])('refuses a body of %j', (body) => {
    expect(validateSettingsPatch(body)).toStrictEqual({
      error: 'Body must be a JSON object',
    })
  })
})

describe('listAccountRoles', () => {
  it('lists Akahu accounts with their role, in id order, and nothing else', async () => {
    const [first] = await insertAccount({
      akahu_id: 'acc_inv_1',
      name: 'Everyday A',
    })
    const [second] = await insertAccount({
      akahu_id: 'acc_inv_2',
      name: 'Business B',
      scope: 'strawb',
    })
    await insertAccount({ source: 'xero', akahu_id: null, name: 'Xero C' })
    await connection('account_settings').insert({
      account_id: second,
      role: 'tax_pot',
      updated_at: NOW,
    })

    const rows = await listAccountRoles()

    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(['id', 'name', 'role', 'scope'])
    }
    expect(rows).toStrictEqual([
      { id: String(first), name: 'Everyday A', scope: 'personal', role: null },
      {
        id: String(second),
        name: 'Business B',
        scope: 'strawb',
        role: 'tax_pot',
      },
    ])
  })
})

describe('setAccountRole', () => {
  it('sets, changes and clears a role, one row per account, and never writes accounts', async () => {
    const [id] = await insertAccount({ akahu_id: 'acc_inv_1', name: 'Card D' })
    const accountBefore = await connection('accounts').where({ id }).first()

    expect(await setAccountRole(id, 'current')).toStrictEqual({
      id: String(id),
      name: 'Card D',
      scope: 'personal',
      role: 'current',
    })
    const [{ id: settingId }] =
      await connection('account_settings').select('id')

    expect((await setAccountRole(id, 'credit_card'))?.role).toBe('credit_card')
    const rows = await connection('account_settings').select(
      'id',
      'account_id',
      'role',
      'updated_at',
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      id: settingId,
      account_id: id,
      role: 'credit_card',
    })
    expect(rows[0].updated_at).toMatch(ISO)

    expect((await setAccountRole(id, null))?.role).toBeNull()
    expect(await connection('account_settings')).toEqual([])

    expect(await connection('accounts').where({ id }).first()).toStrictEqual(
      accountBefore,
    )
  })

  it('clears a role that was never set without error', async () => {
    const [id] = await insertAccount({ akahu_id: 'acc_inv_1' })

    expect((await setAccountRole(id, null))?.role).toBeNull()
    expect(await connection('account_settings')).toEqual([])
  })

  it('answers undefined for an unknown id or a Xero account, and writes nothing', async () => {
    const [xero] = await insertAccount({ source: 'xero', akahu_id: null })

    expect(await setAccountRole(999999, 'current')).toBeUndefined()
    expect(await setAccountRole(xero, 'current')).toBeUndefined()
    expect(await connection('account_settings')).toEqual([])
  })
})
