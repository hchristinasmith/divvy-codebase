import { readFileSync } from 'node:fs'
import * as Path from 'node:path'
import * as URL from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'

const __dirname = Path.dirname(URL.fileURLToPath(import.meta.url))
const root = Path.join(__dirname, '../../..')

// The knexfile reads DATABASE_PATH when it is first imported, so each test
// re-imports it after setting the environment.
async function productionFilename(): Promise<unknown> {
  vi.resetModules()
  const { default: config } = await import('../knexfile.js')
  return config.production.connection.filename
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('production database path', () => {
  it('comes from DATABASE_PATH when it is set', async () => {
    vi.stubEnv('DATABASE_PATH', '/somewhere/else.sqlite3')

    expect(await productionFilename()).toBe('/somewhere/else.sqlite3')
  })

  it('defaults to a file on the volume fly.toml mounts', async () => {
    vi.stubEnv('DATABASE_PATH', '')

    const filename = await productionFilename()
    const flyToml = readFileSync(Path.join(root, 'fly.toml'), 'utf8')
    const mount = flyToml.match(/^\s*destination\s*=\s*"([^"]+)"/m)?.[1]

    expect(filename).toBe('/data/divvy.sqlite3')
    expect(mount).toBe(Path.dirname(filename as string))
  })
})
