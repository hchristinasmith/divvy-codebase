import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { grabSettingsAccounts, updateAccountRole } from '../../apis/settings.ts'
import { invalidateOverview, queryKeys } from '../../apis/queryKeys.ts'
import {
  ACCOUNT_ROLES,
  type AccountRole,
  type AccountSettingsRow,
  type RowScope,
} from '../../../shared/contracts.ts'
import {
  CARD,
  ERROR,
  HEADING,
  HINT,
  SECONDARY_BUTTON,
  SELECT,
  scopeTag,
} from './styles.ts'

// What each account is for (issue 46; prd-02 Rulings 2, 10 and 11). The
// role decides what safe-to-spend counts: only Current accounts are
// spendable, a credit card's owed balance is subtracted, and a tax pot nets
// the tax hold of its own scope. The scope is shown, never edited here.

// Under the settings prefix, so a settings change refetches it too.
const ACCOUNTS_KEY = [...queryKeys.settings.all, 'accounts'] as const

const ROLE_LABELS: Record<AccountRole, string> = {
  current: 'Current',
  savings: 'Savings',
  tax_pot: 'Tax pot',
  credit_card: 'Credit card',
}

const SCOPE_LABELS: Record<RowScope, string> = {
  personal: 'Personal',
  strawb: 'Strawb',
}

function toRole(value: string): AccountRole | null {
  return ACCOUNT_ROLES.find((role) => role === value) ?? null
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
  const mutation = useMutation({
    mutationFn: (role: AccountRole | null) =>
      updateAccountRole(account.id, role),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.settings.all }),
        invalidateOverview(queryClient),
      ])
    },
  })

  // While a change is in flight the select shows it; otherwise (including
  // after a refusal) it shows what the server says.
  const shown = mutation.isPending ? mutation.variables : account.role

  return (
    <li className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-body-14 font-semibold text-ink">
            {account.name}
          </span>
          <span className={scopeTag(account.scope)}>
            {SCOPE_LABELS[account.scope]}
          </span>
        </div>
        <select
          aria-label={`Role for ${account.name}`}
          className={SELECT}
          value={shown ?? ''}
          disabled={mutation.isPending}
          onChange={(event) => mutation.mutate(toRole(event.target.value))}
        >
          <option value="">No role</option>
          {ACCOUNT_ROLES.map((role) => (
            <option key={role} value={role}>
              {ROLE_LABELS[role]}
            </option>
          ))}
        </select>
      </div>
      {mutation.isError && (
        <p role="alert" className={ERROR}>
          {mutation.error.message}
        </p>
      )}
    </li>
  )
}
