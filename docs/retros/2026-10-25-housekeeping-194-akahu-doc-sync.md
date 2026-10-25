# Retro: #194 housekeeping, akahu-pending-semantics section 6 said what the code no longer did

Gear 1 as stamped; no shift. Docs only. Housekeeping milestone, `Spawned-by: #155`, `Missed-by: plan`. The conductor read the code and briefed the implementer (haiku, effort high) with checked facts. Fence was `docs/akahu-pending-semantics.md` and `docs/retros/`; nothing outside it was touched. No telemetry is stated here; the lane posts the four narratives after `baseline finish`.

Verify passed on the final state, HEAD 0ed0090: `npx tsc --noEmit`, `npm run lint` clean, `npx vitest run` 58 files / 1563 tests passed. Commits: 6bef23a (the three spots), 0ed0090 (review fixes). Seats: implementer, reviewer, docs-syncer, this retro.

## What was built

A doc edit, no code. Three spots in section 6 of `docs/akahu-pending-semantics.md` (31 insertions, 7 deletions):

- The `attributes` row: an open set; the Get accounts page lists `TRANSACTIONS`, `PAYMENT_TO`, `PAYMENT_FROM`; the test fixtures also carry `TRANSFER_FROM` and `TRANSFER_TO`, which the page omits. Stored in the order sent; none sent is `[]`.
- The paragraph after the table: sync reads `_authorisation`, `attributes`, `connection.connection_type`, `connection.logo` and `_credentials` as optional on purpose (#155). The reverse holds for `balance` (read as required) and `balance.currency` (read as optional).
- The "Finding, not fixed here" paragraph: drift is in `models/akahu.ts` only; sync uses `server/sync/types.ts`. `posted_date` and `merchant.nzbn` are read by the client and get columns in #191. Conversion amounts are hundredths, and #192 tracks minor units.

## What happened

- The conductor read the code and gave the implementer a brief of facts. The implementer wrote the three spots and the gate went green on the first run (6bef23a).
- The implementer's `attributes` list came from a WebFetch summary of Akahu's page, not the page text. The reviewer re-fetched the raw page with curl and grepped the enum. The summary happened to be right.
- The reviewer found one false sentence: "a value of the wrong type fails the whole listing". It is false for JSON numbers. `shared/exact-json.ts` `parseExactJson` turns every number into its text, so `_authorisation: 5` is kept as "5". Only booleans, objects and arrays are refused. The behaviour is pinned by the test `keeps a bare number in the attributes as its text` (`server/sync/__tests__/akahu-client.test.ts:1252`).
- The reviewer also flagged an ambiguous "Its types" (which file's types?). Both fixed in 0ed0090: the numbers sentence was corrected and the sync types are now named (`server/sync/types.ts`).
- docs-syncer: nothing else is stale, no edits.

## What went wrong

1. **A false claim reached the doc and was caught only in review.** The doc said a wrong-typed value fails the listing; a number does not. Cost: one review round and one fix commit (0ed0090). Nothing reached main.
2. **A fetch summary was used as the check for a list of enum values.** It was right this time. Nothing in the record shows it was verified before the reviewer did it.

## Root causes

- **Brief traced one function, not the path (item 1).** The conductor's brief said "non-text throws", read from `optionalText` alone. The parse step upstream (`parseExactJson`) changes the input before `optionalText` sees it, and the brief did not follow it. The implementer copied the brief, which is what a brief is for. The error is in what was checked, not in who wrote the sentence.
- **A summary is not a check (item 2).** A WebFetch summary is a model's paraphrase of the page. Exact value lists need the raw bytes and a grep. Unclear whether the implementer was told the list was unverified; the record does not say.

## What worked, keep it

- **A conductor-read brief of checked facts for a haiku implementer.** Every other claim in the three spots survived review. The gate was green first time and the implementer did not have to find the facts itself.
- **A reviewer who re-fetched the source and ran the claim against the code.** It grepped the raw page, and it followed the parse step far enough to find the number case. The false sentence was then pinned by an existing test, not by opinion.
- **Staying in the fence.** The `balance` mismatch was reported in the doc as what sync does, and not fixed.

## Surfaced, not absorbed

- Sync reads `balance` as required, though Akahu's docs say optional. That is code and belongs to another lane. The doc now says what the code does.
- Numbers are accepted in id and text fields. That is pinned, intended behaviour; no change recommended.
- No prd-01 Ruling 4 implementation note, since the issue made it Hannah's call and she did not ask for it.
- No follow-up issues filed.

## Recommended changes

1. **A brief's claim about how code handles input is traced from the wire to the function, not read from the function alone.** For a doc about parsing, that means opening the parser the value passes through first. First occurrence, so by the house rule do not encode it yet; if it recurs, add one line to the conductor's brief checklist. Artifact: the conductor's issue-briefing checklist (the `parallel-agents` skill's handoff section).
2. **A doc claim about a third-party page is checked by `curl` and `grep` on the raw page, not a fetch summary.** First occurrence; same rule. Artifact: the implementer and reviewer prompts (`~/.claude/agents/implementer.md`, `~/.claude/agents/reviewer.md`), if it recurs.

## Highest-leverage next step

If either recurs, add to the conductor's briefing checklist: for any sentence about how code treats a value, name the parse step the value passes through and cite its file and line. For now, nothing to change; this is one false sentence, caught by the seat built to catch it.

## Open items for the PR body

- Docs only, one file. Gate green on 0ed0090: 58 files, 1563 tests.
- The review fix (0ed0090) is a separate commit from the build (6bef23a).
- `balance` read as required is surfaced, not changed.
- Fixture values are invented; no real account data appears.

## For Baseline (four fields)

- **narrative_code_type:** a documentation edit to section 6 of `docs/akahu-pending-semantics.md`; no code changed.
- **narrative_built:** three spots in section 6 now say what the sync code does after #155. The `attributes` row is an open set; the Get accounts page lists three values and the test fixtures carry two more. The paragraph after the table says sync reads `_authorisation`, `attributes`, `connection.connection_type`, `connection.logo` and `_credentials` as optional, with the reverse for `balance` (required) and `balance.currency` (optional). The "Finding" paragraph says the drift is in `models/akahu.ts` only, that sync uses `server/sync/types.ts`, that `posted_date` and `merchant.nzbn` wait on #191, and that conversion amounts are in hundredths (#192). The gate is green: `tsc` and lint clean, 1563 tests passing.
- **narrative_how:** the conductor read the code and briefed a haiku implementer with checked facts. The implementer rewrote the three spots (6bef23a). The reviewer re-fetched Akahu's page with curl and grepped the raw enum, and ran the doc's claims against the code. One claim was wrong; it and an ambiguous phrase were fixed in a separate commit (0ed0090). docs-syncer found nothing else stale. The `balance` mismatch was surfaced, not absorbed, and no follow-up issues were filed.
- **narrative_wrong:** the doc said a value of the wrong type fails the whole listing, but a JSON number is kept as its text, because `parseExactJson` turns numbers into text before `optionalText` runs; only booleans, objects and arrays are refused. The conductor's brief said "non-text throws" from reading `optionalText` alone and did not follow the parse step, and the implementer copied it. The reviewer caught it, at the cost of one review round. The implementer's `attributes` list also came from a WebFetch summary and not the raw page; the summary happened to be right, but only the reviewer's curl and grep checked it.
