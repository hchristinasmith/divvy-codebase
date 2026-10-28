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
- `AKAHU_*`, `XERO_*` and `ANTHROPIC_*` env vars are read in `server/` only, and `ANTHROPIC_*` only in `server/agents/llm/` (the API key in `config.ts` alone); never bundled into the client.
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

<!-- ~/.claude/CLAUDE.md holds the general rule: work is dispatched to an agent in its own worktree, and this session reviews. This section copies the kyncess repo's lane rules (Hannah, 2026-10-23); only what is specific to Divvy is here. -->

- **At most 5 lanes run at once** (Hannah, 2026-10-23). Count every open lane before dispatching; queue the rest.
- Worktrees live at `../divvy-codebase__worktrees/<issue>-<slug>`, never inside the repo. Branches `feature/<issue>-<slug>`, `fix/…`, `test/…`, `docs/…`. Never commit to `main`.
- **A lane is a workmux window, never a subagent of the conductor.** A subagent fires no workmux hooks, so the sidebar cannot show it. Open one like this:

  ```bash
  git worktree add ../divvy-codebase__worktrees/<issue>-<slug> -b feature/<issue>-<slug> origin/main
  cd ../divvy-codebase__worktrees/<issue>-<slug>
  baseline start --issue <n> --title "<issue title>" --project divvy-codebase \
    --workflow 4462e5a3-c96e-42d4-a82b-4181d0c158a1 --handoff-file <handoff.md>
  npm ci
  workmux open <issue>-<slug> --parent-session divvy
  ```

  The repo path has spaces, so the new panes can start in a broken directory. If `claude` reports "the current working directory was deleted", `cd` into the worktree in the pane and run `claude` there. The first prompt is the real task, sent with `tmux send-keys -t divvy:wm-<issue>-<slug>.1 -l "<text>"`, then `Enter`.
- **The main checkout authors nothing.** It reads diffs, merges, and adds or removes worktrees. A one-line config fix is the only exception, and it still goes through a branch and a PR.
- **Never `git stash` in a lane.** The stash stack is shared by every worktree of this repo; two lanes' pops crossed on 2026-10-23 and moved one lane's files into another's index. Gate the working tree directly.
- A lane commits, pushes, opens a PR and stops. It never merges. The conductor merges after reading the diff.

### Issues and the board

- Board: GitHub Project #3 "Divvy" (`PVT_kwHOC_QBzM4BoS8_`, Status field `PVTSSF_lAHOC_QBzM4BoS8_zhmztZQ`): `Backlog` `460c7010` · `Todo` `0925703f` · `In progress` `9454dc3d` · `In review` `959abdc9` · `Done` `50ff20eb`. Move the issue to *In progress* at branch cut and *In review* at PR.
- Milestones: M1 health, M2 prd-01, M3 prd-02, M4 prd-05, M5 prd-03, M6 prd-04, M7 Hannah's tasks (operator acts only; never dispatch an M7 issue to an agent), Housekeeping.
- **A follow-up goes into a PRD milestone only if it passes the phase test; everything else goes to `Housekeeping`.** Put it in the PRD's milestone if it is a security hole someone could use today, broken or leaks data, blocking merges (a flaky test that fails the gate), or needed for that PRD's own Done-when. Whoever files it writes `Priority: phase — <which row>` or `Priority: housekeeping` in the body; unsure means housekeeping. The conductor checks the line at merge.
- **Close every issue by hand with a reason** (`gh issue close <N> --reason completed --comment "<what fixed it, with the PR>"`).

### Small issues share a lane

| Bundle into one lane when **all** hold | Keep in its own lane when **any** holds |
|---|---|
| Each is gear 1 or 2 | It is gear 3 or 4 (new behaviour, a migration, a new export) |
| Same or neighbouring files, or all tiny | It needs a decision from Hannah first |
| None is blocked on another open lane | It is blocked on an unmerged PR |
| At most 4 issues | It adds a dependency |

- One PR; every commit carries its issue number. A bundled PR merges with `gh pr merge <N> --merge --delete-branch`, not `--squash`, so per-issue commits survive; a single-issue PR squashes. The merger closes every bundled issue by hand.
- Plain UI from the design handoff, with no data, auth or money: at most 2 such issues per lane, gear 1–2, no architect, `brand-checker` checks tokens and type roles only.

### The implementer runs opus or haiku, not sonnet

Copied from kyncess, where sonnet cost more at every gear (evidence in `~/.claude/workflow-changes.md`, 2026-09-28 entry).

| Gear | implementer model |
|---|---|
| 1 | `haiku` |
| 2 | `haiku`, or `opus` if the change is subtle rather than merely small |
| 3 | `opus` |
| 4 | `opus` |

Issues sliced before 2026-10-23 say `model: sonnet`; the lane reads that line through this table and passes the result as a per-call override on the implementer dispatch.

### Baseline

- Project id **`divvy-codebase`**, exactly (discovered by `POST /projects/scan` on 2026-10-23). Workflow `current` (`4462e5a3-…`) unless the handoff says otherwise; check `curl -s 127.0.0.1:3001/workflows` rather than assuming.
- `baseline start` writes the run id into the worktree's `.claude/settings.local.json` and materialises `.claude/agents/`, `.claude/skills/` and `.claude/workflow.md`. Those three are listed in the repo's local `.git/info/exclude` so no lane commits them.
- The lane dispatches building to `implementer` and the retro to `retro-writer`, and ends with `baseline finish`, then the retro POST. The merging session records `baseline outcome --run <id> --status merged --at <mergedAt>`.

### Not copied from kyncess

- **Phase branches.** Kyncess cuts `phase/<N>-<slug>` per PRD because Railway deploys `main`. Divvy has no deploy yet and runs five PRDs at once with blockers across them, so issue PRs go straight to `main`.
- **A second review account.** Kyncess has `@strawbreview` approve every PR under a ruleset. Divvy has no second account, token or ruleset; the conductor's diff read is the review of record.
