import { useMemo, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  parseChartSpecJson,
  type ChartChannel,
  type ChartSpec,
  type ChartValue,
} from '../../../models/insights.ts'
import { formatCents } from '../../../shared/money.ts'
import { MUTED } from '../../screens/Overview/styles.ts'
import { stripBidi } from './InsightBody.tsx'
import {
  CHART_COLORS,
  CHART_CSP,
  CHART_FONT,
  CHART_SANDBOX,
  CHART_SERIES_COLORS,
  chartSrcDoc,
} from './sandbox.ts'

// An insight's chart (prd-04 Ruling 3, Ruling 8; #55). The stored text is
// checked by `parseChartSpecJson` here, at render, and only the spec it
// returns is drawn: no chart library, no expression, no eval. The SVG is
// built as React elements from that spec, serialised by React (which
// escapes every label and attribute) and shown in a sandboxed iframe under
// its own CSP (./sandbox.ts).
//
// Anything this cannot draw faithfully shows "Chart unavailable": an
// invalid spec, a quantitative cell that is not a finite number, a `_cents`
// value that is not whole cents, a y channel that is not quantitative, a
// negative pie slice, or nothing left to draw. Never a partial chart.
//
// Each mark carries an SVG `<title>` with its label and value, the value
// formatted as the axis formats it: a quantitative field whose name ends in
// `_cents` is shown in dollars, any other number as `String(value)`.
//
// Choices Vega-Lite would make differently: bars with a colour field are
// grouped, not stacked; areas with a colour field overlap; categories keep
// the order of their first row (a quantitative x sorts ascending).

const VIEW_W = 480
const VIEW_H = 280
const PAD = { top: 36, right: 16, bottom: 52, left: 76 }
const LEGEND_H = 18
const TICK_COUNT = 4
const MAX_TICKS = 24
const NO_SERIES = '(none)'

class Unavailable extends Error {}

function fail(): never {
  throw new Unavailable('chart unavailable')
}

// Two decimals is finer than any screen pixel at this viewBox.
function px(n: number): number {
  return Math.round(n * 100) / 100
}

// Cut to `max` code points, so a surrogate pair is never split.
function clip(text: string, max: number): string {
  const chars = Array.from(text)
  return chars.length <= max ? text : `${chars.slice(0, Math.max(1, max - 1)).join('')}…`
}

// ---- Values ----

function isCents(channel: ChartChannel): boolean {
  return channel.type === 'quantitative' && channel.field.endsWith('_cents')
}

// A quantitative cell: null or absent is skipped; anything else must be a
// finite number, and whole cents for a `_cents` field.
function quantity(channel: ChartChannel, cell: ChartValue | undefined): number | null {
  if (cell === null || cell === undefined) return null
  if (typeof cell !== 'number' || !Number.isFinite(cell)) fail()
  if (isCents(channel) && !Number.isSafeInteger(cell)) fail()
  return cell
}

function formatNumber(channel: ChartChannel, value: number): string {
  return isCents(channel) ? formatCents(value) : String(value)
}

// A cell as a label: a quantitative channel formats its number, any other
// channel shows the value as text.
function label(channel: ChartChannel, cell: ChartValue | undefined): string | null {
  if (channel.type === 'quantitative') {
    const value = quantity(channel, cell)
    return value === null ? null : formatNumber(channel, value)
  }
  if (cell === null || cell === undefined) return null
  return stripBidi(String(cell))
}

function axisTitle(channel: ChartChannel): string {
  const title = stripBidi(channel.title ?? channel.field).trim()
  if (isCents(channel) && title.toLowerCase().endsWith(' in cents')) {
    return title.slice(0, -' in cents'.length).trimEnd()
  }
  return title
}

function seriesColor(index: number): string {
  return CHART_SERIES_COLORS[index % CHART_SERIES_COLORS.length]
}

// ---- Scales ----

interface LinearScale {
  lo: number
  hi: number
  ticks: number[]
}

