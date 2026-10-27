import type { Insight } from '../../../models/insights.ts'
import { CARD, CARD_TITLE, SECONDARY_BUTTON } from '../../screens/Overview/styles.ts'
import ChartView from './ChartView.tsx'
import InsightBody, { stripBidi } from './InsightBody.tsx'

// One insight from the inbox (prd-04 Ruling 2, Ruling 3; #55): its title,
// its markdown body and its chart, if it has one. The title is outside text
// like the body, so it is shown as an isolated text node with bidi controls
// removed. Dismiss shows only when the caller can act on it. The optional
// Mermaid diagram is not drawn in this pass.

export default function InsightCard({
  insight,
  onDismiss,
}: {
  insight: Insight
  onDismiss?: (id: number) => void
}) {
  return (
    <article className={`${CARD} flex flex-col gap-3 p-5`}>
      <div className="flex items-start justify-between gap-3">
        <h3 className={`${CARD_TITLE} break-words`}>
          <bdi>{stripBidi(insight.title)}</bdi>
        </h3>
        {onDismiss && (
          <button
            type="button"
            className={`${SECONDARY_BUTTON} shrink-0`}
            onClick={() => onDismiss(insight.id)}
          >
            Dismiss
          </button>
        )}
      </div>
      <InsightBody markdown={insight.body_md} />
      <ChartView specJson={insight.chart_spec_json} />
    </article>
  )
}
