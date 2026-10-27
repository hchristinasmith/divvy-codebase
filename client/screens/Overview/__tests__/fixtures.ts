import { vi } from 'vitest'
import { pendingFetch } from '../../../components/Shell/__tests__/renderWithProviders.tsx'
import type {
  AccountSummary,
  ActivityRow,
  Alert,
  OverviewResponse,
  SafeToSpendResult,
  Scope,
  SpendingByCategoryResponse,
} from '../../../../shared/contracts.ts'
import type { CategoryGroup } from '../../../../models/categories.ts'

// Overview fixtures and a routing fetch stub, shared by the screen tests
// and client/hooks/__tests__/useAlertCount.test.ts. Not a test file: vitest
// collects only `*.test.ts(x)`. Every name and amount is invented, in
// integer cents.

export const EVERYDAY: AccountSummary = {
  id: '1',
  name: 'Everyday Invented',
  scope: 'personal',
  role: 'current',
  balanceCents: 250000,
}
export const CARD_ACCOUNT: AccountSummary = {
  id: '2',
  name: 'Card Invented',
  scope: 'personal',
  role: 'credit_card',
  balanceCents: -45000,
}
export const BUSINESS: AccountSummary = {
  id: '3',
  name: 'Business Invented',
  scope: 'strawb',
  role: 'current',
  balanceCents: 600000,
}
export const BUSINESS_POT: AccountSummary = {
  id: '4',
  name: 'Pot Invented',
  scope: 'strawb',
  role: 'tax_pot',
  balanceCents: 150000,
}

export const OVER_BUDGET: Alert = {
  id: 'over_budget:12:2026-10-20',
  kind: 'over_budget',
  scope: 'personal',
  subject: 'Cafes and restaurants',
  amountCents: 3000,
  dueDate: null,
}
export const BILL_SOON: Alert = {
  id: 'bill_due_soon:3:2026-10-30',
  kind: 'bill_due_soon',
  scope: 'personal',
  subject: 'Rent Invented',
  amountCents: 120000,
  dueDate: '2026-10-30',
}
export const BILL_OVERDUE: Alert = {
  id: 'bill_overdue:4:2026-10-18',
  kind: 'bill_overdue',
  scope: 'strawb',
  subject: 'Hosting Invented',
  amountCents: 1800,
  dueDate: '2026-10-18',
}

export const CAFE_ROW: ActivityRow = {
  id: '101',
  date: '2026-10-21',
  description: 'Cafe Invented',
  amountCents: -940,
  scope: 'personal',
  accountName: 'Everyday Invented',
  status: 'settled',
  category: 'Cafes and restaurants',
  categorySource: 'akahu',
}
export const INCOME_ROW: ActivityRow = {
  id: '102',
  date: '2026-10-20',
  description: 'Client Invented',
  amountCents: 180000,
  scope: 'strawb',
  accountName: 'Business Invented',
  status: 'settled',
  category: null,
  categorySource: 'akahu',
}
export const PENDING_ROW: ActivityRow = {
  id: '103',
  date: '2026-10-22',
  description: 'Shop Invented',
  amountCents: -4218,
  scope: 'personal',
  accountName: 'Everyday Invented',
  status: 'pending',
  category: null,
  categorySource: 'akahu',
}

export const GROUPS: CategoryGroup[] = [
  {
    name: 'Food',
    categories: ['Bakeries', 'Supermarkets and grocery stores'],
  },
  { name: 'Lifestyle', categories: ['Cafes and restaurants'] },
]

const BASE_RESULT: SafeToSpendResult = {
  scope: 'all',
  today: '2026-10-28',
  lastPayday: '2026-10-27',
  nextPayday: '2026-11-03',
  liquidCents: 850000,
  unpaidBillsCents: 120000,
  remainingBudgetCents: 30000,
  strawbTaxOwedCents: 250000,
  strawbTaxPotCents: 150000,
  strawbBillsBufferCents: 0,
  strawbTaxHoldCents: 100000,
  personalTaxOwedCents: 0,
  personalTaxPotCents: 0,
  personalTaxHoldCents: 0,
  taxHoldCents: 100000,
  cardDebtCents: 45000,
  // 850000 − 100000 − 120000 − 30000 − 45000
  safeCents: 555000,
  shortByCents: 0,
  daysToPayday: 6,
  perDayCents: 92500,
  budgets: [],
}

