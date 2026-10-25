// @vitest-environment node
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// The handoff's "Design tokens" section, as update 2 changes it
// (docs/design/CHANGES-2.md §1, prd-02 Ruling 13), as tokens in App.css. A
// value that drifts from the design, or a token that disappears, fails here.
// vitest runs from the repository root.
const css = readFileSync(resolve('client/styles/App.css'), 'utf8')

type Block = { head: string; text: string; vars: Map<string, string> }

// Every top-level `@theme`, `@theme inline`, `:root` and `.dark` block, in
// file order. Each closes with a `}` at the start of a line.
function blocks(): Block[] {
  return [
    ...css.matchAll(/^(@theme(?: inline)?|:root|\.dark)\s*\{([\s\S]*?)\n\}/gm),
  ].map(([text, head, body]) => {
    const vars = new Map<string, string>()
    for (const [, name, value] of body.matchAll(/(--[\w-]+):\s*([^;]+);/g)) {
      vars.set(name, value.trim())
    }
    return { head, text, vars }
  })
}

function only(found: Block[], what: string): Block {
  if (found.length !== 1) {
    throw new Error(`expected one ${what} in App.css, found ${found.length}`)
  }
  return found[0]
}

const all = blocks()
const declares = (b: Block, prefix: string) =>
  [...b.vars.keys()].some((k) => k.startsWith(prefix))

// The pink vars a later theme resets, on :root.
const root = only(
  all.filter((b) => b.head === ':root' && declares(b, '--dv-')),
  ':root block of --dv-* vars',
)
// The Divvy colours and offsets, `inline` so utilities read the vars.
const skin = only(
  all.filter((b) => b.head === '@theme inline' && b.vars.has('--color-pink')),
  '@theme inline block of Divvy colours',
)
// Everything else: fonts, type, tracking, radii, spacing, breakpoint.
const theme = only(
  all.filter((b) => b.head === '@theme'),
  'plain @theme block',
)

// CHANGES-2.md §1: token -> Candy default.
const pinks: [string, string][] = [
  ['--dv-bg', '#FFF0F5'],
  ['--dv-blush', '#FFD3E2'],
  ['--dv-blush2', '#FFBFD5'],
  ['--dv-pink', '#FF5C9E'],
  ['--dv-solid', '#F0418A'],
  ['--dv-shadow', '#FF9CC4'],
  ['--dv-deep', '#E0297A'],
  ['--dv-rose', '#B81E63'],
  ['--dv-border', '#F7C9D8'],
  ['--dv-divider', '#FBDDE7'],
]

// Neutrals are hex, not theme vars (CHANGES-2.md §1 "Neutrals unchanged").
const NEUTRALS = {
  surface: '#FFFFFF',
  ink: '#2B2224',
  muted: '#8A5A70',
  faint: '#C9A0B3',
  ok: '#3E9A6E',
  warn: '#D9893A',
  danger: '#D23F5B',
}

// Theme token -> what it reads. Names predate update 2 and dodge shadcn's.
const colours: [string, string][] = [
  ['--color-canvas', 'var(--dv-bg)'],
  ['--color-surface', NEUTRALS.surface],
  ['--color-line', 'var(--dv-border)'],
  ['--color-divider', 'var(--dv-divider)'],
  ['--color-blush', 'var(--dv-blush)'],
  ['--color-blush-hover', 'var(--dv-blush2)'],
  ['--color-pink', 'var(--dv-pink)'],
  ['--color-pink-hover', 'var(--dv-solid)'],
  ['--color-deep', 'var(--dv-deep)'],
  ['--color-rose', 'var(--dv-rose)'],
  ['--color-ink', NEUTRALS.ink],
  ['--color-ink-muted', NEUTRALS.muted],
  ['--color-ink-faint', NEUTRALS.faint],
  ['--color-ok', NEUTRALS.ok],
  ['--color-warn', NEUTRALS.warn],
  ['--color-danger', NEUTRALS.danger],
]

