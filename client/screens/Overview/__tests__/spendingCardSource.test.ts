// @vitest-environment node
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// The spending card, its shared bar and the Spending screen (issue 272) do
// no money arithmetic (prd-02 Ruling 1, note of 2026-10-25): every figure is
// a route field passed to `formatCents`, and the bar's `flexGrow` takes the
// cents as they are. Hex colours and
// shadows are already checked for every file under client/screens by
// client/components/Shell/__tests__/noHardcodedStyle.test.ts.
//
// The patterns start from `ARITHMETIC` in
// client/components/Subscriptions/__tests__/noHardcodedStyle.test.ts, but
// match `cents` in any case and through a compound assignment: the card's
// own lines carry their amount as `cents`, which the copy did not see.
// The files that show a figure; every one must call `formatCents`.
const DISPLAYS = [
  'client/screens/Overview/SpendingCard.tsx',
  'client/screens/Spending/index.tsx',
]
const FILES = [
  ...DISPLAYS,
  'client/screens/Overview/SpendingBar.tsx',
  'client/screens/Spending/month.ts',
]

// A sum, a rounding, or cents put through an operator on either side.
const ARITHMETIC = [
  /\.reduce\(/,
  /\bMath\./,
  /\bsumCents\b/,
  /cents\s*[*/+-]/i,
  /[*/+-]=?\s*[\w.]*cents\b/i,
]

describe('spending card and screen source', () => {
  it('scans the card and the screen, so the check below cannot pass on nothing', () => {
    expect(FILES).toContain('client/screens/Overview/SpendingCard.tsx')
    expect(FILES).toContain('client/screens/Spending/index.tsx')
    for (const file of DISPLAYS) {
      expect(readFileSync(resolve(file), 'utf8')).toContain('formatCents(')
    }
    expect(readFileSync(resolve('client/screens/Overview/SpendingBar.tsx'), 'utf8')).toContain(
      'flexGrow: line.cents',
    )
  })

  it.each([
    'total += line.cents',
    'lines[0].cents + lines[1].cents',
    'data.totalCents - data.otherCents',
    'sumCents(amounts)',
  ])('the patterns catch %s', (sample) => {
    expect(ARITHMETIC.some((pattern) => pattern.test(sample))).toBe(true)
  })

  it.each(FILES)('%s does no money arithmetic', (file) => {
    const src = readFileSync(resolve(file), 'utf8')
    expect(ARITHMETIC.filter((pattern) => pattern.test(src))).toEqual([])
  })
})
