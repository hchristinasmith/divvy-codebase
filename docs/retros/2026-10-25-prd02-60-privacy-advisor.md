# Retro: #60 prd02, the Privacy screen says only what is true, and the Advisor points to Claude desktop

Gear 3 as stamped; no shift. The issue said `model: sonnet`; the CLAUDE.md table maps gear 3 to opus, and the build implementer ran on opus. One test file outside the declared fence was edited and declared (below). `docs/retros/` is in this lane's fence. This file states no telemetry (model, duration, tokens, tool calls); the lane posts the four narratives after `baseline finish`.

Seats run, in order: researcher, architect, implementer (opus, build, one commit), reviewer (four findings, fixed in one commit), brand-checker, implementer (haiku, brand and tense fixes, one commit), test-guard, docs-syncer (no doc falsified), this retro. Every seat the gear 3 table lists ran, plus brand-checker because the diff is UI. Verify passed on the final state: tsc exit 0, lint exit 0, vitest 94 files / 3156 tests.

Commits (`git log --oneline origin/main..HEAD`): 92b9907 (build), 80b97e4 (review fixes), 6094ac1 (brand and tense fixes). The diff is 16 files, +1163 / -13, most of it tests (six new test files plus the Advisor test).

## What was built

- **Kind of code:** two client screens. Privacy (`client/screens/Privacy/`: a hero, then banks, server, storage, advisor and claim cards, plus `serverStatus.ts`, a small reader for the sync status) and Advisor (`client/screens/Advisor/index.tsx`, now a pointer to Claude desktop instead of a chat box).
- **Pattern:** every sentence on the screen is backed by something in the repo, and each card carries a `Basis:` comment naming it. Anything that is configured but not running, or planned but not built, reads as planned ("will be"). The only live fact on the screen is the sync status from the server's existing route. Source-reading tests (`screenSourceGuards.test.ts`, `noThirdParty.test.tsx`) pin that the screen names no third-party AI and no outbound host it cannot back.
- **Why this shape:** the design handoff's Privacy copy could not be shipped as drawn (see below). The alternative was to build the screen as designed and fix the copy later; the PRD rulings and the handoff's own precedence rule (the PRD wins) made that the wrong order.

## What happened

- **The researcher found the design's Privacy copy false in eight places before any code:** a local model, a nightly job, "encrypted", the home-box host, an uptime figure, a last-backup time, the outbound-calls claim, and "runs on your server". It also found that Fly and Litestream exist only as merged config, not as a running deployment, and that the MCP tools are stubs. The 90-day re-consent claim has only a passing basis (prd-01), so it is hedged and flagged rather than stated.
- **The architect planned; the conductor cut one item from the plan.** The plan proposed a source test that counts `Basis:` comments per `<p>`. The conductor dropped it as brittle: it checks that a comment exists, not that the sentence is true.
- **Plan errors the implementer caught.** The plan cited prd-03 Ruling 5 for "read but cannot change"; the correct basis is Ruling 1. The plan's hero basis, "the only outbound host is Akahu", was stale: a Xero client exists, though nothing calls it.
- **Implementer tests.** Six new test files. About 27 hand-run mutations; three tests survived at first and were fixed before the build commit, so the survivors never reached review.
- **Review (reviewer): four findings, all fixed in 80b97e4.**
  1. "that connection" on the Advisor screen had no antecedent.
  2. "the server's settings" was ambiguous with the Settings screen and the settings table.
  3. and 4. Two forbidden-word tests were vacuous: they passed with nothing rendered. They now assert the cards rendered first, so they fail on an empty screen.
  The reviewer also flagged that the Advisor said "The advisor is Claude" in the present tense while MCP is not live. That went to 6094ac1 as "will be" in both places.
