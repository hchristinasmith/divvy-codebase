// Builds the `ToolContext` the stdio entry serves calls with (prd-03
// Ruling 2, Ruling 4).
//
// The replica reader is `openReplica` (`mcp/replica/index.ts`) and the audit
// sink is `createAuditSink` (`mcp/audit/index.ts`), each at the path
// `resolvePaths` returns. Neither does I/O here: the reader opens and closes
// the replica inside every call, and the sink creates the audit file and
// applies its schema on each `record`. So `tools/list` works before either
// file exists (the guard test spawns the entry with fresh scratch paths),
// and a missing or unreadable replica is a failed call, answered
// `internal_error` and still audited, not a failed start.
//
// `createAuditSink` throws for an audit path that is not absolute, so a
// relative `DIVVY_AUDIT_PATH` stops the entry at start-up rather than
// serving calls it cannot record.
//
// No I/O at import time.

import { createAuditSink } from './audit/index.ts'
import {
  AUDIT_PATH_ENV,
  DEFAULT_AUDIT_PATH,
  DEFAULT_REPLICA_PATH,
  REPLICA_PATH_ENV,
  systemClock,
} from './contracts.ts'
import type { Clock, ToolContext } from './contracts.ts'
import { openReplica } from './replica/index.ts'

type Env = Readonly<Record<string, string | undefined>>

/** The replica and audit paths, from the environment or the PRD defaults. */
export function resolvePaths(env: Env = process.env): { replicaPath: string; auditPath: string } {
  const replicaPath = env[REPLICA_PATH_ENV]
  const auditPath = env[AUDIT_PATH_ENV]
  return {
    replicaPath: replicaPath ? replicaPath : DEFAULT_REPLICA_PATH,
    auditPath: auditPath ? auditPath : DEFAULT_AUDIT_PATH,
  }
}

export async function createContext(env: Env = process.env, clock: Clock = systemClock): Promise<ToolContext> {
  const { replicaPath, auditPath } = resolvePaths(env)
  const replica = await openReplica({ path: replicaPath })
  const audit = await createAuditSink({ path: auditPath })
  return { replica, audit, clock }
}
