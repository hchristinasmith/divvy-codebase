/**
 * Dev seed for the key/value `settings` table (issue 46): one row per key,
 * no `user_id`, `updated_at` as an ISO-8601 UTC string. `currency` is one
 * of the `CurrencySymbol` values in shared/contracts.ts; `dark_mode` and
 * `notifications` are keys nothing reads yet, which the settings route
 * ignores.
 *
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
export async function seed(knex) {
  // Deletes ALL existing entries
  await knex('settings').del()

  const updatedAt = new Date().toISOString()
  await knex('settings').insert([
    { key: 'dark_mode', value: 'true', updated_at: updatedAt },
    { key: 'currency', value: '$', updated_at: updatedAt },
    { key: 'notifications', value: 'enabled', updated_at: updatedAt },
  ])
}
