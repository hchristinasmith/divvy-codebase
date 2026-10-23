// The advisor audit sink (prd-03 Ruling 4; Done when 6, the write half).
// This test fails if:
//   - `schema.sql` holds anything but `CREATE TABLE IF NOT EXISTS`, a column
//     goes missing, or a second open changes or duplicates the schema;
//   - a call through the real dispatcher leaves no row or two;
//   - returned data or error text reaches the file, or a parameter can grow
//     a row without bound;
//   - a record breaking the contract is stored instead of refused;
//   - records land out of call order, or a second writer fails on a lock;
//   - an unwritable path, missing directory or non-database file lets data
//     through, or a failure sticks after the cause is gone;
//   - the file is left in WAL mode, or cannot be read with a read-only open;
//   - the sink imports anything beyond node:fs, node:path, sqlite3 and the
//     contract, or `index.ts` exports more than `createAuditSink`.
//
// Every test works in its own mkdtemp directory, removed afterwards.

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import sqlite3 from 'sqlite3'
import ts from 'typescript'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
import { MAX_REJECTED_PARAMS_LENGTH, dispatchToolCall } from '../../tools/registry.ts'
import * as auditModule from '../index.ts'
import { MAX_AUDIT_PARAMS_LENGTH, createAuditSink } from '../sink.ts'

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

/** Every file in `dir` whose raw bytes contain `needle`. */
function filesContaining(dir: string, needle: string): string[] {
  return readdirSync(dir).filter((name) => readFileSync(join(dir, name)).includes(needle))
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

// ---- What a row may hold ----

describe('returned data is never stored', () => {
  it('a result and an exception carrying the sentinel leave it nowhere in the directory', async () => {
    const dir = scratch()
    const sink = createAuditSink({ path: join(dir, 'audit.sqlite3') })
    const ok = await call(sink, 'fake_ok', { scope: 'personal' })
    expect(JSON.stringify(ok)).toContain(SENTINEL)
    await call(sink, 'fake_throws', { scope: 'personal' })
    await call(sink, 'fake_blob', { blob: 'short' })

    expect(await readRows(join(dir, 'audit.sqlite3'))).toHaveLength(3)
    expect(readdirSync(dir)).toEqual(['audit.sqlite3'])
    expect(filesContaining(dir, SENTINEL)).toEqual([])
  })

  it('positive control: the same scan finds the sentinel when it is a validated parameter', async () => {
    const dir = scratch()
    await call(createAuditSink({ path: join(dir, 'audit.sqlite3') }), 'fake_blob', { blob: SENTINEL })
    expect(filesContaining(dir, SENTINEL)).toEqual(['audit.sqlite3'])
  })

  it('stray result and error keys on a record are ignored, not stored', async () => {
    const dir = scratch()
    const entry = { ...validRecord(), result: { note: SENTINEL }, error: new Error(SENTINEL) }
    await createAuditSink({ path: join(dir, 'audit.sqlite3') }).record(entry)
    const rows = await readRows(join(dir, 'audit.sqlite3'))
    expect(rows).toHaveLength(1)
    expect(rows[0].params_json).toBe('{}')
    expect(filesContaining(dir, SENTINEL)).toEqual([])
  })
})

describe('parameters are bounded', () => {
  const oversized = (length: number) => JSON.stringify({ oversized_params_length: length })

  it('uses the same bound as the dispatcher', () => {
    expect(MAX_AUDIT_PARAMS_LENGTH).toBe(MAX_REJECTED_PARAMS_LENGTH)
  })

  it('a 5 MB parameter on the ok path is stored as its length only', async () => {
    const dir = scratch()
    const path = join(dir, 'audit.sqlite3')
    const blob = 'x'.repeat(5 * 1024 * 1024)
    const result = await call(createAuditSink({ path }), 'fake_blob', { blob })
    expect(result.isError).toBeUndefined()

    const rows = await readRows(path)
    expect(rows).toHaveLength(1)
    expect(rows[0].params_json).toBe(oversized(JSON.stringify({ blob }).length))
    expect(statSync(path).size).toBeLessThan(64 * 1024)
  })

  it("passes the dispatcher's own marker for an oversized rejected call through as given", async () => {
    const path = join(scratch(), 'audit.sqlite3')
    const args = { scope: 'x'.repeat(5000) }
    await call(createAuditSink({ path }), 'fake_ok', args)
    const rows = await readRows(path)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ outcome: 'rejected', params_json: oversized(JSON.stringify(args).length) })
  })

  it('stores JSON of exactly the bound verbatim and one character more as the marker', async () => {
    const path = join(scratch(), 'audit.sqlite3')
    const sink = createAuditSink({ path })
    // A string's JSON is the string plus its two quotes.
    const atBound = 'a'.repeat(MAX_AUDIT_PARAMS_LENGTH - 2)
    const overBound = 'b'.repeat(MAX_AUDIT_PARAMS_LENGTH - 1)
    await sink.record(validRecord({ params: atBound }))
    await sink.record(validRecord({ params: overBound }))
    const rows = await readRows(path)
    expect(rows[0].params_json).toBe(JSON.stringify(atBound))
    expect(rows[0].params_json).toHaveLength(MAX_AUDIT_PARAMS_LENGTH)
    expect(rows[1].params_json).toBe(oversized(MAX_AUDIT_PARAMS_LENGTH + 1))
  })
})

