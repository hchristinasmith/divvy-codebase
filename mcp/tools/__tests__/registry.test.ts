// The advisor's tool surface, pinned (prd-03 Ruling 1, Ruling 4; Done when
// 4, 6, 7). This pins names and input schemas, never stub output, so later
// lanes fill handlers without touching this file. Editing it to make a
// change pass is a finding (prd-03, "The one risk worth watching").

import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { READ_ONLY_ANNOTATIONS, UNKNOWN_TOOL, staticSql } from '../../contracts.ts'
import type {
  AuditRecord,
  AuditSink,
  Clock,
  HandlerOutcome,
  ReplicaReader,
  ToolContext,
  ToolDefinition,
} from '../../contracts.ts'
import { MAX_LIMIT, MAX_RANGE_DAYS, SCOPES, noInputSchema, scopeSchema } from '../common.ts'
import { TOOLS, TOOL_NAMES, createToolServer, describeTools, dispatchToolCall } from '../registry.ts'

// ---- The fixed list, written out independently of the registry ----

const EXPECTED_TOOLS = [
  'get_safe_to_spend',
  'list_transactions',
  'get_budgets',
  'get_bills',
  'get_goals',
  'get_habits',
  'get_sync_status',
]

// Per tool: every property it accepts and which are required.
const EXPECTED_INPUTS: Record<string, { properties: string[]; required: string[] }> = {
  get_safe_to_spend: { properties: ['scope'], required: ['scope'] },
  list_transactions: {
    properties: ['scope', 'from', 'to', 'category', 'limit'],
    required: ['scope', 'from', 'to'],
  },
  get_budgets: { properties: ['scope'], required: ['scope'] },
  get_bills: { properties: ['scope'], required: ['scope'] },
  get_goals: { properties: [], required: [] },
  get_habits: { properties: [], required: [] },
  get_sync_status: { properties: [], required: [] },
}

// A name token that would make a tool sound like it changes something.
const WRITE_VERBS = [
  'create', 'update', 'delete', 'insert', 'upsert', 'set', 'write', 'exec', 'execute',
  'run', 'apply', 'remove', 'drop', 'put', 'post', 'patch', 'add', 'edit', 'modify',
  'save', 'send', 'submit', 'import', 'upload', 'reset', 'clear', 'truncate', 'alter',
  'replace', 'merge', 'call', 'invoke', 'trigger', 'start', 'stop', 'kill', 'move',
  'rename', 'mark', 'approve', 'pay', 'transfer', 'assign', 'link', 'attach', 'pragma',
  'vacuum', 'commit', 'query', 'sql', 'categorise', 'categorize', 'refresh', 'sync_now',
]

// A property name that would let a caller pick what is read, or how.
const FORBIDDEN_PROPERTY =
  /sql|query|path|file|url|uri|table|column|statement|command|cmd|expression|where|order|select|dir|host|raw/i

type JsonSchema = {
  type?: string
  properties?: Record<string, JsonSchema>
  required?: string[]
  additionalProperties?: unknown
  enum?: unknown[]
  format?: string
  maxLength?: number
  minimum?: number
  maximum?: number
  items?: JsonSchema
  $defs?: Record<string, JsonSchema>
  patternProperties?: unknown
  anyOf?: unknown
  oneOf?: unknown
  allOf?: unknown
}

function inputOf(name: string): JsonSchema {
  const tool = describeTools().find((t) => t.name === name)
  if (!tool) throw new Error(`no tool ${name}`)
  return tool.inputSchema as JsonSchema
}

function toolNamed(name: string): ToolDefinition {
  const tool = TOOLS.find((t) => t.name === name)
  if (!tool) throw new Error(`no tool ${name}`)
  return tool
}

/** Every schema node reachable from a tool's input schema, with its key. */
function* walk(schema: JsonSchema, key = '(root)'): Generator<[string, JsonSchema]> {
  yield [key, schema]
  for (const [k, v] of Object.entries(schema.properties ?? {})) yield* walk(v, k)
  for (const [k, v] of Object.entries(schema.$defs ?? {})) yield* walk(v, k)
  if (schema.items) yield* walk(schema.items, `${key}[]`)
}

