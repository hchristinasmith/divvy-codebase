// Structural guards for the Xero token vault (#28): what the barrel exposes,
// and properties of the source a behavioural test cannot see (a log line, a
// weak random source, a second place that reads the environment, a reach
// into the database connection or another Xero lane, a committed key).
import { readdirSync, readFileSync } from 'node:fs'
import * as Path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import * as barrel from '../index.ts'

const testsDir = Path.dirname(fileURLToPath(import.meta.url))
const vaultDir = Path.join(testsDir, '..')

function sourcesIn(dir: string): Map<string, string> {
  const sources = new Map<string, string>()
  for (const name of readdirSync(dir)) {
    if (name.endsWith('.ts')) sources.set(name, readFileSync(Path.join(dir, name), 'utf8'))
  }
  return sources
}

/** Every production source file of the vault, keyed by file name. */
const production = sourcesIn(vaultDir)
/** Every file under the vault, tests included, keyed by relative path. */
const everything = new Map([
  ...production,
  ...[...sourcesIn(testsDir)].map(([name, text]) => [`__tests__/${name}`, text] as const),
])

/** The import specifiers of a source file. */
function importsOf(text: string): string[] {
  return [...text.matchAll(/\bfrom\s+'([^']+)'|\bimport\s*\(\s*'([^']+)'/g)].map(
    (m) => m[1] ?? m[2],
  )
}

describe('the vault barrel', () => {
  it('exports exactly the public runtime surface', () => {
    expect(Object.keys(barrel).sort()).toEqual(['XeroVaultError', 'createXeroVault'].sort())
  })
})

describe('the vault source', () => {
  it('is the files this guard expects to read', () => {
    expect([...production.keys()].sort()).toEqual(
      ['crypto.ts', 'errors.ts', 'index.ts', 'refresh.ts', 'store.ts', 'types.ts', 'vault.ts'].sort(),
    )
  })

  it('never logs', () => {
    for (const [name, text] of production) {
      expect({ name, hit: /\bconsole\b/.exec(text)?.[0] ?? null }).toEqual({ name, hit: null })
    }
  })

  it('never uses a non-cryptographic random source', () => {
    for (const [name, text] of production) {
      expect({ name, hit: /Math\.random/.exec(text)?.[0] ?? null }).toEqual({ name, hit: null })
    }
  })

  it('reads the environment only in crypto.ts, and only XERO_TOKEN_KEY', () => {
    const readers = [...production]
      .filter(([, text]) => /process\.env|import\.meta\.env/.test(text))
      .map(([name]) => name)
    expect(readers).toEqual(['crypto.ts'])
    const names = [...(production.get('crypto.ts') ?? '').matchAll(/process\.env\.(\w+)/g)].map(
      (m) => m[1],
    )
    expect(new Set(names)).toEqual(new Set(['XERO_TOKEN_KEY']))
    expect(production.get('crypto.ts')).not.toMatch(/process\.env\s*\[/)
  })

  it('imports only node:crypto, knex types and its own files', () => {
    for (const [name, text] of production) {
      for (const specifier of importsOf(text)) {
        expect({ name, specifier, allowed: /^(node:crypto|knex|\.\/[\w-]+\.ts)$/.test(specifier) })
          .toEqual({ name, specifier, allowed: true })
      }
    }
  })

  it('never imports the database connection, the Xero client, OAuth or the routes', () => {
    for (const [name, text] of production) {
      for (const specifier of importsOf(text)) {
        expect({ name, specifier, hit: /connection|client|oauth|routes/.test(specifier) })
          .toEqual({ name, specifier, hit: false })
      }
    }
  })

  it('never calls the network', () => {
    for (const [name, text] of production) {
      expect({ name, hit: /\bfetch\s*\(|node:https?|node:net/.exec(text)?.[0] ?? null }).toEqual({
        name,
        hit: null,
      })
    }
  })
})

// 32 bytes in padded base64 (or base64url) is 43 characters and one `=`.
const KEY_LITERAL = /(?<![A-Za-z0-9+/_-])[A-Za-z0-9+/_-]{43}=/

describe('no committed key (Done-when 2)', () => {
  it('no file under the vault, tests included, holds a 32-byte base64 literal', () => {
    expect(everything.size).toBeGreaterThan(production.size)
    for (const [name, text] of everything) {
      expect({ name, hit: KEY_LITERAL.exec(text)?.[0] ?? null }).toEqual({ name, hit: null })
    }
  })

  it('positive control: the same pattern finds a key written into a file', () => {
    const generated = Buffer.alloc(32, 0xab).toString('base64')
    expect(KEY_LITERAL.test(`const KEY = '${generated}'`)).toBe(true)
  })
})