- **brand-checker: one must-fix.** The hero body text, `text-blush` on `bg-pink-hover`, measured 2.69:1. It was changed to white at 3.6:1, which is still under AA for 15px body text. The design assigns that pink to the hero, so the choice is Hannah's: `bg-rose` measures 6.17:1 and was offered. The inline Privacy link is now underlined, because by colour alone it differs from the text at 1.26:1.
- **test-guard:** gate green, 95 mutations, 93 killed, 2 survived. Both survivors are equivalent mutations (same behaviour), so no test was added.
- **Screenshots.** Taken with a cached `playwright-core` against a scratch stub API with invented data. Port 3005 was already taken, so the stub ran elsewhere.
- **One declared widening outside the fence.** `client/screens/__tests__/routes.test.tsx` took a change to its stub-loop filter, because Privacy and Advisor are no longer stubs (9 lines changed). Same precedent as #45.

## What went wrong

1. **The "planned versus live" rule was applied to Privacy and not carried to the Advisor screen (Missed-by: do, caught by review).** The brief said anything not yet built must read as planned. The first copy pass did that on Privacy and then wrote the Advisor as "The advisor is Claude" while MCP is stubs. Review caught it. Cost: the tense fix landed in 6094ac1, a third commit that would not have been needed.
2. **Two vacuous tests (Missed-by: do, caught by review).** The forbidden-word tests asserted that a word was absent from a screen that, under a render failure, would be empty. They passed with nothing rendered, so they could not fail for the thing they exist to catch. Cost: one test edit each, small. The implementer's own mutation pass found three other survivors but not these two.
3. **Two stale or wrong plan citations (Missed-by: plan, caught by the implementer).** Ruling 5 instead of Ruling 1, and the "only outbound host is Akahu" basis. Neither shipped. Cost: nothing in the diff; the risk was a `Basis:` comment pointing at the wrong ruling on a screen whose entire point is that its claims are backed.
4. **Ambiguous words in new copy (Missed-by: do, caught by review).** "that connection" with no antecedent, "the server's settings" colliding with the Settings screen. Cost: two copy edits.
5. **A contrast failure in the design's own pairing (Missed-by: plan, caught by brand-checker; the plan carried the design pairing unchecked).** Blush text on the hover pink is 2.69:1. The fix to white (3.6:1) is partial. It is still below AA at 15px, and the real fix is a colour choice only Hannah can make. Left open on purpose.
6. **Environment: port 3005 was taken.** The screenshots needed a different port for the stub API. Cost: minutes.
7. **Four things found outside the fence (surfaced, below), none fixable in this lane.**

## Root causes

- **A rule stated for one screen is not a rule for the diff (item 1).** The brief's sentence "planned things must read as planned" was in the Privacy section of the plan. Nothing listed it against the Advisor screen, which is in the same issue and has the same unbuilt dependency (MCP). The implementer applied it where the plan put it. New name: **claim rule scoped to one screen**. First occurrence in the record I read; I did not re-read every earlier retro.
- **Tests that cannot fail (item 2).** Same family as #45 item 3, #46 item 4 and #39 item 2, here in the negative form: an absence assertion is true of an empty render. The implementer's mutations flip the code under test; they do not blank the render. Only a seat that checks "does this test fail when the screen is empty" finds it, and that was the reviewer.
- **The design handoff describes the finished product (the eight falsehoods, items 3 and 5).** Its copy and its colour pairings are drawn for the end state, and the handoff says the PRD wins on contradictions without saying the same of what is built. The researcher caught the copy because the brief asked it to check each claim against the repo. The plan's citation errors came after that pass: citations were typed from memory of the rulings, and the implementer re-read them.
- **Item 4:** the cause is not visible in the record. The fix is clear (the words are replaced); why the first pass used them is not stated anywhere I can point to.

## What worked, keep it

- **The researcher checked each design claim against the repo before any code.** Eight falsehoods became a list in a plan instead of eight corrections after review, and the screen was never built wrong first.
- **The conductor cut the `Basis:`-comment-count test.** A test that checks a comment exists says nothing about whether the sentence is true. Keeping a cheap, brittle check out kept the suite honest.
- **The implementer re-read the rulings against the plan.** It caught Ruling 5 versus Ruling 1 and the stale Akahu-only basis, both on a screen about being correct.
- **Mutation testing before review and after.** The implementer's 27 mutations removed three survivors early; test-guard's 95 mutations (93 killed, 2 equivalent) are the strongest evidence the suite checks something.
- **Review on committed work, fixes as their own commits.** Three commits, each with one purpose: build, review response, brand and tense response.
- **Haiku for the mechanical fixes.** The brand and tense commit is small and exactly specified; the gear table's haiku-for-fixes choice cost nothing here.
- **Declared widening, follow-ups surfaced and not absorbed.** The routes.test.tsx edit is named; the items below were not folded in.