// A domain that holds zero and every value, cut into round steps.
function linearScale(values: number[], whole: boolean): LinearScale {
  let min = Math.min(0, ...values)
  let max = Math.max(0, ...values)
  if (min === max) max = min + 1
  const raw = (max - min) / TICK_COUNT
  if (!Number.isFinite(raw) || raw <= 0) fail()
  const magnitude = 10 ** Math.floor(Math.log10(raw))
  let step = [1, 2, 5, 10].map((m) => m * magnitude).find((s) => s >= raw) ?? 10 * magnitude
  if (whole) step = Math.max(1, Math.round(step))
  min = Math.floor(min / step) * step
  max = Math.ceil(max / step) * step
  const ticks: number[] = []
  for (let k = 0; min + k * step <= max + step / 2; k += 1) {
    if (k > MAX_TICKS) fail()
    const tick = min + k * step
    ticks.push(whole ? Math.round(tick) : Number(tick.toPrecision(12)))
  }
  return { lo: min, hi: max, ticks }
}

// ---- Data ----

interface Datum {
  category: number
  series: number
  value: number
  title: string
}

interface XYData {
  categories: string[]
  series: string[]
  data: Datum[]
}

function readXY(spec: ChartSpec, x: ChartChannel, y: ChartChannel): XYData {
  const color = spec.encoding.color
  const xKeys: (string | number)[] = []
  const series: string[] = []
  const rows: { xKey: string | number; xLabel: string; series: number; value: number }[] = []

  for (const row of spec.data.values) {
    const value = quantity(y, row[y.field])
    const xLabel = label(x, row[x.field])
    if (value === null || xLabel === null) continue
    const xKey = x.type === 'quantitative' ? (row[x.field] as number) : xLabel
    if (!xKeys.includes(xKey)) xKeys.push(xKey)
    const seriesLabel = color ? (label(color, row[color.field]) ?? NO_SERIES) : ''
    if (!series.includes(seriesLabel)) series.push(seriesLabel)
    rows.push({ xKey, xLabel, series: series.indexOf(seriesLabel), value })
  }
  if (rows.length === 0) fail()

  if (x.type === 'quantitative') (xKeys as number[]).sort((a, b) => a - b)
  const categories = xKeys.map((key) =>
    typeof key === 'number' ? formatNumber(x, key) : key,
  )
  const data = rows.map((r) => {
    const valueText = formatNumber(y, r.value)
    const name = color ? `${r.xLabel}, ${series[r.series]}` : r.xLabel
    return {
      category: xKeys.indexOf(r.xKey),
      series: r.series,
      value: r.value,
      title: `${name}: ${valueText}`,
    }
  })
  return { categories, series, data }
}

// ---- Drawing ----

// Every label is isolated, so a right-to-left name cannot reorder the
// amount beside it. The font is set once, on the root.
const TEXT = { unicodeBidi: 'isolate' } as const

function ChartTitle({ text }: { text: string | undefined }) {
  if (!text) return null
  return (
    <text {...TEXT} x={8} y={20} fontSize={14} fontWeight={600} fill={CHART_COLORS.ink}>
      {clip(stripBidi(text), 64)}
    </text>
  )
}

// A row of swatches under the title, one per series; past the width, the
// rest are counted.
function Legend({ series }: { series: string[] }) {
  const shown = series.length > 6 ? 5 : series.length
  const slot = (VIEW_W - 16) / (shown + (series.length > shown ? 1 : 0))
  const maxChars = Math.max(3, Math.floor((slot - 20) / 6))
  return (
    <g>
      {series.slice(0, shown).map((name, i) => (
        <g key={i}>
          <rect x={px(8 + i * slot)} y={28} width={10} height={10} fill={seriesColor(i)} />
          <text {...TEXT} x={px(22 + i * slot)} y={37} fontSize={11} fill={CHART_COLORS.muted}>
            {clip(name, maxChars)}
          </text>
        </g>
      ))}
      {series.length > shown && (
        <text {...TEXT} x={px(8 + shown * slot)} y={37} fontSize={11} fill={CHART_COLORS.muted}>
          {`+${series.length - shown} more`}
        </text>
      )}
    </g>
  )
}

