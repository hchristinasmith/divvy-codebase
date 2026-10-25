// What a screen shows until its own issue builds it. Says so plainly rather
// than showing sample numbers (prd-02: nothing may look like data we do not
// have). A card in the update 2 look (prd-02 Ruling 13): no border, a hard
// pink offset instead.
export default function StubBody() {
  return (
    <div className="rounded-card bg-surface p-6 text-body-14 text-ink-muted shadow-card">
      This screen is built in a later step.
    </div>
  )
}
