import { LINK } from './styles.ts'

// The design's advisor line under the list. It hands off to Claude Desktop,
// which reads Divvy through the MCP server (prd-03); it names no
// subscription and shows no figure, so nothing here is sent anywhere.
// The link is a placeholder until #60 settles how Divvy opens Claude.
const CLAUDE_DESKTOP_URL = 'claude://'

export default function AdvisorBanner() {
  return (
    <p
      data-testid="advisor-banner"
      className="m-0 rounded-summary bg-blush px-5 py-4 text-body-14 leading-[1.45] text-rose"
    >
      <strong>Advisor:</strong> Not sure what to cancel? Ask Claude.{' '}
      <a href={CLAUDE_DESKTOP_URL} className={LINK}>
        Help me cancel →
      </a>
    </p>
  )
}
