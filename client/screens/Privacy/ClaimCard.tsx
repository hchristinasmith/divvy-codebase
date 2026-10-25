import { useId } from 'react'
import type { ReactNode } from 'react'
import { CARD, CARD_TITLE, EYEBROW } from '../Overview/styles.ts'

// One of the Privacy screen's white cards (docs/design/handoff.md Screen 8):
// the uppercase label, a short title, then the claims. The label is the
// card's heading, so a screen reader lists Banks, Advisor and Storage. Each
// claim is the caller's own paragraph, so its basis comment sits directly
// above the sentence it backs.
export default function ClaimCard({
  heading,
  title,
  children,
}: {
  heading: string
  title: string
  children: ReactNode
}) {
  const headingId = useId()
  return (
    <section
      aria-labelledby={headingId}
      className={`${CARD} flex flex-col gap-1.5 p-6`}
    >
      <h2 id={headingId} className={`${EYEBROW} text-deep`}>
        {heading}
      </h2>
      <p className={CARD_TITLE}>{title}</p>
      {children}
    </section>
  )
}

// A claim's paragraph inside a ClaimCard.
export const CLAIM = 'm-0 text-body-14 leading-normal text-ink-muted'
