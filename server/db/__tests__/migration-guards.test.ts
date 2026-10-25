// #134, #165: no migration may rebuild a table that another table references
// with ON DELETE CASCADE or SET NULL. knex rebuilds a SQLite table to drop or
// alter a column (`dropColumn`, `.alter()`), and the rebuild runs inside
// knex's migration transaction, where PRAGMA foreign_keys = OFF is ignored,
// so dropping the old copy of the parent deletes every CASCADE child row and
// clears every SET NULL column. `migrate:latest` runs on every boot with no
// backup before it, so the loss would be silent. A lost `credit_card` role
// overstates safe-to-spend (prd-02 Ruling 10). See the hazard notes in
// 20261023120000_money_as_cents.js, 20261024100004_category_corrections.js
// and 20261025120000_prd02_budgets_bills_goals_roles_dismissals.js.
//
// One guard per parent. Each writes the parent in the schema left by the
// migration that created its first child, then steps up one migration at a
// time and writes a row in each child table in the schema left by the
// migration that created that child. Every migration after a child's creation
// runs over that child's row, including one that creates a later child and
// rebuilds the parent at once, and so do migrations not written yet. A parent
// whose first child came from the newest migration has nothing after it to
// check yet; its guard is skipped until a migration lands after that point,
// and runs from then on without anyone editing it.
//
// Each canary runs the same flow with one extra in-test migration that
// rebuilds that parent, and expects the guard's own check to fail: proof that
// the hazard is real on this knex and that the guard can go red, including
// for the parents whose guard is skipped today.
//
// The first test pins GUARDS against the schema: a new CASCADE or SET NULL
// foreign key with no guard fails it. Each guard also pins every child's
// `createdBy`, so a child cannot be seeded later than its table exists.
import { readdirSync } from 'node:fs'
import * as Path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import knex, { Knex } from 'knex'
import config from '../knexfile.js'
import { migrateThrough, migrateToJustBefore } from './migrateToJustBefore.ts'
import { sequence } from './schemaInfo.ts'

const AT = '2026-10-25T03:00:00.000Z'

type Row = Record<string, unknown>

type Child = {
  table: string
  // The column holding the parent's id. The guard writes it.
  column: string
  onDelete: 'CASCADE' | 'SET NULL'
  // The migration that creates `table`. The guard writes the child's row in
  // the schema it leaves.
  createdBy: string
  // A valid row in that schema, without `column`.
  row: Row
}

type Guard = {
  parent: string
  // A valid parent row, distinct for each `name`, in the schema left by the
  // migration that creates the first child.
  parentRow: (name: string) => Row
  children: Child[]
}

const GUARDS: Guard[] = [
  {
    parent: 'transactions',
    parentRow: (name) => ({
      akahu_id: `trans_fixture_${name}`,
      account_id: 'acc_fixture_everyday',
      amount_cents: -450,
    }),
    children: [
      {
        table: 'category_corrections',
        column: 'transaction_id',
        onDelete: 'CASCADE',
        createdBy: '20261024100004_category_corrections.js',
        row: { from_category: null, to_category: 'Bakeries', corrected_at: AT, source: 'user' },
      },
      {
        table: 'category_proposals',
        column: 'transaction_id',
        onDelete: 'CASCADE',
        createdBy: '20261025160000_agent_inboxes.js',
        row: {
          current_category: null,
          proposed_category: 'Bakeries',
          confidence: 0.9,
          reason: 'Moved to Bakeries twice',
          origin: 'rule',
          status: 'pending',
          created_at: AT,
        },
      },
    ],
  },
  {
    parent: 'users',
    parentRow: (name) => ({ email: `${name}@example.com`, password: 'x' }),
    // `targets` was a child too, until prd-02 Ruling 6 dropped it in
    // 20261025120000; nothing of it is left for a later migration to lose.
    // So was `settings`, until 20261025150000 (issue 46) dropped its
    // `user_id`: its rows no longer hang off a user.
    children: [
      {
        table: 'wishlist_items',
        column: 'user_id',
        onDelete: 'CASCADE',
        createdBy: '20250619122157_wishlist_items.js',
        row: {
          name: 'Bike',
          target_amt: 120000,
          saved_amt: 5000,
          priority: 'high',
          url: 'https://example.com/bike',
          img_url: null,
          created_at: AT,
          updated_at: AT,
        },
      },
      {
        table: 'user_challenges',
        column: 'user_id',
        onDelete: 'CASCADE',
        createdBy: '20250619122214_challenges.js',
        row: {
          id: 'challenge_fixture',
          challenge_id: 'no_spend_week',
          status: 'active',
          progress: 40,
          started_at: AT,
          completed_at: null,
        },
      },
    ],
  },
  {
    parent: 'accounts',
    parentRow: (name) => ({
      akahu_id: `acc_fixture_${name}`,
      name,
      created_at: AT,
      updated_at: AT,
    }),
    children: [
      {
        table: 'account_settings',
        column: 'account_id',
        onDelete: 'CASCADE',
        createdBy: '20261025120000_prd02_budgets_bills_goals_roles_dismissals.js',
        row: { role: 'credit_card', updated_at: AT },
      },
      {
        table: 'bills',
        column: 'account_id',
        onDelete: 'SET NULL',
        createdBy: '20261025120000_prd02_budgets_bills_goals_roles_dismissals.js',
        row: {
          scope: 'personal',
          name: 'Power',
          amount_cents: 18450,
          repeat: 'monthly',
          first_due_date: '2026-10-31',
          created_at: AT,
          updated_at: AT,
        },
      },
    ],
  },
  {
    parent: 'bills',
    parentRow: (name) => ({
      scope: 'personal',
      name,
      amount_cents: 18450,
      repeat: 'monthly',
      first_due_date: '2026-10-31',
      created_at: AT,
      updated_at: AT,
    }),
    children: [
      {
        table: 'bill_payments',
        column: 'bill_id',
        onDelete: 'CASCADE',
        createdBy: '20261025120000_prd02_budgets_bills_goals_roles_dismissals.js',
        row: { due_date: '2026-10-31', amount_cents: 18450, paid_at: AT },
      },
    ],
  },
  {
    parent: 'goals',
    parentRow: (name) => ({ name, target_cents: 120000, created_at: AT, updated_at: AT }),
    children: [
      {
        table: 'goal_contributions',
        column: 'goal_id',
        onDelete: 'CASCADE',
        createdBy: '20261025120000_prd02_budgets_bills_goals_roles_dismissals.js',
        row: { amount_cents: 5000, contributed_at: AT },
      },
    ],
  },
]

