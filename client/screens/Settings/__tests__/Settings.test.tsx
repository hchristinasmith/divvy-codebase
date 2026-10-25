import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import {
  grabSettings,
  grabSettingsAccounts,
  updateAccountRole,
  updateSettings,
} from '../../../apis/settings.ts'
import {
  pendingFetch,
  renderWithProviders,
} from '../../../components/Shell/__tests__/renderWithProviders.tsx'
import type {
  AccountSettingsRow,
  SettingsResponse,
} from '../../../../shared/contracts.ts'
import SettingsScreen from '../index.tsx'

// The Settings screen (issue 46). The settings requests are mocked; the
// sync pill's fetch never settles. Every value is invented.

vi.mock('../../../apis/settings.ts', () => ({
  grabSettings: vi.fn(),
  updateSettings: vi.fn(),
  grabSettingsAccounts: vi.fn(),
  updateAccountRole: vi.fn(),
}))
const grab = vi.mocked(grabSettings)
const update = vi.mocked(updateSettings)
const grabAccounts = vi.mocked(grabSettingsAccounts)
const setRole = vi.mocked(updateAccountRole)

const SETTINGS: SettingsResponse = {
  taxRateBasisPoints: 2500,
  profitCents: 0,
  paydayWeekday: 2,
  personalTaxOwedCents: 0,
  currency: '$',
}

const EVERYDAY: AccountSettingsRow = {
  id: '7',
  name: 'Everyday Invented',
  scope: 'personal',
  role: 'current',
}
const POT: AccountSettingsRow = {
  id: '12',
  name: 'Pot Invented',
  scope: 'strawb',
  role: null,
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(pendingFetch))
  grab.mockResolvedValue(SETTINGS)
  grabAccounts.mockResolvedValue({ items: [EVERYDAY, POT] })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.resetAllMocks()
})

function field(label: string): HTMLInputElement {
  return screen.getByLabelText(label)
}
function select(label: string): HTMLSelectElement {
  return screen.getByLabelText(label)
}
function saveButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: 'Save' })
}
function options(el: HTMLSelectElement) {
  return [...el.options].map((o) => [o.value, o.textContent])
}

async function renderLoaded() {
  const rendered = renderWithProviders(<SettingsScreen />, {
    path: '/settings',
  })
  await screen.findByLabelText('Tax rate (%)')
  return rendered
}

function type(label: string, value: string) {
  fireEvent.change(field(label), { target: { value } })
}

