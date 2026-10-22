import type { ReactNode } from 'react'
import ShellSidebar from './ShellSidebar.tsx'
import TabBar from './TabBar.tsx'

// The app shell (docs/design/handoff.md "Global layout"): the sidebar at
// 720px and up, the tab bar below it, and the main column between. The
// header is not here; each screen renders its own ScreenHeader.
//
// `leading-[normal]` undoes preflight's 1.5 line height, which the
// prototype does not have, so type sits where the design puts it.
export default function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen bg-canvas font-sans leading-[normal] text-ink antialiased">
      <ShellSidebar />
      <main className="flex min-w-0 max-w-page flex-1 flex-col gap-7 px-4 pt-5 pb-24 shell:px-10 shell:pt-9">
        {children}
      </main>
      <TabBar />
    </div>
  )
}
