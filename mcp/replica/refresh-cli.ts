// The replica refresh command (prd-03 Ruling 2), built to dist/mcp/refresh.js.
//
//   node dist/mcp/refresh.js           one refresh; exits 0, or 1 if it failed
//   node dist/mcp/refresh.js --watch   refresh now, every five minutes, and
//                                      within a minute of a finished sync;
//                                      a failed refresh is reported on stderr
//                                      and the loop carries on
//
// The live database is `DATABASE_PATH`, or `/data/divvy.sqlite3`, the same
// default as the production config in `server/db/knexfile.js` (not imported:
// mcp/ never imports server/, Ruling 6). The replica is `DIVVY_REPLICA_PATH`,
// or the PRD default. It runs as the web app's OS user, never as `divvy-mcp`,
// and is a separate bundle from the MCP entry, so the tool-serving process
// holds no path to the live file.
//
// Error messages go to stderr; nothing here prints a row or a value.

import { DEFAULT_REPLICA_PATH, REPLICA_PATH_ENV } from '../contracts.ts'
import { refreshReplica, watchReplica } from './refresh.ts'

const LIVE_PATH_ENV = 'DATABASE_PATH'
const DEFAULT_LIVE_PATH = '/data/divvy.sqlite3'

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error'
}

function report(error: unknown): void {
  console.error(`[divvy-replica] refresh failed: ${messageOf(error)}`)
}

async function main(argv: readonly string[]): Promise<void> {
  const unknown = argv.filter((arg) => arg !== '--watch')
  if (unknown.length > 0) {
    console.error(`[divvy-replica] unknown argument(s): ${unknown.join(' ')}; usage: refresh.js [--watch]`)
    process.exitCode = 2
    return
  }
  const options = {
    livePath: process.env[LIVE_PATH_ENV] || DEFAULT_LIVE_PATH,
    replicaPath: process.env[REPLICA_PATH_ENV] || DEFAULT_REPLICA_PATH,
  }
  if (!argv.includes('--watch')) {
    try {
      await refreshReplica(options)
    } catch (error) {
      report(error)
      process.exitCode = 1
    }
    return
  }
  const watcher = watchReplica({ ...options, onError: report })
  const stop = (): void => {
    void watcher.stop().then(() => process.exit(0))
  }
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
}

void main(process.argv.slice(2))
