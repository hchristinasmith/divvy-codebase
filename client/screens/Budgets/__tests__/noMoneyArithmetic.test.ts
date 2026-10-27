// @vitest-environment node
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// A copy of client/screens/Bills/__tests__/noMoneyArithmetic.test.ts (itself
// a copy of the money tripwire in
// client/components/Subscriptions/__tests__/noHardcodedStyle.test.ts). The
// hex and offset-token checks are not copied:
// client/components/Shell/__tests__/noHardcodedStyle.test.ts already scans
// client/screens for both. The Goals copy's "never touches the Overview"
// check is not copied either: every budget write must refetch the overview
// (prd-02 Done-when 3), which ./Budgets.test.tsx asserts by its refetch.
//
// The Budgets screen does no money arithmetic: spent, limit, remaining and
// over are route fields passed to `formatCents`, the bar's width comes from
// `barPercent`, and a typed limit becomes cents only through the Settings
// parser. Two named helpers are the exception, and only their bodies are
// let through: the $10 step (`stepLimit`) and the amber test, which
// compares spent × 5 with limit × 4 (`isNearLimit`). Tests are excluded;
// they build fixtures.
const ROOT = 'client/screens/Budgets'
const API = 'client/apis/budgets.ts'

const ALLOWED: Record<string, string[]> = {
  'client/screens/Budgets/fields.ts': ['stepLimit'],
  'client/screens/Budgets/format.ts': ['isNearLimit'],
}

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

/** One top-level `export function name` from its line to its closing brace. */
function helperPattern(name: string): RegExp {
  return new RegExp(`^export function ${name}\\(.*?^\\}$`, 'ms')
}

/** The source with each allowed helper's whole definition cut out. */
function withoutAllowed(file: string, src: string): string {
  return (ALLOWED[file] ?? []).reduce(
    (rest, name) => rest.replace(helperPattern(name), ''),
    src,
  )
}

describe('budgets screen source', () => {
  it('finds the screen files to scan', () => {
    expect(files).toContain('client/screens/Budgets/index.tsx')
    expect(files).toContain('client/screens/Budgets/BudgetCard.tsx')
    expect(files).toContain('client/screens/Budgets/fields.ts')
    expect(files).toContain('client/screens/Budgets/format.ts')
    expect(files).toContain(API)
  })

  it.each(Object.entries(ALLOWED))(
    '%s still defines the helpers it is allowed, each with arithmetic in it',
    (file, names) => {
      const src = readFileSync(resolve(file), 'utf8')
      for (const name of names) {
        const body = helperPattern(name).exec(src)?.[0]
        expect(body, name).toBeDefined()
        expect(ARITHMETIC.some((pattern) => pattern.test(body ?? '')), name).toBe(true)
      }
    },
  )

  it.each(files)('%s does no money arithmetic outside its allowed helpers', (file) => {
    const src = withoutAllowed(file, readFileSync(resolve(file), 'utf8'))
    expect(ARITHMETIC.filter((pattern) => pattern.test(src))).toEqual([])
  })
})
