// Field encryption for the Xero token vault (prd-05 Ruling 2, closing D6).
//
// The access token, the refresh token and the tenant id are each stored as
// AES-256-GCM ciphertext in their own `xero_connection.*_enc` column, laid
// out as `IV (12 bytes) ‖ tag (16 bytes) ‖ ciphertext`. Every encryption
// draws a fresh random IV, so the same plaintext never encrypts the same way
// twice, and every decryption checks the full 16-byte tag, so a changed bit
// anywhere in the blob is refused rather than decrypted.
//
// The column the blob belongs in is bound in as associated data
// (`divvy:xero_vault:v1:<field>`), so a blob moved to another column (the
// refresh token copied over the access token, say) fails to authenticate.
// The `v1` names this layout; a future layout would bind a different string.
// The row's `version` is not bound: a refresh rewrites the tokens and bumps
// the version, but the tenant blob is never rewritten.
//
// The key is `XERO_TOKEN_KEY`: 32 bytes in standard, padded base64, from the
// environment only (a Fly secret in production), never the database, the
// image or the replica. It is read on every call and never cached. Nothing
// re-encrypts under a new key and there is no old-key fallback, so rotating
// the secret makes every stored blob `decrypt_failed` until a reconnect
// stores a new consent under the new key. There is
// no default and no lenient decoding: a key that is unset or empty is
// `key_missing`, and anything that does not re-encode to exactly itself as
// 32 bytes (a trailing newline, missing padding, base64url, hex, the wrong
// length) is `key_invalid`. Neither message carries the value.
//
// This is the only file in the vault that reads the environment.

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

import { XeroVaultError } from './errors.ts'

/** The `xero_connection` column a value is encrypted for, minus `_enc`. */
export type VaultField = 'access_token' | 'refresh_token' | 'tenant_id'

const ALGORITHM = 'aes-256-gcm'
const KEY_BYTES = 32
const IV_BYTES = 12
const TAG_BYTES = 16
/** IV, tag and at least one byte of ciphertext; the schema's CHECK agrees. */
const MIN_BLOB_BYTES = IV_BYTES + TAG_BYTES + 1

function associatedData(field: VaultField): Buffer {
  return Buffer.from(`divvy:xero_vault:v1:${field}`, 'ascii')
}

function loadKey(): Buffer {
  const value = process.env.XERO_TOKEN_KEY
  if (value === undefined || value === '') {
    throw new XeroVaultError('key_missing', 'XERO_TOKEN_KEY is not set')
  }
  const key = Buffer.from(value, 'base64')
  // Buffer.from ignores characters it cannot decode, so a value with a
  // trailing newline or in base64url still yields 32 bytes; only a value
  // that re-encodes to itself was written as the rule says.
  if (key.length !== KEY_BYTES || key.toString('base64') !== value) {
    throw new XeroVaultError(
      'key_invalid',
      'XERO_TOKEN_KEY must be 32 bytes written as standard padded base64',
    )
  }
  return key
}

/** Encrypts `plaintext` for `field`. Refuses an empty or non-string value. */
export function encryptField(plaintext: string, field: VaultField): Buffer {
  if (typeof plaintext !== 'string' || plaintext === '') {
    throw new XeroVaultError('invalid_input', `the ${field} to store is empty`)
  }
  const key = loadKey()
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES })
  cipher.setAAD(associatedData(field))
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), body])
}

/**
 * Decrypts a blob `encryptField` wrote for `field`. Anything that is not
 * such a blob under the current key, including a value that is not a Buffer
 * or is too short to hold an IV and a tag, is `decrypt_failed`.
 */
export function decryptField(blob: unknown, field: VaultField): string {
  const key = loadKey()
  if (!Buffer.isBuffer(blob) || blob.length < MIN_BLOB_BYTES) {
    throw decryptFailed(field)
  }
  try {
    const decipher = createDecipheriv(ALGORITHM, key, blob.subarray(0, IV_BYTES), {
      authTagLength: TAG_BYTES,
    })
    decipher.setAAD(associatedData(field))
    decipher.setAuthTag(blob.subarray(IV_BYTES, IV_BYTES + TAG_BYTES))
    const body = blob.subarray(IV_BYTES + TAG_BYTES)
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8')
  } catch {
    throw decryptFailed(field)
  }
}

function decryptFailed(field: VaultField): XeroVaultError {
  return new XeroVaultError(
    'decrypt_failed',
    `the stored ${field} did not decrypt under XERO_TOKEN_KEY`,
  )
}
