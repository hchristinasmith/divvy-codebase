// The write wrapper the agents' inbox accessors share (prd-04 Rulings 2 and 7;
// #31). It takes no table and imports nothing: it only rewrites a refused
// write's error, so the accessors in proposals.ts, insights.ts and
// agent-runs.ts can all wrap a write the same way.

/**
 * Runs a write and, if the database refuses it, throws `<operation> failed:`
 * and SQLite's text after knex's ` - ` (`SQLITE_CONSTRAINT: FOREIGN KEY
 * constraint failed`), or only the error's code when there is no such text.
 * Never the SQL, and never the original error as a `cause`, because both
 * carry the row's values. The inbox accessors wrap every write in it.
 */
export async function scrubbed<T>(operation: string, write: PromiseLike<T>): Promise<T> {
  try {
    return await write
  } catch (error) {
    const message = error instanceof Error ? error.message : ''
    const code = (error as { code?: unknown } | null)?.code
    const at = message.lastIndexOf(' - ')
    const sqlite = at === -1 ? message : message.slice(at + 3)
    if (typeof code === 'string' && sqlite.startsWith(`${code}: `)) {
      throw new Error(`${operation} failed: ${sqlite}`)
    }
    throw new Error(`${operation} failed: ${typeof code === 'string' ? code : 'database error'}`)
  }
}
