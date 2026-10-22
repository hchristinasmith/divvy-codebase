import { Routes, Route } from 'react-router'
import Sidebar from './Sidebar.tsx'
import Dashboard from './Dashboard/Dashboard.tsx'
import Settings from './Settings.tsx'
import Wishlist from './Wishlist/WishlistDashboard.tsx'
import Challenges from './Challenges/ChallengesDashboard.tsx'
import '../styles/App.css'
import { useState } from 'react'
import Subscriptions from './ManageSubscriptions/Subscriptions.tsx'
import Transactions from './Transactions/TransactionsPage.tsx'
import DarkModeToggle from './DarkMode.tsx'
import Targets from './Targets/targets.tsx'
export default function App() {
  const [sidebarOpen, setSidebarOpen] = useState(false)

  return (
    <div className="flex min-h-screen flex-col font-sans">
      <div className="flex flex-1">
        <Sidebar
          isOpen={sidebarOpen}
          onClose={() => setSidebarOpen(false)}
          onToggle={() => setSidebarOpen(!sidebarOpen)}
        />

        <main
          className={`flex-1 p-6 overflow-auto transition-all duration-300 ${
            sidebarOpen ? 'ml-[240px]' : 'ml-0'
          }`}
        >
          <div className="mb-4 flex justify-end items-center space-x-4">
            <DarkModeToggle />
          </div>

          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/wishlist" element={<Wishlist />} />
            <Route
              path="/targets"
              element={
                <Targets
                  targets={[]}
                  onAddNewTarget={function (): void {
                    throw new Error('Function not implemented.')
                  }}
                />
              }
            />
            <Route path="/manage-subscriptions" element={<Subscriptions />} />
            <Route path="/challenges" element={<Challenges />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="/transactions" element={<Transactions />} />
          </Routes>
        </main>
      </div>
    </div>
  )
}
