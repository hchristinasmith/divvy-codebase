// The insights agent's inbox (prd-04 Rulings 2, 3 and 8; #31): writes and
// reads `insights`, and no other table.
//
// A chart spec is validated on write and again on read (Ruling 8), though
// code builds it, because merchant text reaches its labels. On write, a spec
// `validateChartSpec` refuses is not stored and nothing is written; a spec it
// accepts is stored as the validator's copy, never the input object. On
// read, stored text `parseChartSpecJson` refuses comes back as a NULL chart,
// and the rest of the row is kept, so one bad row costs its chart and not the
// insight.
//
// `Insight.mermaid` (Ruling 3) has no column. A `mermaid` key on the input is
// ignored, and a read row has no `mermaid` key.
//
// A refused input throws an error naming the field, never its value, and a
// title or body_md past its length cap is a refused input. A refused write
// throws SQLite's words without the row (`scrubbed`, in ./scrubbed.ts).
import {
  INSIGHT_KINDS,
  parseChartSpecJson,
  validateChartSpec,
  type ChartSpecRejection,
  type Insight,
  type InsightKind,
  type InsightScope,
} from '../../../models/insights.ts'
import connection from '../../db/connection.ts'
import { scrubbed } from './scrubbed.ts'

// A Record so that TypeScript refuses this file if `InsightScope` changes.
const SCOPES: Record<InsightScope, true> = { personal: true, strawb: true }

// Length caps, counted in code points, not UTF-16 units: a non-BMP character
// is one code point and two units.
const TITLE_MAX_LENGTH = 200
const BODY_MD_MAX_LENGTH = 20_000

export interface NewInsight {
  kind: InsightKind
  title: string
  body_md: string
  scope: InsightScope
  period: string
  // The in-memory spec, not text. Null or absent stores no chart.
  chart_spec?: unknown
}

export type InsertInsightResult =
  | { ok: true; id: number }
  | { ok: false; reason: ChartSpecRejection; path: string }

type InsightRow = Omit<Insight, 'mermaid'>

function notBlank(value: unknown, field: string): void {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${field} must not be blank`)
  }
}

function atMostLength(value: string, field: string, max: number): void {
  if (Array.from(value).length > max) {
    throw new Error(`${field} must be at most ${max} characters`)
  }
}

/**
 * Stores an insight. A chart spec the validator refuses returns its reason
 * and path and writes nothing.
 */
export async function insertInsight(
  insight: NewInsight,
  now: Date = new Date(),
  db = connection,
): Promise<InsertInsightResult> {
  if (!(INSIGHT_KINDS as readonly unknown[]).includes(insight.kind)) {
    throw new Error('kind is not a known insight kind')
  }
  if (typeof insight.scope !== 'string' || !Object.prototype.hasOwnProperty.call(SCOPES, insight.scope)) {
    throw new Error('scope must be personal or strawb')
  }
  notBlank(insight.title, 'title')
  atMostLength(insight.title, 'title', TITLE_MAX_LENGTH)
  notBlank(insight.body_md, 'body_md')
  atMostLength(insight.body_md, 'body_md', BODY_MD_MAX_LENGTH)
  notBlank(insight.period, 'period')

  let chartSpecJson: string | null = null
  if (insight.chart_spec !== null && insight.chart_spec !== undefined) {
    const checked = validateChartSpec(insight.chart_spec)
    if (!checked.ok) return { ok: false, reason: checked.reason, path: checked.path }
    chartSpecJson = JSON.stringify(checked.spec)
  }

  const row: Omit<InsightRow, 'id'> = {
    kind: insight.kind,
    title: insight.title,
    body_md: insight.body_md,
    chart_spec_json: chartSpecJson,
    scope: insight.scope,
    period: insight.period,
    created_at: now.toISOString(),
    dismissed_at: null,
  }
  const [{ id }]: { id: number }[] = await scrubbed(
    'insertInsight',
    db('insights').insert(row).returning('id'),
  )
  return { ok: true, id }
}

// A stored row as an `Insight`, its chart re-validated.
function fromRow(row: InsightRow): Insight {
  let chartSpecJson: string | null = null
  if (row.chart_spec_json !== null) {
    const checked = parseChartSpecJson(row.chart_spec_json)
    chartSpecJson = checked.ok ? JSON.stringify(checked.spec) : null
  }
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    body_md: row.body_md,
    chart_spec_json: chartSpecJson,
    scope: row.scope,
    period: row.period,
    created_at: row.created_at,
    dismissed_at: row.dismissed_at,
  }
}

export async function getInsight(
  id: number,
  db = connection,
): Promise<Insight | undefined> {
  const row: InsightRow | undefined = await db('insights').where({ id }).first()
  return row === undefined ? undefined : fromRow(row)
}

export interface InsightFilter {
  kind?: InsightKind
  scope?: InsightScope
  // Dismissed insights are left out unless this is true.
  includeDismissed?: boolean
}

/** Insights, newest first. */
export async function listInsights(
  filter: InsightFilter = {},
  db = connection,
): Promise<Insight[]> {
  const query = db('insights')
  if (filter.kind !== undefined) query.where({ kind: filter.kind })
  if (filter.scope !== undefined) query.where({ scope: filter.scope })
  if (filter.includeDismissed !== true) query.whereNull('dismissed_at')
  const rows: InsightRow[] = await query.orderBy([
    { column: 'created_at', order: 'desc' },
    { column: 'id', order: 'desc' },
  ])
  return rows.map(fromRow)
}

/**
 * Dismisses an insight. True when this call dismissed it; false when there
 * is no such insight or it was already dismissed, which keeps the first
 * dismissal's time.
 */
export async function dismissInsight(
  id: number,
  now: Date = new Date(),
  db = connection,
): Promise<boolean> {
  const updated = await scrubbed(
    'dismissInsight',
    db('insights').where({ id }).whereNull('dismissed_at').update({ dismissed_at: now.toISOString() }),
  )
  return updated > 0
}
