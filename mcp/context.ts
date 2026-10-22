// Builds the `ToolContext` the stdio entry serves calls with.
//
// In prd-03 wave 1 the replica reader and the audit sink do not exist yet,
// so `createContext` returns a fail-closed placeholder: `tools/list` works,
// and every `tools/call` is answered `audit_unavailable` with no data,
// because the placeholder sink refuses every record. The wave-2 wiring lane
// replaces the placeholder with `openReplica` (`mcp/replica/index.ts`) and
// `createAuditSink` (`mcp/audit/index.ts`) at the paths `resolvePaths`
// returns; that is the only edit this file expects.
//
// No I/O at import time.

import {
  AUDIT_PATH_ENV,
  DEFAULT_AUDIT_PATH,
  DEFAULT_REPLICA_PATH,
  REPLICA_PATH_ENV,
  systemClock,
} from './contracts.ts'
import type { AuditSink, Clock, ReplicaReader, ToolContext } from './contracts.ts'

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

const placeholderReplica: ReplicaReader = {
  meta: () => Promise.reject(new Error('replica not wired (prd-03 wave 2)')),
  select: () => Promise.reject(new Error('replica not wired (prd-03 wave 2)')),
}

const placeholderAudit: AuditSink = {
  record: () => Promise.reject(new Error('audit sink not wired (prd-03 wave 2)')),
}

export async function createContext(env: Env = process.env, clock: Clock = systemClock): Promise<ToolContext> {
  // Resolved now so wave 2 only has to pass these on.
  resolvePaths(env)
  return { replica: placeholderReplica, audit: placeholderAudit, clock }
}