function drawXY(spec: ChartSpec): ReactElement {
  const { x, y, color } = spec.encoding
  if (!x || !y || y.type !== 'quantitative') fail()
  const { categories, series, data } = readXY(spec, x, y)
  const scale = linearScale(
    data.map((d) => d.value),
    isCents(y),
  )

  const top = PAD.top + (color ? LEGEND_H : 0)
  const bottom = VIEW_H - PAD.bottom
  const left = PAD.left
  const right = VIEW_W - PAD.right
  const band = (right - left) / categories.length
  const yAt = (v: number) => px(bottom - ((v - scale.lo) / (scale.hi - scale.lo)) * (bottom - top))
  const xAt = (category: number) => px(left + band * (category + 0.5))
  const zero = yAt(0)
  const labelChars = Math.max(3, Math.floor(band / 6.5))

  let marks: ReactElement[]
  if (spec.mark === 'bar') {
    const inner = band * 0.8
    const sub = inner / series.length
    marks = data.map((d, i) => {
      const end = yAt(d.value)
      return (
        <rect
          key={i}
          x={px(left + band * d.category + band * 0.1 + sub * d.series)}
          y={Math.min(end, zero)}
          width={px(Math.max(1, sub - 1))}
          height={px(Math.max(0.5, Math.abs(zero - end)))}
          fill={seriesColor(d.series)}
        >
          <title>{d.title}</title>
        </rect>
      )
    })
  } else {
    const radius = spec.mark === 'point' ? 4 : 3
    const dots = data.map((d, i) => (
      <circle key={`dot${i}`} cx={xAt(d.category)} cy={yAt(d.value)} r={radius} fill={seriesColor(d.series)}>
        <title>{d.title}</title>
      </circle>
    ))
    const paths =
      spec.mark === 'point'
        ? []
        : series.map((name, s) => {
            const own = data
              .filter((d) => d.series === s)
              .sort((a, b) => a.category - b.category)
            const line = `M ${own.map((d) => `${xAt(d.category)} ${yAt(d.value)}`).join(' L ')}`
            const firstX = xAt(own[0].category)
            const lastX = xAt(own[own.length - 1].category)
            const area = spec.mark === 'area'
            return (
              <path
                key={`series${s}`}
                d={area ? `${line} L ${lastX} ${zero} L ${firstX} ${zero} Z` : line}
                fill={area ? seriesColor(s) : 'none'}
                fillOpacity={area ? 0.3 : undefined}
                stroke={seriesColor(s)}
                strokeWidth={2}
                strokeLinejoin="round"
              >
                <title>{color ? name : axisTitle(y)}</title>
              </path>
            )
          })
    marks = [...paths, ...dots]
  }

  return (
    <>
      {color && <Legend series={series} />}
      {scale.ticks.map((tick) => (
        <g key={`tick${tick}`}>
          <line x1={left} x2={right} y1={yAt(tick)} y2={yAt(tick)} stroke={CHART_COLORS.divider} />
          <text
            {...TEXT}
            x={left - 6}
            y={yAt(tick)}
            fontSize={11}
            fill={CHART_COLORS.muted}
            textAnchor="end"
            dominantBaseline="middle"
          >
            {formatNumber(y, tick)}
          </text>
        </g>
      ))}
      <line x1={left} x2={right} y1={zero} y2={zero} stroke={CHART_COLORS.faint} />
      {categories.map((name, i) => (
        <text
          {...TEXT}
          key={`cat${i}`}
          x={xAt(i)}
          y={bottom + 16}
          fontSize={11}
          fill={CHART_COLORS.muted}
          textAnchor="middle"
        >
          {clip(name, labelChars)}
        </text>
      ))}
      {marks}
      <text
        {...TEXT}
        x={px((left + right) / 2)}
        y={VIEW_H - 10}
        fontSize={12}
        fill={CHART_COLORS.ink}
        textAnchor="middle"
      >
        {clip(axisTitle(x), 60)}
      </text>
      <text
        {...TEXT}
        x={14}
        y={px((top + bottom) / 2)}
        fontSize={12}
        fill={CHART_COLORS.ink}
        textAnchor="middle"
        transform={`rotate(-90 14 ${px((top + bottom) / 2)})`}
      >
        {clip(axisTitle(y), 36)}
      </text>
    </>
  )
}

