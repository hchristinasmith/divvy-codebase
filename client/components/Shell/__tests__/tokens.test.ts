// @vitest-environment node
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// The handoff's "Design tokens" section, as theme tokens in App.css. A value
// that drifts from the handoff, or a token that disappears, fails here.
// vitest runs from the repository root.
const css = readFileSync(resolve('client/styles/App.css'), 'utf8')

// Only the plain `@theme { ... }` block; the shadcn `@theme inline` block
// belongs to the old pages.
function themeBlock(): Map<string, string> {
  const match = css.match(/@theme\s*\{([\s\S]*?)\n\}/)
  if (!match) throw new Error('no @theme block in App.css')
  const tokens = new Map<string, string>()
  for (const [, name, value] of match[1].matchAll(/(--[\w-]+):\s*([^;]+);/g)) {
    tokens.set(name, value.trim())
  }
  return tokens
}

// handoff.md name -> theme token -> value. Renames dodge shadcn's names.
const colours: [string, string, string][] = [
  ['bg', '--color-canvas', '#FAF6F3'],
  ['surface', '--color-surface', '#FFFFFF'],
  ['border', '--color-line', '#F0E4E6'],
  ['divider', '--color-divider', '#F6ECEE'],
  ['blush', '--color-blush', '#FBE4EA'],
  ['blush-hover', '--color-blush-hover', '#F7D2DC'],
  ['pink', '--color-pink', '#EC6A94'],
  ['pink-hover/solid', '--color-pink-hover', '#D9507D'],
  ['deep rose text', '--color-deep', '#C2386A'],
  ['rose text', '--color-rose', '#A12A56'],
  ['ink', '--color-ink', '#2B2224'],
  ['muted', '--color-ink-muted', '#7A6A6F'],
  ['faint', '--color-ink-faint', '#B3A3A8'],
  ['ok', '--color-ok', '#3E9A6E'],
  ['warn', '--color-warn', '#D9893A'],
  ['danger', '--color-danger', '#D23F5B'],
]

describe('design tokens match docs/design/handoff.md', () => {
  const tokens = themeBlock()

  it.each(colours)('colour %s is %s %s', (_name, token, hex) => {
    expect(tokens.get(token)?.toUpperCase()).toBe(hex)
  })

  it('declares exactly the handoff colours, no more', () => {
    const declared = [...tokens.keys()].filter((k) => k.startsWith('--color-'))
    expect(declared.sort()).toEqual(colours.map(([, t]) => t).sort())
  })

  it('has the handoff type scale', () => {
    for (const px of [72, 40, 36, 34, 28, 26, 22]) {
      expect(tokens.get(`--text-display-${px}`)).toBe(`${px}px`)
    }
    for (const px of [15, 14, 13, 12, 11]) {
      expect(tokens.get(`--text-body-${px}`)).toBe(`${px}px`)
    }
  })

  it('uses Outfit, DM Sans and DM Mono', () => {
    expect(tokens.get('--font-display')).toMatch(/^'Outfit Variable',/)
    expect(tokens.get('--font-sans')).toMatch(/^'DM Sans Variable',/)
    expect(tokens.get('--font-mono')).toMatch(/^'DM Mono',/)
  })

  it('has the handoff radii', () => {
    expect(tokens.get('--radius-card')).toBe('24px')
    expect(tokens.get('--radius-tile')).toBe('14px')
    expect(tokens.get('--radius-tile-lg')).toBe('18px')
    expect(tokens.get('--radius-button')).toBe('12px')
    expect(tokens.get('--radius-pill')).toBe('999px')
    expect(tokens.get('--radius-tag')).toBe('8px')
    expect(tokens.get('--radius-tag-lg')).toBe('11px')
  })

  it('has a 4px spacing unit, the 720px phone breakpoint and the 1040px column', () => {
    expect(tokens.get('--spacing')).toBe('0.25rem')
    expect(tokens.get('--breakpoint-shell')).toBe('45rem')
    expect(tokens.get('--container-page')).toBe('1040px')
  })

  it('declares no shadow token', () => {
    expect([...tokens.keys()].filter((k) => k.includes('shadow'))).toEqual([])
  })
})
