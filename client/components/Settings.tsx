import SettingsScreen from '../screens/Settings/index.tsx'

// The /settings page App.tsx routes to. The panel itself lives in
// client/screens/Settings (issue 46); this file stays so App.tsx and its
// test need no edit.
export default function Settings() {
  return <SettingsScreen />
}
