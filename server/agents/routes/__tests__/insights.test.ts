import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import connection from '../../../db/connection.ts'
import {
  closeDb,
  freshApp,
  serveOnLoopback,
  type LoopbackApi,
} from '../../../test-utils/app.ts'
import { insertInsight, type NewInsight } from '../../db/insights.ts'

// /api/v1/agents/insights (prd-04 Rulings 2, 3 and 8, #51), over HTTP
// against the real app and a fresh in-memory database. Every value is
// invented.

let served: LoopbackApi | undefined
let api: LoopbackApi['api']

beforeEach(async () => {
  served = await serveOnLoopback(await freshApp())
  api = served.api
})

afterEach(async () => {
  await served?.close() // beforeEach can fail before the server listens
  served = undefined
  vi.restoreAllMocks()
})

afterAll(closeDb)

type Row = Record<string, unknown>

const INSIGHT_KEYS = [
  'id',
  'kind',
  'title',
  'body_md',
  'chart_spec_json',
  'scope',
  'period',
  'created_at',
  'dismissed_at',
]

const at = (hour: number) => new Date(`2026-10-25T${String(hour).padStart(2, '0')}:00:00.000Z`)

const chartSpec = {
  data: {
    values: [
      { merchant: 'Fixture Bakery', total: 1250 },
      { merchant: 'Fixture Grocer', total: 830 },
    ],
  },
  mark: 'bar',
  encoding: {
    x: { field: 'merchant', type: 'nominal' },
    y: { field: 'total', type: 'quantitative' },
  },
}

const insight = (fields: Partial<NewInsight> = {}): NewInsight => ({
  kind: 'pattern',
  title: 'Fixture Bakery again',
  body_md: 'Most of the week went to **Fixture Bakery**.',
  scope: 'personal',
  period: '2026-W43',
  ...fields,
})

async function seedInsight(i: NewInsight, now: Date): Promise<number> {
  const result = await insertInsight(i, now)
  if (!result.ok) throw new Error(`expected an insert, got ${result.reason}`)
  return result.id
}

// A local copy of `snapshotTables` in server/db/__tests__/overview.test.ts.
async function snapshotTables(): Promise<Record<string, Row[]>> {
  const tables: { name: string }[] = await connection('sqlite_master')
    .select('name')
    .where({ type: 'table' })
    .whereNot('name', 'like', 'knex_%')
    .whereNot('name', 'like', 'sqlite_%')
    .orderBy('name')
  const out: Record<string, Row[]> = {}
  for (const { name } of tables) {
    out[name] = await connection(name).select().orderByRaw('rowid')
  }
  return out
}

async function insightRow(id: number): Promise<Row> {
  return connection('insights').where({ id }).first()
}

// One of each kind across both scopes, one already dismissed, one whose
// stored chart spec the validator refuses, and a transaction elsewhere.
async function seedMain() {
  const personalPattern = await seedInsight(insight(), at(1))
  const strawbReport = await seedInsight(
    insight({ kind: 'report', scope: 'strawb', title: 'Fixture week', body_md: 'An invented week.' }),
    at(2),
  )
  const personalChart = await seedInsight(
    insight({ kind: 'chart', title: 'Top merchants', chart_spec: chartSpec }),
    at(3),
  )
  const dismissed = await seedInsight(insight({ title: 'Old news' }), at(4))
  await connection('insights')
    .where({ id: dismissed })
    .update({ dismissed_at: at(5).toISOString() })
  // Direct insert: insertInsight refuses a bad spec, as it should.
  const [corrupt] = await connection('insights').insert({
    kind: 'chart',
    title: 'Corrupt chart',
    body_md: 'An invented body.',
    chart_spec_json: '{"mark":"bar","data":{"url":"https://evil.example/x.json"}}',
    scope: 'strawb',
    period: '2026-W43',
    created_at: at(6).toISOString(),
    dismissed_at: null,
  })
  await connection('transactions').insert({
    akahu_id: 'trans_fixture_elsewhere',
    account_id: 'acc_fixture_everyday',
    amount_cents: -450,
  })
  return { personalPattern, strawbReport, personalChart, dismissed, corrupt }
}

const dismiss = (id: number | string) => api.post(`/api/v1/agents/insights/${id}/dismiss`)

