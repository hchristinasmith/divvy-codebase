import { readFileSync } from 'node:fs'
import * as Path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { categories } from '../../../data/cats.js'
import { rawCategories } from '../../../data/rawCategories.js'
import {
  PROPOSAL_ORIGINS,
  PROPOSAL_STATUSES,
  parseProposedCategory,
  type AgentConfig,
  type CategoryProposal,
} from '../contracts.ts'

// Issue #26: the agents' contract (prd-04 Ruling 2, Ruling 6, Ruling 7;
// Done when 8). Every fixture is invented.

const agentsDir = Path.join(Path.dirname(fileURLToPath(import.meta.url)), '..')

describe('the file header', () => {
  it('documents every category_proposals column and cites Ruling 7', () => {
    const source = readFileSync(Path.join(agentsDir, 'contracts.ts'), 'utf8')
    const header = source.slice(0, source.search(/^import\s/m))
    expect(header.length).toBeGreaterThan(0)
    const columns = [
      'id',
      'transaction_id',
      'current_category',
      'proposed_category',
      'confidence',
      'reason',
      'origin',
      'status',
      'created_at',
    ]
    for (const word of [...columns, 'category_proposals', 'Ruling 2', 'Ruling 6', 'Ruling 7']) {
      expect(header).toContain(word)
    }
  })
})

const flattened: string[] = Object.values(categories).flat()
const known = new Set(flattened)

describe('parseProposedCategory accepts only the data/cats.js taxonomy', () => {
  it('accepts every category in data/cats.js', () => {
    expect(flattened.length).toBeGreaterThan(0)
    const refused = flattened.filter((name) => parseProposedCategory(name) !== name)
    expect(refused).toEqual([])
  })

  it('reads the same names as data/rawCategories.js, both ways', () => {
    const raw = new Set(rawCategories.map((entry) => entry.name))
    expect([...known].filter((name) => !raw.has(name))).toEqual([])
    expect([...raw].filter((name) => !known.has(name))).toEqual([])
  })

  it.each<[string, unknown]>([
    ['an empty string', ''],
    ['a space', ' '],
    ['free text', 'Example coffee and snacks'],
    ['__proto__', '__proto__'],
    ['constructor', 'constructor'],
    ['toString', 'toString'],
    ['hasOwnProperty', 'hasOwnProperty'],
    ['null', null],
    ['undefined', undefined],
    ['a number', 42],
    ['an object', {}],
    ['an array holding a real name', [flattened[0]]],
  ])('rejects %s', (_name, value) => {
    expect(parseProposedCategory(value)).toBeNull()
  })

  it('rejects group names that are not also categories', () => {
    const groups = Object.keys(categories).filter((group) => !known.has(group))
    expect(groups.length).toBeGreaterThan(0)
    expect(groups.filter((group) => parseProposedCategory(group) !== null)).toEqual([])
  })

  it('rejects a near-miss of every name', () => {
    const accepted: string[] = []
    for (const name of flattened) {
      const misses = [
        name.toUpperCase(),
        name.toLowerCase(),
        ` ${name}`,
        `${name} `,
        name.slice(0, -1),
        `${name}s`,
        `${name}\u0000`,
      ].filter((miss) => miss !== name && !known.has(miss))
      for (const miss of misses) {
        if (parseProposedCategory(miss) !== null) accepted.push(JSON.stringify(miss))
      }
    }
    expect(accepted).toEqual([])
  })
})


describe('row and config types', () => {
  it('pins the status and origin lists', () => {
    expect([...PROPOSAL_STATUSES]).toEqual(['pending', 'accepted', 'rejected'])
    // Ruling 7: origin `claude` returns only by a further amendment.
    expect([...PROPOSAL_ORIGINS]).toEqual(['rule'])
  })

  it('types a proposal and a config', () => {
    const proposal = {
      id: 1,
      transaction_id: 2,
      current_category: null,
      proposed_category: 'Bakeries',
      confidence: 0.9,
      reason: 'Example reason',
      origin: 'rule',
      status: 'pending',
      created_at: '2026-10-25T03:00:00.000Z',
    } satisfies CategoryProposal
    const config = {
      batchSize: 20,
      ruleThreshold: 2,
      enabled: true,
    } satisfies AgentConfig
    expect(parseProposedCategory(proposal.proposed_category)).toBe('Bakeries')
    expect(Object.keys(proposal).sort()).toEqual([
      'confidence',
      'created_at',
      'current_category',
      'id',
      'origin',
      'proposed_category',
      'reason',
      'status',
      'transaction_id',
    ])
    expect(Object.keys(config).sort()).toEqual(['batchSize', 'enabled', 'ruleThreshold'])
  })
})
