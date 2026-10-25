import { categories } from '../../data/cats.js'
import type { CategoryGroup } from '../../models/categories.ts'
import { DRAWINGS_CATEGORY } from '../../shared/drawings.ts'

// The category list is data/cats.js, the same file the Category dropdown
// imports, so the server accepts exactly what the client offers. If
// categories move into a table, this module is where that read goes.
//
// Two lists. `getCategoryGroups` and `isKnownCategory` are data/cats.js
// alone, the NZFCC taxonomy: the agents' contract (server/agents) checks
// proposals against it, so an agent can never propose a category Divvy
// derives. `getSelectableCategoryGroups` and `isSelectableCategory` are
// what Hannah can pick (GET /api/v1/categories, PATCH
// /api/v1/transactions/:id): the same groups plus Divvy's own, which holds
// Drawings, so an unmatched drawing can be tagged by hand (prd-02 Ruling
// 15).

const groups: CategoryGroup[] = Object.entries(categories).map(
  ([name, names]) => ({ name, categories: [...names] }),
)

const known = new Set(groups.flatMap((g) => g.categories))

/** The categories Divvy itself defines, after the NZFCC groups. */
const DIVVY_GROUP: CategoryGroup = {
  name: 'Divvy',
  categories: [DRAWINGS_CATEGORY],
}

const selectableGroups: CategoryGroup[] = [...groups, DIVVY_GROUP]

const selectable = new Set(selectableGroups.flatMap((g) => g.categories))

export function getCategoryGroups(): CategoryGroup[] {
  return groups
}

export function isKnownCategory(name: string): boolean {
  return known.has(name)
}

/** What Hannah can pick: data/cats.js, then Divvy's own group. */
export function getSelectableCategoryGroups(): CategoryGroup[] {
  return selectableGroups
}

/** A name Hannah can pick (`getSelectableCategoryGroups`). */
export function isSelectableCategory(name: string): boolean {
  return selectable.has(name)
}
