import express from 'express'
import * as db from '../db/settings.ts'
import {
  ACCOUNT_ROLES,
  type AccountRole,
  type AccountSettingsRow,
  type SettingsAccountsResponse,
  type SettingsResponse,
} from '../../shared/contracts.ts'

// /api/v1/settings (issue 46; prd-02 Rulings 2, 9, 10, 11), mounted by
// ./index.ts. The settings panel reads and writes the tax rate, Strawb's
// profit, the payday weekday, the personal tax owed and the currency
// symbol, and sets each account's role. Every error is `{ error: string }`;
// a path not listed here falls through to the app's JSON 404.

const router = express.Router()

// What a 500 logs: the stack as a string, as server.ts logs one, never the
// error object and the fields Node prints beside it.
function logged(error: unknown): string | undefined {
  return error instanceof Error ? error.stack : typeof error
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// GET /api/v1/settings
router.get('/', async (_req, res) => {
  try {
    const body: SettingsResponse = await db.getSettings()
    res.json(body)
  } catch (error) {
    console.error('Error reading settings:', logged(error))
    res.status(500).json({ error: 'Internal server error' })
  }
})

// PATCH /api/v1/settings  body: UpdateSettingsRequest. Any subset; `{}` is a
// no-op. Answers with every setting afterwards.
router.patch('/', async (req, res) => {
  const result = db.validateSettingsPatch(req.body)
  if ('error' in result) return res.status(400).json({ error: result.error })

  try {
    const body: SettingsResponse = await db.updateSettings(result.patch)
    res.json(body)
  } catch (error) {
    console.error('Error updating settings:', logged(error))
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/v1/settings/accounts
router.get('/accounts', async (_req, res) => {
  try {
    const body: SettingsAccountsResponse = {
      items: await db.listAccountRoles(),
    }
    res.json(body)
  } catch (error) {
    console.error('Error listing account roles:', logged(error))
    res.status(500).json({ error: 'Internal server error' })
  }
})

const ROLE_ERROR = `role must be one of ${ACCOUNT_ROLES.join(', ')}, or null`

function isRole(value: unknown): value is AccountRole | null {
  return (
    value === null ||
    (typeof value === 'string' &&
      (ACCOUNT_ROLES as readonly string[]).includes(value))
  )
}

// PUT /api/v1/settings/accounts/:id  body: SetAccountRoleRequest. `null`
// removes the role. Only the role is editable here, never the scope.
router.put('/accounts/:id', async (req, res) => {
  // Digits only: Number() would also accept '1e3', '0x10' and ' 7'.
  const id = Number(req.params.id)
  if (!/^[1-9]\d*$/.test(req.params.id) || !Number.isSafeInteger(id)) {
    return res.status(400).json({ error: 'id must be a positive integer' })
  }

  const body: unknown = req.body
  if (!isPlainObject(body)) {
    return res.status(400).json({ error: 'Body must be a JSON object' })
  }
  const unknown = Object.keys(body).find((key) => key !== 'role')
  if (unknown !== undefined) {
    return res.status(400).json({ error: `Unknown field: ${unknown}` })
  }
  // A missing role is undefined, which isRole refuses.
  const role = body.role
  if (!isRole(role)) {
    return res.status(400).json({ error: ROLE_ERROR })
  }

  try {
    const row: AccountSettingsRow | undefined = await db.setAccountRole(
      id,
      role,
    )
    if (row === undefined) {
      return res.status(404).json({ error: 'Account not found' })
    }
    res.json(row)
  } catch (error) {
    console.error('Error setting account role:', logged(error))
    res.status(500).json({ error: 'Internal server error' })
  }
})

export default router
