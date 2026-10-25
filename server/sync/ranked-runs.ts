import type { Knex } from 'knex'

// A ranking for `sync_runs` rows, shared by the claim step in run.ts and
// GET /api/v1/sync/status (#169, #188, #206): latest start first.
//
// Only a started_at in the exact `toISOString()` form is ranked, by
// julianday(); a tie on started_at goes to the higher id, the later insert.
// Any other started_at is left out, so it can never be the latest run.
//
// Why the filter: as text, 'not-a-timestamp' sorts after every ISO time, so
// an ordering on the raw column would pick it. julianday() alone is not
// enough either: it reads strings Date.parse does not, such as 'now' (the
// wall clock, later than every real start), and ISO forms toISOString()
// never writes, such as '2999-01-01T00:00:00Z' (no milliseconds).
// `strftime(...) = started_at` holds only for text already in the exact
// form strftime writes, which is the form toISOString() writes.

const EXACT_ISO_START =
  "strftime('%Y-%m-%dT%H:%M:%fZ', started_at) = started_at"

/** `query`, narrowed to rankable starts and ordered latest first. */
export function rankByStartedAt<TRecord extends object, TResult>(
  query: Knex.QueryBuilder<TRecord, TResult>,
): Knex.QueryBuilder<TRecord, TResult> {
  return query
    .whereRaw(EXACT_ISO_START)
    .orderByRaw('julianday(started_at) DESC')
    .orderBy('id', 'desc')
}
