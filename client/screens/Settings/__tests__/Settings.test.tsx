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

  it('says Save, not Saving…, once Saved shows, while the refetches are still running', async () => {
    update.mockResolvedValue({ ...SETTINGS, profitCents: 50000 })
    const { client } = await renderLoaded()
    // The refetches never finish: the save must not wait for them.
    vi.spyOn(client, 'invalidateQueries').mockReturnValue(
      new Promise<void>(() => {}),
    )

    type('Strawb profit, year to date ($)', '500')
    fireEvent.click(saveButton())

    expect((await screen.findByRole('status')).textContent).toBe('Saved')
    expect(screen.getByRole('button', { name: /^Sav/ }).textContent).toBe(
      'Save',
    )
  })

  it('locks every field while a save is in flight, and unlocks it after', async () => {
    let answer: (value: SettingsResponse) => void = () => {}
    update.mockReturnValue(
      new Promise<SettingsResponse>((resolve) => {
        answer = resolve
      }),
    )
    await renderLoaded()
    const fields = [
      field('Tax rate (%)'),
      field('Strawb profit, year to date ($)'),
      select('Payday'),
      field('Personal income tax owed ($)'),
      select('Currency symbol'),
    ]

    type('Strawb profit, year to date ($)', '500')
    fireEvent.click(saveButton())

    await waitFor(() => expect(update).toHaveBeenCalledTimes(1))
    await waitFor(() =>
      expect(fields.map((el) => el.disabled)).toEqual(fields.map(() => true)),
    )

    await act(async () => answer({ ...SETTINGS, profitCents: 50000 }))
    await waitFor(() =>
      expect(fields.map((el) => el.disabled)).toEqual(fields.map(() => false)),
    )
  })

  it("clears a field's error when that field is edited, and leaves the others", async () => {
    await renderLoaded()

    type('Tax rate (%)', 'abc')
    type('Strawb profit, year to date ($)', '-5')
    fireEvent.click(saveButton())
    expect(field('Tax rate (%)').getAttribute('aria-invalid')).toBe('true')

    type('Tax rate (%)', '20')

    const tax = field('Tax rate (%)')
    expect(tax.getAttribute('aria-invalid')).toBe('false')
    expect(screen.queryByText('Enter a percentage, like 25 or 10.5')).toBeNull()
    expect(
      field('Strawb profit, year to date ($)').getAttribute('aria-invalid'),
    ).toBe('true')
    expect(screen.queryByText('Must be 0 or more')).not.toBeNull()
  })

  it("shows the server's refusal and never Saved", async () => {
    update.mockRejectedValue(
      new Error(
        'profitCents must be a whole number of cents from 0 to 900719925474',
      ),
    )
    await renderLoaded()

    type('Strawb profit, year to date ($)', '12')
    fireEvent.click(saveButton())

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe(
      'profitCents must be a whole number of cents from 0 to 900719925474',
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

// The handoff's tokens where the settings screen uses them
// (docs/design/handoff.md): class names, because the token is the behaviour.
describe('design tokens', () => {
  function classes(el: Element) {
    return el.className.split(/\s+/)
  }

  it('codes the scope tag by scope: Personal canvas and muted, Strawb solid pink', async () => {
    renderWithProviders(<SettingsScreen />)
    const row = (name: string) =>
      within(
        screen.getByLabelText(`Role for ${name}`).closest('li') as HTMLElement,
      )
    await screen.findByLabelText('Role for Pot Invented')

    const personal = classes(row('Everyday Invented').getByText('Personal'))
    const strawb = classes(row('Pot Invented').getByText('Strawb'))
    for (const tag of [personal, strawb]) {
      expect(tag).toEqual(
        expect.arrayContaining(['rounded-tag', 'py-1', 'font-semibold']),
      )
      expect(tag).not.toContain('bg-blush')
      expect(tag).not.toContain('py-0.5')
    }
    expect(personal).toEqual(
      expect.arrayContaining(['bg-canvas', 'text-ink-muted']),
    )
    expect(strawb).toEqual(
      expect.arrayContaining(['bg-pink-hover', 'text-surface']),
    )
  })

  it('sets numbers in DM Mono and choices in DM Sans, each with a pink focus border', async () => {
    await renderLoaded()
    await screen.findByLabelText('Role for Pot Invented')

    const inputs = [
      field('Tax rate (%)'),
      field('Strawb profit, year to date ($)'),
      field('Personal income tax owed ($)'),
    ]
    const selects = [
      select('Payday'),
      select('Currency symbol'),
      select('Role for Pot Invented'),
    ]
    for (const el of inputs) {
      expect(classes(el)).toContain('font-mono')
    }
    for (const el of selects) {
      expect(classes(el)).toContain('font-sans')
      expect(classes(el)).not.toContain('font-mono')
    }
    for (const el of [...inputs, ...selects]) {
      expect(classes(el)).toEqual(
        expect.arrayContaining([
          'focus-visible:border-pink',
          'focus-visible:outline-pink',
        ]),
      )
    }
  })

  it('spaces the cards 16px apart', async () => {
    await renderLoaded()

    const card = screen
      .getByRole('heading', { name: 'Tax and payday' })
      .closest('section') as HTMLElement
    const grid = classes(card.parentElement as HTMLElement)
    expect(grid).toContain('gap-4')
    expect(grid).not.toContain('gap-6')
  })

  it('keeps solid pink for Save and blush for Try again', async () => {
    grab.mockRejectedValueOnce(new Error('Server error (500)'))
    grabAccounts.mockRejectedValueOnce(new Error('Server error (500)'))
    renderWithProviders(<SettingsScreen />)

    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: 'Try again' })).toHaveLength(
        2,
      ),
    )
    const retries = screen.getAllByRole('button', { name: 'Try again' })
    for (const retry of retries) {
      expect(classes(retry)).toEqual(
        expect.arrayContaining([
          'bg-blush',
          'text-rose',
          'hover:bg-blush-hover',
        ]),
      )
      expect(classes(retry)).not.toContain('bg-pink')
    }

    fireEvent.click(retries[0])
    await screen.findByLabelText('Tax rate (%)')
    expect(classes(saveButton())).toEqual(
      expect.arrayContaining(['bg-pink', 'text-surface']),
    )
  })
})
