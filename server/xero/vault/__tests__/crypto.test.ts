// prd-05 Ruling 2 (#28 Done-when 1 and 2): AES-256-GCM per field, a fresh
// IV per encryption, the tag checked, the field bound in as associated data,
// and the key read only from XERO_TOKEN_KEY. Every key is drawn at random per
// test; every plaintext is invented.
import { createCipheriv, randomBytes } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { decryptField, encryptField } from '../crypto.ts'
import { XeroVaultError } from '../errors.ts'
import { errorTexts, sentinel, stubKey } from './helpers.ts'

const IV = 12
const TAG = 16

let key: string
beforeEach(() => {
  key = stubKey()
})
afterEach(() => {
  vi.unstubAllEnvs()
})

/** The error `fn` throws, or a test failure if it returns. */
function thrownBy(fn: () => unknown): unknown {
  try {
    fn()
  } catch (err) {
    return err
  }
  throw new Error('expected a throw, but it returned')
}

function expectCode(err: unknown, code: string): void {
  expect(err).toBeInstanceOf(XeroVaultError)
  expect((err as XeroVaultError).code).toBe(code)
}

describe('ciphertext layout', () => {
  it('is a 12-byte IV, a 16-byte tag, then exactly the plaintext length', () => {
    const plaintext = sentinel('access')
    const blob = encryptField(plaintext, 'access_token')
    expect(Buffer.isBuffer(blob)).toBe(true)
    expect(blob.length).toBe(IV + TAG + Buffer.byteLength(plaintext))
  })

  it('decrypts back to the plaintext, including non-ASCII text', () => {
    for (const plaintext of [sentinel('access'), 'x', 'café \u{1F511}']) {
      const blob = encryptField(plaintext, 'refresh_token')
      expect(decryptField(blob, 'refresh_token')).toBe(plaintext)
    }
  })

  it('encrypts the same plaintext differently every time, with a new IV', () => {
    const plaintext = sentinel('refresh')
    const first = encryptField(plaintext, 'refresh_token')
    const second = encryptField(plaintext, 'refresh_token')
    expect(first.equals(second)).toBe(false)
    expect(first.subarray(0, IV).equals(second.subarray(0, IV))).toBe(false)
  })

  it('is AES-256-GCM with the field as associated data, readable by node:crypto', () => {
    const blob = encryptField('known text', 'tenant_id')
    const iv = blob.subarray(0, IV)
    const cipher = createCipheriv('aes-256-gcm', Buffer.from(key, 'base64'), iv, {
      authTagLength: TAG,
    })
    cipher.setAAD(Buffer.from('divvy:xero_vault:v1:tenant_id', 'ascii'))
    const body = Buffer.concat([cipher.update('known text', 'utf8'), cipher.final()])
    expect(blob.subarray(IV, IV + TAG).equals(cipher.getAuthTag())).toBe(true)
    expect(blob.subarray(IV + TAG).equals(body)).toBe(true)
  })
})

describe('tampering', () => {
  const regions: [string, (blob: Buffer) => number][] = [
    ['the IV', () => 3],
    ['the tag', () => IV + 5],
    ['the ciphertext', (blob) => blob.length - 1],
  ]
  for (const [region, offset] of regions) {
    it(`refuses a blob with one bit flipped in ${region}`, () => {
      const blob = encryptField(sentinel('access'), 'access_token')
      const tampered = Buffer.from(blob)
      tampered[offset(blob)] ^= 0x01
      expectCode(
        thrownBy(() => decryptField(tampered, 'access_token')),
        'decrypt_failed',
      )
    })
  }

  it('refuses a blob with one tag byte removed', () => {
    const blob = encryptField(sentinel('access'), 'access_token')
    const short = Buffer.concat([blob.subarray(0, IV + TAG - 1), blob.subarray(IV + TAG)])
    expectCode(thrownBy(() => decryptField(short, 'access_token')), 'decrypt_failed')
  })

  it('refuses a blob shorter than IV + tag + one byte as decrypt_failed, not RangeError', () => {
    for (const length of [0, 1, IV, IV + TAG]) {
      expectCode(
        thrownBy(() => decryptField(Buffer.alloc(length), 'access_token')),
        'decrypt_failed',
      )
    }
  })

  it('refuses a blob of only IV and tag even when it authenticates', () => {
    // An empty plaintext encrypts to exactly IV + tag and verifies; the vault
    // never writes one, so reading one back means the row was not its own.
    const iv = randomBytes(IV)
    const cipher = createCipheriv('aes-256-gcm', Buffer.from(key, 'base64'), iv, {
      authTagLength: TAG,
    })
    cipher.setAAD(Buffer.from('divvy:xero_vault:v1:access_token', 'ascii'))
    const body = Buffer.concat([cipher.update('', 'utf8'), cipher.final()])
    const blob = Buffer.concat([iv, cipher.getAuthTag(), body])
    expect(blob.length).toBe(IV + TAG)
    expectCode(thrownBy(() => decryptField(blob, 'access_token')), 'decrypt_failed')
  })

  it('refuses a value that is not a Buffer', () => {
    const blob = encryptField(sentinel('access'), 'access_token')
    for (const value of [null, undefined, blob.toString('base64'), blob.toString('hex')]) {
      expectCode(thrownBy(() => decryptField(value, 'access_token')), 'decrypt_failed')
    }
  })

  it('refuses a blob read as a different field', () => {
    const blob = encryptField(sentinel('access'), 'access_token')
    for (const field of ['refresh_token', 'tenant_id'] as const) {
      expectCode(thrownBy(() => decryptField(blob, field)), 'decrypt_failed')
    }
    expect(() => decryptField(blob, 'access_token')).not.toThrow()
  })

  it('refuses a blob encrypted under another key', () => {
    const blob = encryptField(sentinel('access'), 'access_token')
    stubKey()
    expectCode(thrownBy(() => decryptField(blob, 'access_token')), 'decrypt_failed')
  })
})

