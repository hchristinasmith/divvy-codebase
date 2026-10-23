import { readdirSync, readFileSync } from 'node:fs'
import * as Path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import * as barrel from '../index.ts'
import { fixturesDir } from './fakeXero.ts'

// Structural guards for issue #34: what the barrel exposes, and properties of
// the source that a behavioural test cannot see (a second request site, a
// float parser, a real organisation's name in a fixture).

const clientDir = Path.join(Path.dirname(fileURLToPath(import.meta.url)), '..')

/** Every production source file of the client, keyed by file name. */
function productionSources(): Map<string, string> {
  const sources = new Map<string, string>()
  for (const name of readdirSync(clientDir)) {
    if (name.endsWith('.ts')) {
      sources.set(name, readFileSync(Path.join(clientDir, name), 'utf8'))
    }
  }
  return sources
}

describe('the client barrel', () => {
  it('exports exactly the public runtime surface', () => {
    expect(Object.keys(barrel).sort()).toEqual(
      ['XeroClientError', 'createXeroClient', 'sumAmountDueCents'].sort(),
    )
  })

  it('creates a client with exactly the four read functions', () => {
    const client = barrel.createXeroClient({
      getAccessToken: async () => 'unused',
      tenantId: 'unused',
    })
    expect(Object.keys(client).sort()).toEqual(
      [
        'getPayRuns',
        'getPayableBills',
        'getProfitLoss',
        'getReceivableInvoices',
      ].sort(),
    )
  })
})

describe('the client source', () => {
  it('has a single request site', () => {
    const sites = [...productionSources()].flatMap(([name, text]) =>
      [...text.matchAll(/\bfetch\s*\(/g)].map(() => name),
    )
    expect(sites).toEqual(['http.ts'])
  })

  it('names no HTTP method other than GET', () => {
    const methods = [...productionSources()].flatMap(([, text]) =>
      [...text.matchAll(/\bmethod\s*:\s*['"`]?(\w+)/g)].map((m) => m[1]),
    )
    expect(methods.length).toBeGreaterThan(0)
    expect(new Set(methods)).toEqual(new Set(['GET']))
    for (const [, text] of productionSources()) {
      expect(text).not.toMatch(/\b(POST|PUT|PATCH|DELETE)\b/)
    }
  })

  it('never parses a value with a float parser', () => {
    for (const [name, text] of productionSources()) {
      expect({
        name,
        hit: /parseFloat|\bNumber\s*\(/.exec(text)?.[0] ?? null,
      }).toEqual({
        name,
        hit: null,
      })
    }
  })

  it('reads no environment variables', () => {
    for (const [, text] of productionSources()) {
      expect(text).not.toMatch(/process\.env|import\.meta\.env/)
    }
  })
})

describe('the fixtures (issue #34 done-when 10)', () => {
  it('name no real organisation', () => {
    const files = readdirSync(fixturesDir).filter((f) => f.endsWith('.json'))
    expect(files.length).toBeGreaterThan(0)
    for (const file of files) {
      const text = readFileSync(Path.join(fixturesDir, file), 'utf8')
      expect({ file, hit: /strawb/i.exec(text)?.[0] ?? null }).toEqual({
        file,
        hit: null,
      })
    }
  })
})
