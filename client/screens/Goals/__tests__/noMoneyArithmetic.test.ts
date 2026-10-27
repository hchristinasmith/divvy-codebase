// @vitest-environment node
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// A copy of the money tripwire in
// client/components/Subscriptions/__tests__/noHardcodedStyle.test.ts (and of
// client/screens/Bills/__tests__/noMoneyArithmetic.test.ts on the unmerged
// Bills branch, PR #288), which are outside this issue's fence. The hex and
// offset-token checks there are not copied:
// client/components/Shell/__tests__/noHardcodedStyle.test.ts already scans
// client/screens for both.
//
// The Goals screen does no money arithmetic: saved, target, pace and months
// to go are route fields passed to `formatCents`, the bar's width comes from
// `barPercent`, and a typed target becomes cents only through the Settings
// parser. Nor does it touch the Overview's query: a goal write never moves
// safe-to-spend (prd-02 Ruling 5). Tests are excluded; they build fixtures.
const ROOT = 'client/screens/Goals'
const API = 'client/apis/goals.ts'

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

// The Overview's invalidation, its key, or the key's literal in any quotes.
const OVERVIEW = /invalidateOverview|queryKeys\.overview|['"`]overview['"`]/

describe('goals screen source', () => {
  it('finds the screen files to scan', () => {
    expect(files).toContain('client/screens/Goals/index.tsx')
    expect(files).toContain('client/screens/Goals/GoalCard.tsx')
    expect(files).toContain('client/screens/Goals/fields.ts')
    expect(files).toContain('client/screens/Goals/useGoalActions.ts')
    expect(files).toContain(API)
  })

  it.each(files)('%s does no money arithmetic', (file) => {
    const src = readFileSync(resolve(file), 'utf8')
    expect(ARITHMETIC.filter((pattern) => pattern.test(src))).toEqual([])
  })

  it.each(files)('%s never touches the Overview query', (file) => {
    const src = readFileSync(resolve(file), 'utf8')
    expect(src.match(OVERVIEW)).toBeNull()
  })
})
