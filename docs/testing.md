# Testing

How Divvy's tests are laid out and run. `CLAUDE.md` (Testing) is the short form; this is the long one.

## Running

- `npm test` — every test, once (`vitest run`).
- `npm run test:watch` — watch mode.
- `npx vitest run <file>` — one file.

## Where tests live

Tests sit beside the code in a `__tests__/` folder, named after the file they cover:

| Code | Test |
|---|---|
| `server/routes/categories.ts` | `server/routes/__tests__/categories.test.ts` |
| `client/components/Dashboard/ActualVTarget.tsx` | `client/components/Dashboard/__tests__/ActualVTarget.test.tsx` |
| `shared/<module>.ts` | `shared/__tests__/<module>.test.ts` |

`vitest.config.ts` only collects `*.test.ts(x)` files inside `__tests__/` folders under `client/`, `server/`, `shared/` and `models/`. A test anywhere else does not run.

## Environments

- `client/**` runs in **jsdom**.
- Everything else runs in **node**.

This is set once in `vitest.config.ts` (`environmentMatchGlobs`); a test file does not need an environment comment.

## Server route tests

Use supertest against the real Express app, backed by a fresh in-memory SQLite database:

```ts
import request from 'supertest'
import type { Express } from 'express'
import { afterAll, beforeEach, it, expect } from 'vitest'
import { closeDb, freshApp } from '../../test-utils/app.ts'

let app: Express
beforeEach(async () => {
  app = await freshApp()
})
afterAll(closeDb)

it('…', async () => {
  const res = await request(app).get('/api/v1/…')
  expect(res.status).toBe(200)
})
```

- `freshApp()` (`server/test-utils/app.ts`) rolls every migration back, re-applies them all, and returns the app, so each test starts from an empty, fully migrated schema. Insert the rows a test needs inside that test.
- The database is the `test` config in `server/db/knexfile.js` (`:memory:`), chosen because vitest sets `NODE_ENV=test`. `freshApp()` throws if the connection is anything other than `:memory:` — never run tests against a developer's real `.sqlite3` file.
- Each test file gets its own module graph and so its own database. Call `closeDb` in `afterAll`.

## Component tests

Use Testing Library with jsdom. No snapshot tests.

- vitest runs without globals, so Testing Library cannot clean up on its own: add `afterEach(cleanup)` to every component test file.
- `@testing-library/jest-dom` is not installed; assert on the DOM directly (`textContent`, `queryByText(...)` is `null`, attributes).
- Pick leaf components first. A component that needs Auth0, react-router or TanStack Query needs a provider wrapper; write that wrapper once in a shared test helper rather than per file.

## Assertions

- When asserting the shape of a row or API response, pin the key set: `expect(Object.keys(body).sort()).toEqual([...].sort())`. `toEqual` alone cannot see a key that disappeared.
- Before shipping a test, break the code it covers and watch the test go red for the reason its title gives.

## Money

Anything that computes money (safe-to-spend, tax hold, budgets) gets a pure-function test in `shared/__tests__/` with integer-cent fixtures.
