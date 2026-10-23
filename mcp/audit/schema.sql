-- The advisor audit file's schema (prd-03 Ruling 4).
--
-- Applied by the MCP itself (`mcp/audit/sink.ts`) every time it opens the
-- file, never by a knex migration: the main database is read-only to the
-- MCP (Ruling 2), and this file is the only thing it writes. Every statement
-- here must be safe to run again on a file that already has it, so the file
-- holds `CREATE TABLE IF NOT EXISTS` and nothing else; pragmas live in the
-- sink. Changing a column means a new table or an explicit upgrade step,
-- not an edit here, because an existing file never sees this text again.
--
-- One row per tool call. Never the returned data, never error text.

CREATE TABLE IF NOT EXISTS advisor_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  -- ISO 8601 UTC of the call's start, always with milliseconds.
  at TEXT NOT NULL CHECK (at GLOB '????-??-??T??:??:??.???Z'),
  -- The tool name, or '(unknown)' for a name not in the registry.
  tool TEXT NOT NULL CHECK (length(tool) > 0),
  -- The call's parameters as bounded JSON (see MAX_AUDIT_PARAMS_LENGTH).
  params_json TEXT NOT NULL CHECK (json_valid(params_json)),
  -- Rows the handler read; NULL when not applicable.
  row_count INTEGER CHECK (row_count IS NULL OR row_count >= 0),
  outcome TEXT NOT NULL CHECK (outcome IN ('ok', 'rejected', 'error')),
  duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0)
);
