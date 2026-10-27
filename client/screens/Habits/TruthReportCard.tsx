import { TRUTH_CARD, TRUTH_EYEBROW, TRUTH_NOTE, TRUTH_TITLE } from './styles.ts'

// Weekly truth report (handoff.md Screen 5; prd-02, Out of scope: "the CTA
// links to Claude desktop"). The advisor is Claude desktop over the MCP
// server (prd-03), not a chat in this app, so this card only says where to
// ask. It is not a button: it opens no chat, sends no prompt and goes to no
// other screen.
export default function TruthReportCard() {
  return (
    <section aria-label="Weekly truth report" className={TRUTH_CARD}>
      <h2 className={TRUTH_EYEBROW}>Weekly truth report</h2>
      <p className={TRUTH_TITLE}>Ask Claude desktop for this week&apos;s honest read.</p>
      <p className={TRUTH_NOTE}>
        Ask it for the weekly truth report. It must name at least one flaw, even in a
        good week.
      </p>
    </section>
  )
}
