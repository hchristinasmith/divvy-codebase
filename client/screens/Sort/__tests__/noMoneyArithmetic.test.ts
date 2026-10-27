// @vitest-environment node
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// A copy of the money tripwire in
// client/components/Subscriptions/__tests__/noHardcodedStyle.test.ts (and of
// client/screens/Goals/__tests__/noMoneyArithmetic.test.ts on the unmerged
// Goals branch), which are outside this issue's fence. The hex and
// offset-token checks are not copied:
// client/components/Shell/__tests__/noHardcodedStyle.test.ts already scans
// client/screens for both. Goals' "never touches the Overview" check is not
// copied either: a category change moves budgets spent, so this screen must
// invalidate the Overview.
//
// The Sort screen does no money arithmetic (prd-02 Ruling 17): every total,
// received amount and latest amount is a route field passed to
// `formatCents`. Tests are excluded; they build fixtures.
const ROOT = 'client/screens/Sort'
const API = 'client/apis/categorise.ts'

function sources(dir: string): string[] {
  return readdirSync(resolve(dir), { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name)
    if (e.isDirectory()) return e.name === '__tests__' ? [] : sources(path)
    return /\.(ts|tsx)$/.test(e.name) ? [path] : []
  })
}

const files = [...sources(ROOT), API]

// A sum, a rounding, or cents put through an operator on either side.
const ARITHMETIC = [
  /\.reduce\(/,
  /\bMath\./,
  /Cents\s*[*/+-]/,
  /[*/+-]\s*[\w.]*Cents\b/,
]

describe('sort screen source', () => {
  it('finds the screen files to scan', () => {
    expect(files).toContain('client/screens/Sort/index.tsx')
    expect(files).toContain('client/screens/Sort/GroupCard.tsx')
    expect(files).toContain('client/screens/Sort/SortQueue.tsx')
    expect(files).toContain('client/screens/Sort/useApplyGroup.ts')
    expect(files).toContain(API)
  })

  it.each(files)('%s does no money arithmetic', (file) => {
    const src = readFileSync(resolve(file), 'utf8')
    expect(ARITHMETIC.filter((pattern) => pattern.test(src))).toEqual([])
  })
})
