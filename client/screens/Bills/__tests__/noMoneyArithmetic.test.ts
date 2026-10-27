// @vitest-environment node
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// A copy of the money tripwire in
// client/components/Subscriptions/__tests__/noHardcodedStyle.test.ts, which
// is outside this issue's fence. The hex and offset-token checks there are
// not copied: client/components/Shell/__tests__/noHardcodedStyle.test.ts
// already scans client/screens for both.
//
// The Bills screen does no money arithmetic: every figure is a route field
// passed to `formatCents`, and a typed amount becomes cents only through the
// Settings parser. Tests are excluded; they build fixtures.
const ROOT = 'client/screens/Bills'

function sources(dir: string): string[] {
  return readdirSync(resolve(dir), { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name)
    if (e.isDirectory()) return e.name === '__tests__' ? [] : sources(path)
    return /\.(ts|tsx)$/.test(e.name) ? [path] : []
  })
}

const files = sources(ROOT)

// A sum, a rounding, or cents put through an operator on either side.
const ARITHMETIC = [
  /\.reduce\(/,
  /\bMath\./,
  /Cents\s*[*/+-]/,
  /[*/+-]\s*[\w.]*Cents\b/,
]

describe('bills screen source', () => {
  it('finds the screen files to scan', () => {
    expect(files).toContain('client/screens/Bills/index.tsx')
    expect(files).toContain('client/screens/Bills/SummaryTiles.tsx')
    expect(files).toContain('client/screens/Bills/fields.ts')
  })

  it.each(files)('%s does no money arithmetic', (file) => {
    const src = readFileSync(resolve(file), 'utf8')
    expect(ARITHMETIC.filter((pattern) => pattern.test(src))).toEqual([])
  })
})
