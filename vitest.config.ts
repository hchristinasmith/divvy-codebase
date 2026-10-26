import { defineConfig, mergeConfig } from 'vitest/config'
import viteConfig from './vite.config.js'

// Every test run uses UTC, a non-NZ zone, so a test that reads the browser's
// local date instead of `nzCalendarDate` fails here rather than passing on an
// Auckland machine (#396). This line runs in the main vitest process before
// its workers are spawned; workers inherit `process.env`, and Node re-reads
// the zone when `TZ` is assigned. `npx vitest run` and `npm test` both use it.
process.env.TZ = 'UTC'

// Tests sit beside the code in `__tests__/` folders (CLAUDE.md, Testing;
// docs/testing.md). Anything outside those folders is not collected, so a
// stray `*.test.*` elsewhere (or in a dead tree) never runs by accident.
//
// Server tests run in node; client tests run in jsdom. vitest sets
// NODE_ENV=test when it is unset, which makes `server/db/connection.ts`
// pick the `:memory:` SQLite config; `server/test-utils/app.ts` refuses to
// run if it did not.
//
// The Vite config is merged in so client tests resolve the same `@/` alias
// and plugins as the app build.
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: 'node',
      environmentMatchGlobs: [['client/**', 'jsdom']],
      include: ['{client,server,shared,models,mcp}/**/__tests__/**/*.test.{ts,tsx}'],
    },
  }),
)
