// @vitest-environment node
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// Shell code uses the App.css theme tokens, never a hex, and casts a shadow
// only through the theme's offset tokens (docs/design/CHANGES-2.md §1: a
// hard offset in --dv-shadow, never a soft Tailwind shadow). Tests are
// excluded; they name classes to assert on them.
const ROOTS = [
  'client/components/Shell',
  'client/screens',
  'client/context',
  'client/hooks',
]

function sources(dir: string): string[] {
  return readdirSync(resolve(dir), { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name)
    if (e.isDirectory()) return e.name === '__tests__' ? [] : sources(path)
    return /\.(ts|tsx)$/.test(e.name) ? [path] : []
  })
}

const files = ROOTS.flatMap(sources)

// `shadow-card`, `shadow-tile`, ...: one utility per `--shadow-*` token.
const shadowTokens = [
  ...readFileSync(resolve('client/styles/App.css'), 'utf8').matchAll(
    /--(shadow-[\w-]+):/g,
  ),
].map(([, name]) => name)

describe('shell source', () => {
  it('finds the shell files to scan', () => {
    expect(files).toContain('client/components/Shell/Shell.tsx')
    expect(files).toContain('client/screens/routes.tsx')
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
})
