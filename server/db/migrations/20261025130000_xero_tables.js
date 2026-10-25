// prd-05 wave 1 (#25), Rulings 2, 3, 6 and 7: the tables every other prd-05
// issue stands on. Creates `xero_connection`, `xero_invoices`, `xero_bills`,
// `xero_pay_runs` and `xero_profit_loss`, and touches nothing outside the
// `xero_` namespace: no table prd-01 or prd-02 owns is read, altered or
// referenced here, and there are no foreign keys. Rolling back drops
// every table this creates, and every row in them.
//
// Ruling 6: Xero data is a copy, not a ledger. Invoices, bills and pay runs
// are keyed on Xero's own id, so the sync replaces a row with
// `INSERT … ON CONFLICT(<id>) DO UPDATE` (knex `onConflict(id).merge()`) and
// a second sync of the same document leaves one row. Divvy never edits them.
//
// Column names follow `models/xero.ts` (what `server/xero/client/` returns),
// in snake_case, plus the time Divvy stored the row.
//
// Conventions on every table here:
// - Money is integer cents (M1 #8, Ruling 6). Every `*_cents` CHECK also
//   asserts `typeof(col) = 'integer'`: a column with INTEGER affinity stores
//   12.5 as a REAL rather than refusing it. (Affinity still turns '100' or a
//   REAL 100.0 into the integer 100 before any CHECK sees it; what is stored
//   is then an integer, which is the rule.)
// - Calendar dates are `YYYY-MM-DD` text in the organisation's calendar, as
//   Xero states them, checked with `date(col, '+0 days') IS col`. The
//   modifier normalises an impossible day (2026-02-30) to a different string,
//   and `IS` treats NULL as a value, so a nullable date column accepts NULL
//   and nothing else that is not a real date.
// - Instants are ISO-8601 UTC strings with milliseconds and a `Z`
//   (`2026-10-25T03:00:00.000Z`, what `Date#toISOString` writes), set by the
//   application. The CHECK reformats the value with
//   `strftime('%Y-%m-%dT%H:%M:%fZ', col, '+0 days')` and requires it to come
//   back unchanged, which refuses a missing millisecond part, an offset, a
//   missing `Z`, an impossible day or hour, and a number. There is no
//   `CURRENT_TIMESTAMP` default: its format sorts differently from these.
// - Enumerated text (`status`, `type`, `basis`) and every other column has
//   no default, so a writer has to say. The one default is
//   `xero_connection.version = 0`.
// - Every CHECK is named `<table>_<what>`, so a refusal names its rule.
// - A non-integer PRIMARY KEY in SQLite allows NULL unless the column says
//   NOT NULL, so each text key does, and refuses the empty string.
//
// xero_connection (Rulings 2, 3): the token vault, one row at most. `id` is
// pinned to 1 by `xero_connection_single_row`; the sync writes it with
// `onConflict('id').merge()`. The access token, refresh token and tenant id
// are stored only as AES-256-GCM ciphertext under a key from the
// environment (`XERO_TOKEN_KEY`), never in this file or the database: there
// is no plaintext column for any of them, and each `*_enc` column holds a
// blob of at least 29 bytes (12-byte IV, 16-byte tag, one byte of
// ciphertext) or NULL. How the bytes are laid out inside the blob belongs to
// the vault, not this migration. `version` is the guard for Ruling 3's
// atomic refresh: a refresher writes the new pair only `WHERE version = ?`
// and increments it. `status`:
// - `connected` — the tokens, tenant, `expires_at`, `scopes` and
//   `connected_at` are all present (`xero_connection_connected_has_tokens`).
// - `needs_reconnect` — a refresh failed (Ruling 3); the old ciphertext may
//   stay, so nothing is required or forbidden.
// - `disconnected` — no token or tenant ciphertext is kept
//   (`xero_connection_disconnected_has_no_tokens`).
// prd-03's read-only replica must exclude this table (Ruling 2); that
// allowlist is prd-03's edit, not this one.
//
// xero_invoices and xero_bills: outstanding receivables (`ACCREC`) and
// payables (`ACCPAY`), the same columns, one CHECK pinning each table's
// type. `currency` is the document's ISO 4217 code and has no default:
// Ruling 7 sums only NZD and keeps every other currency apart, so a row
// that does not say its currency is refused, never assumed NZD.
// `amount_due_cents` is what is still owed and cannot be negative.
// `status` is Xero's own word, kept as received.
//
// xero_pay_runs: stored only (matching is a later PRD), keyed on Xero's
// `payRunID`. There is no currency column because the client returns none:
// the organisation's payroll is Xero Payroll NZ, which pays in NZD. prd-03's
// replica must exclude this table too (Ruling 2).
//
// xero_profit_loss (Ruling 6): the accrual-basis Net Profit for one period,
// one row per (period_from, period_to), with the time it was fetched,
// because "this year's profit" is only as good as when it was fetched. A
// refetch of the same period replaces the row with
// `onConflict(['period_from', 'period_to']).merge()`. `net_profit_cents` is
// negative for a loss. No currency column: the client returns none, and the
// report is in the organisation's base currency, NZD.