describe('the tool list', () => {
  it('is exactly the fixed seven, in order, with no duplicates', () => {
    expect([...TOOL_NAMES]).toEqual(EXPECTED_TOOLS)
    expect(new Set(TOOL_NAMES).size).toBe(TOOL_NAMES.length)
    expect(describeTools().map((t) => t.name)).toEqual(EXPECTED_TOOLS)
  })

  it('is frozen', () => {
    expect(Object.isFrozen(TOOLS)).toBe(true)
    expect(Object.isFrozen(TOOL_NAMES)).toBe(true)
  })

  it('names every tool as a read (get_ or list_) with no write-sounding token', () => {
    for (const name of TOOL_NAMES) {
      expect(name).toMatch(/^(get|list)_[a-z_]+$/)
      const tokens = `_${name}_`
      for (const verb of WRITE_VERBS) {
        expect(tokens.includes(`_${verb}_`), `${name} contains "${verb}"`).toBe(false)
      }
    }
  })

  it('declares every tool read-only, non-destructive and closed-world', () => {
    for (const tool of describeTools()) {
      expect(tool.annotations).toEqual({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      })
      expect(Object.keys(tool).sort()).toEqual(['annotations', 'description', 'inputSchema', 'name', 'title'])
    }
    expect(READ_ONLY_ANNOTATIONS.readOnlyHint).toBe(true)
  })

  it('serves the same list over MCP tools/list', async () => {
    const client = await connectedClient(fakeContext().ctx)
    const listed = await client.listTools()
    expect(listed.tools.map((t) => t.name)).toEqual(EXPECTED_TOOLS)
    for (const tool of listed.tools) {
      expect(tool.inputSchema).toEqual(inputOf(tool.name))
      expect(tool.annotations?.readOnlyHint).toBe(true)
    }
  })
})

describe('the input schemas', () => {
  it.each(EXPECTED_TOOLS)('%s accepts exactly its declared properties and rejects any other key', (name) => {
    const schema = inputOf(name)
    const expected = EXPECTED_INPUTS[name]
    expect(schema.type).toBe('object')
    expect(schema.additionalProperties).toBe(false)
    expect(Object.keys(schema.properties ?? {}).sort()).toEqual([...expected.properties].sort())
    expect([...(schema.required ?? [])].sort()).toEqual([...expected.required].sort())
    expect(Object.keys(EXPECTED_INPUTS).sort()).toEqual([...EXPECTED_TOOLS].sort())
  })

  it.each(EXPECTED_TOOLS)('%s has no free-form or SQL-, path- or table-shaped property', (name) => {
    for (const [key, node] of walk(inputOf(name))) {
      if (key !== '(root)') expect(key, `${name}.${key}`).not.toMatch(FORBIDDEN_PROPERTY)
      expect(node.patternProperties, `${name}.${key}`).toBeUndefined()
      expect(node.anyOf ?? node.oneOf ?? node.allOf, `${name}.${key}`).toBeUndefined()
      if (node.type === 'object' && key !== '(root)') expect.fail(`${name}.${key} is a nested object`)
      if (node.type === 'string') {
        const bounded = node.enum !== undefined || node.format !== undefined || node.maxLength !== undefined
        expect(bounded, `${name}.${key} is an unbounded string`).toBe(true)
      }
    }
  })

  it('types scope as the enum personal | strawb', () => {
    expect([...SCOPES]).toEqual(['personal', 'strawb'])
    for (const name of ['get_safe_to_spend', 'list_transactions', 'get_budgets', 'get_bills']) {
      const scope = inputOf(name).properties?.scope
      expect(scope?.type).toBe('string')
      expect(scope?.enum).toEqual(['personal', 'strawb'])
    }
  })

  it('types list_transactions dates, category and limit', () => {
    const props = inputOf('list_transactions').properties ?? {}
    expect(props.from).toMatchObject({ type: 'string', format: 'date' })
    expect(props.to).toMatchObject({ type: 'string', format: 'date' })
    expect(props.category).toMatchObject({ type: 'string', maxLength: 100 })
    expect(props.limit).toMatchObject({ type: 'integer', minimum: 1, maximum: 200 })
    expect(MAX_LIMIT).toBe(200)
    expect(MAX_RANGE_DAYS).toBe(366)
  })

  it.each(EXPECTED_TOOLS)('%s rejects an extra key, including sql, query and table', (name) => {
    const valid = validInput(name)
    const schema = toolNamed(name).inputSchema
    expect(schema.safeParse(valid).success).toBe(true)
    for (const extra of ['sql', 'query', 'table', 'path', 'url', 'note']) {
      expect(schema.safeParse({ ...valid, [extra]: 'x' }).success, `${name} + ${extra}`).toBe(false)
    }
  })

  it('rejects a scope outside personal | strawb', () => {
    for (const scope of ['Personal', 'everyone', '', 'strawb ', null]) {
      expect(scopeSchema.safeParse(scope).success, String(scope)).toBe(false)
    }
  })

  it('takes nothing for the no-input tools', () => {
    expect(noInputSchema.safeParse({}).success).toBe(true)
    expect(noInputSchema.safeParse({ scope: 'personal' }).success).toBe(false)
  })
})

