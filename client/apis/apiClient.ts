import request from 'superagent'
import { Accounts } from '../../models/akahu'
import type { CategoriesResponse } from '../../models/categories.ts'
import type {
  UpdateTransactionCategory,
  UpdateTransactionCategoryResponse,
} from '../../models/transactions.ts'

const rootURL = new URL(`/api/v1`, document.baseURI)

export async function grabAccounts(): Promise<Accounts> {
  const response = await request.get(`${rootURL}/accounts`)
  return response.body as Accounts
}

export async function grabTransactions(
  accountIds?: string[] | null | undefined,
) {
  if (accountIds && accountIds.length > 0) {
    // For specific account transactions
    const queryString = accountIds.join(',')
    const response = await request.get(
      `${rootURL}/accounts/transactions?accountIds=${queryString}`,
    )

    return response.body
  } else {
    // For 'view all transactions' mode
    const response = await request.get(`${rootURL}/accounts/transactions`)
    return response.body
  }
}

export async function grabCategories(): Promise<CategoriesResponse> {
  const response = await request.get(`${rootURL}/categories`)
  return response.body as CategoriesResponse
}

// Sets the user's category on a transaction. `category` is a category name
// from GET /categories (the same names as data/cats.js).
export async function updateTransactionCategory(
  transactionId: string | number,
  category: string,
): Promise<UpdateTransactionCategoryResponse> {
  const body: UpdateTransactionCategory = { category }
  const response = await request
    .patch(`${rootURL}/transactions/${transactionId}`)
    .send(body)
  return response.body as UpdateTransactionCategoryResponse
}