function centsCheck(table, column, name, { nonNegative }) {
  table.check(
    nonNegative ? "?? >= 0 AND typeof(??) = 'integer'" : "typeof(??) = 'integer'",
    nonNegative ? [column, column] : [column],
    name,
  )
}

function dateCheck(table, column, name) {
  table.check("date(??, '+0 days') IS ??", [column, column], name)
}

function instantCheck(table, column, name) {
  table.check(
    "?? IS NULL OR (typeof(??) = 'text' AND strftime('%Y-%m-%dT%H:%M:%fZ', ??, '+0 days') IS ??)",
    [column, column, column, column],
    name,
  )
}

function ciphertextCheck(table, column, name) {
  table.check(
    "?? IS NULL OR (typeof(??) = 'blob' AND length(??) >= 29)",
    [column, column, column],
    name,
  )
}

function nonEmptyCheck(table, column, name) {
  table.check('length(??) > 0', [column], name)
}

// xero_invoices and xero_bills share every column; `prefix` names the
// table's CHECKs and `type` is the one Xero type the table holds.
function documentColumns(table, prefix, type) {
  table.text('invoice_id').notNullable().primary()
  table.text('invoice_number')
  table.text('contact_name').notNullable()
  table.text('type').notNullable()
  table.text('status').notNullable()
  table.text('date').notNullable()
  table.text('due_date')
  table.text('currency').notNullable()
  table.integer('total_cents').notNullable()
  table.integer('amount_due_cents').notNullable()
  table.integer('amount_paid_cents').notNullable()
  table.timestamp('synced_at').notNullable()

  nonEmptyCheck(table, 'invoice_id', `${prefix}_invoice_id_not_empty`)
  table.check('?? = ?', ['type', type], `${prefix}_type_is_${type.toLowerCase()}`)
  dateCheck(table, 'date', `${prefix}_date_is_date`)
  dateCheck(table, 'due_date', `${prefix}_due_date_is_date`)
  table.check("?? GLOB '[A-Z][A-Z][A-Z]'", ['currency'], `${prefix}_currency_is_code`)
  centsCheck(table, 'total_cents', `${prefix}_total_is_cents`, { nonNegative: false })
  centsCheck(table, 'amount_due_cents', `${prefix}_amount_due_non_negative`, {
    nonNegative: true,
  })
  centsCheck(table, 'amount_paid_cents', `${prefix}_amount_paid_is_cents`, {
    nonNegative: false,
  })
  instantCheck(table, 'synced_at', `${prefix}_synced_at_is_instant`)
}

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
export async function up(knex) {
  await knex.schema.createTable('xero_connection', (table) => {
    table.integer('id').notNullable().primary()
    table.binary('access_token_enc')
    table.binary('refresh_token_enc')
    table.binary('tenant_id_enc')
    table.timestamp('expires_at')
    table.integer('version').notNullable().defaultTo(0)
    table.text('status').notNullable()
    table.text('scopes')
    table.timestamp('connected_at')
    table.timestamp('last_refresh_at')

    table.check('?? = 1', ['id'], 'xero_connection_single_row')
    ciphertextCheck(table, 'access_token_enc', 'xero_connection_access_token_enc_is_ciphertext')
    ciphertextCheck(table, 'refresh_token_enc', 'xero_connection_refresh_token_enc_is_ciphertext')
    ciphertextCheck(table, 'tenant_id_enc', 'xero_connection_tenant_id_enc_is_ciphertext')
    instantCheck(table, 'expires_at', 'xero_connection_expires_at_is_instant')
    table.check(
      "?? >= 0 AND typeof(??) = 'integer'",
      ['version', 'version'],
      'xero_connection_version_non_negative',
    )
    table.check(
      '?? IN (?, ?, ?)',
      ['status', 'connected', 'needs_reconnect', 'disconnected'],
      'xero_connection_status_known',
    )
    instantCheck(table, 'connected_at', 'xero_connection_connected_at_is_instant')
    instantCheck(table, 'last_refresh_at', 'xero_connection_last_refresh_at_is_instant')
    table.check(
      `?? <> 'connected' OR (?? IS NOT NULL AND ?? IS NOT NULL AND ?? IS NOT NULL
        AND ?? IS NOT NULL AND ?? IS NOT NULL AND ?? IS NOT NULL)`,
      [
        'status',
        'access_token_enc',
        'refresh_token_enc',
        'tenant_id_enc',
        'expires_at',
        'scopes',
        'connected_at',
      ],
      'xero_connection_connected_has_tokens',
    )
    table.check(
      "?? <> 'disconnected' OR (?? IS NULL AND ?? IS NULL AND ?? IS NULL)",
      ['status', 'access_token_enc', 'refresh_token_enc', 'tenant_id_enc'],
      'xero_connection_disconnected_has_no_tokens',
    )
  })

  await knex.schema.createTable('xero_invoices', (table) => {
    documentColumns(table, 'xero_invoices', 'ACCREC')
  })

  await knex.schema.createTable('xero_bills', (table) => {
    documentColumns(table, 'xero_bills', 'ACCPAY')
  })

  await knex.schema.createTable('xero_pay_runs', (table) => {
    table.text('pay_run_id').notNullable().primary()
    table.text('period_start').notNullable()
    table.text('period_end').notNullable()
    table.text('payment_date').notNullable()
    table.text('status').notNullable()
    table.integer('total_cost_cents').notNullable()
    table.integer('total_pay_cents').notNullable()
    table.timestamp('synced_at').notNullable()

    nonEmptyCheck(table, 'pay_run_id', 'xero_pay_runs_pay_run_id_not_empty')
    dateCheck(table, 'period_start', 'xero_pay_runs_period_start_is_date')
    dateCheck(table, 'period_end', 'xero_pay_runs_period_end_is_date')
    dateCheck(table, 'payment_date', 'xero_pay_runs_payment_date_is_date')
    centsCheck(table, 'total_cost_cents', 'xero_pay_runs_total_cost_non_negative', {
      nonNegative: true,
    })
    centsCheck(table, 'total_pay_cents', 'xero_pay_runs_total_pay_non_negative', {
      nonNegative: true,
    })
    instantCheck(table, 'synced_at', 'xero_pay_runs_synced_at_is_instant')
    table.check('?? <= ??', ['period_start', 'period_end'], 'xero_pay_runs_period_in_order')
  })

  await knex.schema.createTable('xero_profit_loss', (table) => {
    table.increments('id').primary()
    table.text('period_from').notNullable()
    table.text('period_to').notNullable()
    table.text('basis').notNullable()
    table.integer('net_profit_cents').notNullable()
    table.timestamp('fetched_at').notNullable()

    table.unique(['period_from', 'period_to'])
    dateCheck(table, 'period_from', 'xero_profit_loss_period_from_is_date')
    dateCheck(table, 'period_to', 'xero_profit_loss_period_to_is_date')
    table.check("?? = 'accrual'", ['basis'], 'xero_profit_loss_basis_is_accrual')
    centsCheck(table, 'net_profit_cents', 'xero_profit_loss_net_profit_is_cents', {
      nonNegative: false,
    })
    instantCheck(table, 'fetched_at', 'xero_profit_loss_fetched_at_is_instant')
    table.check('?? <= ??', ['period_from', 'period_to'], 'xero_profit_loss_period_in_order')
  })
}

/**
 * Drops every table `up` creates, and every row in them.
 *
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
export async function down(knex) {
  await knex.schema.dropTable('xero_profit_loss')
  await knex.schema.dropTable('xero_pay_runs')
  await knex.schema.dropTable('xero_bills')
  await knex.schema.dropTable('xero_invoices')
  await knex.schema.dropTable('xero_connection')
}
