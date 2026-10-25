import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, screen } from '@testing-library/react'
import { grabSettings, grabSettingsAccounts } from '../../apis/settings.ts'
import {
  pendingFetch,
  renderWithProviders,
} from '../Shell/__tests__/renderWithProviders.tsx'
import Settings from '../Settings.tsx'

// The /settings page App.tsx routes to renders the Settings screen
// (issue 46), not the old Akahu connect toggle. Requests are mocked.

vi.mock('../../apis/settings.ts', () => ({
  grabSettings: vi.fn(),
  updateSettings: vi.fn(),
  grabSettingsAccounts: vi.fn(),
  updateAccountRole: vi.fn(),
}))

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(pendingFetch))
  vi.mocked(grabSettings).mockReturnValue(new Promise(() => {}))
  vi.mocked(grabSettingsAccounts).mockReturnValue(new Promise(() => {}))
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.resetAllMocks()
})

it('renders the Settings screen', () => {
  renderWithProviders(<Settings />, { path: '/settings' })

  expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Settings')
  expect(screen.queryByText(/akahu/i)).toBeNull()
  expect(grabSettings).toHaveBeenCalled()
})
