import { readdirSync, readFileSync } from 'node:fs'
import * as Path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import { rankByStartedAt } from '../ranked-runs.ts'
import { closeDb, db, freshDb } from './harness.ts'

// Issue #206: the claim step (run.ts) and GET /api/v1/sync/status rank
// `sync_runs` through one helper. Only a started_at in the exact
// toISOString() form is ranked, latest first; a tie goes to the higher id.
// The behaviour through each caller is pinned in run.test.ts (#169) and
// routes/__tests__/sync.test.ts (#188); this pins the helper itself and that
// no second copy of its filter comes back.

beforeEach(async () => {
  await freshDb()
})
afterAll(closeDb)

interface RunFixture {
  id: number
  started_at: string
  outcome: 'success' | 'failed'
}

async function insertRuns(runs: RunFixture[]): Promise<void> {
  for (const run of runs) {
    await db('sync_runs').insert({
      ...run,
      finished_at: '2026-10-28T00:00:00.000Z',
      error_message: run.outcome === 'failed' ? 'akahu_network' : null,
    })
  }
}

// Inserted neither in start order nor in id order. Ids 5 and 7 share a
// start; every start that is not exact toISOString() text is one the ranking
// must leave out: text that sorts after every ISO time, text julianday()
// reads as the wall clock, an ISO form with no milliseconds, and SQLite's
// own datetime form.
const MIXED: RunFixture[] = [
  { id: 3, started_at: '2026-10-22T08:00:00.000Z', outcome: 'success' },
  { id: 9, started_at: '2026-10-27 09:00:00', outcome: 'success' },
  { id: 1, started_at: '2026-10-20T08:00:00.000Z', outcome: 'success' },
  { id: 7, started_at: '2026-10-23T08:00:00.000Z', outcome: 'success' },
  { id: 4, started_at: 'not-a-timestamp', outcome: 'success' },
  { id: 10, started_at: '2026-10-21T08:00:00.000Z', outcome: 'success' },
  { id: 2, started_at: '2026-10-24T08:00:00.000Z', outcome: 'success' },
  { id: 6, started_at: 'now', outcome: 'success' },
  { id: 5, started_at: '2026-10-23T08:00:00.000Z', outcome: 'success' },
  { id: 8, started_at: '2999-01-01T00:00:00Z', outcome: 'success' },
]

describe('rankByStartedAt', () => {
  it('orders exact ISO starts latest first, breaks a tie by higher id, and leaves out every other start', async () => {
    await insertRuns(MIXED)

    expect(await rankByStartedAt(db('sync_runs')).pluck('id')).toEqual([
      2, 7, 5, 3, 10, 1,
    ])
  })

  it('keeps a where applied before it, and ranks only the rows that match', async () => {
    await insertRuns([
      ...MIXED,
      // A failed run with the latest exact start of all.
      { id: 11, started_at: '2026-10-25T08:00:00.000Z', outcome: 'failed' },
      { id: 12, started_at: '2026-10-19T08:00:00.000Z', outcome: 'failed' },
    ])

    expect(
      await rankByStartedAt(
        db('sync_runs').where({ outcome: 'success' }),
      ).pluck('id'),
    ).toEqual([2, 7, 5, 3, 10, 1])
    expect(
      await rankByStartedAt(db('sync_runs').where({ outcome: 'failed' })).pluck(
        'id',
      ),
    ).toEqual([11, 12])
  })

  it('returns no rows when no start is exact ISO text', async () => {
    await insertRuns(MIXED.filter((run) => !run.started_at.endsWith('.000Z')))

    expect(await rankByStartedAt(db('sync_runs')).pluck('id')).toEqual([])
  })
})

describe('static guard on the sync_runs ranking (#206)', () => {
  const serverDir = Path.join(
    Path.dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
  )
  // Matched with every space removed, so a copy reformatted by hand or by a
  // formatter is still found: the filter, and the ordering it goes with.
  const RANKING_TEXT = ['started_at)=started_at', 'julianday(started_at)']
  const squashed = (name: string): string =>
    readFileSync(Path.join(serverDir, name), 'utf8').replace(/\s+/g, '')

  /** Every non-test `.ts` file under `dir`, relative to server/. */
  function sourceFiles(dir: string): string[] {
    return readdirSync(Path.join(serverDir, dir), { withFileTypes: true })
      .flatMap((entry) => {
        const relative = Path.join(dir, entry.name)
        if (entry.isDirectory()) {
          return entry.name === '__tests__' ? [] : sourceFiles(relative)
        }
        return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')
          ? [relative]
          : []
      })
      .sort()
  }

  it('writes the started_at filter and ordering once, in ranked-runs.ts, across server/sync and server/routes', () => {
    const files = [...sourceFiles('sync'), ...sourceFiles('routes')]
    expect(files).toEqual(
      expect.arrayContaining([
        Path.join('sync', 'run.ts'),
        Path.join('routes', 'sync.ts'),
      ]),
    )

    for (const text of RANKING_TEXT) {
      const holders = files.filter((name) => squashed(name).includes(text))
      expect(holders, text).toEqual([Path.join('sync', 'ranked-runs.ts')])
      expect(
        squashed(Path.join('sync', 'ranked-runs.ts')).split(text).length - 1,
        text,
      ).toBe(1)
    }
  })
})
