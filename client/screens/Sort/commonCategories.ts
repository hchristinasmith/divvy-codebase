// The quick category buttons on a Sort card (prd-02 Ruling 16, issue 259):
// names from data/cats.js that suit an NZ personal and small-business mix,
// in the order the buttons show. A name the server's category list does not
// offer is never shown (the screen filters on GET /api/v1/categories), and
// a test pins every name to data/cats.js. Everything else is under More….
export const COMMON_CATEGORIES: readonly string[] = [
  'Supermarkets and grocery stores',
  'Cafes and restaurants',
  'Fast food stores',
  'Fuel stations',
  'Media and entertainment streaming services',
  'Business software and cloud services',
]
