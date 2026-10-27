import { Routes, Route } from 'react-router'
import '../styles/App.css'
import Shell from './Shell/Shell.tsx'
import { ScopeProvider } from '../context/ScopeContext.tsx'
import { screenRoutes } from '../screens/routes.tsx'
import Spending from '../screens/Spending/index.tsx'
import Settings from './Settings.tsx'

// Every page renders inside the handoff shell, under one scope.
//
// The handoff's screens come from the route table in screens/routes.tsx.
// Settings is routed here and linked from the sidebar. The old Dashboard,
// Transactions, Targets, Subscriptions and Challenges pages were deleted in
// the prd-02 w5 sweep (prd-02 Ruling 8).
//
// /spending (issue 272) is a handoff-style screen routed here rather than in
// screens/routes.tsx: that table also feeds the sidebar and the tab bar, and
// the handoff gives Spending no entry in either. It is reached from the
// Overview's "Spending by category" card.
export default function App() {
  return (
    <ScopeProvider>
      <Shell>
        <Routes>
          {screenRoutes}
          <Route path="/spending" element={<Spending />} />
          <Route path="/settings" element={<Settings />} />
        </Routes>
      </Shell>
    </ScopeProvider>
  )
}