describe('list_transactions bounds', () => {
  const schema = () => toolNamed('list_transactions').inputSchema
  const base = { scope: 'personal', from: '2026-01-01', to: '2026-01-31' }

  it('rejects limit above 200 rather than clamping it', () => {
    const over = schema().safeParse({ ...base, limit: 201 })
    expect(over.success).toBe(false)
    const at = schema().safeParse({ ...base, limit: 200 })
    expect(at.success && at.data.limit).toBe(200)
  })

  it('rejects a limit that is not a positive integer', () => {
    for (const limit of [0, -1, 50.5, '50', 1e9]) {
      expect(schema().safeParse({ ...base, limit }).success, String(limit)).toBe(false)
    }
  })

  it('requires both dates', () => {
    expect(schema().safeParse({ scope: 'personal', to: '2026-01-31' }).success).toBe(false)
    expect(schema().safeParse({ scope: 'personal', from: '2026-01-01' }).success).toBe(false)
  })

  it('rejects a date that is not a real YYYY-MM-DD day', () => {
    for (const from of ['2026-02-30', '2026-1-1', '2026-01-01T00:00:00Z', 'yesterday']) {
      expect(schema().safeParse({ ...base, from }).success, from).toBe(false)
    }
  })

  it('rejects from after to and accepts a single day', () => {
    expect(schema().safeParse({ ...base, from: '2026-02-01', to: '2026-01-31' }).success).toBe(false)
    expect(schema().safeParse({ ...base, from: '2026-01-31', to: '2026-01-31' }).success).toBe(true)
  })

  it('accepts a span of MAX_RANGE_DAYS inclusive and rejects one day more', () => {
    expect(schema().safeParse({ ...base, from: '2024-01-01', to: '2024-12-31' }).success).toBe(true)
    expect(schema().safeParse({ ...base, from: '2024-01-01', to: '2025-01-01' }).success).toBe(false)
    expect(schema().safeParse({ ...base, from: '2016-01-01', to: '2026-01-01' }).success).toBe(false)
  })

  it('rejects an empty or overlong category', () => {
    expect(schema().safeParse({ ...base, category: '' }).success).toBe(false)
    expect(schema().safeParse({ ...base, category: 'x'.repeat(101) }).success).toBe(false)
    expect(schema().safeParse({ ...base, category: 'Groceries' }).success).toBe(true)
  })
})

// ---- The dispatcher, driven with fake tools so it never reads stub output ----

const SENTINEL = 'sentinel-7f3a-returned-data'
const AS_OF = '2026-10-23T00:00:00.000Z'

function fakeContext(options: { record?: (entry: AuditRecord) => Promise<void> } = {}) {
  const records: AuditRecord[] = []
  let tick = Date.parse('2026-10-23T01:00:00.000Z')
  const clock: Clock = {
    now: () => {
      const at = new Date(tick)
      tick += 5
      return at
    },
  }
  const replica: ReplicaReader = {
    meta: async () => ({ data_as_of: AS_OF, built_at: AS_OF, last_sync_at: null }),
    select: async () => [],
  }
  const audit: AuditSink = {
    record:
      options.record ??
      (async (entry) => {
        records.push(entry)
      }),
  }
  const ctx: ToolContext = { replica, audit, clock }
  return { ctx, records }
}

function fakeTool(name: string, handler: () => Promise<HandlerOutcome>): ToolDefinition {
  return {
    name,
    title: name,
    description: name,
    inputSchema: z.strictObject({ scope: scopeSchema }),
    annotations: READ_ONLY_ANNOTATIONS,
    handler,
  }
}

const okTool = fakeTool('get_ok', async () => ({
  ok: true,
  result: { data_as_of: AS_OF, note: SENTINEL, amount_cents: 1234 },
  rowCount: 3,
}))
const throwingTool = fakeTool('get_throws', async () => {
  throw new Error(`boom ${SENTINEL} /app/storage/prod.sqlite3`)
})
const refusingTool = fakeTool('get_refuses', async () => ({
  ok: false,
  error: { code: 'not_implemented', message: 'get_refuses is not implemented yet' },
}))
const fakeTools = [okTool, throwingTool, refusingTool]

function bodyOf(result: CallToolResult): string {
  return JSON.stringify(result)
}

function errorCodeOf(result: CallToolResult): string | undefined {
  const first = result.content[0]
  if (!result.isError || first?.type !== 'text') return undefined
  return (JSON.parse(first.text) as { error: { code: string } }).error.code
}

