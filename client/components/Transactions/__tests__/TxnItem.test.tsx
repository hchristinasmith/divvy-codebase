// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import TxnItem from '../TxnItem.tsx'
import type { Transaction } from '../../../../models/transactions.ts'
import { categories } from '../../../../data/cats.js'

afterEach(cleanup)

function txn(overrides: Partial<Transaction>): Transaction {
  return {
    id: '1',
    account_id: 'acc_fixture_everyday',
    user_id: 'user_fixture',
    connection_id: 'conn_fixture_bank',
    created_at: '2026-09-01T09:01:00.000Z',
    updated_at: '2026-09-01T09:01:00.000Z',
    date: '2026-09-01',
    description: 'Sample Superette Te Aro',
    amount_cents: -6437,
    balance_cents: 602015,
    type: 'EFTPOS',
    hash: 'fixture_hash_002',
    category_id: '',
    category_name: '',
    category_group_id: '',
    category_group_name: 'Food',
    particulars: '',
    code: '',
    reference: '',
    other_account: '',
    logo: '',
    conversion_amount_cents: null,
    conversion_currency: 0,
    conversion_rate: 0,
    card_suffix: '',
    merchant_id: '',
    merchant_name: '',
    merchant_website: '',
    merchant_logo: '',
    category: null,
    category_source: 'akahu',
    ...overrides,
  }
}

function renderRow(transaction: Transaction) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <table>
        <tbody>
          <TxnItem transaction={transaction} />
        </tbody>
      </table>
    </QueryClientProvider>,
  )
}

describe('TxnItem', () => {
  it('shows a stored integer-cent amount as dollars', () => {
    renderRow(txn({ amount_cents: -6437 }))
    expect(screen.getByText('-$64.37')).toBeTruthy()
  })

  it('shows thousands and whole dollars without float rounding', () => {
    renderRow(txn({ amount_cents: 425000 }))
    expect(screen.getByText('$4,250.00')).toBeTruthy()
  })

  it('shows the effective category of a synced row and the group derived from its name', () => {
    renderRow(
      txn({
        category: 'Bakeries',
        category_source: 'akahu',
        category_name: '',
        category_group_name: '',
      }),
    )
    expect(screen.getByText('Bakeries')).toBeTruthy()
    expect(screen.getByText('Food')).toBeTruthy()
  })

  it('takes the group from the name, not from Akahu or legacy group fields', () => {
    renderRow(
      txn({
        category: 'Bakeries',
        category_source: 'akahu',
        category_name: '',
        category_group_name: 'Lifestyle',
        akahu_category_group_name: 'Lifestyle',
      }),
    )
    expect(screen.getByText('Food')).toBeTruthy()
    expect(screen.queryByText('Lifestyle')).toBeNull()
  })

  it('shows no category and no group when the effective category is null', () => {
    // The fixture's legacy category_group_name is 'Food'; it must not leak in.
    renderRow(txn({ category: null, category_source: 'akahu' }))
    // Cells follow the page header: Date, Description, Amount, Category, Actions.
    expect(document.querySelectorAll('td')[3]?.textContent).toBe('')
    for (const group of Object.keys(categories)) {
      expect(screen.queryByText(group)).toBeNull()
    }
  })

  it('shows a category name missing from data/cats.js without inventing a group', () => {
    renderRow(
      txn({
        category: 'Invented category',
        category_source: 'user',
      }),
    )
    expect(screen.getByText('Invented category')).toBeTruthy()
    for (const group of Object.keys(categories)) {
      expect(screen.queryByText(group)).toBeNull()
    }
  })
})