// What a later migration must leave exactly as it found it. Child rows are
// compared whole, so a column added to or dropped from a child table also
// fails here; if that was deliberate, this test is the place to say so. The
// parent is compared by id only: adding a column to it is not the hazard.
type Survivors = {
  children: Record<string, Row[]>
  parentIds: number[]
  parentSequence: number | undefined
}

let db: Knex | undefined

afterEach(async () => {
  await db?.destroy()
  db = undefined
})

// Children whose table does not exist yet are left out.
async function survivors(db: Knex, guard: Guard, parentId: number): Promise<Survivors> {
  const children: Record<string, Row[]> = {}
  for (const child of guard.children) {
    if (await db.schema.hasTable(child.table)) {
      children[child.table] = await db(child.table).orderBy('id')
    }
  }
  return {
    children,
    parentIds: await db(guard.parent).where({ id: parentId }).pluck('id'),
    parentSequence: await sequence(db, guard.parent),
  }
}

function firstChildMigration(guard: Guard): string {
  return guard.children.map((child) => child.createdBy).sort()[0]
}

// Steps up through the migration that creates the parent's first child and
// writes the parent there, plus a later parent that is inserted and deleted,
// so the AUTOINCREMENT high-water mark sits above every live id (a rebuild
// copies the live rows into a new table, whose counter then restarts at the
// highest live id). Then steps up one migration at a time, writing each
// child's row as soon as the migration that creates its table has run.
// `before` holds the parent and each child as they were when written.
async function seed(db: Knex, guard: Guard): Promise<{ parentId: number; before: Survivors }> {
  let applied = firstChildMigration(guard)
  await migrateThrough(db, applied)

  const [parentId] = await db(guard.parent).insert(guard.parentRow('kept'))
  const [deletedId] = await db(guard.parent).insert(guard.parentRow('deleted'))
  await db(guard.parent).where({ id: deletedId }).delete()
  const before = await survivors(db, guard, parentId)
  // The seed itself, so a guard over an empty table cannot pass, and every
  // SET NULL column starts out set.
  expect(before.parentIds).toEqual([parentId])
  expect(before.parentSequence).toBe(deletedId)

  let waiting = guard.children
  for (;;) {
    for (const child of waiting.filter((c) => c.createdBy === applied)) {
      await db(child.table).insert({ ...child.row, [child.column]: parentId })
      before.children[child.table] = await db(child.table).orderBy('id')
      expect(before.children[child.table], child.table).toHaveLength(1)
      expect(before.children[child.table][0], child.table).toMatchObject({
        ...child.row,
        [child.column]: parentId,
      })
    }
    waiting = waiting.filter((c) => c.createdBy !== applied)
    if (waiting.length === 0) return { parentId, before }

    const [, log] = (await db.migrate.up()) as [number, string[]]
    expect(log, `stepping up towards ${waiting[0].createdBy}`).toHaveLength(1)
    applied = log[0]
  }
}

// The guard's check, shared with the canary so the canary exercises it
// rather than a copy.
async function expectSurvivedLatest(db: Knex, guard: Guard, parentId: number, before: Survivors) {
  expect(
    await survivors(db, guard, parentId),
    `children of ${guard.parent}, the parent row and its id counter after migrate:latest`,
  ).toStrictEqual(before)
}