function drawArc(spec: ChartSpec): ReactElement {
  const { theta, color } = spec.encoding
  if (!theta || theta.type !== 'quantitative') fail()

  const series: string[] = []
  const slices: { value: number; series: number; name: string; valueText: string; title: string }[] = []
  for (const row of spec.data.values) {
    const value = quantity(theta, row[theta.field])
    if (value === null) continue
    if (value < 0) fail()
    const name = color ? (label(color, row[color.field]) ?? NO_SERIES) : `Slice ${slices.length + 1}`
    if (!series.includes(name)) series.push(name)
    const valueText = formatNumber(theta, value)
    slices.push({ value, series: series.indexOf(name), name, valueText, title: `${name}: ${valueText}` })
  }
  const total = slices.reduce((sum, s) => sum + s.value, 0)
  if (slices.length === 0 || !(total > 0) || !Number.isFinite(total)) fail()

  const cx = 130
  const cy = px((PAD.top + VIEW_H) / 2)
  const r = px((VIEW_H - PAD.top) / 2 - 16)
  const point = (angle: number) => `${px(cx + r * Math.cos(angle))} ${px(cy + r * Math.sin(angle))}`

  let angle = -Math.PI / 2
  const paths = slices.map((slice, i) => {
    const sweep = (slice.value / total) * 2 * Math.PI
    const start = angle
    angle += sweep
    const d =
      slice.value === total
        ? `M ${cx} ${px(cy - r)} A ${r} ${r} 0 1 1 ${cx} ${px(cy + r)} A ${r} ${r} 0 1 1 ${cx} ${px(cy - r)} Z`
        : `M ${cx} ${cy} L ${point(start)} A ${r} ${r} 0 ${sweep > Math.PI ? 1 : 0} 1 ${point(angle)} Z`
    return (
      <path key={i} d={d} fill={seriesColor(slice.series)} stroke={CHART_COLORS.surface} strokeWidth={1}>
        <title>{slice.title}</title>
      </path>
    )
  })

  const legendX = 260
  const rows = Math.floor((VIEW_H - PAD.top - 16) / 18)
  const shown = slices.length > rows ? rows - 1 : slices.length
  return (
    <>
      {paths}
      {slices.slice(0, shown).map((slice, i) => (
        <g key={`key${i}`}>
          <rect x={legendX} y={PAD.top + 8 + i * 18} width={10} height={10} fill={seriesColor(slice.series)} />
          <text {...TEXT} x={legendX + 16} y={PAD.top + 17 + i * 18} fontSize={11} fill={CHART_COLORS.ink}>
            {/* The name is cut, never the amount: `$1,234…` would read as a number. */}
            {`${clip(slice.name, Math.max(3, 34 - slice.valueText.length - 2))}: ${slice.valueText}`}
          </text>
        </g>
      ))}
      {slices.length > shown && (
        <text {...TEXT} x={legendX} y={PAD.top + 17 + shown * 18} fontSize={11} fill={CHART_COLORS.muted}>
          {`+${slices.length - shown} more`}
        </text>
      )}
    </>
  )
}

function drawChart(spec: ChartSpec): ReactElement {
  const body = spec.mark === 'arc' ? drawArc(spec) : drawXY(spec)
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
      role="img"
      fontFamily={CHART_FONT}
    >
      {spec.title && <title>{stripBidi(spec.title)}</title>}
      <ChartTitle text={spec.title} />
      {body}
    </svg>
  )
}

type Built = { ok: true; srcDoc: string; title: string } | { ok: false }

function build(specJson: string): Built {
  const parsed = parseChartSpecJson(specJson)
  if (!parsed.ok) return { ok: false }
  try {
    const markup = renderToStaticMarkup(drawChart(parsed.spec))
    return {
      ok: true,
      srcDoc: chartSrcDoc(markup),
      title: stripBidi(parsed.spec.title ?? 'Chart'),
    }
  } catch {
    // Unavailable, or formatCents refusing a value: either way, no chart.
    return { ok: false }
  }
}

// `csp` is the iframe's embedded-enforcement attribute; React passes a
// lowercase unknown attribute through, but its types do not list it.
const CSP_ATTRIBUTE = { csp: CHART_CSP }

/** Draws `insights.chart_spec_json`; null draws nothing. */
export default function ChartView({ specJson }: { specJson: string | null }) {
  const built = useMemo(() => (specJson === null ? null : build(specJson)), [specJson])
  if (built === null) return null
  if (!built.ok) return <p className={MUTED}>Chart unavailable</p>
  return (
    <iframe
      sandbox={CHART_SANDBOX}
      {...CSP_ATTRIBUTE}
      srcDoc={built.srcDoc}
      referrerPolicy="no-referrer"
      title={built.title}
      className="block w-full border-0"
      style={{ aspectRatio: `${VIEW_W} / ${VIEW_H}` }}
    />
  )
}