describe('the settings form', () => {
  it('prefills the stored values as typed text', async () => {
    await renderLoaded()

    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
      'Settings',
    )
    expect(field('Tax rate (%)').value).toBe('25')
    expect(field('Strawb profit, year to date ($)').value).toBe('0.00')
    expect(select('Payday').value).toBe('2')
    expect(field('Personal income tax owed ($)').value).toBe('0.00')
    expect(select('Currency symbol').value).toBe('$')
  })

  it('says Xero will supply the profit, and offers no connect button and no Akahu toggle', async () => {
    await renderLoaded()

    expect(
      screen.queryByText(
        'Xero will supply this once it is connected. Until then, type it in.',
      ),
    ).not.toBeNull()
    expect(screen.queryByRole('button', { name: /connect/i })).toBeNull()
    expect(document.body.textContent).not.toMatch(/akahu/i)
  })

  it('offers every weekday as payday, Sunday 0 to Saturday 6', async () => {
    await renderLoaded()

    expect(options(select('Payday'))).toEqual([
      ['0', 'Sunday'],
      ['1', 'Monday'],
      ['2', 'Tuesday'],
      ['3', 'Wednesday'],
      ['4', 'Thursday'],
      ['5', 'Friday'],
      ['6', 'Saturday'],
    ])
  })

  it('offers exactly the currency symbols the server accepts', async () => {
    await renderLoaded()

    expect(options(select('Currency symbol'))).toEqual([
      ['$', '$'],
      ['NZ$', 'NZ$'],
      ['£', '£'],
    ])
  })

  it('keeps Save disabled until something changes', async () => {
    await renderLoaded()

    expect(saveButton().disabled).toBe(true)
    type('Tax rate (%)', '26')
    expect(saveButton().disabled).toBe(false)
    type('Tax rate (%)', '25')
    expect(saveButton().disabled).toBe(true)
  })

  it('sends only what changed, with the rate in basis points', async () => {
    update.mockResolvedValue({ ...SETTINGS, taxRateBasisPoints: 1050 })
    await renderLoaded()

    type('Tax rate (%)', '10.5')
    fireEvent.click(saveButton())

    await waitFor(() => expect(update).toHaveBeenCalledTimes(1))
    expect(update.mock.calls[0][0]).toStrictEqual({ taxRateBasisPoints: 1050 })
  })

  it('sends dollar fields as exact cents', async () => {
    update.mockResolvedValue({
      ...SETTINGS,
      profitCents: 104999,
      personalTaxOwedCents: 115,
      paydayWeekday: 5,
      currency: 'NZ$',
    })
    await renderLoaded()

    type('Strawb profit, year to date ($)', '1049.99')
    type('Personal income tax owed ($)', '1.15')
    fireEvent.change(select('Payday'), { target: { value: '5' } })
    fireEvent.change(select('Currency symbol'), { target: { value: 'NZ$' } })
    fireEvent.click(saveButton())

    await waitFor(() => expect(update).toHaveBeenCalledTimes(1))
    expect(update.mock.calls[0][0]).toStrictEqual({
      profitCents: 104999,
      personalTaxOwedCents: 115,
      paydayWeekday: 5,
      currency: 'NZ$',
    })
  })

  it('shows Saved and refetches settings and the overview after a save', async () => {
    update.mockResolvedValue({ ...SETTINGS, profitCents: 50000 })
    const { client } = await renderLoaded()
    const invalidate = vi.spyOn(client, 'invalidateQueries')

    type('Strawb profit, year to date ($)', '500')
    fireEvent.click(saveButton())

    const status = await screen.findByRole('status')
    expect(status.textContent).toBe('Saved')
    expect(field('Strawb profit, year to date ($)').value).toBe('500.00')
    await waitFor(() => {
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['settings'] })
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['overview'] })
    })
  })

  it('clears Saved on the next edit', async () => {
    update.mockResolvedValue({ ...SETTINGS, paydayWeekday: 3 })
    await renderLoaded()

    fireEvent.change(select('Payday'), { target: { value: '3' } })
    fireEvent.click(saveButton())
    await screen.findByRole('status')

    type('Tax rate (%)', '30')
    expect(screen.queryByRole('status')).toBeNull()
  })

  it("shows the server's refusal and never Saved", async () => {
    update.mockRejectedValue(
      new Error('profitCents must be a whole number of cents, 0 or more'),
    )
    await renderLoaded()

    type('Strawb profit, year to date ($)', '12')
    fireEvent.click(saveButton())

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe(
      'profitCents must be a whole number of cents, 0 or more',
    )
    expect(screen.queryByRole('status')).toBeNull()
  })

  it.each([
    ['Tax rate (%)', 'abc', 'Enter a percentage, like 25 or 10.5'],
    ['Tax rate (%)', '12.345', 'Enter a percentage, like 25 or 10.5'],
    ['Tax rate (%)', '101', 'Must be 100% or less'],
    ['Tax rate (%)', '', 'Required'],
    ['Strawb profit, year to date ($)', '-5', 'Must be 0 or more'],
    [
      'Strawb profit, year to date ($)',
      '12.345',
      'Enter dollars and cents, like 1049.99',
    ],
    ['Personal income tax owed ($)', '', 'Required'],
  ])(
    'refuses %s %j beside the field and sends nothing',
    async (label, value, error) => {
      await renderLoaded()

      type(label, value)
      fireEvent.click(saveButton())

      const input = field(label)
      expect(input.getAttribute('aria-invalid')).toBe('true')
      const describedBy = (input.getAttribute('aria-describedby') ?? '').split(
        ' ',
      )
      const message = document.getElementById(describedBy[0])
      expect(message?.getAttribute('role')).toBe('alert')
      expect(message?.textContent).toBe(error)
      // A mutation would call the request a few microtasks after the click;
      // let them all run before checking it never was.
      await act(() => new Promise((resolve) => setTimeout(resolve, 0)))
      expect(update).not.toHaveBeenCalled()
    },
  )

  it('says it is loading while the settings are on their way', async () => {
    grab.mockReturnValue(new Promise<SettingsResponse>(() => {}))
    renderWithProviders(<SettingsScreen />)

    expect(screen.queryByText('Loading settings…')).not.toBeNull()
    expect(screen.queryByLabelText('Tax rate (%)')).toBeNull()
  })

  it('says when the settings could not be loaded, and tries again', async () => {
    grab.mockRejectedValueOnce(new Error('Server error (500)'))
    renderWithProviders(<SettingsScreen />)

    const section = (
      await screen.findByText(/Settings could not be loaded/)
    ).closest('section')
    expect(section?.textContent).toContain(
      'Settings could not be loaded: Server error (500)',
    )
    fireEvent.click(
      within(section as HTMLElement).getByRole('button', { name: 'Try again' }),
    )

    expect(await screen.findByLabelText('Tax rate (%)')).not.toBeNull()
    expect(grab).toHaveBeenCalledTimes(2)
  })
})

