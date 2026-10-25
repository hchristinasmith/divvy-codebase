# Divvy

Divvy is a private personal-and-business money app for one person. It runs on a single server reachable only over a Tailscale network, so it has no login page (D4 in [docs/decisions.md](docs/decisions.md)). Bank data comes from Akahu.

It is an early prototype. [docs/audit-2026-10-23.md](docs/audit-2026-10-23.md) records what works, what is stubbed and what is planned.

## What works today

- The Dashboard lists your Akahu accounts and shows a spending breakdown from live Akahu transactions. The Express server proxies Akahu, using one token from `.env`.
- `GET /api/v1/transactions?description=` searches the local SQLite `transactions` table, and `PATCH /api/v1/transactions/:id` sets your category on a row (a row still pending is refused with 409 until it settles).
- The Transactions, Targets, Subscriptions, Wishlist, Challenges and Settings pages are shells or show mock data.

## Stack

- **Client** (`client/`): React 18, Vite 5, Tailwind CSS 4, react-router 7, TanStack Query 5, and shadcn/Radix primitives in `src/components/ui/`
- **Server** (`server/`): Express 4 on Node, run with `tsx` in development
- **Database:** SQLite through Knex 2. Migrations and seeds live in `server/db/`; the knexfile is `server/db/knexfile.js`
- **Shared types:** `models/`
- **Language:** TypeScript 5. Tests use vitest

## Setup

You need Node 20 or later.

```sh
git clone https://github.com/hchristinasmith/divvy-codebase.git
cd divvy-codebase
npm ci
cp .env.example .env        # then fill in AKAHU_USER_TOKEN and AKAHU_APP_ID
npm run knex -- migrate:latest
npm run dev
```

`npm run dev` starts two processes:

- the Express API on <http://localhost:3005>, or on `PORT` if you set it
- the Vite client on <http://localhost:5173>, which proxies `/api` to port 3005

Open the client URL.

### Seeding

`npm run knex -- seed:run` currently fails on a fresh clone, because the transactions seed imports a private `spending.js` that is gitignored. The Dashboard does not need seeded data, since it reads Akahu live. Seeding from a committed fixture is tracked as an M1 issue.

## Scripts

| Script | Does |
|---|---|
| `npm run dev` | Client and server together, with watch |
| `npm run knex -- <cmd>` | Knex CLI against `server/db/knexfile.js`, e.g. `migrate:latest`, `seed:run` |
| `npm run build` | Client bundle (`vite build`), then server bundle (`dist/server.js`) |
| `npm test` | vitest |
| `npm run lint` | ESLint |
| `npm run typecheck` | `tsc --noEmit` |

## Docs

- [docs/decisions.md](docs/decisions.md): architecture decisions (deploy, auth, storage, AI, notifications)
- [docs/audit-2026-10-23.md](docs/audit-2026-10-23.md): the codebase audit behind the M1 milestone