describe('the update 2 pink vars', () => {
  it.each(pinks)('%s is %s', (name, hex) => {
    expect(root.vars.get(name)?.toUpperCase()).toBe(hex)
  })

  it('declares exactly the CHANGES-2.md vars, nothing else, in one place', () => {
    expect([...root.vars.keys()].sort()).toEqual(pinks.map(([n]) => n).sort())
    const elsewhere = all.filter((b) => b !== root && declares(b, '--dv-'))
    expect(elsewhere.map((b) => b.head)).toEqual([])
  })

  it('writes no pink hex in client/styles outside the var block', () => {
    // Every hex outside the block is a neutral; any other is a pink that
    // a theme could not reach.
    const allowed = new Set(Object.values(NEUTRALS))
    const stray: string[] = []
    for (const name of readdirSync(resolve('client/styles'))) {
      if (!name.endsWith('.css')) continue
      let src = readFileSync(resolve(join('client/styles', name)), 'utf8')
      if (name === 'App.css') src = src.replace(root.text, '')
      for (const hex of src.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []) {
        if (!allowed.has(hex.toUpperCase())) stray.push(`${name}: ${hex}`)
      }
    }
    expect(stray).toEqual([])
  })
})

describe('design tokens match the handoff as update 2 changes it', () => {
  it.each(colours)('colour %s reads %s', (token, value) => {
    expect(skin.vars.get(token)?.replace(/#\w+/, (h) => h.toUpperCase())).toBe(
      value,
    )
  })

  it('declares exactly the handoff colours, no more, all inline', () => {
    const declared = [...skin.vars.keys()].filter((k) =>
      k.startsWith('--color-'),
    )
    expect(declared.sort()).toEqual(colours.map(([t]) => t).sort())
    // A colour in the plain block would resolve its var on :root only.
    expect(
      [...theme.vars.keys()].filter((k) => k.startsWith('--color-')),
    ).toEqual([])
  })

  it('has the handoff type scale', () => {
    for (const px of [72, 40, 36, 34, 28, 26, 22]) {
      expect(theme.vars.get(`--text-display-${px}`)).toBe(`${px}px`)
    }
    for (const px of [15, 14, 13, 12, 11]) {
      expect(theme.vars.get(`--text-body-${px}`)).toBe(`${px}px`)
    }
  })

  it('has the handoff letter-spacing', () => {
    expect(theme.vars.get('--tracking-hero')).toBe('-0.03em')
    expect(theme.vars.get('--tracking-title')).toBe('-0.02em')
    expect(theme.vars.get('--tracking-eyebrow')).toBe('0.1em')
    expect(theme.vars.get('--tracking-tagline')).toBe('0.14em')
    // The update 2 wordmark spreads its letters instead.
    expect(theme.vars.has('--tracking-wordmark')).toBe(false)
  })

  it('uses Outfit, DM Sans and DM Mono', () => {
    expect(theme.vars.get('--font-display')).toMatch(/^'Outfit Variable',/)
    expect(theme.vars.get('--font-sans')).toMatch(/^'DM Sans Variable',/)
    expect(theme.vars.get('--font-mono')).toMatch(/^'DM Mono',/)
  })

  it('has the update 2 radii', () => {
    const radii = [...theme.vars].filter(([k]) => k.startsWith('--radius-'))
    expect(Object.fromEntries(radii)).toStrictEqual({
      '--radius-card': '12px',
      '--radius-summary': '10px',
      '--radius-inset': '8px',
      '--radius-pill': '6px',
      '--radius-nav': '12px',
      '--radius-tile': '14px',
      '--radius-tag': '8px',
      '--radius-tag-lg': '11px',
    })
  })

  it('has a 4px spacing unit, the 720px phone breakpoint and the 1040px column', () => {
    expect(theme.vars.get('--spacing')).toBe('0.25rem')
    expect(theme.vars.get('--breakpoint-shell')).toBe('45rem')
    expect(theme.vars.get('--container-page')).toBe('1040px')
  })

  it('casts shadows only as hard offsets in --dv-shadow', () => {
    const shadows = [...skin.vars].filter(([k]) => k.includes('shadow'))
    expect(Object.fromEntries(shadows)).toStrictEqual({
      '--shadow-card': '5px 5px 0 var(--dv-shadow)',
      '--shadow-tile': '4px 4px 0 var(--dv-shadow)',
      '--shadow-pill': '3px 3px 0 var(--dv-shadow)',
    })
    expect([...theme.vars.keys()].filter((k) => k.includes('shadow'))).toEqual(
      [],
    )
    // noHardcodedStyle.test.ts allows every `--shadow-*` in the file, so a
    // soft one declared in any other block would pass there.
    expect(
      [...css.matchAll(/--(shadow-[\w-]+):/g)].map(([, n]) => n).sort(),
    ).toEqual(['shadow-card', 'shadow-pill', 'shadow-tile'])
  })
})
