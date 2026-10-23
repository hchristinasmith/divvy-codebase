// The advisor audit sink (prd-03 Ruling 4; Done when 6, the write half).
// This test fails if:
//   - `schema.sql` holds anything but `CREATE TABLE IF NOT EXISTS`, a column
//     goes missing, or a second open changes or duplicates the schema;
//   - a call through the real dispatcher leaves no row or two;
//   - the sink imports anything beyond node:fs, node:path, sqlite3 and the
//     contract, or `index.ts` exports more than `createAuditSink`.
//
// Every test works in its own mkdtemp directory, removed afterwards.

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import sqlite3 from 'sqlite3'
import ts from 'typescript'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { READ_ONLY_ANNOTATIONS, UNKNOWN_TOOL, WAVE2_MODULES } from '../../contracts.ts'
import type {
  AuditModule,
  AuditRecord,
  AuditSink,
  Clock,
  HandlerOutcome,
  ReplicaReader,
  ToolContext,
  ToolDefinition,
} from '../../contracts.ts'
import { dispatchToolCall } from '../../tools/registry.ts'
import * as auditModule from '../index.ts'
import { createAuditSink } from '../sink.ts'

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const AUDIT_DIR = fileURLToPath(new URL('../', import.meta.url))
const SCHEMA_SQL = readFileSync(join(AUDIT_DIR, 'schema.sql'), 'utf8')

const SENTINEL = 'SENTINEL-7f3a9c-returned-data'
const AS_OF = '2026-10-23T00:00:00.000Z'
const START = '2026-10-23T01:02:03.000Z'
const TICK_MS = 37

const COLUMNS = ['at', 'duration_ms', 'id', 'outcome', 'params_json', 'row_count', 'tool']

// ---- Scratch directories ----

const scratchDirs: string[] = []

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'divvy-audit-'))
  scratchDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

// ---- Reading the file back, read-only ----

interface AuditRow {
  id: number
  at: string
  tool: string
  params_json: string
  row_count: number | null
  outcome: string
  duration_ms: number
}

function openReadOnly(path: string): Promise<sqlite3.Database> {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(path, sqlite3.OPEN_READONLY, (error) => (error ? reject(error) : resolve(db)))
  })
}

function all<T>(db: sqlite3.Database, sql: string): Promise<T[]> {
  return new Promise((resolve, reject) => {
    db.all<T>(sql, (error, rows) => (error ? reject(error) : resolve(rows)))
  })
}

function close(db: sqlite3.Database): Promise<void> {
  return new Promise((resolve, reject) => db.close((error) => (error ? reject(error) : resolve())))
}

async function query<T>(path: string, sql: string): Promise<T[]> {
  const db = await openReadOnly(path)
  try {
    return await all<T>(db, sql)
  } finally {
    await close(db)
  }
}

function readRows(path: string): Promise<AuditRow[]> {
  return query<AuditRow>(path, 'SELECT * FROM advisor_audit ORDER BY id')
}

// ---- The dispatcher's context, with the real sink ----

function fixedClock(): Clock {
  let tick = Date.parse(START)
  return {
    now: () => {
      const at = new Date(tick)
      tick += TICK_MS
      return at
    },
  }
}

const unusedReplica: ReplicaReader = {
  meta: () => Promise.reject(new Error('the fake tools never read the replica')),
  select: () => Promise.reject(new Error('the fake tools never read the replica')),
}

function contextFor(audit: AuditSink): ToolContext {
  return { replica: unusedReplica, audit, clock: fixedClock() }
}

function fakeTool<S extends z.ZodObject>(name: string, inputSchema: S, handler: () => Promise<HandlerOutcome>): ToolDefinition {
  return { name, title: name, description: name, inputSchema, annotations: READ_ONLY_ANNOTATIONS, handler }
}

const scopeInput = z.strictObject({ scope: z.enum(['personal', 'strawb']) })

const okTool = fakeTool('fake_ok', scopeInput, async () => ({
  ok: true,
  result: { data_as_of: AS_OF, note: SENTINEL, amount_cents: 1234 },
  rowCount: 3,
}))
const throwingTool = fakeTool('fake_throws', scopeInput, async () => {
  throw new Error(`no such table: ${SENTINEL}`)
})
const refusingTool = fakeTool('fake_refuses', scopeInput, async () => ({
  ok: false,
  error: { code: 'internal_error' },
}))
// Accepts any string, however long, so an oversized parameter reaches the
// sink on the ok path, where the dispatcher does not bound it.
const blobTool = fakeTool('fake_blob', z.strictObject({ blob: z.string() }), async () => ({
  ok: true,
  result: { data_as_of: AS_OF, note: SENTINEL },
  rowCount: null,
}))
const FAKE_TOOLS: readonly ToolDefinition[] = [okTool, throwingTool, refusingTool, blobTool]

function call(audit: AuditSink, name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  return dispatchToolCall(name, args, contextFor(audit), FAKE_TOOLS)
}

