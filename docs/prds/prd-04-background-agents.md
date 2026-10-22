# PRD 04 — Background agents: category proposals and insights

> **Status:** blessed by Hannah in session, 2026-10-23 (all five PRDs blessed together; decisions 6 and 7 answered the same day)

**Prerequisites.** M1 has landed. prd-01 is deployed with data syncing (and its category fields, ruling 4). prd-02 has landed the Overview and Habits screens (waves 2 and 4). prd-03 is not required, and nothing here goes through it.

**Territory.** This PRD owns `server/agents/**` (including the agents' routes), the migrations for its inbox tables, the chart-spec types in `models/insights.ts`, and `client/components/Insights/**`. `server/sync/**`, `fly.toml`, and Litestream are prd-01's territory; the rest of `client/**`, `src/**`, `shared/**` and the budgets/bills/goals routes are prd-02's; `mcp/**` is prd-03's. No wave here enters them, with two declared exceptions in wave 3: mounting the suggestions pill and the Patterns card in prd-02's Overview and Habits components. It consumes prd-01's `transactions`, `category_corrections` and `sync_runs`. *Added 2026-10-23:* `server/xero/**` and the Xero migrations are prd-05's territory; no wave here enters them.

## What we're building

Two agents that work in the background on your Fly machine and only ever make suggestions. The category agent looks at your transactions after each sync and, where Akahu's category looks wrong, proposes a better one, which you accept or reject with a tap. The insights agent studies your spending weekly, or when you ask, and writes up patterns with charts that appear in the app. Neither can change your money data: accepting a suggestion is what changes a category, and only you accept.

## Why this first (after prd-01 and prd-02)

1. Hannah's categories are wrong often enough that she wants them corrected, and corrections feed every budget and the advisor.
2. It is the work D3 names for the API: cheap, background, and not suited to Claude desktop, which has no scheduler.
3. The Habits "Patterns" card is empty in prd-02 and the handoff says Claude generates it from data (`docs/design/handoff.md:46`).

Rejected alternatives:

- *Raw HTML artifacts in an iframe*: let the agent return a page and show it. Rejected because the agent reads merchant names and memos written by strangers, which is a prompt-injection surface; rendering its HTML, even sandboxed, hands that surface a browser. A bad day then means a request out of your tailnet or a convincing fake screen.
- *Auto-apply*: let the agent change categories directly. Rejected because every error would be a silent change to the record that budgets read.
- *Through the MCP*: add proposal and insight tools to prd-03. Rejected because it would break the MCP's read-only guarantee and tie the agents to Claude desktop being open.

## Evidence

- **The decision exists.** D3: "the server calls the API only for background jobs such as categorising, rules first then Haiku" (`docs/decisions.md:9`); audit gap "Claude fixes categories, learns: partial" (`docs/audit-2026-10-23.md:103`).
- **Akahu's taxonomy is already in the repo.** `data/cats.js:1-12` (group `Appearance` and its categories) and `data/rawCategories.js:1-12` (ids, names and the `personal_finance` group); the server serves only 8 hardcoded categories (`docs/audit-2026-10-23.md:36`).
- **Category columns exist for Akahu's value.** `server/db/migrations/20250611031435_transactions.js:22-25`; prd-01 ruling 4 separates Akahu's value from the effective one and adds `category_corrections`.
- **The only edit path overwrites in place.** `server/db/transactions.ts:27-29`; the contract is being reconciled in issue #9.
- **The Patterns card and report are specified but have no engine.** Handoff Habits section "Patterns" and "Weekly truth report" (`docs/design/handoff.md:46-47`) and the report rules (`:52`).
- **The attack surface is real.** Free-text fields from merchants and banks: `description`, `particulars`, `reference`, `merchant_name` (`20250611031435_transactions.js:15,28-30,40`).
- **A chart library is on hand, but may be pruned.** `package.json` lists `recharts` and `chart.js`; audit health issue 6 and issue #4 flag them unused.
- **No agent, scheduler or API client exists.** `server/index.ts:5-8` only listens; no `@anthropic-ai/*` dependency in `package.json:27-52`.

## In scope

- `category_proposals`, `insights`, and an `agent_runs` usage log (tokens, model, cost, outcome).
- Category agent: rules from past corrections first, then Haiku for the rest; proposals only from Akahu's taxonomy.
- Insights agent: patterns and charts from fixed, typed aggregate queries.
- Routes: list, accept, reject proposals; list, dismiss insights; run now.
- A renderer for markdown and an allow-listed chart spec in a sandboxed container.
- Schedules: after each sync (new or changed rows), weekly for insights, and on demand.
- A kill switch, a daily token budget, and a cost report from logged usage.

## Out of scope

| Item | Goes instead to |
|---|---|
| Auto-accepting high-confidence proposals | Open question below; default no |
| Weekly truth report as an advisor deliverable and its delivery | Later PRD (prd-03 open question; insights are its input) |
| Weekly insights by email | Open question below (D5) |
| In-app Advisor chat | prd-03 open question |
| Any write to budgets, bills, goals or settings by an agent | A future write-tools PRD |
| Need/want tagging, subscription detection | Later PRD |
| Reaching the data through the MCP | Never; prd-03 stays read-only |
| Xero data in insights | M4 PRD |
| A full Transactions page | Open question below; not in the handoff |

## Done when

1. After a sync with new transactions, the app shows a "N category suggestions" pill with accept and reject on each; accepting one changes the category, and it survives the next sync. *Not met while* the category reverts after a sync, the accepted row lacks `category_source` of `claude` or `rule`, or no `category_corrections` row was appended.
2. Agents cannot change money state. *Not met while* any module under `server/agents/` imports or calls a function that writes `transactions`, budgets, bills, goals or settings other than the accept route, or the accept route writes anything beyond the category, its source and a corrections row.
3. A rejected proposal is never proposed again for that transaction and proposed category, and is passed back as an example. *Not met while* the same pair reappears, or the rejection is not in the next prompt's examples.
4. The model sees only allow-listed fields. *Not met while* a recorded request body contains an account id, token, card suffix, `reference`, `particulars`, `code` or any field not in Ruling 4.
5. Hostile content is inert. *Not met while* a chart spec with a URL, an unknown mark type or an inline script is accepted, or the renderer makes a network request, evaluates content, or the page lacks a restrictive CSP.
6. The brakes work. *Not met while* setting the kill-switch variable still lets an API call go out, or a run keeps calling past the daily token budget.
7. The Habits Patterns card shows at least one agent-generated pattern with a rendered chart. *Not met while* the card is empty, or the chart's numbers differ from a hand query of the same rows.
8. A proposal is always a valid Akahu category. *Not met while* a stored proposal names a category not in the `data/cats.js` taxonomy.

Items 1–6 and 8 are tests (the code does what is written). **Two criteria that decide whether it was right, and only you can judge them:**

- **Quality:** you review a real batch of 10 proposals and agree with at least 8. *Not met while* you reject 3 or more.
- **Cost:** a month of runs costs under NZ$5 at Haiku prices, measured from `agent_runs` usage, not estimated. *Not met while* logged usage extrapolates above it.

**Only the quality check matters most:** a suggestion engine that is cheap and safe but wrong is something you stop opening.

## Rulings

## Ruling 1 — Agents run on the server and call the Claude API; they never touch the MCP
The category agent uses rules first, then `claude-haiku-5-5`; the insights agent uses `claude-sonnet-5-5`. The API key is a Fly secret, readable only by the agent code path and not present in the MCP's environment (prd-03 ruling 2). This is D3's "API only for background jobs" and leaves prd-03's read-only guarantee untouched. Why: the MCP runs only when Claude desktop is open and must not gain a second job.

## Ruling 2 — Agents write only to inboxes, never to money state
Agents write `category_proposals` (transaction id, current, proposed, confidence, reason, origin `rule | claude`, status `pending | accepted | rejected`, created_at), `insights` (id, kind `pattern | report | chart`, title, body_md, chart_spec_json, scope, period, created_at, dismissed_at) and the `agent_runs` usage log, and nothing else. Accepting a proposal in the UI sets `transactions.category` and `category_source` (`claude`, or `rule` for a rule-origin proposal), and appends to `category_corrections`; that route is the one writer. Rejections are kept and fed back as few-shot examples. Why: an inbox cannot corrupt a budget; an error costs you one tap. `agent_runs` is a log and holds no money state.

## Ruling 3 — Insight artifacts are data, not HTML
The agent returns markdown plus a constrained chart spec in Vega-Lite JSON (allow-listed mark types, data inlined from the agent's own aggregate results, no URLs), and optionally a Mermaid diagram as text. The app renders them with its own renderer in a sandboxed container under a restrictive CSP, with no scripts from the content and no `eval`. The schema lives in `models/insights.ts` and is validated on write and on render. Why: *raw HTML artifacts in an iframe* are rejected (see above); a spec can be checked, an HTML page cannot. Extends to: any new chart type is an amendment to the allow-list.

## Ruling 4 — The model sees only allow-listed fields
The category agent receives date, amount, merchant, description, current category, and your past corrections for similar merchants. The insights agent receives aggregates produced by fixed, typed query functions, not SQL written by the model. Never account ids, account numbers, tokens, card suffixes or reference fields. Batch size, the daily token budget and the model ids are config; a kill-switch environment variable stops all agent API calls. Why: the account ids and tokens add risk and no accuracy; the cap and switch bound both cost and the damage of a prompt-injection or a runaway loop.

## Ruling 5 — Schedules are polling, not hooks into prd-01
Category proposals run after each sync completes, for new or changed rows (the agent polls `sync_runs` for new completed runs, so `server/sync/**` is never edited). Insights run weekly and on demand. Backlog history is processed gradually under the daily budget, never in one burst. Why: it keeps the fences clean and the cost flat.

## Ruling 6 — Proposals must be real Akahu categories
A proposal is validated against the taxonomy in `data/cats.js` / `data/rawCategories.js` and discarded if it is not in it. Why: a free-text category would silently break every budget that matches on category.

## Sequencing

Waves are **layers**: issues in a wave are fenced apart and built in parallel; one PR per wave.

**Wave 0 — operator acts (not dispatchable):**
- Create an Anthropic API key with a monthly spend limit set in the console, and add it as a Fly secret.
- Confirm the two model ids (`claude-haiku-5-5`, `claude-sonnet-5-5`) are available to your key.
- Pick the 10 real transactions' worth of review time for the quality check.

**Wave 1 — the keystone (contracts, additive):**
- `prd04 w1: proposals, insights and the agent usage log exist as tables` — migrations, schema-reviewed; creates `server/agents/db/**`.
- `prd04 w1: proposals, insights and the chart spec have validated types` — creates `models/insights.ts`, `server/agents/contracts.ts`, the allow-list of fields and the taxonomy validator.
- `prd04 w1: the Claude API client has a kill switch, a daily budget and usage logging` — creates `server/agents/llm/**`; the one dependency-adding issue (the API SDK).

**Wave 2 — behaviour (parallel):**
- `prd04 w2: the category agent proposes better categories from rules first, then Haiku`
- `prd04 w2: the insights agent writes patterns and chart specs from fixed aggregate queries`
- `prd04 w2: proposals and insights have list, accept, reject and dismiss routes` — the accept route is the only writer of categories.
- `prd04 w2: insights render as markdown and sandboxed charts` — creates `client/components/Insights/**`; spec and Mermaid renderers; may add one dependency in place of the API SDK issue only if the chart library is chosen first (otherwise a separate wave).

**Wave 3 — schedules and the visible slice (parallel):**
- `prd04 w3: proposals are generated after each completed sync, insights weekly and on demand` — creates `server/agents/scheduler.ts`.
- `prd04 w3: the Overview shows a suggestions pill with accept and reject` — modifies prd-02's recent-activity component (declared widening, recorded on the PR before the change).
- `prd04 w3: the Habits Patterns card shows agent insights with charts` — modifies prd-02's Habits component (same).

**Wave 4 — acceptance:**
- `prd04 w4: ten real proposals were reviewed and a month's cost was measured` — operator-run.

Unfiled work implied, described not numbered: auto-accept above a threshold if ever ruled; weekly truth report built on insights; email delivery.

## Open questions that block this

- Where does the suggestions pill live? Hannah asked for it on "the Transactions page", but the handoff has no Transactions screen and prd-02 retires the old one. This PRD plans for the Overview's recent-activity card; a Transactions screen would be a separate PRD. Open, not ruled.
- Does the Anthropic API key exist, and is an API budget acceptable alongside the subscription? Open, not ruled.

**Not blocking, deliberately open:**
- Whether insights are also emailed weekly (D5) or only shown in-app. Open, not ruled.
- Whether the proposal agent may auto-accept above a confidence threshold. Default no. Open, not ruled.
- Whether Mermaid diagrams ship in the first renderer pass or after the Vega-Lite subset.

## The one risk worth watching

The agent's reach creeping: one write "just for the obvious cases", a field added to what the model sees, a rendering path that trusts a string. Each is small, and together they remove the reason for the inbox. Keep the writer list (Ruling 2) and the field list (Ruling 4) as contracts changed only by amending this PRD. The second risk is cost drift from an unbounded backlog sweep, which is why the budget is enforced in code.
