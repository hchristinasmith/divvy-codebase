import request from 'superagent'
import type {
  AccountRole,
  AccountSettingsRow,
  SetAccountRoleRequest,
  SettingsAccountsResponse,
  SettingsResponse,
  UpdateSettingsRequest,
} from '../../shared/contracts.ts'

// The settings panel's requests (issue 46): /api/v1/settings and
// /api/v1/settings/accounts. A refused request rejects with an Error whose
// message is the server's own `{ error }` text, so the panel can show it as
// it is.

const rootURL = new URL('/api/v1', document.baseURI)

// Turns a superagent failure into an Error carrying the server's message,
// or a plain one when there is none.
async function send<T>(pending: Promise<request.Response>): Promise<T> {
  try {
    const response = await pending
    return response.body as T
  } catch (err) {
    const failure = err as {
      status?: unknown
      response?: { body?: { error?: unknown } }
    }
    const message = failure.response?.body?.error
    if (typeof message === 'string') throw new Error(message)
    if (typeof failure.status === 'number') {
      throw new Error(`Server error (${failure.status})`)
    }
    throw new Error('The server could not be reached')
  }
}

export function grabSettings(): Promise<SettingsResponse> {
  return send(request.get(`${rootURL}/settings`))
}

/** PATCH: any subset; answers every setting afterwards. */
export function updateSettings(
  patch: UpdateSettingsRequest,
): Promise<SettingsResponse> {
  return send(request.patch(`${rootURL}/settings`).send(patch))
}

export function grabSettingsAccounts(): Promise<SettingsAccountsResponse> {
  return send(request.get(`${rootURL}/settings/accounts`))
}

/** PUT: `null` removes the role. Answers the account as listed afterwards. */
export function updateAccountRole(
  id: string,
  role: AccountRole | null,
): Promise<AccountSettingsRow> {
  const body: SetAccountRoleRequest = { role }
  return send(
    request
      .put(`${rootURL}/settings/accounts/${encodeURIComponent(id)}`)
      .send(body),
  )
}
