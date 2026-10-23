// Throwaway spike for prd-03 Ruling 3, wave 1: a hello-world MCP server on
// stdio, so the real machine can show whether Claude desktop reaches it over
// Tailscale SSH or through `fly ssh console` (see RUNBOOK.md beside this
// file). It is not the advisor: nothing imports it, it exports nothing, and
// `mcp/index.ts` never serves its tool. Delete it once the spike is recorded.
//
// stdout is the MCP protocol stream; diagnostics go to stderr only.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

async function main(): Promise<void> {
  const server = new McpServer({ name: 'divvy-mcp-spike', version: '0.0.0' })

  server.registerTool(
    'hello',
    {
      title: 'Hello',
      description: 'Answers with a fixed greeting. Proves the stdio-over-SSH path reaches the spike server.',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => ({ content: [{ type: 'text', text: 'hello from the divvy-mcp spike' }] }),
  )

  // When stdin closes (the SSH session goes away) nothing else holds the
  // event loop open, so the process exits.
  await server.connect(new StdioServerTransport())
}

main().catch(() => {
  process.stderr.write('[divvy-mcp-spike] fatal error during start-up\n')
  process.exit(1)
})
