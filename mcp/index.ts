// The advisor's MCP server, on stdio (prd-03 Ruling 3: stdio over SSH, no
// HTTP endpoint and no listening socket).
//
// Order matters: the environment check runs first, before a context or a
// server exists, and a failure exits 1 naming the variables, not their
// values. Every other module under `mcp/` is free of side effects, so the
// imports below load code but do nothing.
//
// stdout is the MCP protocol stream; anything else written there corrupts
// it, so diagnostics go to stderr.

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createContext } from './context.ts'
import { ForbiddenEnvError, assertCleanEnv } from './guard-env.ts'
import { createToolServer } from './tools/registry.ts'

async function main(): Promise<void> {
  try {
    assertCleanEnv()
  } catch (error) {
    const message = error instanceof ForbiddenEnvError ? error.message : 'environment check failed'
    process.stderr.write(`[divvy-mcp] refusing to start: ${message}\n`)
    process.exit(1)
  }

  const ctx = await createContext()
  const server = createToolServer(ctx)
  // When stdin closes (the SSH session goes away) nothing else holds the
  // event loop open, so the process exits; the guard test's clean-env run
  // pins that.
  await server.connect(new StdioServerTransport())
}

main().catch(() => {
  process.stderr.write('[divvy-mcp] fatal error during start-up\n')
  process.exit(1)
})
