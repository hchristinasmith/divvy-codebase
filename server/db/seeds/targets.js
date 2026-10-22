/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
export async function seed(knex) {
  // Deletes ALL existing entries
  await knex('targets').del()

  // Inserts seed entries
  await knex('targets').insert([
    {
      user_id: 1,
      category: 'Housing',
      target_amount_cents: 120000,
      period: 'monthly',
      created_at: new Date(),
      updated_at: new Date(),
    },
    {
      user_id: 1,
      category: 'Food',
      target_amount_cents: 50000,
      period: 'monthly',
      created_at: new Date(),
      updated_at: new Date(),
    },
    {
      user_id: 2,
      category: 'Entertainment',
      target_amount_cents: 15000,
      period: 'monthly',
      created_at: new Date(),
      updated_at: new Date(),
    },
  ])
}
