// The advisor audit sink (prd-03 Ruling 4; Done when 6, the write half).
// This test fails if:
//   - `schema.sql` holds anything but `CREATE TABLE IF NOT EXISTS`.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const AUDIT_DIR = fileURLToPath(new URL('../', import.meta.url))
const SCHEMA_SQL = readFileSync(join(AUDIT_DIR, 'schema.sql'), 'utf8')

// ---- schema.sql ----

describe('schema.sql', () => {
  it('is idempotent by construction: every statement is CREATE TABLE IF NOT EXISTS advisor_audit', () => {
    const statements = SCHEMA_SQL.replace(/--[^\n]*/g, '')
      .split(';')
      .map((statement) => statement.trim())
      .filter((statement) => statement.length > 0)
    expect(statements.length).toBeGreaterThan(0)
    for (const statement of statements) expect(statement).toMatch(/^CREATE TABLE IF NOT EXISTS advisor_audit \(/)
  })
})