const RECORD_KEYS = ['at', 'durationMs', 'outcome', 'params', 'rowCount', 'tool']

const clients: Client[] = []
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()))
})

async function connectedClient(ctx: ToolContext, tools?: readonly ToolDefinition[]): Promise<Client> {
  const server = createToolServer(ctx, tools)
  const client = new Client({ name: 'registry-test', version: '0.0.0' })
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverSide), client.connect(clientSide)])
  clients.push(client)
  return client
}

describe('dispatchToolCall records every outcome before it answers', () => {
  it('ok: one record with the validated params, row count and timing; the result is returned', async () => {
    const { ctx, records } = fakeContext()
    const result = await dispatchToolCall('get_ok', { scope: 'strawb' }, ctx, fakeTools)
    expect(result.isError).toBeUndefined()
    expect(result.structuredContent).toEqual({ data_as_of: AS_OF, note: SENTINEL, amount_cents: 1234 })
    expect(records).toHaveLength(1)
    const [entry] = records
    expect(Object.keys(entry).sort()).toEqual(RECORD_KEYS)
    expect(entry).toEqual({
      at: '2026-10-23T01:00:00.000Z',
      tool: 'get_ok',
      params: { scope: 'strawb' },
      rowCount: 3,
      outcome: 'ok',
      durationMs: 5,
    })
    expect(JSON.stringify(entry)).not.toContain(SENTINEL)
  })

  it('rejected: invalid arguments are recorded with the raw arguments and the handler never runs', async () => {
    let ran = false
    const spy = fakeTool('get_spy', async () => {
      ran = true
      return { ok: true, result: { data_as_of: AS_OF }, rowCount: 0 }
    })
    const { ctx, records } = fakeContext()
    const result = await dispatchToolCall('get_spy', { scope: 'everyone', sql: 'DROP TABLE x' }, ctx, [spy])
    expect(ran).toBe(false)
    expect(errorCodeOf(result)).toBe('invalid_arguments')
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      tool: 'get_spy',
      outcome: 'rejected',
      rowCount: null,
      params: { scope: 'everyone', sql: 'DROP TABLE x' },
    })
    expect(Object.keys(records[0]).sort()).toEqual(RECORD_KEYS)
  })

  it('error: a throwing handler is recorded and its message is neither returned nor recorded', async () => {
    const { ctx, records } = fakeContext()
    const result = await dispatchToolCall('get_throws', { scope: 'personal' }, ctx, fakeTools)
    expect(errorCodeOf(result)).toBe('internal_error')
    expect(bodyOf(result)).not.toContain(SENTINEL)
    expect(bodyOf(result)).not.toContain('/app/storage')
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ tool: 'get_throws', outcome: 'error', rowCount: null })
    expect(JSON.stringify(records[0])).not.toContain(SENTINEL)
  })

  it('error: a handler that refuses (not_implemented) is recorded as error', async () => {
    const { ctx, records } = fakeContext()
    const result = await dispatchToolCall('get_refuses', { scope: 'personal' }, ctx, fakeTools)
    expect(errorCodeOf(result)).toBe('not_implemented')
    expect(records.map((r) => r.outcome)).toEqual(['error'])
  })

  it('rejected: an unknown name is recorded under UNKNOWN_TOOL with the name truncated into params', async () => {
    for (const name of ['delete_everything', '__proto__', 'constructor', 'x'.repeat(500)]) {
      const { ctx, records } = fakeContext()
      const result = await dispatchToolCall(name, {}, ctx, fakeTools)
      expect(errorCodeOf(result), name).toBe('unknown_tool')
      expect(records, name).toHaveLength(1)
      expect(records[0]).toMatchObject({
        tool: UNKNOWN_TOOL,
        outcome: 'rejected',
        rowCount: null,
        params: { requested_tool: name.slice(0, 64) },
      })
    }
  })

  it('treats omitted arguments as {}', async () => {
    const { ctx, records } = fakeContext()
    const noInput: ToolDefinition = {
      ...fakeTool('get_nothing', async () => ({ ok: true, result: { data_as_of: AS_OF }, rowCount: null })),
      inputSchema: noInputSchema,
    }
    const result = await dispatchToolCall('get_nothing', undefined, ctx, [noInput])
    expect(result.isError).toBeUndefined()
    expect(records[0]).toMatchObject({ outcome: 'ok', params: {} })
  })

  it('error: a result without data_as_of, or with fractional cents, returns no data', async () => {
    const results = [
      { note: SENTINEL },
      { data_as_of: 'last tuesday', note: SENTINEL },
      { data_as_of: '2026-10-23', note: SENTINEL },
      { data_as_of: 1792713600000, note: SENTINEL },
      { data_as_of: AS_OF, note: SENTINEL, amount_cents: 12.5 },
      { data_as_of: AS_OF, note: SENTINEL, rows: [{ amount_cents: '1200' }] },
    ]
    for (const bad of results) {
      const tool = fakeTool('get_bad', async () => ({ ok: true, result: bad as never, rowCount: 1 }))
      const { ctx, records } = fakeContext()
      const result = await dispatchToolCall('get_bad', { scope: 'personal' }, ctx, [tool])
      expect(errorCodeOf(result), JSON.stringify(bad)).toBe('internal_error')
      expect(bodyOf(result)).not.toContain(SENTINEL)
      expect(records.map((r) => r.outcome)).toEqual(['error'])
    }
  })

  it('error: a negative or fractional row count returns no data', async () => {
    for (const rowCount of [-1, 1.5]) {
      const tool = fakeTool('get_rows', async () => ({ ok: true, result: { data_as_of: AS_OF, note: SENTINEL }, rowCount }))
      const { ctx, records } = fakeContext()
      const result = await dispatchToolCall('get_rows', { scope: 'personal' }, ctx, [tool])
      expect(errorCodeOf(result)).toBe('internal_error')
      expect(bodyOf(result)).not.toContain(SENTINEL)
      expect(records.map((r) => r.outcome)).toEqual(['error'])
    }
  })
})

