import {
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import type { QueryClient } from '@tanstack/react-query'
import { grabSettingsAccounts, updateAccount } from '../../apis/settings.ts'
import { invalidateOverview, queryKeys } from '../../apis/queryKeys.ts'
import {
  ACCOUNT_ROLES,
  ROW_SCOPES,
  type AccountRole,
  type AccountSettingsRow,
  type RowScope,
} from '../../../shared/contracts.ts'
import {
  CARD,
  ERROR,
  HEADING,
  HINT,
  SCOPE_TRACK,
  SECONDARY_BUTTON,
  SELECT,
  scopeOption,
} from './styles.ts'

// What each account is for (issue 46; prd-02 Rulings 2, 10 and 11). The
// role decides what safe-to-spend counts: only Current accounts are
// spendable, a credit card's owed balance is subtracted, and a tax pot nets
// the tax hold of its own scope. The scope is the account's owner, Personal
// or Business, set here (prd-01 Ruling 8, dated note 2026-10-25); sync never
// sets it.

// Under the settings prefix, so a settings change refetches it too.
const ACCOUNTS_KEY = [...queryKeys.settings.all, 'accounts'] as const

const ROLE_LABELS: Record<AccountRole, string> = {
  current: 'Current',
  savings: 'Savings',
  tax_pot: 'Tax pot',
  credit_card: 'Credit card',
}

// The stored scope `strawb` is shown as Business.
const SCOPE_LABELS: Record<RowScope, string> = {
  personal: 'Personal',
  strawb: 'Business',
}

function toRole(value: string): AccountRole | null {
  return ACCOUNT_ROLES.find((role) => role === value) ?? null
}

// After a save, refetch what the Overview, Transactions and account lists
// show. The last two keys are the legacy Dashboard's
// (client/components/Dashboard/Dashboard.tsx); queryKeys has no entry for them.
function refreshAfterSave(client: QueryClient): Promise<unknown> {
  return Promise.all([
    client.invalidateQueries({ queryKey: queryKeys.settings.all }),
    invalidateOverview(client),
    client.invalidateQueries({ queryKey: ['accounts'] }),
    client.invalidateQueries({ queryKey: ['transactions'] }),
  ])
}

export default function AccountRoles() {
  const accounts = useQuery({
    queryKey: ACCOUNTS_KEY,
    queryFn: grabSettingsAccounts,
  })

  return (
    <section className={CARD} aria-labelledby="settings-roles-heading">
      <h2 id="settings-roles-heading" className={HEADING}>
        Account roles
      </h2>
      <p className={`mt-1 ${HINT}`}>
        Only Current accounts count as spendable. What a Credit card owes is
        subtracted from safe-to-spend.
      </p>
      {accounts.isPending ? (
        <p className={`mt-5 ${HINT}`}>Loading accounts…</p>
      ) : accounts.isError ? (
        <div className="mt-5 flex flex-wrap items-center gap-3">
          <p role="alert" className={ERROR}>
            Accounts could not be loaded: {accounts.error.message}
          </p>
          <button
            type="button"
            className={SECONDARY_BUTTON}
            onClick={() => void accounts.refetch()}
          >
            Try again
          </button>
        </div>
      ) : accounts.data.items.length === 0 ? (
        <p className={`mt-5 ${HINT}`}>
          No accounts yet. They appear after the first sync.
        </p>
      ) : (
        <ul className="m-0 mt-5 flex list-none flex-col gap-4 p-0">
          {accounts.data.items.map((account) => (
            <AccountRow key={account.id} account={account} />
          ))}
        </ul>
      )}
    </section>
  )
}

function AccountRow({ account }: { account: AccountSettingsRow }) {
  const queryClient = useQueryClient()
  const roleMutation = useMutation({
    mutationFn: (role: AccountRole | null) =>
      updateAccount(account.id, { role }),
    onSuccess: () => refreshAfterSave(queryClient),
  })
  const scopeMutation = useMutation({
    mutationFn: (scope: RowScope) => updateAccount(account.id, { scope }),
    onSuccess: () => refreshAfterSave(queryClient),
  })

  // While a change is in flight the control shows it; otherwise (including
  // after a refusal) it shows what the server says. Nothing is optimistic.
  const shownRole = roleMutation.isPending
    ? roleMutation.variables
    : account.role
  const shownScope = scopeMutation.isPending
    ? scopeMutation.variables
    : account.scope

  return (
    <li className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-body-14 font-semibold text-ink">
          {account.name}
        </span>
        <div className="flex flex-wrap items-center gap-2">
          <div
            role="group"
            aria-label={`Scope for ${account.name}`}
            className={SCOPE_TRACK}
          >
            {ROW_SCOPES.map((scope) => (
              <button
                key={scope}
                type="button"
                aria-pressed={shownScope === scope}
                className={scopeOption(shownScope === scope)}
                disabled={scopeMutation.isPending}
                onClick={() => {
                  if (scope !== account.scope) scopeMutation.mutate(scope)
                }}
              >
                {SCOPE_LABELS[scope]}
              </button>
            ))}
          </div>
          <select
            aria-label={`Role for ${account.name}`}
            className={SELECT}
            value={shownRole ?? ''}
            disabled={roleMutation.isPending}
            onChange={(event) =>
              roleMutation.mutate(toRole(event.target.value))
            }
          >
            <option value="">No role</option>
            {ACCOUNT_ROLES.map((role) => (
              <option key={role} value={role}>
                {ROLE_LABELS[role]}
              </option>
            ))}
          </select>
        </div>
      </div>
      {roleMutation.isError && (
        <p role="alert" className={ERROR}>
          {roleMutation.error.message}
        </p>
      )}
      {scopeMutation.isError && (
        <p role="alert" className={ERROR}>
          {scopeMutation.error.message}
        </p>
      )}
    </li>
  )
}
