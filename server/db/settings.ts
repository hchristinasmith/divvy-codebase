import {
  CURRENCY_SYMBOLS,
  SETTING_KEYS,
  SETTINGS_DEFAULTS,
  type AccountRole,
  type AccountSettingsRow,
  type CurrencySymbol,
  type RowScope,
  type SettingsResponse,
  type UpdateSettingsRequest,
} from '../../shared/contracts.ts'
import connection from './connection.ts'

// The settings route's data module (issue 46; prd-02 Rulings 2, 9, 10, 11).
//
// Settings live one row per key in the key/value `settings` table, as
// decimal-integer strings or a currency symbol. Reading never throws on a
// stored value: a missing row, or one that fails its rule, takes its default
// from `SETTINGS_DEFAULTS`, so one bad row cannot make safe-to-spend throw on
// every request (issue 46 conductor note, item 1). Writing refuses a value
// that fails its rule, so the route only ever stores what reading accepts.
//
// An account's role is its `account_settings` row; no row is no role (not
// liquid). Nothing here writes `accounts`: the scope is not editable from
// settings, and sync owns everything else on that table.

/** The rule for one setting: what a sent value must be, and how a stored string reads back. */
interface Rule<T> {
  accepts(value: unknown): value is T
  /** The stored string as a candidate value; `accepts` decides whether it is used. */
  parse(stored: string): unknown
  error: string
}

// Digits only, no leading zero, no sign, no exponent, no spaces: what
// `String(n)` writes for a non-negative safe integer and nothing else.
const DIGITS = /^(0|[1-9]\d*)$/

function wholeNumber(min: number, max: number, error: string): Rule<number> {
  return {
    accepts: (value): value is number =>
      typeof value === 'number' &&
      Number.isSafeInteger(value) &&
      value >= min &&
      value <= max,
    parse: (stored) => (DIGITS.test(stored) ? Number(stored) : undefined),
    error,
  }
}

const CENTS_ERROR = (field: string) =>
  `${field} must be a whole number of cents, 0 or more`

/** One rule per `SettingsResponse` field, used to validate a patch and to read a stored row. */
const RULES: { [K in keyof SettingsResponse]: Rule<SettingsResponse[K]> } = {
  taxRateBasisPoints: wholeNumber(
    0,
    10000,
    'taxRateBasisPoints must be a whole number from 0 to 10000',
  ),
  profitCents: wholeNumber(
    0,
    Number.MAX_SAFE_INTEGER,
    CENTS_ERROR('profitCents'),
  ),
  paydayWeekday: wholeNumber(
    0,
    6,
    'paydayWeekday must be a whole number from 0 (Sunday) to 6 (Saturday)',
  ),
  personalTaxOwedCents: wholeNumber(
    0,
    Number.MAX_SAFE_INTEGER,
    CENTS_ERROR('personalTaxOwedCents'),
  ),
  currency: {
    accepts: (value): value is CurrencySymbol =>
      typeof value === 'string' &&
      (CURRENCY_SYMBOLS as readonly string[]).includes(value),
    parse: (stored) => stored,
    error: `currency must be one of ${CURRENCY_SYMBOLS.join(', ')}`,
  },
}

/** `SETTINGS_DEFAULTS`, by API field. */
const DEFAULTS: SettingsResponse = {
  taxRateBasisPoints: SETTINGS_DEFAULTS.tax_rate_bp,
  profitCents: SETTINGS_DEFAULTS.profit_cents,
  paydayWeekday: SETTINGS_DEFAULTS.payday_weekday,
  personalTaxOwedCents: SETTINGS_DEFAULTS.personal_tax_owed_cents,
  currency: SETTINGS_DEFAULTS.currency,
}

const FIELDS = Object.keys(SETTING_KEYS) as (keyof SettingsResponse)[]
const FIELD_SET: ReadonlySet<string> = new Set(FIELDS)

function isField(key: string): key is keyof SettingsResponse {
  return FIELD_SET.has(key)
}

export type SettingsPatchResult =
  | { patch: UpdateSettingsRequest }
  | { error: string }

// Copies `value` into `patch[field]` if it passes the field's rule.
function accept<K extends keyof SettingsResponse>(
  patch: UpdateSettingsRequest,
  field: K,
  value: unknown,
): boolean {
  const rule: Rule<SettingsResponse[K]> = RULES[field]
  if (!rule.accepts(value)) return false
  patch[field] = value
  return true
}

/**
 * Checks a PATCH /api/v1/settings body. Every key must be a
 * `SettingsResponse` field and every value must pass its rule; nothing is
 * coerced (a numeric string, `null` or a boolean is refused). The error is
 * the first failure in the body's key order. `{}` is a valid, empty patch.
 */
