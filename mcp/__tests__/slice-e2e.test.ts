// The thinnest end-to-end slice (prd-03 Ruling 1, Ruling 2, Ruling 4; #80
// Done when 4, 5). This test fails if:
//   - the entry does not serve a call through the real replica reader and
//     the real audit sink that `createContext` wires in;
//   - a successful `get_sync_status` returns no `data_as_of`, or leaves
//     anything but exactly one `ok` row in the audit file;
//   - a rejected call (`scope: "everyone"`) returns data, is not answered
//     `invalid_arguments`, or is not recorded as exactly one `rejected` row;
//   - a valid `get_safe_to_spend` returns no `data_as_of`, or leaves anything
//     but exactly one more `ok` row in the audit file (#473).
//
// It spawns the entry the way the guard test does: a constructed clean
// environment and scratch replica and audit paths, never the PRD defaults.
// The audit file is read directly with sqlite3, not through the sink.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import sqlite3 from 'sqlite3'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { AUDIT_PATH_ENV, REPLICA_PATH_ENV } from '../contracts.ts'
import { all, close, openDatabase, run } from '../replica/scrub.ts'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const ENTRY = 'mcp/index.ts'
const TSX_CLI = join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs')
const PROCESS_TIMEOUT_MS = 30_000

const SCRATCH = mkdtempSync(join(tmpdir(), 'divvy-mcp-slice-'))
const REPLICA = join(SCRATCH, 'replica.sqlite3')
const AUDIT = join(SCRATCH, 'audit.sqlite3')
const CLEAN_ENV: Record<string, string> = {
  PATH: process.env.PATH ?? '',
  [REPLICA_PATH_ENV]: REPLICA,
  [AUDIT_PATH_ENV]: AUDIT,
}

const META = { built_at: '2026-10-28T01:00:05.000Z', last_sync_at: '2026-10-28T00:58:00.000Z', data_as_of: '2026-10-28T01:00:00.000Z' }

interface AuditRow {
  id: number
  tool: string
  params_json: string
  row_count: number | null
  outcome: string
}

/**
 * A replica holding what `get_sync_status` and `get_safe_to_spend` read, in
 * the scrub's schema: one personal current account and nothing else, so the
 * safe-to-spend tables exist and the settings take their defaults.
 */
async function writeReplica(): Promise<void> {
  const db = await openDatabase(REPLICA, sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE)
  try {
    await run(db, 'CREATE TABLE replica_meta (built_at TEXT NOT NULL, last_sync_at TEXT, data_as_of TEXT NOT NULL)')
    await run(db, 'INSERT INTO replica_meta VALUES (?, ?, ?)', [META.built_at, META.last_sync_at, META.data_as_of])
    await run(db, 'CREATE TABLE sync_runs (started_at datetime, finished_at datetime, outcome text)')
    await run(db, 'INSERT INTO sync_runs VALUES (?, ?, ?)', ['2026-10-28T00:57:00.000Z', META.last_sync_at, 'success'])
    await run(db, 'CREATE TABLE settings (key varchar(255), value text)')
    await run(
      db,
      'CREATE TABLE accounts (id integer, akahu_id varchar(255), source text, scope text, name varchar(255), balance_cents integer)',
    )
    await run(db, 'INSERT INTO accounts VALUES (?, ?, ?, ?, ?, ?)', [1, 'acc_1', 'akahu', 'personal', 'Everyday', 123456])
    await run(db, 'CREATE TABLE account_settings (account_id integer, role text)')
    await run(db, 'INSERT INTO account_settings VALUES (?, ?)', [1, 'current'])
    await run(
      db,
      'CREATE TABLE bills (id integer, scope text, name varchar(255), amount_cents integer, repeat text, first_due_date date)',
    )
    await run(db, 'CREATE TABLE bill_payments (bill_id integer, due_date date)')
    await run(db, 'CREATE TABLE budgets (id integer, scope text, category varchar(255), limit_cents integer)')
    await run(
      db,
      'CREATE TABLE transactions (id integer, account_id varchar(255), source text, date datetime, amount_cents integer, category varchar(255), category_source text, status text)',
    )
  } finally {
    await close(db)
  }
}