// What each scope's route would answer: only that scope's accounts, alerts
// and rows; the other scope's tax parts are 0.
const BY_SCOPE: Record<
  Scope,
  {
    result: Partial<SafeToSpendResult>
    accounts: AccountSummary[]
    alerts: Alert[]
    rows: ActivityRow[]
  }
> = {
  all: {
    result: {},
    accounts: [EVERYDAY, CARD_ACCOUNT, BUSINESS, BUSINESS_POT],
    alerts: [OVER_BUDGET, BILL_SOON, BILL_OVERDUE],
    rows: [PENDING_ROW, CAFE_ROW, INCOME_ROW],
  },
  personal: {
    result: {
      scope: 'personal',
      liquidCents: 250000,
      unpaidBillsCents: 120000,
      remainingBudgetCents: 30000,
      strawbTaxOwedCents: 0,
      strawbTaxPotCents: 0,
      strawbTaxHoldCents: 0,
      taxHoldCents: 0,
      cardDebtCents: 45000,
      safeCents: 55000,
      perDayCents: 9166,
    },
    accounts: [EVERYDAY, CARD_ACCOUNT],
    alerts: [OVER_BUDGET, BILL_SOON],
    rows: [PENDING_ROW, CAFE_ROW],
  },
  strawb: {
    result: {
      scope: 'strawb',
      liquidCents: 600000,
      unpaidBillsCents: 0,
      remainingBudgetCents: 0,
      cardDebtCents: 0,
      safeCents: 500000,
      perDayCents: 83333,
    },
    accounts: [BUSINESS, BUSINESS_POT],
    alerts: [BILL_OVERDUE],
    rows: [INCOME_ROW],
  },
}

export interface OverviewOverrides {
  safeToSpend?: Partial<SafeToSpendResult>
  accounts?: AccountSummary[]
  alerts?: Alert[]
  recentActivity?: ActivityRow[]
}

export function overviewFixture(
  scope: Scope,
  overrides: OverviewOverrides = {},
): OverviewResponse {
  const base = BY_SCOPE[scope]
  return {
    safeToSpend: {
      ...BASE_RESULT,
      ...base.result,
      ...overrides.safeToSpend,
    },
    accounts: overrides.accounts ?? base.accounts,
    alerts: overrides.alerts ?? base.alerts,
    recentActivity: overrides.recentActivity ?? base.rows,
    dataAsOf: null,
  }
}

/** What a handler answers: a JSON body and a status (200 by default). */
export interface Reply {
  status?: number
  body: unknown
}

/** A handler answers, or returns undefined to leave the request pending. */
export type Handler = (call: FetchCall) => Reply | undefined

export interface Handlers {
  overview?: Handler
  dismiss?: Handler
  categories?: Handler
  patch?: Handler
  spending?: Handler
  /** GET /transactions, which the Spending screen (issue 272) reads. */
  transactions?: Handler
}

export interface FetchCall {
  method: string
  url: URL
  body: string | undefined
}

/**
 * Stubs global `fetch`, routing by method and path. Handlers can be swapped
 * mid-test through the returned object. Anything without a handler,
 * including the sync pill's `/sync/status`, never settles. Every call is
 * recorded.
 *
 * The one default: GET /spending/categories answers `spendingByScope()`
 * unless the test passes its own handler (`() => undefined` to leave it
 * pending). The spending card's query sits under the overview's key, and
 * `invalidateOverview` waits for every query under it, so a spending read
 * that never settled would hold every invalidation, and every mutation
 * awaiting one, open for good.
 */
