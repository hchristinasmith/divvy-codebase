export interface Category {
  id: string
  name: string
  color: string
}

// GET /api/v1/categories: the NZFCC categories from data/cats.js, grouped as
// the Category dropdown shows them, then Divvy's own group, which holds
// Drawings (prd-02 Ruling 15). PATCH /api/v1/transactions/:id accepts
// exactly the names listed here.
export interface CategoryGroup {
  name: string
  categories: string[]
}

export interface CategoriesResponse {
  items: CategoryGroup[]
}