## Surfaced, not absorbed

- **Sync-status reader is now copy 3.** `useSyncPill`, `apiClient` `grabSyncStatus` and `serverStatus.ts` each read the same route. The fence blocks lifting them into one; file as housekeeping.
- **Cross-screen import:** Privacy imports Overview's `styles.ts`. Should live in a shared place; housekeeping.
- **`ShellSidebar` footer "Running on your server."** is unbacked by anything in the repo, and the file is outside the fence. Same class of claim as the eight above.
- **Claude desktop URL** `https://claude.ai/download` is unverified by any repo doc. It is in the Advisor screen; someone should confirm it.
- **Two `/sync/status` GETs on Privacy** (the shell pill and `serverStatus.ts`) are by design here, not a bug.
- **Pending, not done:** Hannah's choice on the hero contrast (`bg-rose` at 6.17:1 versus the current white on pink at 3.6:1), and her visual check at 1040 and 390 wide.
- Follow-ups, when filed, carry `Spawned-by: #60`. `Missed-by` for the sync-status copy: `plan` (the fence did not list the two other readers). For the `ShellSidebar` footer: `none` (outside this issue's reach). For the other two: `plan` for the cross-screen import, `none` for the URL.

## Recommended changes

1. **Design handoff: add a header rule that copy and colour pairings describe the finished product, so every capability sentence is planned until a repo file proves it, and every text/background pair gets a contrast check before use.** Why: the eight falsehoods and the 2.69:1 pair share one cause, and the handoff is where the next lane starts. Artifact: `docs/design/handoff.md`. High leverage; cheap.
2. **Architect plan template: when a claim-bearing rule (planned versus live, no third party, read-only) is set, list it against every screen or file in the fence, not only the one that prompted it.** Do not encode yet; one occurrence (item 1). If a second lane scopes a rule to one screen, add the line to `~/.claude/agents/architect.md`.
3. **Implementer and test-guard: for an absence assertion ("does not contain X"), the mutation to run is "render nothing", and the test must assert the thing is rendered first.** The family is now at least four retros old, so this is the one to encode: `~/.claude/agents/implementer.md` and `~/.claude/agents/test-guard.md`. Medium to high leverage. I did not re-read every earlier retro to confirm the count, so check the earlier retros before wording it.
4. **Plan citations: the architect writes the ruling text beside each number it cites.** Do not encode; one occurrence, no cost this time because the implementer caught it.
5. **File the three housekeeping follow-ups above**, not in a PRD milestone: none passes the phase test.

## Highest-leverage next step

Add the finished-product caveat and the contrast check to the top of `docs/design/handoff.md` (recommendation 1). It addresses the cause behind the eight copy falsehoods and the one contrast failure, it costs a few lines, and every UI lane reads that file first. Recommendation 3 is second and needs the wording checked against earlier retros before it goes into an agent file.

## Open items for the PR body

- Gear 3, no shift. One declared out-of-fence test edit: `client/screens/__tests__/routes.test.tsx` (stub-loop filter).
- Design copy that could not ship as drawn (eight places); the 90-day re-consent line is hedged and flagged on a passing basis.
- Hero contrast: white on the pink at 3.6:1, still below AA at 15px. `bg-rose` (6.17:1) is the AA option and needs Hannah's call.
- The Advisor reads "will be" for the connection until MCP is live; the Claude desktop URL is unverified.
- Surfaced follow-ups: sync-status reader copy 3, Overview `styles.ts` import, `ShellSidebar` footer claim.
- Gate: tsc 0, lint 0, vitest 94 files / 3156 tests. test-guard: 95 mutations, 93 killed, 2 equivalent survivors. docs-syncer: no doc falsified.
- Not yet done: Hannah's visual check at 1040/390 and her contrast choice.