describe('parameters that do not serialise', () => {
  const cycle: Record<string, unknown> = {}
  cycle.self = cycle
  let deep: unknown = 'bottom'
  for (let i = 0; i < 100_000; i++) deep = [deep]

  it.each([
    ['undefined', undefined],
    ['a function', () => SENTINEL],
    ['a BigInt', BigInt(1)],
    ['a cycle', cycle],
    ['a throwing toJSON', { toJSON: () => { throw new Error(SENTINEL) } }],
    ['a very deep nest', deep],
  ])('%s is stored as the unserialisable marker, in one row', async (_label, params) => {
    const dir = scratch()
    const path = join(dir, 'audit.sqlite3')
    await createAuditSink({ path }).record(validRecord({ params }))
    const rows = await readRows(path)
    expect(rows).toHaveLength(1)
    expect(rows[0].params_json).toBe('{"unserialisable_params":true}')
    expect(filesContaining(dir, SENTINEL)).toEqual([])
  })

  it('null is stored as null', async () => {
    const path = join(scratch(), 'audit.sqlite3')
    await createAuditSink({ path }).record(validRecord({ params: null }))
    expect((await readRows(path))[0].params_json).toBe('null')
  })
})

describe('a record that breaks the contract is refused before the file is touched', () => {
  const BAD = 'BAD-VALUE-4e1d'

  it.each([
    ['outcome', { outcome: BAD }],
    ['outcome', { outcome: undefined }],
    ['durationMs', { durationMs: -1 }],
    ['durationMs', { durationMs: Number.NaN }],
    ['durationMs', { durationMs: Number.POSITIVE_INFINITY }],
    ['durationMs', { durationMs: BAD }],
    ['durationMs', { durationMs: Number.MAX_SAFE_INTEGER + 1 }],
    ['rowCount', { rowCount: -1 }],
    ['rowCount', { rowCount: 1.5 }],
    ['rowCount', { rowCount: undefined }],
    ['rowCount', { rowCount: BAD }],
    ['at', { at: '2026-10-23T01:02:03Z' }],
    ['at', { at: '2026-10-23T01:02:03.000+00:00' }],
    ['at', { at: BAD }],
    ['at', { at: '+010000-01-01T00:00:00.000Z' }],
    ['tool', { tool: '' }],
    ['tool', { tool: `${BAD}${'x'.repeat(64)}` }],
    ['tool', { tool: `${BAD}\nforged` }],
    ['tool', { tool: `${BAD}‮` }],
    ['tool', { tool: 42 }],
  ])('%s: %j', async (field, overrides) => {
    const dir = scratch()
    const path = join(dir, 'audit.sqlite3')
    const error = await createAuditSink({ path }).record(validRecord(overrides)).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(TypeError)
    expect((error as TypeError).message).toBe(`invalid audit record: ${field}`)
    expect((error as TypeError).message).not.toContain(BAD)
    expect(existsSync(path)).toBe(false)
  })

  it('entry: null', async () => {
    const path = join(scratch(), 'audit.sqlite3')
    const sink = createAuditSink({ path })
    await expect(sink.record(null as unknown as AuditRecord)).rejects.toThrow(new TypeError('invalid audit record: entry'))
    expect(existsSync(path)).toBe(false)
  })

  it('accepts the boundaries: rowCount 0, rowCount null, durationMs 0, a fractional duration rounded', async () => {
    const path = join(scratch(), 'audit.sqlite3')
    const sink = createAuditSink({ path })
    await sink.record(validRecord({ rowCount: 0, durationMs: 0 }))
    await sink.record(validRecord({ rowCount: null, durationMs: 2.6 }))
    const rows = await readRows(path)
    expect(rows.map((row) => [row.row_count, row.duration_ms])).toEqual([
      [0, 0],
      [null, 3],
    ])
  })
})

