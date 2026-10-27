# Retro: #55 prd04 w2, insights render as markdown and sandboxed charts (renderer components, SVG charts, sandbox helper, tests)

Gear 3 as stamped; no shift. The implementer ran on opus. The architect was skipped (keep-lanes-small), so the plan went straight into the implementer handoff. This file states no telemetry (model, duration, tokens, tool calls); the lane posts the four narratives to Baseline after `baseline finish`.

Seats run: implementer (build), then brand-checker, security-auditor, test-guard and reviewer in parallel on the uncommitted diff, this retro. Verify passed on the final state: 101 Insights tests, full suite 6345 green (per the dispatch). I did not re-run it for this retro.

Commit: 0a75d81 (build and review fixes together, 7 files, +1814).

## What was built

- **Kind of code:** React components in `client/components/Insights/`: `InsightBody` (markdown), `ChartView` (charts), `InsightCard`, a `sandbox.ts` helper, and three test files. No server change, no migration, no new dependency.
- **Pattern:** markdown is hand-parsed into React text nodes, so no HTML string is ever built from insight text. Charts are hand-written SVG React elements, serialised with `renderToStaticMarkup` into `<iframe sandbox="" srcdoc>` with a meta CSP of `default-src 'none'; style-src 'unsafe-inline'`.
- **Why this shape:** the conductor chose hand-written SVG because recharts was removed in M1 #4 and vega would be a new dependency. Serialising into a sandboxed iframe reconciled the issue's "sandbox + CSP" Done-when with "draw as React elements".

## What happened

- **Implementer:** 7 files, gate green, 14 self-mutations.
- **Brand-checker:** clean. Two small notes: a local LINK constant lacking FOCUS, and the chip radius.
- **Security-auditor:** no Critical. W1: credentialed URLs such as `https://bnz.co.nz@evil/` passed `safeHref`. W2: U+061C (Arabic letter mark) was missing from the bidi strip. W3: a comment overstated what the iframe `csp` attribute does.
- **Test-guard:** 30 mutations. One gap: chart axis and legend labels were never tested against hostile text. A `dangerouslySetInnerHTML` tspan kept 93 tests green.
- **Reviewer:** found three more. The arc legend clipped the amount rather than the name, so it showed a different number. U+061C (same as W2). The sandbox test compared the attribute to its own exported constant, so `allow-popups` passed.
- All of the above were fixed in the reviewer pass.

## What went wrong

1. **The sandbox test could not fail (Missed-by: do).** It compared the iframe attribute to the exported constant, so loosening the constant (`allow-popups`) changed both sides and stayed green. The one test guarding the main security boundary guarded nothing. Cost: found only by the reviewer.
2. **The implementer's mutation list missed label escaping and the arc clip (Missed-by: do).** 14 self-mutations did not touch axis and legend text, the one place hostile insight text reaches SVG. Test-guard's `dangerouslySetInnerHTML` tspan stayed green across 93 tests.
3. **The arc legend clipped the wrong end (Missed-by: do).** It cut the amount and kept the name, so the legend could show a different number from the real one. On a money screen that is a wrong figure, not a cosmetic fault.
4. **Credentialed URLs passed `safeHref` (Missed-by: do).** `https://bnz.co.nz@evil/` reads as a bank link and points elsewhere. In a link renderer for text a model wrote, that is a phishing shape.
5. **U+061C missing from the bidi strip (Missed-by: do).** Found independently by security-auditor and the reviewer.
6. **Review fixes landed in the build commit.** The build was uncommitted while four seats reviewed it in parallel on the working diff, so there was no earlier commit to separate the fixes from. This deviates from "review fixes separate": the second reader of 0a75d81 cannot see the response to review.
7. **Not verified in a real browser:** sandbox and CSP enforcement, and unicode-bidi on SVG text. jsdom checks the attributes and strings, not what a browser does with them.

## Root causes

- **Tests asserted against the code's own constants (items 1, 2).** A test that imports the value under test passes whatever the value is. The record shows the implementer's mutations were chosen from the paths it had thought about; hostile text in labels was not one of them. Two seats (test-guard, reviewer) found these by mutating, not by reading.
- **Allow-list written from memory (items 4, 5).** `safeHref` and the bidi strip were written from the implementer's own list of dangerous cases. Two independent seats each found a missing entry. The deeper cause is not shown in the record beyond that.
- **Legend clip (item 3):** unclear; the record does not show why the clip direction was chosen.
- **Parallel review on an uncommitted diff (item 6):** a sequencing choice, deliberate for speed. It is the cause of the commit shape, not a mistake in itself.

