// What a log line may say about something thrown: its class, never the thing
// itself. A class name is code, not data; a message (and the stack, which
// repeats it) can carry knex's SQL and bound values, or a credential.
export function errorClass(err: unknown): string {
  return err instanceof Error ? err.constructor.name : typeof err
}
