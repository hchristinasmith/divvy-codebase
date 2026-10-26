import express from 'express'
import * as db from '../db/settings.ts'
import {
  ACCOUNT_ROLES,
  ROW_SCOPES,
  type AccountRole,
  type AccountSettingsRow,
  type RowScope,
  type SettingsAccountsResponse,
  type SettingsResponse,
  type UpdateAccountRequest,
} from '../../shared/contracts.ts'

// /api/v1/settings (issue 46; prd-02 Rulings 2, 9, 10, 11), mounted by
// ./index.ts. The settings panel reads and writes the tax rate, Strawb's
// profit, the payday weekday, the personal tax owed and the currency
// symbol, and sets each account's role and scope. Every error is
// `{ error: string }`; a path not listed here falls through to the app's
// JSON 404.

const router = express.Router()

// Logs the class only: a class is code; a message can carry SQL or values.
function errorClass(err: unknown): string {
  return err instanceof Error ? err.constructor.name : typeof err
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
    console.error('Error reading settings:', errorClass(error))
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
    console.error('Error updating settings:', errorClass(error))
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
    console.error('Error listing account roles:', errorClass(error))
    res.status(500).json({ error: 'Internal server error' })
  }
})

const ROLE_ERROR = `role must be one of ${ACCOUNT_ROLES.join(', ')}, or null`
const SCOPE_ERROR = `scope must be ${ROW_SCOPES.join(' or ')}`
const EMPTY_ERROR = 'Body must set role, scope, or both'

function isRole(value: unknown): value is AccountRole | null {
  return (
    value === null ||
    (typeof value === 'string' &&
      (ACCOUNT_ROLES as readonly string[]).includes(value))
  )
}

function isScope(value: unknown): value is RowScope {
  return (
    typeof value === 'string' &&
    (ROW_SCOPES as readonly string[]).includes(value)
  )
}

// PUT /api/v1/settings/accounts/:id  body: UpdateAccountRequest. `role`
// (`null` removes it) and `scope` (personal | strawb), either or both. Every
// key is checked before anything is written, so a refused body changes
// nothing. The scope is editable here (prd-01 Ruling 8, dated note
// 2026-10-25); sync never writes it.
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
  const unknown = Object.keys(body).find(
    (key) => key !== 'role' && key !== 'scope',
  )
  if (unknown !== undefined) {
    return res.status(400).json({ error: `Unknown field: ${unknown}` })
  }
  if (!('role' in body) && !('scope' in body)) {
    return res.status(400).json({ error: EMPTY_ERROR })
  }

  // Only the keys sent are copied: an absent key is left alone, not nulled.
  const patch: UpdateAccountRequest = {}
  if ('role' in body) {
    // A missing role is undefined, which isRole refuses.
    if (!isRole(body.role)) {
      return res.status(400).json({ error: ROLE_ERROR })
    }
    patch.role = body.role
  }
  if ('scope' in body) {
    if (!isScope(body.scope)) {
      return res.status(400).json({ error: SCOPE_ERROR })
    }
    patch.scope = body.scope
  }

  try {
    const row: AccountSettingsRow | undefined =
      await db.updateAccountSettings(id, patch)
    if (row === undefined) {
      return res.status(404).json({ error: 'Account not found' })
    }
    res.json(row)
  } catch (error) {
    console.error('Error updating account settings:', errorClass(error))
    res.status(500).json({ error: 'Internal server error' })
  }
})

export default router
