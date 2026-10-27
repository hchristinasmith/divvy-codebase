import { useRef, useState } from 'react'
import { formatCents } from '../../../shared/money.ts'
import type { ActivityRow } from '../../../shared/contracts.ts'
// Type only: erased from the client bundle.
import type { ListedProposal } from '../../../server/agents/contracts.ts'
import { ERROR, MUTED, SECONDARY_BUTTON } from '../../screens/Overview/styles.ts'
import {
  usePendingProposals,
  useProposalDecision,
  type ProposalDecision,
} from './useProposals.ts'

// The suggestions pill on the Overview's recent-activity card (prd-04
// Ruling 2, #62): "N category suggestions" when the category agent has
// pending proposals, and nothing at all otherwise (loading, a failed read,
// or none pending). Tapping it lists each proposal with Accept and Reject.
//
// The proposals route carries each transaction's description and amount
// (#439), so the pill reads both from the proposal, never from the card's rows.
//
// Every proposal field is rendered as text: the reason and the merchant are
// outside text, never markup.

interface SuggestionsPillProps {
  // Unused: ActivityCard still passes its rows. This prop goes when it stops.
  rows?: ActivityRow[]
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- ActivityCard still passes rows; the prop goes with it.
export default function SuggestionsPill(_props: SuggestionsPillProps) {
  const [open, setOpen] = useState(false)
  const proposals = usePendingProposals()

  const items = proposals.data
  if (items === undefined || items.length === 0) return null

  const count = items.length
  const label = `${count} category ${count === 1 ? 'suggestion' : 'suggestions'}`

  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        className={`${SECONDARY_BUTTON} self-start`}
        aria-expanded={open}
        onClick={() => setOpen((was) => !was)}
      >
        {label}
      </button>
      {open && (
        <ul
          aria-label="Category suggestions"
          className="m-0 flex list-none flex-col p-0"
        >
          {items.map((proposal) => (
            <SuggestionItem key={proposal.id} proposal={proposal} />
          ))}
        </ul>
      )}
    </div>
  )
}

function SuggestionItem({ proposal }: { proposal: ListedProposal }) {
  const decide = useProposalDecision()
  // A second tap can land before the disabled buttons render; this refuses
  // it, so one tap sends one request.
  const inFlight = useRef(false)

  function send(decision: ProposalDecision) {
    if (inFlight.current) return
    inFlight.current = true
    decide.mutate(
      { id: proposal.id, decision },
      {
        onSettled: () => {
          inFlight.current = false
        },
      },
    )
  }

  const name = proposal.description ?? `Transaction #${proposal.transaction_id}`

  return (
    <li
      data-proposal-id={proposal.id}
      className="flex flex-col gap-1 border-t border-divider py-3"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <span className="text-body-14 text-ink">{name}</span>
        {proposal.amountCents !== null && (
          <span className="font-mono text-body-14 text-ink">
            {formatCents(proposal.amountCents)}
          </span>
        )}
      </div>
      <p className="m-0 text-body-12 text-ink-muted">
        {proposal.current_category ?? 'Uncategorised'} → {proposal.proposed_category}
      </p>
      <p className={MUTED}>{proposal.reason}</p>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={SECONDARY_BUTTON}
          disabled={decide.isPending}
          onClick={() => send('accept')}
        >
          Accept
        </button>
        <button
          type="button"
          className={SECONDARY_BUTTON}
          disabled={decide.isPending}
          onClick={() => send('reject')}
        >
          Reject
        </button>
      </div>
      {decide.isError && (
        <p role="alert" className={ERROR}>
          {decide.error.message}
        </p>
      )}
    </li>
  )
}
