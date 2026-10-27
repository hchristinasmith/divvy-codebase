// @vitest-environment node
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// A copy of the money tripwire in
// client/screens/Goals/__tests__/noMoneyArithmetic.test.ts, which is another
// screen's file. The hex and offset-token checks are not copied:
// client/components/Shell/__tests__/noHardcodedStyle.test.ts already scans
// client/screens for both.
//
// The Habits screen does no money arithmetic: runway, the streaks and every
// amount are route fields, formatted only. Nor does it touch the Overview's
// query: a verdict never moves safe-to-spend. Tests are excluded; they
// build fixtures.
const ROOT = 'client/screens/Habits'
const API = 'client/apis/habits.ts'

function sources(dir: string): string[] {
  return readdirSync(resolve(dir), { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name)
    if (e.isDirectory()) return e.name === '__tests__' ? [] : sources(path)
    return /\.(ts|tsx)$/.test(e.name) ? [path] : []
  })
}

const files = [...sources(ROOT), API]

// A sum, a rounding, or cents (or runway's tenths) put through an operator
// on either side.
const ARITHMETIC = [
  /\.reduce\(/,
  /\bMath\./,
  /(Cents|Tenths|tenths)\s*[*/+-]/,
  /[*/+-]\s*[\w.]*(Cents|Tenths|tenths)\b/,
]

// The Overview's invalidation, its key, or the key's literal in any quotes.
const OVERVIEW = /invalidateOverview|queryKeys\.overview|['"`]overview['"`]/

// The projected-date card is hidden, not faked: no source names it.
const FREEDOM = /freedom/i

describe('habits screen source', () => {
  it('finds the screen files to scan', () => {
    expect(files).toContain('client/screens/Habits/index.tsx')
    expect(files).toContain('client/screens/Habits/format.ts')
    expect(files).toContain('client/screens/Habits/WorthItCard.tsx')
    expect(files).toContain('client/screens/Habits/useVerdict.ts')
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

  it.each(files)('%s never names the hidden projected date', (file) => {
    const src = readFileSync(resolve(file), 'utf8')
    expect(src.match(FREEDOM)).toBeNull()
  })
})