export function installFetch(initial: Handlers = {}) {
  const handlers: Handlers = { spending: spendingByScope(), ...initial }
  const calls: FetchCall[] = []

  function route(call: FetchCall): Handler | undefined {
    const path = call.url.pathname
    if (call.method === 'GET' && path === '/api/v1/overview') {
      return handlers.overview
    }
    if (
      call.method === 'POST' &&
      /^\/api\/v1\/overview\/alerts\/[^/]+\/dismiss$/.test(path)
    ) {
      return handlers.dismiss
    }
    if (call.method === 'GET' && path === '/api/v1/categories') {
      return handlers.categories
    }
    if (call.method === 'PATCH' && /^\/api\/v1\/transactions\/[^/]+$/.test(path)) {
      return handlers.patch
    }
    if (call.method === 'GET' && path === '/api/v1/spending/categories') {
      return handlers.spending
    }
    if (call.method === 'GET' && path === '/api/v1/transactions') {
      return handlers.transactions
    }
    return undefined
  }

  const fetchStub = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const call: FetchCall = {
      method: (init?.method ?? 'GET').toUpperCase(),
      url: new URL(String(input)),
      body: typeof init?.body === 'string' ? init.body : undefined,
    }
    calls.push(call)
    const reply = route(call)?.(call)
    if (reply === undefined) return pendingFetch()
    return Promise.resolve(
      new Response(JSON.stringify(reply.body), {
        status: reply.status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
  })
  vi.stubGlobal('fetch', fetchStub)

  return {
    handlers,
    calls,
    /** The recorded calls for one method and path. */
    callsTo(method: string, path: string): FetchCall[] {
      return calls.filter(
        (c) => c.method === method && c.url.pathname === path,
      )
    },
  }
}

/** Answers GET /overview with the fixture for the requested scope. */
export function overviewByScope(
  overrides: Partial<Record<Scope, OverviewOverrides>> = {},
): Handler {
  return (call) => {
    const scope = call.url.searchParams.get('scope') as Scope
    return { body: overviewFixture(scope, overrides[scope]) }
  }
}

// What GET /spending/categories would answer for each scope. The names and
// figures collide with no other fixture's, so a test can find each one on
// its own.
// `all` is both scopes; each one's lines, other and uncategorised add up to
// its total.
const SPENDING_BY_SCOPE: Record<Scope, Omit<SpendingByCategoryResponse, 'scope'>> = {
  all: {
    month: '2026-10',
    totalCents: 101773,
    categories: [
      { category: 'Groceries Invented', spentCents: 31217 },
      { category: 'Takeaways Invented', spentCents: 18833 },
      { category: 'Software Invented', spentCents: 14451 },
      { category: 'Fuel Invented', spentCents: 9119 },
      { category: 'Books Invented', spentCents: 7707 },
    ],
    otherCents: 13391,
    uncategorisedCents: 7055,
  },
  personal: {
    month: '2026-10',
    totalCents: 62337,
    categories: [
      { category: 'Groceries Invented', spentCents: 31217 },
      { category: 'Takeaways Invented', spentCents: 18833 },
      { category: 'Books Invented', spentCents: 7707 },
    ],
    otherCents: 0,
    uncategorisedCents: 4580,
  },
  strawb: {
    month: '2026-10',
    totalCents: 39436,
    categories: [
      { category: 'Software Invented', spentCents: 14451 },
      { category: 'Fuel Invented', spentCents: 9119 },
    ],
    otherCents: 13391,
    uncategorisedCents: 2475,
  },
}

export function spendingFixture(
  scope: Scope,
  overrides: Partial<SpendingByCategoryResponse> = {},
): SpendingByCategoryResponse {
  return { scope, ...SPENDING_BY_SCOPE[scope], ...overrides }
}

/** Answers GET /spending/categories with the fixture for the requested scope. */
export function spendingByScope(
  overrides: Partial<Record<Scope, Partial<SpendingByCategoryResponse>>> = {},
): Handler {
  return (call) => {
    const scope = call.url.searchParams.get('scope') as Scope
    return { body: spendingFixture(scope, overrides[scope]) }
  }
}
