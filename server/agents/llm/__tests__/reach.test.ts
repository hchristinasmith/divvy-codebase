import { readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { ForbiddenEnvError, assertCleanEnv } from '../../../../mcp/guard-env.ts'

// Where the key, the SDK and the model id may appear (#429 Done-when; prd-04
// Ruling 1; prd-03 Ruling 2). A source scan of every non-test module in the
// app's code trees. It reads text, comments included, so a mention in a
// comment counts too.

const REPO = new URL('../../../../', import.meta.url)
const TREES = ['server/', 'shared/', 'models/', 'mcp/', 'client/']
const CONFIG = 'server/agents/llm/config.ts'
const CLIENT = 'server/agents/llm/client.ts'

const isCode = (f: string) =>
  /\.[cm]?[jt]sx?$/.test(f) &&
  !f.split('/').includes('__tests__') &&
  !f.split('/').includes('node_modules') &&
  !/\.test\.[cm]?[jt]sx?$/.test(f)

const modules: { path: string; text: string }[] = TREES.flatMap((tree) =>
  readdirSync(new URL(tree, REPO), { recursive: true, encoding: 'utf8' })
    .map((f) => tree + f.split('\\').join('/'))
    .filter(isCode)
    .map((path) => ({ path, text: readFileSync(new URL(path, REPO), 'utf8') })),
)

// Every module specifier in `text`: static imports and re-exports, dynamic
// `import()` and `require()`.
function specifiers(text: string): string[] {
  const found: string[] = []
  for (const m of text.matchAll(/\b(?:from|import|require)\s*\(?\s*['"]([^'"]+)['"]/g)) {
    found.push(m[1])
  }
  return found
}

const where = (test: (m: { path: string; text: string }) => boolean) =>
  modules.filter(test).map((m) => m.path)

describe('reach of the model path', () => {
  it('scans the trees it names', () => {
    const paths = modules.map((m) => m.path)
    expect(paths).toContain(CONFIG)
    expect(paths).toContain(CLIENT)
    expect(paths).toContain('mcp/guard-env.ts')
    expect(paths.some((p) => p.startsWith('client/'))).toBe(true)
  })

  it('reads the API key only in config.ts', () => {
    expect(where((m) => m.text.includes('ANTHROPIC_API_KEY'))).toEqual([CONFIG])
  })

  it('imports the Anthropic SDK only in client.ts', () => {
    expect(
      where((m) => specifiers(m.text).some((s) => /^@anthropic-ai\/sdk(\/|$)/.test(s))),
    ).toEqual([CLIENT])
  })

  it('writes a model id only in config.ts', () => {
    expect(where((m) => /claude-(haiku|sonnet|opus|fable|mythos)-/.test(m.text))).toEqual([CONFIG])
  })

  it('leaves no module under mcp/ reaching the model path or the SDK', () => {
    const reaching = where(
      (m) =>
        m.path.startsWith('mcp/') &&
        specifiers(m.text).some((s) => /agents\/llm|@anthropic-ai\//.test(s)),
    )
    expect(reaching).toEqual([])
  })

  it('has the MCP refuse an environment holding the key, naming it without its value', () => {
    const value = 'sk-ant-test-6d1e2b77-invented'
    let caught: unknown
    try {
      assertCleanEnv({ PATH: '/usr/bin', ANTHROPIC_API_KEY: value })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(ForbiddenEnvError)
    const err = caught as ForbiddenEnvError
    expect(err.names).toEqual(['ANTHROPIC_API_KEY'])
    expect(err.message).not.toContain(value)
  })
})
