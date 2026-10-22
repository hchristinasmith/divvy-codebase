import { categories } from '../../data/cats.js'
import type { CategoryGroup } from '../../models/categories.ts'

// The category list is data/cats.js, the same file the Category dropdown
// imports, so the server accepts exactly what the client offers. If
// categories move into a table, this module is where that read goes.

const groups: CategoryGroup[] = Object.entries(categories).map(
  ([name, names]) => ({ name, categories: [...names] }),
)

const known = new Set(groups.flatMap((g) => g.categories))

export function getCategoryGroups(): CategoryGroup[] {
  return groups
}

export function isKnownCategory(name: string): boolean {
  return known.has(name)
}