## What worked, keep it

- **Four review seats in parallel.** Each found something the others did not: security-auditor the URL and bidi cases, test-guard the label gap, the reviewer the legend clip and the weak sandbox test. Only U+061C overlapped.
- **The conductor's choice of hand-written SVG in a sandboxed iframe.** No dependency, no HTML built from insight text, and the sandbox and CSP Done-when was met as written.
- **Mutation as the review method.** Test-guard's 30 mutations found the label gap that 93 green tests hid.
- **Surfacing the app-wide CSP gap as #443** instead of absorbing it.

## Surfaced, not absorbed

- **#443** (Housekeeping, Spawned-by #55): app-wide CSP and nosniff headers.
- Wiring `InsightCard` into a screen is existing #63.
- Brand notes (local LINK without FOCUS, chip radius): noted, not acted on.

## Recommended changes

1. **A test that checks a security attribute must assert the literal, not the exported constant.** First occurrence in this form, so write it down but do not encode yet. If it recurs, add the rule to `docs/testing.md` assertion rules.
2. **Run a mutation on every place untrusted text reaches output (labels, legends, links) before review.** Also first occurrence; hold. On a second renderer lane, add it to the implementer handoff template.
3. **Review fixes in the build commit** is a one-off: the build was uncommitted while reviewed. If it recurs, commit the build before dispatching the seats.
4. **Check sandbox and CSP behaviour in a real browser** before the first screen mounts `InsightCard` (#63). This is a manual check, not a doc change.

## Highest-leverage next step

Add to `docs/testing.md` assertion rules: "Assert security-relevant values as literals; a test that compares to the exported constant cannot fail when the constant is loosened." It is the cheapest of the four and the failure was on the main security boundary. Under the first-occurrence rule, hold it until a second occurrence; if #63 or another renderer lane hits it again, write it then.

## Open items for the PR body

- Gear 3 as stamped; no shift. Architect skipped by choice.
- Review: security-auditor no Critical, W1 to W3 fixed; test-guard label gap fixed; reviewer's 3 findings fixed. Fixes are in the build commit.
- Not verified in a real browser: sandbox/CSP enforcement, unicode-bidi on SVG text.
- Follow-up #443 (Housekeeping, Spawned-by #55). InsightCard wiring is #63.
- Gate: 101 Insights tests, full suite 6345 green.

## Baseline narratives

### narrative_code_type

React components in `client/components/Insights/`: a markdown renderer, an SVG chart renderer that serialises into a sandboxed iframe, a card, a sandbox helper and three test files. No server change, no migration, no new dependency; gear 3.

### narrative_built

Insights render as markdown hand-parsed into React text nodes, and charts as hand-written SVG serialised with `renderToStaticMarkup` into `<iframe sandbox="" srcdoc>` with a meta CSP of `default-src 'none'; style-src 'unsafe-inline'`. An invalid spec shows "Chart unavailable". 7 files, +1814; 101 Insights tests and 6345 in the full suite at the end.

### narrative_how

The conductor chose hand-written SVG over vega or a new dependency, and the architect was skipped, so the plan went into the implementer handoff. The implementer on opus built it with 14 self-mutations and a green gate. Brand-checker, security-auditor, test-guard (30 mutations) and the reviewer then ran in parallel on the uncommitted diff and found the issues below, all fixed in the reviewer pass. Fixes are in the build commit because the build was uncommitted while reviewed.

### narrative_wrong

The sandbox test compared the iframe attribute to its own constant, so `allow-popups` passed. The implementer's mutations missed label escaping (a `dangerouslySetInnerHTML` tspan kept 93 tests green) and the arc legend clipped the amount instead of the name, showing a different number. `safeHref` let `https://bnz.co.nz@evil/` through, and U+061C was missing from the bidi strip. Not verified in a real browser: sandbox and CSP enforcement, and unicode-bidi on SVG text. Follow-up #443 filed for app-wide CSP and nosniff.
