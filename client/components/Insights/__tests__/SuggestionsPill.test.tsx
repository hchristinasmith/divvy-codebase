import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import { renderWithProviders } from '../../Shell/__tests__/renderWithProviders.tsx'
import type { ActivityRow } from '../../../../shared/contracts.ts'
import type { ListedProposal } from '../../../../server/agents/contracts.ts'
import SuggestionsPill from '../SuggestionsPill.tsx'

// The Overview's suggestions pill (prd-04 Ruling 2, #62; #439). One describe
// per Done-when line. Requests go through the real useProposals.ts to a
// routing fetch stub. Every value is invented. The merchant and amount come
// from each proposal (#439), so most renders pass no card rows at all.

// The pill's query key, private to useProposals.ts.
const PENDING = ['proposals', 'pending']

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

// Its transaction is 100 + id; the description and amount are the listed fields.
function proposal(id: number, over: Partial<ListedProposal> = {}): ListedProposal {
  return {
    id,
    transaction_id: 100 + id,
    current_category: null,
    proposed_category: 'Cafes and restaurants',
    confidence: 0.9,
    reason: `Invented reason ${id}`,
    origin: 'rule',
    status: 'pending',
    created_at: '2026-10-27T09:00:00.000Z',
    description: 'Invented Cafe',
    amountCents: -1250,
    ...over,
  }
}

// A card row whose id matches proposal 1's transaction, to prove the pill
// ignores it.
const CAFE: ActivityRow = {
  id: '101',
  date: '2026-10-27',
  description: 'Invented Card Row',
  amountCents: -9999,
  scope: 'personal',
  accountName: 'Everyday',
  status: 'settled',
  category: null,
  categorySource: 'akahu',
}

interface Reply {
  status?: number
  body: unknown
}

interface Call {
  method: string
  path: string
}

// GET answers with `list`; a POST to accept or reject answers with what
// `decide` returns, or rejects when it throws (a network failure). A
// promise from `decide` holds the request open.
function installFetch(
  list: ListedProposal[],
  decide: (call: Call) => Reply | Promise<Reply> = () => ({ body: {} }),
) {
  const calls: Call[] = []
  const stub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = {
      method: (init?.method ?? 'GET').toUpperCase(),
      path: new URL(String(input)).pathname,
    }
    calls.push(call)
    let reply: Reply
    if (call.method === 'GET' && call.path === '/api/v1/agents/proposals') {
      reply = { body: { items: list } }
    } else if (call.method === 'POST') {
      reply = await decide(call)
    } else {
      throw new Error(`unexpected ${call.method} ${call.path}`)
    }
    return new Response(JSON.stringify(reply.body), {
      status: reply.status ?? 200,
      headers: { 'content-type': 'application/json' },
    })
  })
  vi.stubGlobal('fetch', stub)
  return {
    calls,
    posts: () => calls.filter((c) => c.method === 'POST'),
  }
}

async function openList(label: string): Promise<void> {
  fireEvent.click(await screen.findByRole('button', { name: label }))
}

