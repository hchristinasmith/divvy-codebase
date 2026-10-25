# Divvy

Divvy is a private personal-and-business money app for one person. It runs on a single server reachable only over a Tailscale network, so it has no login page (D4 in [docs/decisions.md](docs/decisions.md)). Bank data comes from Akahu.

It is an early prototype. [docs/audit-2026-10-23.md](docs/audit-2026-10-23.md) records what works, what is stubbed and what is planned.

## What works today

- The Overview (`/`) shows your safe-to-spend, the account cards, Strawb's tax set-aside, alerts you can dismiss and recent activity, for the scope you pick: All, Personal or Strawb.
- The Dashboard (the old page, at `/dashboard`) lists your accounts and shows a spending breakdown from the transactions the last sync stored.
- The sync is the only code that calls Akahu. It uses one token from `.env`.
- `GET /api/v1/transactions?description=` searches the local SQLite `transactions` table, and `PATCH /api/v1/transactions/:id` sets your category on a row (a row still pending is refused with 409 until it settles).
- The Subscriptions screen finds subscriptions from your settled transactions and shows regular charges, totals, an "Is this a subscription?" question and cancel. Cancelling records a date only; nothing is sent to the merchant or the bank.
- The Settings page is real. It sets the tax rate, Strawb's profit, payday, personal tax owed and currency, and each account's role and scope (Personal or Business).
- The Transactions, Targets, Wishlist and Challenges pages are shells. The old Subscriptions page at `/manage-subscriptions` shows mock data.

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

The Express process also starts the sync scheduler. It syncs every 15 minutes (set `SYNC_INTERVAL_MS` in `.env` to change that), with the first run one interval after start, and it writes to the dev database. With empty Akahu credentials each run records a `failed` row. `POST /api/v1/sync/run` starts a sync now.

Open the client URL.

### Seeding

`npm run knex -- seed:run` currently fails on a fresh clone, because the transactions seed imports a private `spending.js` that is gitignored. The Dashboard does not need seeded data, since it reads the accounts and transactions the last sync stored; before a sync has stored any, it shows "No accounts found". Seeding from a committed fixture is tracked as an M1 issue.

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
