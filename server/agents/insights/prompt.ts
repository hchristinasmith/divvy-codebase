// The insights agent's template module (prd-04 Ruling 7; #47). The name is
// kept from the issue: there is no model and no prompt. Each insight is
// fixed markdown filled from `Aggregates` (./queries.ts), with a chart spec
// built in code; `insertInsight` validates the spec on write (Ruling 8).
//
// Every number here is copied from `Aggregates`. This module selects and
// orders; it adds, subtracts and divides nothing, so each figure an insight
// shows is a queries.ts output the tests check against the database.
//
// Merchant and category labels arrive cleaned by `cleanLabel`, and every
// one is still written into markdown through `mdCode`, a code span, so a
// label renders as text whatever it holds. The markdown has no links,
// images, autolinks or HTML. Fixed titles, field names and channel titles
// hold no `:`, `<` or `/`, and the spec omits `$schema` (its URL is the one
// string the validator would read as a link).
import type { ChartSpec, InsightScope } from '../../../models/insights.ts'
import { formatCents } from '../../../shared/money.ts'
import type { NewInsight } from '../db/insights.ts'
import type { Aggregates } from './queries.ts'

// The categories the week-over-week chart shows, by size of change.
const WEEK_CHANGE_CATEGORIES = 8

/** A cleaned label as an inline code span; a backtick or line break in it becomes a space. */
export function mdCode(label: string): string {
  const safe = label.replace(/[`\r\n]/g, ' ').trim()
  return `\`${safe === '' ? '?' : safe}\``
}

function signedCents(cents: number): string {
  return cents > 0 ? `+${formatCents(cents)}` : formatCents(cents)
}

function nonzeroChanges(a: Aggregates) {
  return a.wow.byCategory.filter((c) => c.changeCents !== 0).slice(0, WEEK_CHANGE_CATEGORIES)
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

export function topMerchantsMarkdown(a: Aggregates): string {
  const lines = ['## Top merchants', '']
  for (const m of a.topMerchants) {
    const times = m.count === 1 ? '1 transaction' : `${m.count} transactions`
    lines.push(`- ${mdCode(m.merchant)} ${formatCents(m.spendCents)} across ${times}`)
  }
  lines.push('', '## Unusual spends', '')
  if (a.unusual.length === 0) {
    lines.push("Nothing stood out against each merchant's recent spending.")
  } else {
    for (const u of a.unusual) {
      lines.push(
        `- ${mdCode(u.merchant)} on ${u.date}, ${formatCents(u.amountCents)} against a typical ${formatCents(u.typicalCents)} (${mdCode(u.category)})`,
      )
    }
  }
  return lines.join('\n')
}

export function weekOverWeekMarkdown(a: Aggregates): string {
  const { wow } = a
  const pct = wow.changePct === null ? '' : ` (${wow.changePct > 0 ? '+' : ''}${wow.changePct}%)`
  const lines = [
    `Spend in ${a.week} was ${formatCents(wow.thisWeekCents)}, against ${formatCents(wow.lastWeekCents)} the week before, a change of ${signedCents(wow.changeCents)}${pct}.`,
    '',
    '## Biggest changes by category',
    '',
  ]
  for (const c of nonzeroChanges(a)) {
    lines.push(
      `- ${mdCode(c.category)} ${signedCents(c.changeCents)}, ${formatCents(c.thisCents)} this week and ${formatCents(c.lastCents)} the week before`,
    )
  }
  return lines.join('\n')
}

export function monthlyMarkdown(a: Aggregates): string {
  const categories: string[] = []
  for (const cell of a.monthly) {
    if (!categories.includes(cell.category)) categories.push(cell.category)
  }
  const [first] = a.months
  return [
    `Spend by category for each month from ${first} to the week ending ${a.asOf}.`,
    '',
    `Categories shown ${categories.map(mdCode).join(', ')}.`,
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Chart specs
// ---------------------------------------------------------------------------

export function topMerchantsChart(a: Aggregates): ChartSpec {
  return {
    title: 'Top merchants by spend',
    data: { values: a.topMerchants.map((m) => ({ merchant: m.merchant, spend_cents: m.spendCents })) },
    mark: 'bar',
    encoding: {
      x: { field: 'merchant', type: 'nominal', title: 'Merchant' },
      y: { field: 'spend_cents', type: 'quantitative', title: 'Spend in cents' },
    },
  }
}

export function weekOverWeekChart(a: Aggregates): ChartSpec {
  return {
    title: 'Change in spend by category',
    data: {
      values: nonzeroChanges(a).map((c) => ({ category: c.category, change_cents: c.changeCents })),
    },
    mark: 'bar',
    encoding: {
      x: { field: 'category', type: 'nominal', title: 'Category' },
      y: { field: 'change_cents', type: 'quantitative', title: 'Change in cents' },
    },
  }
}

export function monthlyChart(a: Aggregates): ChartSpec {
  return {
    title: 'Spend by category per month',
    data: {
      values: a.monthly.map((c) => ({ month: c.month, category: c.category, spend_cents: c.spendCents })),
    },
    mark: 'bar',
    encoding: {
      x: { field: 'month', type: 'ordinal', title: 'Month' },
      y: { field: 'spend_cents', type: 'quantitative', title: 'Spend in cents' },
      color: { field: 'category', type: 'nominal', title: 'Category' },
    },
  }
}

// ---------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------

/** The insights for one week, each skipped when its aggregate is empty. */
export function buildDrafts(a: Aggregates, scope: InsightScope): NewInsight[] {
  const drafts: NewInsight[] = []
  if (a.topMerchants.length > 0) {
    drafts.push({
      kind: 'pattern',
      title: `Top merchants and unusual spends, ${a.week}`,
      body_md: topMerchantsMarkdown(a),
      chart_spec: topMerchantsChart(a),
      scope,
      period: a.week,
    })
  }
  if (nonzeroChanges(a).length > 0) {
    drafts.push({
      kind: 'report',
      title: `Spending against last week, ${a.week}`,
      body_md: weekOverWeekMarkdown(a),
      chart_spec: weekOverWeekChart(a),
      scope,
      period: a.week,
    })
  }
  if (a.monthly.length > 0) {
    drafts.push({
      kind: 'chart',
      title: `Spend by category, last ${a.months.length} months`,
      body_md: monthlyMarkdown(a),
      chart_spec: monthlyChart(a),
      scope,
      period: a.week,
    })
  }
  return drafts
}