describe('GET /api/v1/agents/insights', () => {
  it('lists every insight not dismissed, newest first, as rows with no mermaid key', async () => {
    const ids = await seedMain()

    const res = await api.get('/api/v1/agents/insights')

    expect(res.status).toBe(200)
    expect(Object.keys(res.body)).toEqual(['items'])
    expect(res.body.items.map((i: Row) => i.id)).toEqual([
      ids.corrupt,
      ids.personalChart,
      ids.strawbReport,
      ids.personalPattern,
    ])
    for (const item of res.body.items) {
      expect(Object.keys(item).sort()).toEqual([...INSIGHT_KEYS].sort())
      expect(item.dismissed_at).toBeNull()
    }
    const byId = new Map(res.body.items.map((i: Row) => [i.id, i]))
    expect(byId.get(ids.personalChart)).toEqual(await insightRow(ids.personalChart))
    expect(JSON.parse(String((byId.get(ids.personalChart) as Row).chart_spec_json))).toMatchObject({
      mark: 'bar',
    })
  })

  it('a stored chart spec the validator refuses comes back as a null chart, the rest kept', async () => {
    const { corrupt } = await seedMain()

    const res = await api.get('/api/v1/agents/insights')

    const item = res.body.items.find((i: Row) => i.id === corrupt)
    expect(item).toEqual({ ...(await insightRow(corrupt)), chart_spec_json: null })
    expect(res.text).not.toContain('evil.example')
  })

  it.each([
    ['?scope=all', ['corrupt', 'personalChart', 'strawbReport', 'personalPattern']],
    ['?scope=personal', ['personalChart', 'personalPattern']],
    ['?scope=strawb', ['corrupt', 'strawbReport']],
    ['?kind=pattern', ['personalPattern']],
    ['?kind=report', ['strawbReport']],
    ['?kind=chart', ['corrupt', 'personalChart']],
    ['?scope=strawb&kind=chart', ['corrupt']],
    ['?scope=personal&kind=report', []],
  ] as const)('%s filters', async (query, expected) => {
    const ids = await seedMain()

    const res = await api.get(`/api/v1/agents/insights${query}`)

    expect(res.status).toBe(200)
    expect(res.body.items.map((i: Row) => i.id)).toEqual(expected.map((name) => ids[name]))
  })

  it.each([
    ['?scope=nope', 'scope must be all, personal or strawb'],
    ['?scope=', 'scope must be all, personal or strawb'],
    ['?scope=personal&scope=strawb', 'scope must be all, personal or strawb'],
    ['?kind=nope', 'kind must be pattern, report or chart'],
    ['?kind=', 'kind must be pattern, report or chart'],
    ['?kind=chart&kind=report', 'kind must be pattern, report or chart'],
  ])('%s is 400', async (query, error) => {
    const res = await api.get(`/api/v1/agents/insights${query}`)

    expect(res.status).toBe(400)
    expect(res.body).toStrictEqual({ error })
  })

  it('a cross-site GET is not refused', async () => {
    await seedMain()

    const res = await api.get('/api/v1/agents/insights').set('Sec-Fetch-Site', 'cross-site')

    expect(res.status).toBe(200)
    expect(res.body.items).toHaveLength(4)
  })

  it('a database failure is 500 with fixed text, only the class logged', async () => {
    await seedMain()
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    await connection.raw('ALTER TABLE insights RENAME TO insights_x')
    try {
      const res = await api.get('/api/v1/agents/insights')

      expect(res.status).toBe(500)
      expect(res.body).toStrictEqual({ error: 'Could not list insights' })
      expect(logged.mock.calls).toEqual([['agents: could not list insights', 'Error']])
    } finally {
      await connection.raw('ALTER TABLE insights_x RENAME TO insights')
    }
  })
})

