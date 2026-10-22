// The MCP process holds no secrets (prd-03 Done when 3, Security layers:
// Process). The stdio entry calls `assertCleanEnv` before it does anything
// else and exits non-zero if the environment carries a secret-shaped name,
// or a variable that changes what code Node loads: `NODE_OPTIONS`
// (`--inspect` would open a socket, `--require` would load a file) and the
// dynamic loader's `LD_*` and `DYLD_*`. Node acts on those before this check
// runs, so refusing them stops the process rather than undoing the effect.
//
// It names the offending variables and never prints a value. Under the
// `fly ssh console` fallback (prd-03 Ruling 3) Fly injects `FLY_*` into the
// session, so the launcher must start the entry with a clean environment
// (`su -l divvy-mcp` or `env -i`); this check is meant to refuse a plain
// `su`. Locally, run the entry as `env -i PATH="$PATH" …` if your shell
// exports API keys.

/** Names the MCP process must never see. */
export const FORBIDDEN_ENV = {
  names: ['NODE_OPTIONS', 'NODE_EXTRA_CA_CERTS'],
  prefixes: ['AKAHU_', 'XERO_', 'FLY_', 'ANTHROPIC_', 'LD_', 'DYLD_'],
  pattern: /TOKEN|SECRET|KEY|PASSWORD/i,
} as const

type Env = Readonly<Record<string, string | undefined>>

/** The forbidden variable names present in `env`, sorted. Never values. */
export function findForbiddenEnvNames(env: Env): string[] {
  return Object.keys(env)
    .filter((name) => {
      const upper = name.toUpperCase()
      return (
        (FORBIDDEN_ENV.names as readonly string[]).includes(upper) ||
        FORBIDDEN_ENV.prefixes.some((prefix) => upper.startsWith(prefix)) ||
        FORBIDDEN_ENV.pattern.test(name)
      )
    })
    .sort()
}

export class ForbiddenEnvError extends Error {
  readonly names: readonly string[]

  constructor(names: readonly string[]) {
    super(`process environment contains forbidden variable(s): ${names.join(', ')}`)
    this.name = 'ForbiddenEnvError'
    this.names = names
  }
}

/** Throws `ForbiddenEnvError` naming every forbidden variable in `env`. */
export function assertCleanEnv(env: Env = process.env): void {
  const names = findForbiddenEnvNames(env)
  if (names.length > 0) throw new ForbiddenEnvError(names)
}
