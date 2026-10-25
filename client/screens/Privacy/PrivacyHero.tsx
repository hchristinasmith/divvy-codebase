import { useId } from 'react'

// The Privacy screen's rose hero (docs/design/handoff.md Screen 8), across
// the whole grid. The design's own lines ("Your money data lives on one
// machine", "the advisor model ... stays inside that box") are not true of
// this app: the advisor is Claude in Claude desktop (D3), and what it reads
// leaves the server (prd-03 Ruling 5). These two sentences replace them.
export default function PrivacyHero() {
  const headingId = useId()
  return (
    <section
      aria-labelledby={headingId}
      className="col-span-full flex flex-col gap-3 rounded-card bg-pink-hover p-8 shadow-card"
    >
      {/* Basis: a single-user app with no hosted service of its own
          (CLAUDE.md; D1, D4). The only host server/ calls at runtime is
          Akahu (AKAHU_ORIGIN in server/sync/akahu-client.ts). A Xero client
          exists (XERO_ORIGIN in server/xero/client/http.ts) but nothing
          outside its tests calls it yet; neither is a Divvy cloud. Revisit
          when prd-05's Xero sync is wired, and if the Banks card should
          then name Xero. */}
      <h2
        id={headingId}
        className="m-0 max-w-[560px] font-display text-display-34 font-medium leading-[1.1] text-pretty text-surface"
      >
        Built for one person. There is no Divvy cloud.
      </h2>
      {/* Basis: D1, D4; docs/deploy.md section 1 (no public IP, loopback
          bind, tailscale serve); scripts/start.sh refuses to start without a
          tailnet; the local server binds loopback by default
          (server/index.ts). Config, not a confirmed live deploy: keep "set
          up to" until the deploy is verified. Also depends on the tailnet
          policy (docs/deploy.md section 2). */}
      <p className="m-0 max-w-[560px] text-body-15 leading-normal text-pretty text-blush">
        Divvy is set up to run on a single server that only your Tailscale
        network can reach. The cards below say where your data goes.
      </p>
    </section>
  )
}