describe('records are written one at a time, in call order', () => {
  it('25 concurrent records from one sink land in the order they were called', async () => {
    const path = join(scratch(), 'audit.sqlite3')
    const sink = createAuditSink({ path })
    const tools = Array.from({ length: 25 }, (_, i) => `tool_${String(i).padStart(2, '0')}`)
    await Promise.all(tools.map((tool) => sink.record(validRecord({ tool }))))
    expect((await readRows(path)).map((row) => row.tool)).toEqual(tools)
  })

  // Two sinks on one file are two writers. With a deferred BEGIN this goes red
  // only when their writes collide (one fails on the lock upgrade), so it is a
  // probabilistic check. The busy timeout has its own test below.
  it('two sinks writing ten records each to one file both succeed', async () => {
    const path = join(scratch(), 'audit.sqlite3')
    const a = createAuditSink({ path })
    const b = createAuditSink({ path })
    const writes = Array.from({ length: 10 }, (_, i) => [
      a.record(validRecord({ tool: `a_${i}` })),
      b.record(validRecord({ tool: `b_${i}` })),
    ]).flat()
    await Promise.all(writes)
    expect(await readRows(path)).toHaveLength(20)
  })

  // Another connection holds the write lock for 1.5 s: longer than the 1 s
  // node-sqlite3 sets on every open, shorter than BUSY_TIMEOUT_MS. Red if the
  // sink stops raising the timeout.
  it('waits past the driver default for another connection to release the write lock', async () => {
    const path = join(scratch(), 'audit.sqlite3')
    await createAuditSink({ path }).record(validRecord({ tool: 'first' }))
    const holder = await createDatabase(path)
    await exec(holder, 'BEGIN IMMEDIATE')
    const pending = createAuditSink({ path }).record(validRecord({ tool: 'waited' }))
    await new Promise((resolve) => setTimeout(resolve, 1500))
    await exec(holder, 'COMMIT')
    await close(holder)
    await pending
    expect((await readRows(path)).map((row) => row.tool)).toEqual(['first', 'waited'])
  })

  it('a failed record does not stop the ones queued behind it', async () => {
    const path = join(scratch(), 'audit.sqlite3')
    const sink = createAuditSink({ path })
    const results = await Promise.allSettled([
      sink.record(validRecord({ tool: 'before' })),
      sink.record(validRecord({ outcome: 'nonsense' as AuditRecord['outcome'] })),
      sink.record(validRecord({ tool: 'after' })),
    ])
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected', 'fulfilled'])
    expect((await readRows(path)).map((row) => row.tool)).toEqual(['before', 'after'])
  })
})

// ---- Failing closed ----

