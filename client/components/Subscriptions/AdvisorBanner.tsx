import { LINK } from './styles.ts'

// The design's advisor line under the list. It hands off to Claude Desktop,
// which reads Divvy through the MCP server (prd-03); it names no
// subscription and shows no figure, so nothing here is sent anywhere.
//
// Opened in a new tab with no referrer, so the download site is never told
// which address Divvy was served from (the same choice as the Advisor
// screen, #60). The URL is repeated here rather than shared: the Advisor
// screen does not export it.
const CLAUDE_DESKTOP_URL = 'https://claude.ai/download'

export default function AdvisorBanner() {
  return (
    <p
      data-testid="advisor-banner"
      className="m-0 rounded-summary bg-blush px-5 py-4 text-body-14 leading-[1.45] text-rose"
    >
      <strong>Advisor:</strong> Not sure what to cancel? Ask Claude.{' '}
      <a
        href={CLAUDE_DESKTOP_URL}
        target="_blank"
        rel="noopener noreferrer"
        referrerPolicy="no-referrer"
        className={LINK}
      >
        Help me cancel →
      </a>
    </p>
  )
}
