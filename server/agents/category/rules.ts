// The category agent's rule learner (prd-04 Rulings 6 and 7; #42). Pure: no
// database, no clock, no network. ./read.ts turns rows into the facts below,
// and ./agent.ts applies the rules.
//
// Ruling 7: when Hannah has moved the same merchant (or normalised
// description) to the same category at least N times, with no later
// correction away from it, that category is proposed for the merchant's
// uncorrected rows. Read here as:
//
// - Evidence is Hannah's own corrections only. The reader passes
//   `source = 'user'` rows alone, so a proposal she accepted (a `rule`
//   correction, #280) never reinforces the rule that made it.
// - A merchant is a (scope, key) pair. Personal and Strawb categorise the
//   same merchant separately (prd-01 Ruling 9), so their evidence never pools.
// - Her latest word is the merchant's category: the `to` of its last move.
//   Support is the number of distinct rows in the unbroken trailing run of
//   moves to that category; a move to any other category ends the run, so
//   A, A, B, A has support 1. A re-save to the same category
//   (`from === to`) is neither a move nor a move away and is dropped.
// - The category must be in data/cats.js (Ruling 6). It is checked after the
//   latest word is found, so A, A, then Drawings is no rule at all, not a
//   rule for A.
// - A rejection counts against the rule (Done-when 3, dated note): `net` is
//   support less the rejected proposals of that same category on that
//   merchant, and the rule stands only while `net >= N`. A rejection of
//   another category does not count. The rejected pair itself stays
//   suppressed whatever the rule does, by the inbox's unique index.
//
// The reason text carries the category and counts only. No merchant or
// description text reaches it, so an account number or an instruction in a
// merchant string has no way into the inbox.
import type { AccountScope } from '../../../models/sync.ts'
import { parseProposedCategory } from '../contracts.ts'

/** One user correction, reduced to what the learner reads. */
export interface CorrectionFact {
  // The correction's id: the tiebreak between moves at the same instant.
  id: number
  transactionId: number
  scope: AccountScope
  key: string
  from: string | null
  to: string
  // ISO UTC timestamp, as `corrected_at` stores it.
  at: string
}

/** One rejected proposal, reduced to what the learner reads. */
export interface RejectionFact {
  transactionId: number
  scope: AccountScope
  key: string
  category: string
}

export interface Rule {
  scope: AccountScope
  key: string
  // Always a name from data/cats.js.
  category: string
  // Distinct rows in the trailing run of moves to `category`.
  support: number
  // Rejected proposals of `category` on this merchant.
  rejections: number
  net: number
}

const groupKey = (scope: AccountScope, key: string) => `${scope}|${key}`

function byTime(a: CorrectionFact, b: CorrectionFact): number {
  if (a.at !== b.at) return a.at < b.at ? -1 : 1
  return a.id - b.id
}

/**
 * Every rule `corrections` support with `net >= threshold`, sorted by scope,
 * then key. `corrections` must be user corrections only (see the header).
 */
export function deriveRules(
  corrections: readonly CorrectionFact[],
  rejections: readonly RejectionFact[],
  threshold: number,
): Rule[] {
  if (!Number.isSafeInteger(threshold) || threshold < 1) {
    throw new Error('threshold must be a positive integer')
  }

  const groups = new Map<string, CorrectionFact[]>()
  for (const fact of corrections) {
    // Neutral: see the header.
    if (fact.from === fact.to) continue
    const k = groupKey(fact.scope, fact.key)
    groups.set(k, [...(groups.get(k) ?? []), fact])
  }

  const rules: Rule[] = []
  for (const moves of groups.values()) {
    const latestFirst = [...moves].sort(byTime).reverse()
    const [latest] = latestFirst
    const category = parseProposedCategory(latest.to)
    if (category === null) continue

    const rows = new Set<number>()
    for (const move of latestFirst) {
      if (move.to !== category) break
      rows.add(move.transactionId)
    }
    const against = rejections.filter(
      (r) => r.scope === latest.scope && r.key === latest.key && r.category === category,
    ).length
    const net = rows.size - against
    if (net < threshold) continue
    rules.push({
      scope: latest.scope,
      key: latest.key,
      category,
      support: rows.size,
      rejections: against,
      net,
    })
  }

  return rules.sort((a, b) => {
    if (a.scope !== b.scope) return a.scope < b.scope ? -1 : 1
    if (a.key !== b.key) return a.key < b.key ? -1 : 1
    return 0
  })
}

const times = (n: number) => (n === 1 ? 'once' : `${n} times`)

/**
 * A rule's confidence and reason. Confidence is `net / (net + 1)`: a rank
 * that grows with the evidence, not a probability. It is strictly between 0
 * and 1 and never an integer, so SQLite stores it as the `real` the inbox's
 * CHECK requires.
 */
export function proposalOf(rule: Rule): { confidence: number; reason: string } {
  const lines = [`You moved this merchant to ${rule.category} ${times(rule.support)}, with no move away since.`]
  if (rule.rejections === 1) lines.push('1 earlier suggestion was rejected.')
  if (rule.rejections > 1) lines.push(`${rule.rejections} earlier suggestions were rejected.`)
  return { confidence: rule.net / (rule.net + 1), reason: lines.join(' ') }
}
