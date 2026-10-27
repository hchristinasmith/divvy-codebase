# Retro: #272 prd02, the Spending screen shows every category's total for a chosen month

Gear 3 as stamped; shifted 3 → 4 in effect: the lane extended an API route, which trips the global gear table's "API route → ≥4 / security-auditor" row. security-auditor ran. Implementer ran opus at gear 3 per the table. Commits: `144e5b9` (build) and `960528a` (review fixes). No telemetry is stated here; the Baseline hand-back transcript bug may leave seats red, a standing exception, nothing hand-stated.

## What was built

- **Kind of code:** a client screen at `/spending` (not in the nav; the handoff shows no entry) plus read-only filters on an existing route.
- **Pattern:** the full category bar (no `top`) lifted from `SpendingCard.tsx` into `SpendingBar.tsx`; a month picker (prev/next, NZ month by default); tap a category to list its transactions. `GET /api/v1/transactions` gained optional `scope`, `month` and `category` filters that return exactly the rows the aggregate counts.
- **Why this shape:** the client could not filter by scope and month itself (see item 1), so the server does it, and a cross-check test against `/spending/categories` pins the list to the total.

## Retro summary

Shipped. Gate: tsc clean, lint clean, vitest 143 files / 5757 tests. Biggest issue: the issue's premise about the transactions route was wrong. Biggest strength: the reviewer mutation-tested every server filter and all were caught.

## What went wrong

1. **"The existing transactions route" could not do the job.** It filtered only by description. Transactions carry Akahu account ids, and no client-reachable route maps an account to its scope (`GET /accounts` has no scope; `GET /settings/accounts` uses numeric ids). The lane took the obvious option, extending the route, without a decision round. That was a route change in a slice declared as screen work, so the gear moved (header).
2. **An open category reopened on going back to its month or scope (reviewer).** The state was hidden on switch but never cleared. Fixed in `960528a`.
3. **No test caught `month` missing from the transactions query key (reviewer).** Fixed in `960528a`.
4. **Perf note (security-auditor, no Critical or Warning):** the list reads all of a scope's outflows, then filters in JS, because the date-range helper is private in the fenced `server/db/spending.ts`. Left as is; the fence held.
5. test-guard's mutation pass was blocked by the permission classifier. Covered and gated otherwise; brand-checker found no violations.

## Root causes

- **The slice assumed an existing route could answer scope + month (item 1).** Nobody checked the route's params at slicing time. This is a slicing miss, not a build miss.
- **Hide-without-clear state (item 2) and an untested query-key input (item 3):** the author tested the screen working forward, not going back. Only review exercised the return path.

## What worked, keep it

- The cross-check test between the list and the aggregate: it pins "the rows the total counts" directly.
- Reviewer mutation-testing every server filter.
- Taking the small read-only option and saying so, rather than stalling on a decision.
- The fence held; security-auditor ran when the route change tripped the gear row.

## Recommended changes

1. **At slicing, for any issue that says "the existing X route/endpoint", list its params and confirm they cover what the screen needs.** First occurrence here, so do not encode yet; if it recurs, add the line to the issue-slicing checklist (artifact: the slicing skill or `docs/testing.md`'s neighbour doc, to be chosen then).
2. Not encoding the state-reset or query-key findings: one occurrence each.

## Highest-leverage next step

If the next screen issue also cites an "existing route", add the params check to the slicing checklist. Until then, no change.