describe('an audit file that cannot be written fails closed', () => {
  // The dispatcher reports each failed record on stderr; capture it rather
  // than print it, and count it as evidence the sink rejected.
  const quiet = () => vi.spyOn(console, 'error').mockImplementation(() => undefined)
  let stderr: ReturnType<typeof quiet>
  beforeEach(() => {
    stderr = quiet()
  })
  afterEach(() => {
    stderr.mockRestore()
  })

  it.each([
    ['a successful call', 'fake_ok', { scope: 'personal' }],
    ['a rejected call', 'fake_ok', { scope: 'nobody' }],
    ['a throwing handler', 'fake_throws', { scope: 'personal' }],
    ['an unknown tool', 'drop_table', {}],
  ])('a missing directory: %s returns audit_unavailable and no data', async (_label, name, args) => {
    const missing = join(scratch(), 'missing')
    const result = await call(createAuditSink({ path: join(missing, 'audit.sqlite3') }), name, args)
    expect(errorCode(result)).toBe('audit_unavailable')
    expect(result.structuredContent).toBeUndefined()
    expect(JSON.stringify(result)).not.toContain(SENTINEL)
    expect(existsSync(missing)).toBe(false)
    expect(stderr).toHaveBeenCalledTimes(1)
  })

  it.skipIf(process.getuid?.() === 0)('a directory without write permission: no data returned, no file made', async () => {
    const locked = join(scratch(), 'locked')
    mkdirSync(locked, { mode: 0o555 })
    try {
      const result = await call(createAuditSink({ path: join(locked, 'audit.sqlite3') }), 'fake_ok', { scope: 'personal' })
      expect(errorCode(result)).toBe('audit_unavailable')
      expect(JSON.stringify(result)).not.toContain(SENTINEL)
      expect(readdirSync(locked)).toEqual([])
    } finally {
      chmodSync(locked, 0o755)
    }
  })

  // SQLite opens a write-protected file read-only without complaint; the
  // write must still fail rather than the call return data unlogged.
  it.skipIf(process.getuid?.() === 0)('a read-only audit file: no data returned, no row added', async () => {
    const path = join(scratch(), 'audit.sqlite3')
    await createAuditSink({ path }).record(validRecord({ tool: 'before' }))
    chmodSync(path, 0o444)
    try {
      const result = await call(createAuditSink({ path }), 'fake_ok', { scope: 'personal' })
      expect(errorCode(result)).toBe('audit_unavailable')
      expect(JSON.stringify(result)).not.toContain(SENTINEL)
      expect((await readRows(path)).map((row) => row.tool)).toEqual(['before'])
    } finally {
      chmodSync(path, 0o644)
    }
  })

  it('is not sticky: once the directory exists, the same sink records', async () => {
    const missing = join(scratch(), 'missing')
    const path = join(missing, 'audit.sqlite3')
    const sink = createAuditSink({ path })
    await expect(sink.record(validRecord())).rejects.toThrow()
    mkdirSync(missing)
    await sink.record(validRecord({ tool: 'after_mkdir' }))
    expect((await readRows(path)).map((row) => row.tool)).toEqual(['after_mkdir'])
  })

  it('a file that is not a database: no data returned, its bytes unchanged', async () => {
    const dir = scratch()
    const path = join(dir, 'audit.sqlite3')
    const garbage = Buffer.from('this is not a SQLite database\n'.repeat(200))
    writeFileSync(path, garbage)
    const result = await call(createAuditSink({ path }), 'fake_ok', { scope: 'personal' })
    expect(errorCode(result)).toBe('audit_unavailable')
    expect(JSON.stringify(result)).not.toContain(SENTINEL)
    expect(readFileSync(path).equals(garbage)).toBe(true)
    expect(readdirSync(dir)).toEqual(['audit.sqlite3'])
  })
})

// ---- The journal, and the web app's read-only open ----

function createDatabase(path: string): Promise<sqlite3.Database> {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(path, (error) => (error ? reject(error) : resolve(db)))
  })
}

function exec(db: sqlite3.Database, sql: string): Promise<void> {
  return new Promise((resolve, reject) => db.exec(sql, (error) => (error ? reject(error) : resolve())))
}

describe('the audit file keeps a rollback journal', () => {
  // The only test that goes red if the sink stops setting journal_mode: a
  // fresh file starts in DELETE mode anyway, so this one starts in WAL.
  it('switches a WAL-mode file to journal_mode=delete and leaves no -wal or -shm', async () => {
    const dir = scratch()
    const path = join(dir, 'audit.sqlite3')
    const fixture = await createDatabase(path)
    await exec(fixture, 'PRAGMA journal_mode = WAL; CREATE TABLE unrelated (x INTEGER);')
    await close(fixture)
    expect(readFileSync(path)[18]).toBe(2) // header: WAL

    await createAuditSink({ path }).record(validRecord())

    expect(readFileSync(path)[18]).toBe(1) // header: legacy rollback journal
    expect(await query<{ journal_mode: string }>(path, 'PRAGMA journal_mode')).toEqual([{ journal_mode: 'delete' }])
    expect(readdirSync(dir)).toEqual(['audit.sqlite3'])
  })

  it('a quiescent file reads with a read-only open and the directory is unchanged', async () => {
    const dir = scratch()
    const path = join(dir, 'audit.sqlite3')
    await createAuditSink({ path }).record(validRecord({ tool: 'read_me' }))
    const listing = readdirSync(dir)
    expect((await readRows(path)).map((row) => row.tool)).toEqual(['read_me'])
    expect(readdirSync(dir)).toEqual(listing)
  })

  // Stands in for the web app, a different user with no write access to the
  // file or its directory. Root ignores permissions, so it proves nothing there.
  it.skipIf(process.getuid?.() === 0)('reads read-only with the file 0444 and the directory 0555', async () => {
    const dir = scratch()
    const path = join(dir, 'audit.sqlite3')
    await createAuditSink({ path }).record(validRecord({ tool: 'read_me' }))
    chmodSync(path, 0o444)
    chmodSync(dir, 0o555)
    try {
      expect((await readRows(path)).map((row) => row.tool)).toEqual(['read_me'])
      expect(readdirSync(dir)).toEqual(['audit.sqlite3'])
    } finally {
      chmodSync(dir, 0o755)
      chmodSync(path, 0o644)
    }
  })
})
