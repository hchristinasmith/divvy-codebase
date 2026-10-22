# Divvy — Claude Guidelines

Divvy is Hannah's private personal-and-business money app: one user, one server on her Tailscale network, bank data from Akahu (BNZ personal + Strawb Collective Ltd business), Strawb's books from Xero, and a read-only Claude advisor. Nobody else uses it.

**Stack:** React 18 + Vite 5 + Tailwind 4 + react-router 7 + TanStack Query (`client/`), Express 4 + Knex 2 + SQLite (`server/`), TypeScript 5, vitest. Deploy target: Fly.io Sydney with a volume, Litestream, no public IP (D1, D4 in `docs/decisions.md`).

**Key commands:**

- `npm run dev` — Vite client + tsx server together (ports 5173+ and 3005)
- `npm test` — vitest; `npx vitest run <file>` for one file
- `npm run knex -- migrate:latest` — migrations (knexfile at `server/db/knexfile.js`)
- `npm run build` — client then server bundle to `dist/`

---

## Reference docs

- [docs/decisions.md](docs/decisions.md) — D1–D5 architecture decisions. Read before touching deploy, auth, storage, AI, or notifications.
- [docs/audit-2026-10-23.md](docs/audit-2026-10-23.md) — what exists, what is dead, 14 health issues (M1). Read before M1 work.
- [docs/prds/](docs/prds/) — prd-01…05, blessed 2026-10-23. Every issue cites its PRD and ruling; code comments cite `prd-NN Ruling N`. Never renumber a PRD or ruling.
- [docs/testing.md](docs/testing.md) — where tests live, environments, the `freshApp()` route-test pattern, assertion rules. Read before writing tests.
- [docs/design/handoff.md](docs/design/handoff.md) — the 8-screen design, tokens and fonts. Read before UI work. Where it contradicts a PRD ruling (e.g. "Claude Code owns budget creation", "no third-party AI API"), the PRD wins.

---

## Testing

- Tests sit beside the code in `__tests__/` folders: `server/routes/x.ts` → `server/routes/__tests__/x.test.ts`; same for `client/components/`.
- Server route tests use supertest against the Express app with a fresh in-memory SQLite (`:memory:`) migrated in `beforeEach`. Never test against a developer's real `.sqlite3` file.
- Component tests use Testing Library + jsdom; no snapshot tests.
- Anything that computes money (safe-to-spend, tax hold, budgets) has a pure-function test in `shared/` with integer-cent fixtures.

---

## Code conventions

- Relative imports. No path aliases.
- No `any`. Shared types live in `models/`; money math and safe-to-spend live in `shared/` and are imported by both client and server.
- **Money is integer cents** (M1 #8). Never a float, never a string with a decimal.
- Every row Divvy owns has a `scope` (`personal` | `strawb`) and a `source` (`akahu` | `xero` | `manual`) where the PRD says so (prd-01 Rulings 4, 9).
- Akahu's category and the user's category are separate columns; sync never writes the user's column (prd-01 Ruling 4).

---

## Architecture

- `server/` owns all writes. The client never talks to Akahu or Xero directly.
- `mcp/` (prd-03) must never import from `server/**`; it opens only the scrubbed read-only replica. A lint rule enforces it once it exists.
- `server/agents/**` (prd-04) write only to inbox tables (`category_proposals`, `insights`, `agent_runs`), never to money state.
- `server/xero/**` (prd-05) is the only place Xero is called; tokens are encrypted at rest.
- Safe-to-spend is computed once, on the server, in `shared/safe-to-spend.ts` (prd-02 Ruling 1).

---

## Security

- No Auth0, no login page: the app is reachable only over the tailnet (D4). Do not add a public auth layer.
- Secrets come from the environment (`.env` locally, Fly secrets in prod). Never commit `.env`, tokens, or a real `.sqlite3`. Never log a token.
- `AKAHU_*` and `XERO_*` env vars are read in `server/` only; never bundled into the client.
- No raw-SQL endpoints. The MCP tool surface is fixed and typed (prd-03).

---

## Pre-commit checks

Run all of these, in order, before every commit and push — no exceptions, even for small changes. Fix any failures before committing.

```bash
npx tsc --noEmit
npm run lint
npx vitest run
```

---

## Worktrees and lanes

- Worktrees live in `../divvy-worktrees/<slug>`; branches `feature/<slug>`, `fix/<slug>`, `test/<slug>`, `docs/<slug>`. Never commit to `main`.
- Board: GitHub Project #3 "Divvy" (`PVT_kwHOC_QBzM4BoS8_`, Status field `PVTSSF_lAHOC_QBzM4BoS8_zhmztZQ`). Move the issue to *In progress* at branch cut and *In review* at PR.
- Milestones: M1 health, M2 prd-01, M3 prd-02, M4 prd-05, M5 prd-03, M6 prd-04, M7 Hannah's tasks (operator acts only; never dispatch an M7 issue to an agent).
- A lane commits, pushes, opens a PR and stops. It never merges. The conductor merges after reading the diff.
- Baseline does not know this project yet; lanes run off the record until it is registered. Say so in the PR body instead of hand-stating telemetry.