function errorCode(result: CallToolResult): string {
  const content = result.content[0]
  if (content?.type !== 'text') throw new Error('expected a text result')
  return (JSON.parse(content.text) as { error: { code: string } }).error.code
}

function validRecord(overrides: Partial<Record<keyof AuditRecord, unknown>> = {}): AuditRecord {
  return {
    at: START,
    tool: 'get_goals',
    params: {},
    rowCount: null,
    outcome: 'ok',
    durationMs: 12,
    ...overrides,
  } as AuditRecord
}

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

// ---- One durable row per record ----

describe('the audit file', () => {
  it('has exactly the advisor_audit columns, and a row carries exactly them', async () => {
    const path = join(scratch(), 'audit.sqlite3')
    await createAuditSink({ path }).record(validRecord())
    const columns = await query<{ name: string }>(path, "SELECT name FROM pragma_table_info('advisor_audit')")
    expect(columns.map((column) => column.name).sort()).toEqual(COLUMNS)
    const [row] = await readRows(path)
    expect(Object.keys(row).sort()).toEqual(COLUMNS)
  })

  it('keeps its schema unchanged and single when a second sink opens it', async () => {
    const path = join(scratch(), 'audit.sqlite3')
    const schemaOf = () => query<{ type: string; name: string; sql: string | null }>(path, 'SELECT type, name, sql FROM sqlite_master ORDER BY type, name')

    await createAuditSink({ path }).record(validRecord({ tool: 'first' }))
    const before = await schemaOf()
    await createAuditSink({ path }).record(validRecord({ tool: 'second' }))
    const after = await schemaOf()

    expect(after).toEqual(before)
    expect(JSON.stringify(after)).toBe(JSON.stringify(before))
    expect(after.filter((entry) => entry.name === 'advisor_audit')).toHaveLength(1)
    const rows = await readRows(path)
    expect(rows.map((row) => [row.id, row.tool])).toEqual([
      [1, 'first'],
      [2, 'second'],
    ])
  })
})

describe('through the real dispatcher, each call leaves exactly one row', () => {
  it('a successful call: every field as recorded', async () => {
    const path = join(scratch(), 'audit.sqlite3')
    const result = await call(createAuditSink({ path }), 'fake_ok', { scope: 'personal' })
    expect(result.isError).toBeUndefined()

    const rows = await readRows(path)
    expect(rows).toHaveLength(1)
    expect(Object.keys(rows[0]).sort()).toEqual(COLUMNS)
    expect(rows[0]).toEqual({
      id: 1,
      at: START,
      tool: 'fake_ok',
      params_json: '{"scope":"personal"}',
      row_count: 3,
      outcome: 'ok',
      duration_ms: TICK_MS,
    })
  })

  it.each([
    ['invalid arguments', 'fake_ok', { scope: 'nobody' }, 'fake_ok', 'rejected', 'invalid_arguments'],
    ['an unknown tool', 'drop_table', { scope: 'personal' }, UNKNOWN_TOOL, 'rejected', 'unknown_tool'],
    ['a throwing handler', 'fake_throws', { scope: 'personal' }, 'fake_throws', 'error', 'internal_error'],
    ['a refusing handler', 'fake_refuses', { scope: 'strawb' }, 'fake_refuses', 'error', 'internal_error'],
  ])('%s', async (_label, name, args, tool, outcome, code) => {
    const path = join(scratch(), 'audit.sqlite3')
    const result = await call(createAuditSink({ path }), name, args)
    expect(errorCode(result)).toBe(code)

    const rows = await readRows(path)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ tool, outcome, row_count: null, at: START, duration_ms: TICK_MS })
  })
})

describe('the module surface', () => {
  const specifiers = (file: string) =>
    ts.preProcessFile(readFileSync(join(AUDIT_DIR, file), 'utf8'), true, true).importedFiles.map((f) => f.fileName)

  it('imports only node:fs, node:path, sqlite3 and the contract: no replica, server or other database', () => {
    const allowed = ['node:fs', 'node:path', 'sqlite3', '../contracts.ts', './sink.ts']
    for (const file of ['sink.ts', 'index.ts']) {
      for (const spec of specifiers(file)) expect(allowed, `${file} imports ${spec}`).toContain(spec)
    }
    expect(specifiers('index.ts')).toEqual(['./sink.ts'])
  })

  it('index.ts exports createAuditSink and nothing else, at the path the contract names', () => {
    expect(Object.keys(auditModule)).toEqual(['createAuditSink'])
    const typed: AuditModule = auditModule
    expect(typed.createAuditSink).toBe(createAuditSink)
    expect(WAVE2_MODULES.audit).toEqual({ path: 'mcp/audit/index.ts', exportName: 'createAuditSink' })
    expect(existsSync(join(ROOT, WAVE2_MODULES.audit.path))).toBe(true)
  })

  it.each([[''], ['relative/audit.sqlite3'], [':memory:'], ['file:/tmp/audit.sqlite3?mode=rwc']])(
    'refuses %j as a path, before any I/O',
    (path) => {
      expect(() => createAuditSink({ path })).toThrow(new TypeError('the audit path must be an absolute file path'))
    },
  )
})
