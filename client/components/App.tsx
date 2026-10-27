import { Routes, Route } from 'react-router'
import '../styles/App.css'
import Shell from './Shell/Shell.tsx'
import { ScopeProvider } from '../context/ScopeContext.tsx'
import { screenRoutes } from '../screens/routes.tsx'
import Dashboard from './Dashboard/Dashboard.tsx'
import Settings from './Settings.tsx'
import Challenges from './Challenges/ChallengesDashboard.tsx'
import Subscriptions from './ManageSubscriptions/Subscriptions.tsx'
import Transactions from './Transactions/TransactionsPage.tsx'
import Targets from './Targets/targets.tsx'

// Every page renders inside the handoff shell, under one scope.
//
// The handoff's screens come from the route table in screens/routes.tsx.
// The routes below are the old pages: Settings is linked from the sidebar;
// the rest stay reachable by URL only until the prd-02 w5 sweep deletes
// them (prd-02 Ruling 8). The old Dashboard moved to /dashboard when the
// Overview took "/".
export default function App() {
  return (
    <ScopeProvider>
      <Shell>
        <Routes>
          {screenRoutes}
          <Route path="/settings" element={<Settings />} />
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/transactions" element={<Transactions />} />
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
        </Routes>
      </Shell>
    </ScopeProvider>
  )
}
