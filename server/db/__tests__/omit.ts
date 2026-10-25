// Test helper, not a test.

// `row` without `column`, so the insert leaves it out. Not `{ column: undefined }`:
// with `useNullAsDefault` knex binds that as NULL, which a column default
// never sees, so it could not catch a default creeping in.
export function omit(
  row: Record<string, unknown>,
  column: string,
): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).filter(([key]) => key !== column))
}
