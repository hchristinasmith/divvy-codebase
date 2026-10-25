import ScreenHeader from '../../components/Shell/ScreenHeader.tsx'
import AdvisorCard from './AdvisorCard.tsx'
import BanksCard from './BanksCard.tsx'
import PrivacyHero from './PrivacyHero.tsx'
import ServerCard from './ServerCard.tsx'
import StorageCard from './StorageCard.tsx'

// The Privacy screen (prd-02 wave 4; docs/design/handoff.md Screen 8): the
// rose hero, the Banks, Advisor and Storage cards, and the blush Server
// card. This is the place the app makes claims about itself, so every
// sentence carries a basis comment directly above it, and the design's lines
// that are not true of this app (a local model, nightly encrypted backups,
// "one machine") are replaced rather than kept (prd-02 Evidence, "The
// handoff's Privacy and Advisor copy is partly untrue").
//
// The only request it makes is the Server card's same-origin
// `GET /api/v1/sync/status`; nothing here calls a third-party host, in the
// spirit of prd-02 Ruling 7 (fonts are self-hosted).
export default function Privacy() {
  return (
    <>
      <ScreenHeader title="Privacy" subtitle="Where your data goes" />
      <section
        aria-label="Privacy"
        className="grid grid-cols-[repeat(auto-fit,minmax(280px,1fr))] gap-4.5"
      >
        <PrivacyHero />
        <BanksCard />
        <AdvisorCard />
        <StorageCard />
        <ServerCard />
      </section>
      {/* MOUNT: prd-03 "Advisor reads" list goes here (prd-03 wave 3, declared widening) */}
    </>
  )
}
