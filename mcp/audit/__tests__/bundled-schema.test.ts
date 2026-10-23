// The audit schema ships beside the MCP bundle (prd-03 Ruling 4; #117, after #106).
// This test fails if:
//   - `build:mcp` has no `dist/mcp/` output to redirect, so the test cannot
//     tell where the script writes and would pass on a renamed path;
//   - the script stops copying `mcp/audit/schema.sql` to `dist/mcp/schema.sql`
//     (the script is read from `package.json` and run as written, never
//     restated here), so a bundled sink cannot find its schema;
//   - the bundled sink, run by plain node beside the build's output, does not
//     resolve a record, or writes other than one `advisor_audit` row;
//   - the row's columns drift from the schema's, or a recorded value comes
//     back different;
//   - the build writes anything into the repo's `dist/` instead of a temp
//     directory.
//
// `mcp/index.ts` cannot drive the sink yet (its context keeps a placeholder
// sink until #80), so the probe is `mcp/audit/index.ts`, bundled with the same
// esbuild flags as `build:mcp` beside the build's output. Everything is written
// to a mkdtemp directory that is removed afterwards.

import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import sqlite3 from 'sqlite3'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const BIN_DIR = join(ROOT, 'node_modules', '.bin')

const OUTPUT_DIR = 'dist/mcp/'
const MCP_OUTFILE = '--outfile=dist/mcp/index.js'
const MCP_ENTRY = ' mcp/index.ts'
const PROBE_ENTRY = 'mcp/audit/index.ts'
const PROBE_NAME = 'audit-probe.js'

const RECORD = {
  at: '2026-10-23T01:02:03.000Z',
  tool: 'bundled_probe',
  params: { limit: 5 },
  rowCount: 2,
  outcome: 'ok',
  durationMs: 7,
}

// Run by plain node, the way the shipped bundle runs: no vite, no test runner.
// argv[1] is the bundle's URL and argv[2] the audit file. A rejected record
// throws, so the child exits non-zero and stderr carries the cause.
const CHILD_SCRIPT = [
  'const { createAuditSink } = await import(process.argv[1])',
  'const sink = await createAuditSink({ path: process.argv[2] })',
  `await sink.record(${JSON.stringify(RECORD)})`,
].join('\n')

interface AuditRow {
  id: number
  at: string
  tool: string
  params_json: string
  row_count: number | null
  outcome: string
  duration_ms: number
}

function buildScript(): string {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts?: Record<string, unknown> }
  const script = pkg.scripts?.['build:mcp']
  if (typeof script !== 'string') throw new Error('package.json has no build:mcp script')
  return script
}

/** `value` as one POSIX shell word, so a path with a quote or a space survives `sh -c`. */
function shellWord(value: string): string {
  return `'${value.split("'").join(`'\\''`)}'`
}

/** Runs a shell command from the repo root, with the repo's own binaries first on PATH. */
function sh(command: string): void {
  execFileSync('sh', ['-c', command], {
    cwd: ROOT,
    env: { ...process.env, PATH: `${BIN_DIR}:${process.env.PATH ?? ''}` },
    stdio: 'pipe',
  })
}

/** Every `advisor_audit` row, read through a read-only open. */
function readRows(path: string): Promise<AuditRow[]> {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(path, sqlite3.OPEN_READONLY, (openError) => {
      if (openError) {
        reject(openError)
        return
      }
      db.all<AuditRow>('SELECT * FROM advisor_audit ORDER BY id', (error, rows) => {
        db.close(() => (error ? reject(error) : resolve(rows)))
      })
    })
  })
}

describe('build:mcp ships the audit schema beside the bundle', () => {
  let work = ''
  let rows: AuditRow[] = []

  afterAll(() => {
    if (work) rmSync(work, { recursive: true, force: true })
  })

  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), 'divvy-bundled-schema-'))
    const auditPath = join(work, 'audit.sqlite3')
    const probePath = join(work, PROBE_NAME)
    const script = buildScript()

    // The build as written, with each `dist/mcp/` output redirected into `work`.
    expect(script).toContain(OUTPUT_DIR)
    const build = script.split(OUTPUT_DIR).join(`${shellWord(`${work}/`)}`)
    expect(build).not.toContain('dist/')
    sh(build)

    // The probe: the script's first command (esbuild), with its outfile and entry
    // swapped and every other flag left as the script has it.
    const [esbuild] = script.split('&&')
    const trimmed = esbuild.trim()
    expect(trimmed).toContain(MCP_OUTFILE)
    expect(trimmed.endsWith(MCP_ENTRY)).toBe(true)
    const probe = `${trimmed.slice(0, -MCP_ENTRY.length).replace(MCP_OUTFILE, `--outfile=${shellWord(probePath)}`)} ${PROBE_ENTRY}`
    expect(probe).toContain(shellWord(probePath))
    sh(probe)

    // The bundle's bare `sqlite3` import resolves from here. The package.json
    // gives the probe the `type: module` that dist/mcp inherits from the root.
    symlinkSync(join(ROOT, 'node_modules'), join(work, 'node_modules'), 'dir')
    writeFileSync(join(work, 'package.json'), '{"type":"module"}\n')

    const child = spawnSync(process.execPath, ['--input-type=module', '-e', CHILD_SCRIPT, pathToFileURL(probePath).href, auditPath], {
      cwd: work,
      encoding: 'utf8',
    })
    if (child.status !== 0) {
      throw new Error(`the bundled sink did not resolve the record (exit ${child.status}):\n${child.stderr}`)
    }
    rows = await readRows(auditPath)
  })

  it('writes exactly one advisor_audit row', () => {
    expect(rows).toHaveLength(1)
  })

  it('pins the row key set', () => {
    const [row] = rows
    expect(Object.keys(row).sort()).toEqual(['at', 'duration_ms', 'id', 'outcome', 'params_json', 'row_count', 'tool'])
  })

  it('stores the recorded values', () => {
    const [row] = rows
    expect(row.at).toBe(RECORD.at)
    expect(row.tool).toBe(RECORD.tool)
    expect(row.outcome).toBe(RECORD.outcome)
    expect(row.row_count).toBe(RECORD.rowCount)
    expect(row.duration_ms).toBe(RECORD.durationMs)
    expect(JSON.parse(row.params_json)).toEqual(RECORD.params)
  })
})
