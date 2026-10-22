// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import TxnItem from '../TxnItem.tsx'
import type { Transaction } from '../../../../models/transactions.ts'

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
})
