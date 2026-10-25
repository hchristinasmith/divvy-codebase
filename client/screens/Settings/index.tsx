import ScreenHeader from '../../components/Shell/ScreenHeader.tsx'
import AccountRoles from './AccountRoles.tsx'
import SettingsForm from './SettingsForm.tsx'

// The Settings screen (issue 46): the numbers safe-to-spend reads, and what
// each account is for. Reached at /settings through
// client/components/Settings.tsx.
export default function SettingsScreen() {
  return (
    <>
      <ScreenHeader
        title="Settings"
        subtitle="Tax, payday and what each account is for."
      />
      <div className="flex flex-col gap-6">
        <SettingsForm />
        <AccountRoles />
      </div>
    </>
  )
}
