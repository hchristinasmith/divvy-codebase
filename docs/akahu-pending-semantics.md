# Akahu pending transactions, backfill depth and the effective category

Written for prd-01 wave 1 (#19). It records what Akahu's documentation and a
real Akahu response say about pending transactions, how far back the first
backfill can reach, and which Akahu category field becomes Divvy's effective
`category`. The schema in `server/db/migrations/20261024100001…100004`
follows it; if this doc and the schema ever disagree, one of them is wrong.

This repository is public. Everything below about real responses is key
names and value types only: no ids, merchants, amounts, dates or account
numbers.

## 1. Evidence

| Claim | Source | How it was checked |
|---|---|---|
| A settled transaction carries `_id` and `hash` | Real `GET /transactions` response, 2026-10-25 (key names and types only) | Observed: both keys are in the first page's key set, typed string |
| A pending transaction has no `_id`, no `hash`, no `balance`, no `category`, no `merchant` and no `created_at` | [Get pending transactions][ref-pending] and [Get pending transactions by account][ref-pending-acc], read on 2026-10-25 | Documented: the response schema lists none of them |
| Pending transactions "are not assigned a unique identifier and are not fully enriched by Akahu" | [Accessing transactional data — Pending transactions][guide], read on 2026-10-25 | Documented |
| Akahu recommends rebuilding the local copy of pending data on every fetch | [Accessing transactional data — Pending transactions][guide], read on 2026-10-25 | Documented |
| The pending endpoints take no `start`, `end` or `cursor` and return one unpaginated `items` array | [Get pending transactions][ref-pending], [by account][ref-pending-acc], read on 2026-10-25 | Documented |
| `hash` is deprecated | [Get transactions][ref-transactions], read on 2026-10-25 ("This field is deprecated and should not be used") | Documented; still present on real settled items on 2026-10-25 |
| Akahu occasionally deletes a settled transaction and reissues it under a new `_id` | [Accessing transactional data — Keeping transactions synchronised][guide], read on 2026-10-25 | Documented (see §2, consequence for sync) |
| A personal app gets 730 days of history, counted back from the consent date | [Accessing transactional data — Getting a date range][guide], read on 2026-10-25 | Documented |
| `/transactions` pages hold at most 100 items and continue through `cursor.next` | [Accessing transactional data — Pagination][guide], read on 2026-10-25 | Documented; a real first page on 2026-10-25 held 100 items with more pages after it |

**The pending shape is documented but not yet seen in a real response.**
`GET /transactions/pending` returned an empty `items` array on 2026-10-25,
so there was no pending item to compare against the docs. Re-check the next
time a card payment is in flight, comparing key names only:

```bash
curl -s https://api.akahu.io/v1/transactions/pending \
  -H "Authorization: Bearer $AKAHU_USER_TOKEN" \
  -H "X-Akahu-Id: $AKAHU_APP_ID" \
  | jq '[.items[] | keys] | add | unique'
```

It prints the union of key names across pending items and nothing else.
The expected answer is a subset of `_account`, `_connection`, `_user`,
`amount`, `date`, `description`, `meta`, `type`, `updated_at`. If `_id`
appears, prd-01 Ruling 1 and this schema are wrong about pending identity:
stop and raise it before the sync lane builds on it. Never paste the
response body itself anywhere in this repository.

## 2. How a pending row is identified

Answers, all from the pending endpoints' response schema
([all accounts][ref-pending], [one account][ref-pending-acc]) and the
[guide][guide], read on 2026-10-25:

- **Does a pending item carry an `_id`?** No. "Pending transactions are not
  assigned a unique identifier."
- **A `hash`?** No. (On settled items `hash` is deprecated anyway.)
- **A `balance`?** No.
- **`category`, `merchant`, `meta`?** No `category` and no `merchant`.
  `meta` may be present (`particulars`, `code`, `reference`,
  `other_account`, `conversion`, `card_suffix`), "on a best-effort basis",
  and only with the enriched-data permission.
- **Which identity fields are present?** Only `_account`, `_connection` and
  `_user`, which say whose it is, not which transaction it is; plus `date`,
  `updated_at`, `description`, `amount` and `type`, all of which the bank
  may change while the item is pending ("liable to change significantly as
  they are processed").
- **Does the settled transaction share a key with its pending one?** The
  docs do not say so, and the pending schema has no field that could carry
  one. Treat them as unrelated: a settled item arrives as a new `_id`.
- **Can two pending items be identical?** Yes. Nothing in the schema makes
  two same-amount, same-description card holds at one merchant on one day
  distinguishable.
- **Date range or pagination on the pending endpoints?** None: no `start`,
  `end` or `cursor` parameter, one `items` array.

Conclusions, and what the schema does about each:

- `akahu_id` and `hash` are **NULL** on a pending row. Both columns are
  nullable, and the UNIQUE on `akahu_id` allows any number of NULLs
  (`20250611031435_transactions.js`, `20261024100003_…`).
- There is **no natural key** for a pending row, and Divvy does not invent
  one. A pending row is identified only as a member of the set
  (`account_id`, `status = 'pending'`), indexed by
  `transactions_account_status_idx`.
- That set is **replaced wholesale per account**, delete then insert,
  inside the same database transaction as the settled upsert (prd-01
  Ruling 1). Akahu's own advice is the same: "completely rebuild your local
  copy of this data".
- Two identical pending items become **two rows**; the test
  "holds identical pending rows with no akahu_id or hash side by side" pins
  that the schema allows it.
- A pending row's local `id` is **ephemeral**: the next sync deletes it and
  inserts a new row with a new id. Nothing may keep a pending row's id.
- Rolling back `20261024100003_…` **deletes every pending row** before it
  drops `status`: without the column they would read as settled rows with no
  `akahu_id`, and the M1 code would count them beside the settled row they
  become. Nothing is lost, since the next sync re-mirrors them.
- A pending row's `category` and `akahu_category_*` are **NULL**: Akahu
  sends no category for it.
- `status` defaults to `settled`, so the pending insert must set
  `status = 'pending'` explicitly. One that forgets writes a settled row with
  no `akahu_id` that no later sync removes.

**Consequence for sync (outside this lane): Akahu sometimes reissues a
settled transaction.** The guide's "Keeping transactions synchronised"
section says a heavily altered transaction is deleted and "replaced with the
new version which will have a new identifier" (about 0.1% of transactions),
and that an app must handle deletions to avoid duplicates. Under prd-01
Ruling 1 and Done-when 3, sync never deletes a settled row, so a reissued
transaction would appear twice: the old `akahu_id` row and the new one. That
is a decision for prd-01, not a schema change here.

## 3. How far back the first backfill can go (prd-01 Open question 3)

From [Accessing transactional data][guide], read on 2026-10-25:

- **Default window.** With no `start` and `end`, `/transactions` returns
  "all transactions accessible to your app".
- **Maximum lookback.** "If you are using a personal app, it will be given
  access to 730 days (2 years) of transactions." The earliest fetchable date
  is the consent date minus that setting; the consent date is
  `access_granted_at` on `GET /me`. So history from before the connection
  date is available, back to 730 days before consent.
- **Bank limits.** "Some financial institutions limit the data range of
  historical data that is available", with known limits listed on
  [Supported integrations][integrations] (read on 2026-10-25). That page
  lists BNZ with account and transaction data under enduring access and
  gives no BNZ-specific limit. Its "minimum of 365 days of transaction data"
  note is in the one-off access section, which does not apply to a personal
  app ([Personal apps][personal]: "Ongoing connectivity only").
- **Range per request and pagination.** No maximum range is documented for
  `start`/`end` ([Get transactions][ref-transactions]). A page holds at most
  100 transactions ("this may change in the future without notice"); pass
  `cursor.next` back as the `cursor` parameter; the last page has
  `cursor.next` null, and passing that null back is an error. The same
  `start` and `end` must be sent on every page of one query.
- **Not yet observed:** how far back BNZ actually returns for this
  connection. The first full fetch answers it: record the oldest `date` it
  returned beside `access_granted_at`, in Divvy's own database or Hannah's
  private notes, never in this repository. Both are real personal dates,
  and this repository is public. (`sync_runs` has no column for either
  today; adding one is the sync lane's call.)

The answer, then: up to 730 days before consent, subject to an undocumented
BNZ limit that the first run will show. prd-01 still lists Open question 3
as open; marking it answered is an amendment to the PRD, which this lane does
not edit.

## 4. The effective `category` is the category name

The effective `category` holds an NZFCC **category name** (the leaf, e.g.
"Bakeries"), not the personal-finance group name (e.g. "Food"). Read from
how the code consumes it on 2026-10-25:

- `client/components/Dashboard/SpendingBreakdown.tsx:36-39` groups spending
  by `category.groups.personal_finance.name`, falling back to
  `category.name`. It needs the group, but the group can be derived from the
  name (below), while a name cannot be derived from a group.
- `client/components/Dashboard/TxAnalysis.tsx:5` groups by `category.name`;
  `client/components/Dashboard/Txs.tsx:39` shows `category.name`.
- `PATCH /api/v1/transactions/:id` accepts only names listed in
  `data/cats.js` (`server/routes/transactions.ts:31`,
  `server/db/categories.ts:18`). A user's choice is therefore always a name.
- `20261023130000_transaction_effective_category.js` backfilled `category`
  from `category_name`, and the seed writes `category` from
  `category.name` (`server/db/seeds/transactions.js:68`).
  `20261024100003_…` repairs the same way any row with
  `category_source = 'akahu'` that was left with a NULL `category` beside
  a non-NULL `category_name`. A row a user, rule or Claude owns is never
  filled in.

`data/cats.js` maps each group to its category names, and every name
appears under exactly one group (checked 2026-10-25), so a name always
determines its group. Akahu's side: a category's `groups` is an object keyed
by grouping, so it holds at most one `personal_finance` entry; Akahu offers
that grouping "on all enriched transactions"
([The transaction model][model], [Get categories][ref-categories], read on
2026-10-25), though the schema does not mark it required.

`akahu_category_group_name` keeps Akahu's group as received. **Consequence
for prd-02:** a row whose category the user changed has no stored group for
its effective category; derive it from the name through `data/cats.js`,
never from `akahu_category_group_name`, which describes Akahu's category,
not the user's.

## 5. Corrections and pending rows

`category_corrections.transaction_id` references `transactions.id` with
`ON DELETE CASCADE`. Because a pending row is deleted and reinserted on
every sync (§2), a correction made on a pending row would be deleted with it
at the next run, and the user's choice would be lost silently. RESTRICT
instead would make that delete fail and stop every later sync.

So every category edit path must refuse a transaction whose `status` is not
`settled`. Today's path, `setUserCategory` in `server/db/transactions.ts`,
does not check `status` yet; it belongs to another lane.

## 6. Account fields

From [Get accounts][ref-accounts], read on 2026-10-25, compared with a real
`GET /accounts` response the same day (key names and types only):

| Akahu field | Docs | `accounts` column |
|---|---|---|
| `_id` | required, unique account id | `akahu_id` |
| `_authorisation` | required; groups accounts connected in one authorisation | `authorisation_id` |
| `_credentials` | deprecated, "use `_authorisation` instead" | `credentials_id` |
| `connection._id`, `.name`, `.logo`, `.connection_type` | required object | `connection_id`, `connection_name`, `connection_logo`, `connection_type` |
| `name` | required | `name` |
| `formatted_account` | optional | `formatted_account` |
| `status` | required; `ACTIVE`, `INACTIVE` | `status`, no CHECK |
| `type` | required; `CHECKING`, `SAVINGS`, `CREDITCARD`, `LOAN`, `KIWISAVER`, `INVESTMENT`, `TERMDEPOSIT`, `FOREIGN`, `TAX`, `REWARDS`, `WALLET` | `type`, no CHECK |
| `attributes` | required array of `TRANSACTIONS`, `PAYMENT_TO`, `PAYMENT_FROM` | `attributes`, JSON text |
| `balance.currency`, `.current` | required within an optional `balance` | `currency`, `balance_cents` |
| `balance.available`, `.limit` | optional | `available_balance_cents`, `credit_limit_cents` |
| `balance.overdrawn` | optional boolean | not stored |
| `refreshed.balance`, `.meta`, `.transactions` | optional ISO-8601 timestamps | `refreshed_balance_at`, `refreshed_meta_at`, `refreshed_transactions_at` |
| `meta` (holder, loan details) | optional | not stored |
| `_migrated` | optional; the account's predecessor id | not stored |

`status` and `type` are Akahu's enums, and Akahu can add to them; the
columns store whatever arrives rather than refusing a new value. The real
response matched the docs: its key set included `_migrated` and
`connection.connection_type`, and no account carried `overdrawn`.

**Finding, not fixed here:** `models/akahu.ts` has drifted from both the
docs and the real response. Its account `Item` has no `_migrated`,
`connection.connection_type`, `balance.available`, `balance.limit` or
`refreshed.transactions`; marks `balance`, `balance.overdrawn` and `meta`
required though Akahu marks them optional; and types `refreshed.*` as `Date`
where JSON sends strings. `AkahuTransaction` has no `_migrated`,
`_migrated_account`, `merchant.nzbn` or `meta.conversion`. There is no type
for a pending transaction.

[guide]: https://developers.akahu.nz/docs/accessing-transactional-data
[model]: https://developers.akahu.nz/docs/the-transaction-model
[ref-pending]: https://developers.akahu.nz/reference/get_transactions-pending
[ref-pending-acc]: https://developers.akahu.nz/reference/get_accounts-id-transactions-pending
[ref-transactions]: https://developers.akahu.nz/reference/get_transactions
[ref-accounts]: https://developers.akahu.nz/reference/get_accounts
[ref-categories]: https://developers.akahu.nz/reference/get_categories
[integrations]: https://developers.akahu.nz/docs/integrations
[personal]: https://developers.akahu.nz/docs/personal-apps
