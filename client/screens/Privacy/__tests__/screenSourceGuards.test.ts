// @vitest-environment node
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// The Privacy and Advisor screens' source, read as text (issue Done-when 3
// and 4): no way to reach the network but the Server card's one same-origin
// `fetch`, no AI client, no chat form, and no external URL but the Claude
// desktop link. Tests are excluded; they name these words to assert on them.
// vitest runs from the repository root.
const ROOTS = ['client/screens/Privacy', 'client/screens/Advisor']

function sources(dir: string): string[] {
  return readdirSync(resolve(dir), { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name)
    if (e.isDirectory()) return e.name === '__tests__' ? [] : sources(path)
    return /\.(ts|tsx)$/.test(e.name) ? [path] : []
  })
}

const files = ROOTS.flatMap(sources)
const read = (file: string) => readFileSync(resolve(file), 'utf8')

// Matched in any case: an import, a global or a package name.
const FORBIDDEN_WORDS = [
  'XMLHttpRequest',
  'WebSocket',
  'EventSource',
  'sendBeacon',
  'superagent',
  'anthropic',
  'openai',
]

// Matched as written: a lowercase JSX tag is a DOM element, while
// react-router's `<Link>` is a component and is allowed.
const FORBIDDEN_TAGS = [
  '<img',
  '<input',
  '<textarea',
  '<form',
  '<select',
  '<iframe',
  '<script',
  '<link',
]

describe('Privacy and Advisor source', () => {
  it('finds the files to scan', () => {
    expect(files).toContain('client/screens/Privacy/index.tsx')
    expect(files).toContain('client/screens/Privacy/serverStatus.ts')
    expect(files).toContain('client/screens/Advisor/index.tsx')
  })

  it.each(files)('%s names no network API or AI client', (file) => {
    const src = read(file).toLowerCase()
    expect(
      FORBIDDEN_WORDS.filter((word) => src.includes(word.toLowerCase())),
    ).toEqual([])
  })

  it.each(files)(
    '%s renders no image, form, frame, script or link element',
    (file) => {
      const src = read(file)
      expect(FORBIDDEN_TAGS.filter((tag) => src.includes(tag))).toEqual([])
    },
  )

  it('calls fetch only in serverStatus.ts', () => {
    expect(files.filter((file) => /\bfetch\s*\(/.test(read(file)))).toEqual([
      'client/screens/Privacy/serverStatus.ts',
    ])
  })

  it('holds no external URL but the Claude desktop download page', () => {
    const urls = files.flatMap((file) =>
      [...read(file).matchAll(/https?:\/\/[^\s'"`)]+/g)].map(
        ([url]) => `${file} ${url}`,
      ),
    )
    expect(urls).toEqual([
      'client/screens/Advisor/index.tsx https://claude.ai/download',
    ])
  })
})
