# Divvy — decisions

Numbered, never renumbered. Each answers a question from `audit-2026-10-23.md` §4.

| # | Decision | Why |
|---|---|---|
| D1 | **Host on Fly.io with a volume**, Sydney region, no public IP, reached only over Tailscale | Always on, nothing to look after, private by construction |
| D2 | **SQLite stays**, plus Litestream for continuous backup | One user, one process; a volume alone is not a backup |
| D3 | **Claude both ways, MCP first**: an MCP server over the DB for Claude desktop (runs on the subscription); the server calls the API only for background jobs such as categorising, rules first then Haiku · *2026-10-25: prd-04 Ruling 7 removes the API from background jobs. Rules only, no paid API.* | Advisor costs nothing extra; background jobs cost cents a month |
| D4 | **Tailscale-only, no Auth0**; add OAuth only if the MCP endpoint ever goes online | Nothing faces the public internet, so Auth0 is moving parts for no gain |
| D5 | **Web push for alerts, email for the weekly check-in** | Works on the phone from a home-screen install; Tailscale issues the HTTPS cert web push needs |

Decided 2026-10-23. Still open from the audit: D6 Xero token storage, D7 job runner, D9 email ingestion route, D10 business/personal data model, D11 `wish_web/`, D12 integer cents (recommended yes, in M1).

> 2026-10-26 (#387): D11's page half is settled. Hannah said "remove the wishlist page", and the Wishlist page is removed from the client (no route, sidebar entry or icon). D11 stays open for the data half: the `wishlist_items` table and the `wish_web/` question are untouched and tracked under #219, because dropping a table needs a migration and a separate decision.
