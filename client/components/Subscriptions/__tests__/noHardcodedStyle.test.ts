// @vitest-environment node
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// A copy of client/components/Shell/__tests__/noHardcodedStyle.test.ts for
// this directory, which that guard's roots do not reach and which this
// issue may not edit. The follow-up adds this directory to the Shell
// guard's roots and deletes this copy, keeping the money tripwire below.
//
// Screen code uses the App.css theme tokens, never a hex, and casts a
// shadow only through the theme's offset tokens (docs/design/CHANGES-2.md
// §1). It also does no money arithmetic: every figure is a route field
// passed to `formatCents`. Tests are excluded; they name classes to assert
// on them.
const ROOT = 'client/components/Subscriptions'

function sources(dir: string): string[] {
  return readdirSync(resolve(dir), { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name)
    if (e.isDirectory()) return e.name === '__tests__' ? [] : sources(path)
    return /\.(ts|tsx)$/.test(e.name) ? [path] : []
  })
}

const files = sources(ROOT)

// `shadow-card`, `shadow-tile`, ...: one utility per `--shadow-*` token.
const shadowTokens = [
  ...readFileSync(resolve('client/styles/App.css'), 'utf8').matchAll(
    /--(shadow-[\w-]+):/g,
  ),
].map(([, name]) => name)

// A sum, a rounding, or cents put through an operator.
const ARITHMETIC = [/\.reduce\(/, /\bMath\./, /Cents\s*[*/+-]/]

describe('subscriptions screen source', () => {
  it('finds the screen files to scan', () => {
    expect(files).toContain('client/components/Subscriptions/index.tsx')
    expect(files).toContain('client/components/Subscriptions/SummaryTiles.tsx')
  })

  it.each(files)('%s hardcodes no hex colour', (file) => {
    const src = readFileSync(resolve(file), 'utf8')
    expect(src.match(/#[0-9a-fA-F]{3,8}\b/g)).toBeNull()
  })

  it('finds the shadow tokens to allow', () => {
    expect(shadowTokens).toContain('shadow-card')
  })

  it.each(files)('%s uses no shadow but the theme tokens', (file) => {
    const src = readFileSync(resolve(file), 'utf8')
    const used = src.match(/\bshadow(-[\w[\]]+)?\b/g) ?? []
    expect(used.filter((u) => !shadowTokens.includes(u))).toEqual([])
  })

  it.each(files)('%s does no money arithmetic', (file) => {
    const src = readFileSync(resolve(file), 'utf8')
    expect(ARITHMETIC.filter((pattern) => pattern.test(src))).toEqual([])
  })
})