describe('a failed audit record returns an error and no data', () => {
  const failingSinks: [string, () => Promise<void>][] = [
    ['rejects', () => Promise.reject(new Error('disk full'))],
    [
      'throws synchronously',
      () => {
        throw new Error('disk full')
      },
    ],
  ]

  it.each(failingSinks)('when the sink %s, for every outcome', async (_label, record) => {
    const calls: [string, Record<string, unknown>][] = [
      ['get_ok', { scope: 'personal' }],
      ['get_ok', { scope: 'nobody' }],
      ['get_throws', { scope: 'personal' }],
      ['not_a_tool', {}],
    ]
    for (const [name, args] of calls) {
      const { ctx } = fakeContext({ record })
      const result = await dispatchToolCall(name, args, ctx, fakeTools)
      expect(errorCodeOf(result), name).toBe('audit_unavailable')
      expect(bodyOf(result)).not.toContain(SENTINEL)
      expect(result.structuredContent).toBeUndefined()
    }
  })

  it('returns nothing over MCP until the record has settled', async () => {
    let release: () => void = () => {}
    const recorded = new Promise<void>((resolve) => {
      release = resolve
    })
    const { ctx } = fakeContext({ record: () => recorded })
    const client = await connectedClient(ctx, fakeTools)

    let settled = false
    const call = client.callTool({ name: 'get_ok', arguments: { scope: 'personal' } }).then((r) => {
      settled = true
      return r
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(settled).toBe(false)

    release()
    const result = (await call) as CallToolResult
    expect(settled).toBe(true)
    expect(result.structuredContent).toMatchObject({ note: SENTINEL })
  })
})

// Driven with a fake failing sink, not `createContext`: the wiring lane
// replaces the w1 placeholder context, and this file must not change when it
// does.
describe('the real tools behind a sink that refuses every record', () => {
  it('fail closed: a call returns audit_unavailable and no data, but tools/list works', async () => {
    const { ctx } = fakeContext({ record: () => Promise.reject(new Error('audit sink not wired')) })
    const client = await connectedClient(ctx)
    expect((await client.listTools()).tools).toHaveLength(EXPECTED_TOOLS.length)
    const result = (await client.callTool({ name: 'get_goals', arguments: {} })) as CallToolResult
    expect(errorCodeOf(result)).toBe('audit_unavailable')
  })

  it('refuses a duplicate tool name', () => {
    expect(() => createToolServer(fakeContext().ctx, [okTool, okTool])).toThrow(/unique/)
  })
})

describe('staticSql', () => {
  it('returns the literal text and refuses any substitution', () => {
    expect(staticSql`SELECT 1`).toBe('SELECT 1')
    const scope = 'personal'
    expect(() => (staticSql as unknown as (s: TemplateStringsArray, ...v: unknown[]) => string)`SELECT ${scope}`).toThrow(
      /no substitutions/,
    )
  })
})

/** A minimal valid input for each real tool. */
function validInput(name: string): Record<string, unknown> {
  switch (name) {
    case 'list_transactions':
      return { scope: 'personal', from: '2026-01-01', to: '2026-01-31' }
    case 'get_safe_to_spend':
    case 'get_budgets':
    case 'get_bills':
      return { scope: 'personal' }
    default:
      return {}
  }
}
