import { formatCents } from '../../../shared/money.ts'
import type { BillsResponse, Scope } from '../../../shared/contracts.ts'
import { nextOneLabel } from './format.ts'
import {
  BLUSH_TILE,
  BLUSH_TILE_LABEL,
  TILE,
  TILE_CAPTION,
  TILE_GRID,
  TILE_LABEL,
  TILE_VALUE,
} from './styles.ts'

// The three figures above the list, exactly as the route sent them
// (server/routes/bills.ts): nothing here adds up the rows.
//
// "Due before payday" is gross. The Overview's "Bills due" is the same bills
// less the part the Strawb tax pot covers (prd-02 Ruling 12), so wherever
// Strawb bills are in view the two figures differ on purpose, and a caption
// says why. In Personal there is no pot and they agree.
export default function SummaryTiles({
  data,
  scope,
}: {
  data: BillsResponse
  scope: Scope
}) {
  return (
    <div className={TILE_GRID}>
      <div className={TILE}>
        <span className={TILE_LABEL}>Due before payday</span>
        <span data-testid="tile-due" className={TILE_VALUE}>
          {formatCents(data.dueBeforePaydayCents)}
        </span>
        {scope !== 'personal' && (
          <p className={TILE_CAPTION}>
            All of them, before the Strawb tax pot&apos;s share, so it can be
            more than Overview&apos;s “Bills due”.
          </p>
        )}
      </div>
      <div className={TILE}>
        <span className={TILE_LABEL}>Next one</span>
        <span data-testid="tile-next" className={TILE_VALUE}>
          {nextOneLabel(data.nextBill)}
        </span>
      </div>
      <div className={BLUSH_TILE}>
        <span className={BLUSH_TILE_LABEL}>Paid this month</span>
        <span data-testid="tile-paid" className={TILE_VALUE}>
          {formatCents(data.paidThisMonthCents)}
        </span>
      </div>
    </div>
  )
}