describe('account roles', () => {
  async function roleSelect(name: string) {
    return screen.findByLabelText<HTMLSelectElement>(`Role for ${name}`)
  }

  it('lists each account with its scope as plain text and its role', async () => {
    renderWithProviders(<SettingsScreen />)

    const everyday = await roleSelect('Everyday Invented')
    const pot = await roleSelect('Pot Invented')
    expect(everyday.value).toBe('current')
    expect(pot.value).toBe('')

    const row = everyday.closest('li') as HTMLElement
    expect(within(row).getByText('Personal').tagName).toBe('SPAN')
    expect(within(row).getAllByRole('combobox')).toEqual([everyday])
    expect(within(row).queryByRole('button')).toBeNull()
    expect(
      within(pot.closest('li') as HTMLElement).getByText('Strawb').tagName,
    ).toBe('SPAN')
  })

  it('offers No role and every role', async () => {
    renderWithProviders(<SettingsScreen />)

    expect(options(await roleSelect('Pot Invented'))).toEqual([
      ['', 'No role'],
      ['current', 'Current'],
      ['savings', 'Savings'],
      ['tax_pot', 'Tax pot'],
      ['credit_card', 'Credit card'],
    ])
  })

  it('sets a role and refetches settings and the overview', async () => {
    setRole.mockResolvedValue({ ...POT, role: 'tax_pot' })
    const { client } = renderWithProviders(<SettingsScreen />)
    const invalidate = vi.spyOn(client, 'invalidateQueries')

    fireEvent.change(await roleSelect('Pot Invented'), {
      target: { value: 'tax_pot' },
    })

    await waitFor(() => expect(setRole).toHaveBeenCalledTimes(1))
    expect(setRole.mock.calls[0].slice(0, 2)).toEqual(['12', 'tax_pot'])
    await waitFor(() => {
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['settings'] })
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['overview'] })
    })
  })

  it('shows the change and disables the select while it is in flight', async () => {
    setRole.mockReturnValue(new Promise<AccountSettingsRow>(() => {}))
    renderWithProviders(<SettingsScreen />)

    const pot = await roleSelect('Pot Invented')
    fireEvent.change(pot, { target: { value: 'savings' } })

    await waitFor(() => expect(pot.disabled).toBe(true))
    expect(pot.value).toBe('savings')
  })

  it('sends null for No role', async () => {
    setRole.mockResolvedValue({ ...EVERYDAY, role: null })
    renderWithProviders(<SettingsScreen />)

    fireEvent.change(await roleSelect('Everyday Invented'), {
      target: { value: '' },
    })

    await waitFor(() => expect(setRole).toHaveBeenCalledTimes(1))
    expect(setRole.mock.calls[0].slice(0, 2)).toEqual(['7', null])
  })

  it("shows the server's refusal and puts the select back", async () => {
    setRole.mockRejectedValue(new Error('Account not found'))
    renderWithProviders(<SettingsScreen />)

    const everyday = await roleSelect('Everyday Invented')
    fireEvent.change(everyday, { target: { value: 'credit_card' } })

    const row = everyday.closest('li') as HTMLElement
    const alert = await within(row).findByRole('alert')
    expect(alert.textContent).toBe('Account not found')
    expect(everyday.value).toBe('current')
    expect(everyday.disabled).toBe(false)
  })

  it('says when there are no accounts yet', async () => {
    grabAccounts.mockResolvedValue({ items: [] })
    renderWithProviders(<SettingsScreen />)

    expect(
      await screen.findByText(
        'No accounts yet. They appear after the first sync.',
      ),
    ).not.toBeNull()
    expect(screen.queryByRole('list')).toBeNull()
  })
})