describe('POST /api/v1/agents/insights/:id/dismiss', () => {
  it('dismisses an insight, writes only its dismissed_at, and it leaves the list', async () => {
    const { personalPattern } = await seedMain()
    const before = await snapshotTables()
    const startedAt = new Date().toISOString()

    const res = await dismiss(personalPattern)

    expect(res.status).toBe(200)
    expect(Object.keys(res.body)).toEqual(['insight'])
    expect(Object.keys(res.body.insight).sort()).toEqual([...INSIGHT_KEYS].sort())
    expect(res.body.insight).toEqual(await insightRow(personalPattern))
    expect(res.body.insight.dismissed_at >= startedAt).toBe(true)

    const after = await snapshotTables()
    expect({
      ...after,
      insights: after.insights.map((r) =>
        r.id === personalPattern ? { ...r, dismissed_at: null } : r,
      ),
    }).toEqual(before)

    const list = await api.get('/api/v1/agents/insights')
    expect(list.body.items.map((i: Row) => i.id)).not.toContain(personalPattern)
  })

  it('a second dismissal is 409 and keeps the first dismissal’s time', async () => {
    const { personalPattern } = await seedMain()
    expect((await dismiss(personalPattern)).status).toBe(200)
    const afterFirst = await snapshotTables()

    const res = await dismiss(personalPattern)

    expect(res.status).toBe(409)
    expect(res.body).toStrictEqual({ error: 'Insight already dismissed' })
    expect(await snapshotTables()).toEqual(afterFirst)
  })

  it('an insight dismissed before is 409, its time unchanged', async () => {
    const { dismissed } = await seedMain()

    const res = await dismiss(dismissed)

    expect(res.status).toBe(409)
    expect((await insightRow(dismissed)).dismissed_at).toBe(at(5).toISOString())
  })

  it('a missing id is 404 and writes nothing', async () => {
    await seedMain()
    const before = await snapshotTables()

    const res = await dismiss(999_999)

    expect(res.status).toBe(404)
    expect(res.body).toStrictEqual({ error: 'Insight not found' })
    expect(await snapshotTables()).toEqual(before)
  })

  it.each(['abc', '0', '-1', '1e3', '0x10', '%207', '99999999999999999999'])(
    'id %s is 400 and writes nothing',
    async (bad) => {
      await seedMain()
      const before = await snapshotTables()

      const res = await dismiss(bad)

      expect(res.status).toBe(400)
      expect(res.body).toStrictEqual({ error: 'id must be a positive integer' })
      expect(await snapshotTables()).toEqual(before)
    },
  )

  it('a database failure is 500 with fixed text, only the class logged', async () => {
    const { personalPattern } = await seedMain()
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    await connection.raw('ALTER TABLE insights RENAME TO insights_x')
    try {
      const res = await dismiss(personalPattern)

      expect(res.status).toBe(500)
      expect(res.body).toStrictEqual({ error: 'Could not dismiss insight' })
      expect(logged.mock.calls).toEqual([['agents: could not dismiss insight', 'Error']])
    } finally {
      await connection.raw('ALTER TABLE insights_x RENAME TO insights')
    }
    expect((await insightRow(personalPattern)).dismissed_at).toBeNull()
  })

  describe('only this site may dismiss (as POST /api/v1/sync/run)', () => {
    const ownOrigin = () => `http://127.0.0.1:${served?.address.port}`

    it.each(['cross-site', 'same-site'])(
      'Sec-Fetch-Site %s is refused even with this host’s own Origin',
      async (site) => {
        const { personalPattern } = await seedMain()
        const before = await snapshotTables()

        const res = await api
          .post(`/api/v1/agents/insights/${personalPattern}/dismiss`)
          .set('Sec-Fetch-Site', site)
          .set('Origin', ownOrigin())

        expect(res.status).toBe(403)
        expect(res.body).toStrictEqual({ error: 'Forbidden' })
        expect(await snapshotTables()).toEqual(before)
      },
    )

    it.each(['http://evil.example', 'null', 'not a url'])(
      'without Sec-Fetch-Site, Origin %s is refused',
      async (origin) => {
        const { personalPattern } = await seedMain()
        const before = await snapshotTables()

        const res = await api
          .post(`/api/v1/agents/insights/${personalPattern}/dismiss`)
          .set('Origin', origin)

        expect(res.status).toBe(403)
        expect(res.body).toStrictEqual({ error: 'Forbidden' })
        expect(await snapshotTables()).toEqual(before)
      },
    )

    it.each([
      [
        'Sec-Fetch-Site same-origin, behind the dev proxy',
        { 'Sec-Fetch-Site': 'same-origin', Origin: 'http://localhost:5173' },
      ],
      ['Sec-Fetch-Site none', { 'Sec-Fetch-Site': 'none' }],
      ['this host’s own Origin', 'own'],
      ['no headers (curl)', {}],
    ] as const)('%s passes', async (_why, headers) => {
      const { personalPattern } = await seedMain()

      const res = await api
        .post(`/api/v1/agents/insights/${personalPattern}/dismiss`)
        .set(headers === 'own' ? { Origin: ownOrigin() } : headers)

      expect(res.status).toBe(200)
      expect((await insightRow(personalPattern)).dismissed_at).not.toBeNull()
    })

    it('a cross-site POST for a missing id is 403, not 404', async () => {
      const res = await api
        .post('/api/v1/agents/insights/999999/dismiss')
        .set('Sec-Fetch-Site', 'cross-site')

      expect(res.status).toBe(403)
      expect(res.body).toStrictEqual({ error: 'Forbidden' })
    })
  })
})