describe('the key (Done-when 2)', () => {
  function base64WithUrlUnsafeChar(): string {
    for (;;) {
      const candidate = randomBytes(32).toString('base64')
      if (/[+/]/.test(candidate)) return candidate
    }
  }

  const invalid: [string, () => string][] = [
    ['31 bytes', () => randomBytes(31).toString('base64')],
    ['33 bytes', () => randomBytes(33).toString('base64')],
    ['16 bytes', () => randomBytes(16).toString('base64')],
    ['not base64', () => 'this is not a key, it is a sentence!!'],
    ['32 bytes with a trailing newline', () => `${randomBytes(32).toString('base64')}\n`],
    ['32 bytes with surrounding spaces', () => ` ${randomBytes(32).toString('base64')} `],
    ['32 bytes without padding', () => randomBytes(32).toString('base64').replace(/=+$/, '')],
    [
      '32 bytes in base64url',
      () => base64WithUrlUnsafeChar().replace(/\+/g, '-').replace(/\//g, '_'),
    ],
    ['32 bytes as hex', () => randomBytes(32).toString('hex')],
  ]

  for (const [label, value] of invalid) {
    it(`refuses a key that is ${label} as key_invalid, naming the variable, not the value`, () => {
      const bad = value()
      vi.stubEnv('XERO_TOKEN_KEY', bad)
      for (const attempt of [
        () => encryptField(sentinel('access'), 'access_token'),
        () => decryptField(Buffer.alloc(40), 'access_token'),
      ]) {
        const err = thrownBy(attempt)
        expectCode(err, 'key_invalid')
        expect((err as Error).message).toContain('XERO_TOKEN_KEY')
        for (const text of errorTexts(err)) expect(text).not.toContain(bad.trim())
      }
    })
  }

  it('refuses an unset key as key_missing, naming the variable', () => {
    delete process.env.XERO_TOKEN_KEY
    for (const attempt of [
      () => encryptField(sentinel('access'), 'access_token'),
      () => decryptField(Buffer.alloc(40), 'access_token'),
    ]) {
      const err = thrownBy(attempt)
      expectCode(err, 'key_missing')
      expect((err as Error).message).toContain('XERO_TOKEN_KEY')
    }
  })

  it('refuses an empty key as key_missing', () => {
    vi.stubEnv('XERO_TOKEN_KEY', '')
    expectCode(thrownBy(() => encryptField('x', 'access_token')), 'key_missing')
  })

  it('reads the key at every call, not once', () => {
    const blob = encryptField(sentinel('access'), 'access_token')
    const first = key
    stubKey()
    expectCode(thrownBy(() => decryptField(blob, 'access_token')), 'decrypt_failed')
    vi.stubEnv('XERO_TOKEN_KEY', first)
    expect(() => decryptField(blob, 'access_token')).not.toThrow()
  })

  it('never leaves either key in a decrypt failure', () => {
    const blob = encryptField(sentinel('access'), 'access_token')
    const current = stubKey()
    const err = thrownBy(() => decryptField(blob, 'access_token'))
    expectCode(err, 'decrypt_failed')
    for (const text of errorTexts(err)) {
      expect(text).not.toContain(key)
      expect(text).not.toContain(current)
    }
  })
})

describe('input', () => {
  it('refuses an empty plaintext as invalid_input', () => {
    expectCode(thrownBy(() => encryptField('', 'access_token')), 'invalid_input')
  })

  it('refuses a plaintext that is not a string as invalid_input', () => {
    expectCode(
      thrownBy(() => encryptField(42 as unknown as string, 'access_token')),
      'invalid_input',
    )
  })
})