// Every real migration, by file name as knex's directory source orders
// them. Read once here so a guard knows, while tests are collected, whether
// any migration runs after its seed point.
const MIGRATIONS = config.test.migrations.directory
function realMigrations(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((file) => file.endsWith('.js'))
    .sort()
}
function nothingRunsAfter(file: string): boolean {
  const real = realMigrations()
  return real.indexOf(file) === real.length - 1
}

// The real migrations, then one that rebuilds `parent` the way a careless
// later migration would: adding a column is native, and dropping it makes
// knex rebuild the table, leaving its rows as they were. Nothing is written
// to server/db/migrations/.
function canaryFile(parent: string): string {
  return `99999999999999_canary_rebuild_${parent}.js`
}
function withRebuild(parent: string): Knex.MigrationSource<{ file: string }> {
  const rebuild: Knex.Migration = {
    up: async (knex) => {
      await knex.schema.alterTable(parent, (table) => {
        table.string('canary_rebuild')
      })
      await knex.schema.alterTable(parent, (table) => {
        table.dropColumn('canary_rebuild')
      })
    },
    down: async () => {},
  }
  return {
    async getMigrations() {
      return [...realMigrations(), canaryFile(parent)].map((file) => ({ file }))
    },
    getMigrationName: (migration) => migration.file,
    async getMigration(migration) {
      if (migration.file === canaryFile(parent)) return rebuild
      return (await import(Path.join(MIGRATIONS, migration.file))) as Knex.Migration
    },
  }
}

it('guards every ON DELETE CASCADE or SET NULL foreign key in the latest schema', async () => {
  db = knex(config.test)
  await db.migrate.latest()
  const actual: string[] = []
  for (const table of await db('sqlite_master').where({ type: 'table' }).pluck('name')) {
    const keys: { table: string; from: string; on_delete: string }[] = await db.raw(
      'PRAGMA foreign_key_list(??)',
      [table],
    )
    for (const key of keys) {
      if (key.on_delete === 'NO ACTION' || key.on_delete === 'RESTRICT') continue
      actual.push(`${table}.${key.from} -> ${key.table} ON DELETE ${key.on_delete}`)
    }
  }

  const guarded = GUARDS.flatMap((guard) =>
    guard.children.map(
      (child) => `${child.table}.${child.column} -> ${guard.parent} ON DELETE ${child.onDelete}`,
    ),
  )
  expect(guarded.length).toBeGreaterThan(0)
  expect(guarded.sort()).toEqual(actual.sort())
})

describe.each(GUARDS)('migrations over the children of $parent (#134, #165)', (guard) => {
  const first = firstChildMigration(guard)
  const vacuous = nothingRunsAfter(first)

  it.skipIf(vacuous)(
    `leave every child of ${guard.parent}, the parent row and its id counter untouched${
      vacuous ? ` (skipped: no migration runs after ${first} yet)` : ''
    }`,
    async () => {
      db = knex(config.test)
      const { parentId, before } = await seed(db, guard)

      await db.migrate.latest()

      await expectSurvivedLatest(db, guard, parentId, before)
    },
  )

  it.each(guard.children)('$table is created by $createdBy, and not before', async (child) => {
    db = knex(config.test)
    await migrateToJustBefore(db, child.createdBy)
    expect(await db.schema.hasTable(child.table), 'before').toBe(false)
    await db.migrate.up()
    expect(await db.schema.hasTable(child.table), 'after').toBe(true)
  })

  // knex's directory source also loads `.ts` and `.cjs` files; the canary's
  // `.js` filter would silently skip one, so the two lists are pinned equal.
  it("canary's migration source lists the same real migrations as knex's directory source", async () => {
    db = knex(config.test)
    const [, pending] = (await db.migrate.list()) as [unknown, { file: string }[]]
    const canary = (await withRebuild(guard.parent).getMigrations([])).map((m) => m.file)
    expect(canary).toEqual([...pending.map((m) => m.file), canaryFile(guard.parent)])
  })

  it(`canary: a migration that rebuilds ${guard.parent} takes its children, and the guard catches it`, async () => {
    db = knex({ ...config.test, migrations: { migrationSource: withRebuild(guard.parent) } })
    const { parentId, before } = await seed(db, guard)

    await db.migrate.latest()

    // The reason the guard goes red: the rebuild kept the parent row but
    // the foreign keys fired on every child.
    expect(await db(guard.parent).where({ id: parentId }).pluck('id')).toEqual([parentId])
    for (const child of guard.children) {
      const rows: Row[] = await db(child.table)
      if (child.onDelete === 'CASCADE') expect(rows, child.table).toEqual([])
      else expect(rows.map((row) => row[child.column]), child.table).toEqual([null])
    }
    await expect(expectSurvivedLatest(db, guard, parentId, before)).rejects.toThrow(
      `children of ${guard.parent}, the parent row and its id counter after migrate:latest`,
    )
  })
})
