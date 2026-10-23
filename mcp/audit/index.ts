// The audit module's public face (prd-03 Ruling 4): exactly the
// `AuditModule` shape `mcp/contracts.ts` names at `WAVE2_MODULES.audit`.
// `mcp/context.ts` imports `createAuditSink` from here once wave 2 is wired;
// everything else in `./sink.ts` stays internal to this directory.

export { createAuditSink } from './sink.ts'
