// @vitest-environment node
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// prd-02 Ruling 7: fonts ship from the app. Nothing on load may call a
// third-party host.
// vitest runs from the repository root.
const read = (path: string) => readFileSync(resolve(path), 'utf8')

const html = read('index.html')
const css = read('client/styles/App.css')

describe('the app loads nothing from a third-party host', () => {
  it('index.html references no external URL', () => {
    expect(html).not.toMatch(/https?:\/\//)
    expect(html).not.toMatch(/fonts\.(googleapis|gstatic)/)
  })

  it('App.css imports each self-hosted font package', () => {
    for (const entry of [
      "@import '@fontsource-variable/outfit/index.css';",
      "@import '@fontsource-variable/dm-sans/opsz.css';",
      "@import '@fontsource/dm-mono/400.css';",
      "@import '@fontsource/dm-mono/500.css';",
    ]) {
      expect(css).toContain(entry)
    }
  })

  it('App.css fetches nothing remote', () => {
    expect(css).not.toMatch(/url\(\s*['"]?https?:/)
    expect(css).not.toMatch(/@import\s+(url\()?['"]?https?:/)
  })

  it('declares a phone viewport, so the tab bar appears under 720px', () => {
    expect(html).toContain(
      '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    )
  })
})