async function auditRows(): Promise<AuditRow[]> {
  const db = await openDatabase(AUDIT, sqlite3.OPEN_READONLY)
  try {
    return await all<AuditRow>(db, 'SELECT id, tool, params_json, row_count, outcome FROM advisor_audit ORDER BY id')
  } finally {
    await close(db)
  }
}

function bodyOf(result: CallToolResult): unknown {
  const first = result.content[0]
  if (first?.type !== 'text') throw new Error('expected a text content block')
  return JSON.parse(first.text)
}

let client: Client

beforeAll(async () => {
  await writeReplica()
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [TSX_CLI, ENTRY],
    cwd: ROOT,
    env: CLEAN_ENV,
    stderr: 'pipe',
  })
  client = new Client({ name: 'slice-e2e-test', version: '0.0.0' })
  await client.connect(transport)
}, PROCESS_TIMEOUT_MS)

afterAll(async () => {
  await client.close()
  rmSync(SCRATCH, { recursive: true, force: true })
})

// The calls share one entry and one audit file, so they run in order.
describe('the entry, wired to the real replica and audit sink', () => {
  it(
    'answers get_sync_status from the replica and records exactly one ok row',
    async () => {
      const result = (await client.callTool({ name: 'get_sync_status', arguments: {} })) as CallToolResult

      expect(result.isError).toBeFalsy()
      expect(bodyOf(result)).toMatchObject({
        data_as_of: META.data_as_of,
        last_sync_at: META.last_sync_at,
        last_sync_status: 'success',
        replica_built_at: META.built_at,
      })
      expect(result.structuredContent).toMatchObject({ data_as_of: META.data_as_of })

      const rows = await auditRows()
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ tool: 'get_sync_status', outcome: 'ok', row_count: 1 })
      expect(JSON.parse(rows[0].params_json)).toEqual({})
    },
    PROCESS_TIMEOUT_MS,
  )

  it(
    'refuses get_safe_to_spend for scope "everyone" with no data, and records exactly one rejected row',
    async () => {
      const result = (await client.callTool({
        name: 'get_safe_to_spend',
        arguments: { scope: 'everyone' },
      })) as CallToolResult

      expect(result.isError).toBe(true)
      expect(result.structuredContent).toBeUndefined()
      const body = bodyOf(result) as { error?: { code?: string } }
      expect(Object.keys(body)).toEqual(['error'])
      expect(body.error?.code).toBe('invalid_arguments')
      expect(JSON.stringify(body)).not.toContain('data_as_of')

      const rows = await auditRows()
      expect(rows).toHaveLength(2)
      expect(rows[1]).toMatchObject({ tool: 'get_safe_to_spend', outcome: 'rejected', row_count: null })
      expect(JSON.parse(rows[1].params_json)).toEqual({ scope: 'everyone' })
    },
    PROCESS_TIMEOUT_MS,
  )

  it(
    'answers get_safe_to_spend for a valid scope from the replica and records exactly one ok row',
    async () => {
      const result = (await client.callTool({
        name: 'get_safe_to_spend',
        arguments: { scope: 'personal' },
      })) as CallToolResult

      expect(result.isError).toBeFalsy()
      expect(bodyOf(result)).toMatchObject({ data_as_of: META.data_as_of, scope: 'personal', liquid_cents: 123456 })
      expect(result.structuredContent).toMatchObject({ data_as_of: META.data_as_of })

      const rows = await auditRows()
      expect(rows).toHaveLength(3)
      // The account and its role row; every other table is empty.
      expect(rows[2]).toMatchObject({ tool: 'get_safe_to_spend', outcome: 'ok', row_count: 2 })
      expect(JSON.parse(rows[2].params_json)).toEqual({ scope: 'personal' })
    },
    PROCESS_TIMEOUT_MS,
  )
})
