import { defineConfig } from 'vitest/config'

// Tests sit beside the code in `__tests__/` folders (CLAUDE.md, Testing;
// docs/testing.md). Anything outside those folders is not collected, so a
// stray `*.test.*` elsewhere (or in a dead tree) never runs by accident.
//
// Server tests run in node; client tests run in jsdom. vitest sets
// NODE_ENV=test when it is unset, which makes `server/db/connection.ts`
// pick the `:memory:` SQLite config; `server/test-utils/app.ts` refuses to
// run if it did not.
export default defineConfig({
  test: {
    environment: 'node',
    environmentMatchGlobs: [['client/**', 'jsdom']],
    include: ['{client,server,shared,models}/**/__tests__/**/*.test.{ts,tsx}'],
  },
})
