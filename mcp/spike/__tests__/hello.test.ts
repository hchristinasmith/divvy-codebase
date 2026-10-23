// The wave 1 spike server (prd-03 Ruling 3) answers MCP on stdio, and stays
// out of the real advisor. This test fails if:
//   (a) an MCP client cannot initialize the spike, list exactly `hello`, and
//       call it over stdio;
//   (b) the raw newline-delimited JSON-RPC the spike writes to stdout is not
//       exactly the two responses asked for, or the process does not exit 0
//       once stdin closes;
//   (c) the registry serves `hello`, or any non-test source under mcp/
//       outside mcp/spike/ imports the spike.
//
// No socket is involved: each run is a child process on pipes.

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { TOOL_NAMES } from '../../tools/registry.ts'

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const MCP_DIR = join(ROOT, 'mcp')
const SPIKE_DIR = join(MCP_DIR, 'spike')
const SPIKE = 'mcp/spike/hello.ts'
const TSX_CLI = join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs')
const PROCESS_TIMEOUT_MS = 30_000

// A constructed environment, never `process.env`: the spike needs nothing
// from the developer's shell.
const CHILD_ENV: Record<string, string> = { PATH: process.env.PATH ?? '' }

const GREETING = 'hello from the divvy-mcp spike'

describe('(a) an MCP client reaches the spike over stdio', () => {
  it(
    'initializes, lists only hello with no required input, and calls it',
    async () => {
      expect(existsSync(TSX_CLI), `tsx not found at ${TSX_CLI}`).toBe(true)
      // The SDK client checks the answers against InitializeResultSchema and
      // ListToolsResultSchema, so a malformed reply fails `connect` or
      // `listTools`. A stdout line that is not JSON-RPC at all (a banner, a
      // stray log) is only reported to `onerror` and then dropped, so the
      // errors are collected and must be none.
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [TSX_CLI, SPIKE],
        cwd: ROOT,
        env: CHILD_ENV,
        stderr: 'pipe',
      })
      const client = new Client({ name: 'spike-test', version: '0.0.0' })
      const streamErrors: string[] = []
      client.onerror = (error) => streamErrors.push(error.message)
      try {
        await client.connect(transport)
        expect(client.getServerVersion()?.name).toBe('divvy-mcp-spike')

        const { tools } = await client.listTools()
        expect(tools.map((t) => t.name)).toEqual(['hello'])
        const [hello] = tools
        expect(hello.inputSchema.type).toBe('object')
        expect(hello.inputSchema.required ?? []).toEqual([])
        expect(hello.annotations?.readOnlyHint).toBe(true)

        const result = await client.callTool({ name: 'hello', arguments: {} })
        expect(result.isError ?? false).toBe(false)
        expect(result.content).toEqual([{ type: 'text', text: GREETING }])
        expect(streamErrors).toEqual([])
      } finally {
        await client.close()
      }
    },
    PROCESS_TIMEOUT_MS,
  )
})

describe('(b) the raw stdio stream is valid MCP JSON-RPC and nothing else', () => {
  it(
    'answers initialize and tools/list with exactly two responses, then exits 0 on stdin EOF',
    () => {
      const requests = [
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: 'spike-raw-test', version: '0.0.0' },
          },
        },
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      ]
      const child = spawnSync(process.execPath, [TSX_CLI, SPIKE], {
        cwd: ROOT,
        env: CHILD_ENV,
        input: requests.map((r) => JSON.stringify(r)).join('\n') + '\n',
        encoding: 'utf8',
        timeout: PROCESS_TIMEOUT_MS,
      })
      expect(child.status, child.stderr).toBe(0)

      const lines = child.stdout.split('\n').filter((line) => line.trim() !== '')
      // Every line must parse; a banner or a stray log would throw here.
      const messages = lines.map((line) => JSON.parse(line) as Record<string, unknown>)
      for (const message of messages) {
        expect(message.jsonrpc).toBe('2.0')
        expect(message).not.toHaveProperty('error')
      }
      expect(messages.map((m) => m.id)).toEqual([1, 2])

      const [init, list] = messages as [
        { result: { serverInfo: { name: string } } },
        { result: { tools: { name: string }[] } },
      ]
      expect(init.result.serverInfo.name).toBe('divvy-mcp-spike')
      expect(list.result.tools.map((t) => t.name)).toEqual(['hello'])
    },
    PROCESS_TIMEOUT_MS,
  )
})

describe('(c) the spike stays out of the real advisor', () => {
  it('the registry does not serve hello', () => {
    expect(TOOL_NAMES).not.toContain('hello')
  })

  it('no non-test source under mcp/ outside mcp/spike/ imports the spike', () => {
    const files: string[] = []
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry)
        if (statSync(full).isDirectory()) {
          if (entry === 'node_modules' || entry === '__tests__' || full === SPIKE_DIR) continue
          walk(full)
        } else if (/\.(ts|tsx|js|mjs|cjs)$/.test(entry)) {
          files.push(full)
        }
      }
    }
    walk(MCP_DIR)
    // A walk that found nothing would pass vacuously.
    expect(files.map((f) => relative(ROOT, f))).toContain(join('mcp', 'index.ts'))
    expect(files.some((f) => f.startsWith(SPIKE_DIR + sep))).toBe(false)

    const found = files.flatMap((file) =>
      ts
        .preProcessFile(readFileSync(file, 'utf8'), true, true)
        .importedFiles.map((f) => f.fileName)
        .filter((spec) => /spike|hello/.test(spec))
        .map((spec) => `${relative(ROOT, file)}: ${spec}`),
    )
    expect(found).toEqual([])
  })
})
