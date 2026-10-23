/** A variable from the environment (`.env`, loaded by the entry point), or an error naming it. */
export function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`[fluex] ${name} is not set (see .env)`)
  return value
}
