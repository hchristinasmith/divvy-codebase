import ClaimCard, { CLAIM } from './ClaimCard.tsx'

// Advisor: where the advisor runs and where what it reads goes. Replaces the
// design's "Local model ... never sent to a third-party API", which is not
// true of this design (prd-03 Ruling 5).
export default function AdvisorCard() {
  return (
    <ClaimCard heading="Advisor" title="Claude, not a model on your server">
      {/* Basis: D3 (the advisor is Claude desktop over MCP); prd-04 Ruling 7
          (no paid API, background agents are rules only); package.json has
          no AI SDK. "will be": the read-only connection (prd-03) is not live
          yet; change to "is" when it is. */}
      <p className={CLAIM}>
        Divvy has no AI of its own and calls no AI service. The advisor will be
        Claude, in the Claude desktop app.
      </p>
      {/* Basis: prd-03 Ruling 1 (read-only, fixed tools) and Ruling 5 (tool
          results enter your Claude conversation and so leave your server;
          the Privacy screen must say so). "Planned" because the mcp/ tools
          are not live yet; prd-03 wave 3 edits this sentence when they are. */}
      <p className={CLAIM}>
        It is planned to read your Divvy data through a read-only connection.
        What it reads goes into your Claude conversation, so it leaves your
        server.
      </p>
    </ClaimCard>
  )
}