function item(id: number): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-proposal-id="${id}"]`)
  if (!el) throw new Error(`no proposal ${id}`)
  return el
}

function itemIds(): string[] {
  return [...document.querySelectorAll('[data-proposal-id]')].map(
    (el) => el.getAttribute('data-proposal-id') ?? '',
  )
}

describe('the pill counts the pending proposals and is absent at zero', () => {
  it('reads "3 category suggestions" and lists each one, with the card having no rows', async () => {
    const fx = installFetch([
      proposal(1, {
        current_category: 'Shopping',
        reason: 'Matches 2 corrections',
        description: 'Invented Shop',
        amountCents: -4000,
      }),
      proposal(2, { description: null, amountCents: null }),
      proposal(3),
    ])
    renderWithProviders(<SuggestionsPill rows={[]} />)

    await openList('3 category suggestions')

    expect(itemIds()).toEqual(['1', '2', '3'])
    // The merchant and amount come from the proposal itself.
    const first = item(1)
    expect(first.textContent).toContain('Invented Shop')
    expect(first.textContent).toContain('-$40.00')
    expect(first.textContent).toContain('Shopping → Cafes and restaurants')
    expect(first.textContent).toContain('Matches 2 corrections')
    // A transaction with no description falls back to its id, and with no
    // amount shows none; a null category is named.
    expect(item(2).textContent).toContain('Transaction #102')
    expect(item(2).textContent).not.toContain('$')
    expect(item(2).textContent).toContain('Uncategorised → Cafes and restaurants')
    expect(fx.posts()).toHaveLength(0)
  })

  it('renders nothing when no proposal is pending', async () => {
    installFetch([])
    const { container, client } = renderWithProviders(<SuggestionsPill />)

    // Settled, so the empty card is the zero case, not the loading one.
    await waitFor(() =>
      expect(client.getQueryState(PENDING)?.status).toBe('success'),
    )
    expect(container.innerHTML).toBe('')
    expect(screen.queryByText(/category suggestion/)).toBeNull()
  })

  it('renders nothing when the read fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
    )
    const { container, client } = renderWithProviders(<SuggestionsPill />)

    await waitFor(() =>
      expect(client.getQueryState(PENDING)?.status).toBe('error'),
    )
    expect(container.innerHTML).toBe('')
  })
})

describe('the pill reads the merchant and amount from the proposal, not the card', () => {
  it('shows the proposal’s description and amount even when the card has a row for the same transaction', async () => {
    installFetch([proposal(1, { description: 'Invented Shop', amountCents: -4000 })])
    renderWithProviders(<SuggestionsPill rows={[CAFE]} />)

    await openList('1 category suggestion')

    expect(item(1).textContent).toContain('Invented Shop')
    expect(item(1).textContent).toContain('-$40.00')
    expect(item(1).textContent).not.toContain('Invented Card Row')
    expect(item(1).textContent).not.toContain('-$99.99')
  })
})

describe('accept sends one request, drops the row and refreshes the Overview', () => {
  it('posts once on a double tap, then removes the row and lowers the count', async () => {
    let release: (reply: Reply) => void = () => {}
    const fx = installFetch(
      [proposal(1), proposal(2), proposal(3)],
      () => new Promise<Reply>((resolve) => (release = resolve)),
    )
    const { client } = renderWithProviders(<SuggestionsPill />)
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    await openList('3 category suggestions')

    const accept = within(item(2)).getByRole('button', { name: 'Accept' })
    fireEvent.click(accept)
    fireEvent.click(accept)
    fireEvent.click(within(item(2)).getByRole('button', { name: 'Reject' }))

    await waitFor(() => expect(fx.posts()).toHaveLength(1))
    expect(fx.posts()[0].path).toBe('/api/v1/agents/proposals/2/accept')
    await waitFor(() =>
      expect(
        within(item(2)).getByRole<HTMLButtonElement>('button', { name: 'Accept' })
          .disabled,
      ).toBe(true),
    )

    release({ body: {} })

    await waitFor(() => expect(itemIds()).toEqual(['1', '3']))
    expect(screen.getByRole('button', { name: '2 category suggestions' })).not.toBeNull()
    expect(fx.posts()).toHaveLength(1)
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['overview'] })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['budgets'] })
  })

  it('removes the pill when the last proposal is accepted', async () => {
    const fx = installFetch([proposal(1)])
    const { container } = renderWithProviders(<SuggestionsPill />)
    await openList('1 category suggestion')

    fireEvent.click(within(item(1)).getByRole('button', { name: 'Accept' }))

    await waitFor(() => expect(container.innerHTML).toBe(''))
    expect(screen.queryByText(/category suggestion/)).toBeNull()
    expect(fx.posts().map((c) => c.path)).toEqual([
      '/api/v1/agents/proposals/1/accept',
    ])
  })

  it('says "1 category suggestion" for one', async () => {
    installFetch([proposal(1)])
    renderWithProviders(<SuggestionsPill />)

    expect(
      await screen.findByRole('button', { name: '1 category suggestion' }),
    ).not.toBeNull()
  })
})

describe('reject calls the reject route and removes the row', () => {
  it('posts to reject and drops the row', async () => {
    const fx = installFetch([proposal(1), proposal(2)])
    renderWithProviders(<SuggestionsPill />)
    await openList('2 category suggestions')

    fireEvent.click(within(item(1)).getByRole('button', { name: 'Reject' }))

    await waitFor(() => expect(itemIds()).toEqual(['2']))
    expect(fx.posts().map((c) => c.path)).toEqual([
      '/api/v1/agents/proposals/1/reject',
    ])
    expect(screen.getByRole('button', { name: '1 category suggestion' })).not.toBeNull()
  })
})

describe('a failure shows a message and keeps the row', () => {
  it("shows the server's text for a 409 and keeps the row and count", async () => {
    installFetch([proposal(1), proposal(2)], () => ({
      status: 409,
      body: { error: 'Invented: the category has changed since' },
    }))
    renderWithProviders(<SuggestionsPill />)
    await openList('2 category suggestions')

    fireEvent.click(within(item(1)).getByRole('button', { name: 'Accept' }))

    const alert = await within(item(1)).findByRole('alert')
    expect(alert.textContent).toBe('Invented: the category has changed since')
    expect(itemIds()).toEqual(['1', '2'])
    expect(screen.getByRole('button', { name: '2 category suggestions' })).not.toBeNull()
    // The buttons come back, so the tap can be retried.
    expect(
      within(item(1)).getByRole<HTMLButtonElement>('button', { name: 'Accept' })
        .disabled,
    ).toBe(false)
  })

  it('says the server could not be reached when the request fails', async () => {
    installFetch([proposal(1)], () => {
      throw new TypeError('Failed to fetch')
    })
    renderWithProviders(<SuggestionsPill />)
    await openList('1 category suggestion')

    fireEvent.click(within(item(1)).getByRole('button', { name: 'Reject' }))

    const alert = await within(item(1)).findByRole('alert')
    expect(alert.textContent).toBe('The server could not be reached')
    expect(itemIds()).toEqual(['1'])
  })
})

describe('proposal text is rendered as text, never as HTML', () => {
  it('shows markup in a reason literally', async () => {
    installFetch([proposal(1, { reason: '<b>x</b>' })])
    renderWithProviders(<SuggestionsPill />)
    await openList('1 category suggestion')

    expect(item(1).querySelector('b')).toBeNull()
    expect(item(1).textContent).toContain('<b>x</b>')
  })

  it('shows markup in a merchant and in either category literally', async () => {
    installFetch([
      proposal(1, { description: '<b>x</b>' }),
      proposal(2, { current_category: '<b>x</b>' }),
      proposal(3, { proposed_category: '<b>x</b>' }),
    ])
    renderWithProviders(<SuggestionsPill />)
    await openList('3 category suggestions')

    const list = screen.getByRole('list', { name: 'Category suggestions' })
    expect(list.querySelector('b')).toBeNull()
    expect(item(1).textContent).toContain('<b>x</b>')
    expect(item(2).textContent).toContain('<b>x</b> → Cafes and restaurants')
    expect(item(3).textContent).toContain('Uncategorised → <b>x</b>')
  })
})
