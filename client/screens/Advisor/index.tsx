import { useId } from 'react'
import { Link } from 'react-router'
import ScreenHeader from '../../components/Shell/ScreenHeader.tsx'
import { CARD, CARD_TITLE, EYEBROW, LINK } from '../Overview/styles.ts'

// The Advisor screen (prd-02 wave 4; docs/design/handoff.md Screen 6): one
// card that sends you to Claude desktop. The design's chat (thread, bubbles,
// typing indicator, suggestion chips, input and Send button) and its
// "Runs locally on your server" footer are left out on purpose: the advisor
// is Claude desktop over MCP (D3), Divvy calls no AI service (prd-04
// Ruling 7), and Claude desktop is the chat surface (prd-03 Ruling 5). The
// issue's Done-when 3 is not met while a chat input renders here.

// Opened in a new tab with no referrer, so the download site is never told
// which address Divvy was served from.
const CLAUDE_DESKTOP_URL = 'https://claude.ai/download'

const PARAGRAPH = 'm-0 max-w-xl text-body-14 leading-normal text-ink-muted'

export default function Advisor() {
  const headingId = useId()
  return (
    <>
      <ScreenHeader
        title="Advisor"
        subtitle="Your advisor lives in Claude desktop"
      />
      <section
        aria-labelledby={headingId}
        className={`${CARD} flex flex-col gap-3 p-6`}
      >
        <h2 id={headingId} className={`${EYEBROW} text-deep`}>
          Advisor
        </h2>
        <p className={CARD_TITLE}>There is no chat box here</p>
        {/* Basis: D3 (the advisor is Claude desktop over MCP); prd-04
            Ruling 7 (no paid API); package.json has no AI SDK. */}
        <p className={PARAGRAPH}>
          The advisor is Claude, in the Claude desktop app. Divvy does not run
          an AI model or call an AI service, so there is nothing to type into on
          this screen.
        </p>
        {/* Basis: prd-03 Ruling 1 (strictly read-only, fixed tools).
            Conditional ("When ... is connected") because the mcp/ tools are
            not live yet; it stays true once they are. */}
        <p className={PARAGRAPH}>
          When Claude desktop is connected to Divvy, Claude can read your Divvy
          data but cannot change it.
        </p>
        {/* Basis: prd-03 Ruling 5 (tool results enter your Claude
            conversation and so leave your server). */}
        <p className={PARAGRAPH}>
          What Claude reads goes into your Claude conversation. See{' '}
          <Link to="/privacy" className={LINK}>
            Privacy
          </Link>
          .
        </p>
        <a
          href={CLAUDE_DESKTOP_URL}
          target="_blank"
          rel="noopener noreferrer"
          referrerPolicy="no-referrer"
          className={`${LINK} self-start text-body-14`}
        >
          Claude desktop download page
        </a>
      </section>
    </>
  )
}