export function validateSettingsPatch(body: unknown): SettingsPatchResult {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { error: 'Body must be a JSON object' }
  }
  const patch: UpdateSettingsRequest = {}
  for (const [key, value] of Object.entries(body)) {
    if (!isField(key)) return { error: `Unknown setting: ${key}` }
    if (!accept(patch, key, value)) return { error: RULES[key].error }
  }
  return { patch }
}

// The stored value of `field`, if present and valid; otherwise its default.
function readField<K extends keyof SettingsResponse>(
  field: K,
  stored: ReadonlyMap<string, string>,
): SettingsResponse[K] {
  const raw = stored.get(SETTING_KEYS[field])
  if (raw === undefined) return DEFAULTS[field]
  const rule: Rule<SettingsResponse[K]> = RULES[field]
  const value = rule.parse(raw)
  return rule.accepts(value) ? value : DEFAULTS[field]
}

function assignField<K extends keyof SettingsResponse>(
  settings: SettingsResponse,
  field: K,
  stored: ReadonlyMap<string, string>,
): void {
  settings[field] = readField(field, stored)
}

/** Every setting, parsed; a missing or invalid row takes its default. Never throws on a stored value. */
export async function getSettings(db = connection): Promise<SettingsResponse> {
  const rows: { key: string; value: string }[] = await db('settings')
    .whereIn('key', Object.values(SETTING_KEYS))
    .select('key', 'value')
  const stored = new Map(rows.map((row) => [row.key, row.value]))
  const settings: SettingsResponse = { ...DEFAULTS }
  for (const field of FIELDS) assignField(settings, field, stored)
  return settings
}

/**
 * Stores every field present in `patch` (`undefined` means omitted) and
 * returns the settings afterwards. Throws a RangeError, and writes nothing,
 * if any key is not a setting or any value fails its rule.
 */
export async function updateSettings(
  patch: UpdateSettingsRequest,
  db = connection,
): Promise<SettingsResponse> {
  const writes: { key: string; value: string }[] = []
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    if (!isField(key)) throw new RangeError(`Unknown setting: ${key}`)
    if (!RULES[key].accepts(value)) throw new RangeError(RULES[key].error)
    writes.push({ key: SETTING_KEYS[key], value: String(value) })
  }

  return db.transaction(async (trx) => {
    const updatedAt = new Date().toISOString()
    for (const { key, value } of writes) {
      await trx('settings')
        .insert({ key, value, updated_at: updatedAt })
        .onConflict('key')
        .merge(['value', 'updated_at'])
    }
    return getSettings(trx)
  })
}

interface AccountRoleRow {
  id: number
  name: string
  scope: RowScope
  role: AccountRole | null
}

// Akahu accounts with their role, never a balance, an account number or an
// Akahu id. Mirrors `listAccounts` in ./synced.ts: Xero rows are not listed.
function accountRoles(db: typeof connection) {
  return db('accounts')
    .leftJoin('account_settings', 'account_settings.account_id', 'accounts.id')
    .where('accounts.source', 'akahu')
    .select<
      AccountRoleRow[]
    >('accounts.id', 'accounts.name', 'accounts.scope', 'account_settings.role')
}

function toRow(row: AccountRoleRow): AccountSettingsRow {
  return {
    id: String(row.id),
    name: row.name,
    scope: row.scope,
    role: row.role ?? null,
  }
}

/** Every Akahu account and its role (null: none), in `id` order. */
export async function listAccountRoles(
  db = connection,
): Promise<AccountSettingsRow[]> {
  const rows = await accountRoles(db).orderBy('accounts.id')
  return rows.map(toRow)
}

/**
 * Sets an Akahu account's role, or removes it when `role` is null. Returns
 * the account as listed afterwards, or undefined if there is no such Akahu
 * account. Writes only `account_settings`.
 */
export async function setAccountRole(
  accountId: number,
  role: AccountRole | null,
  db = connection,
): Promise<AccountSettingsRow | undefined> {
  return db.transaction(async (trx) => {
    const account = await trx('accounts')
      .where({ id: accountId, source: 'akahu' })
      .first('id')
    if (account === undefined) return undefined

    if (role === null) {
      await trx('account_settings').where({ account_id: accountId }).delete()
    } else {
      await trx('account_settings')
        .insert({
          account_id: accountId,
          role,
          updated_at: new Date().toISOString(),
        })
        .onConflict('account_id')
        .merge(['role', 'updated_at'])
    }

    const row = await accountRoles(trx).where('accounts.id', accountId).first()
    return row === undefined ? undefined : toRow(row)
  })
}
