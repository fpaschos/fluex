import { execFileSync } from 'node:child_process'
import { AgentRunError } from '@flue/runtime'

/** A variable from the environment (`.env`, loaded by the entry point), or an error naming it. */
export function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`[superapp-flue] ${name} is not set (see .env)`)
  return value
}

/** `git -C <repo> <args>` on the host, its stdout trimmed; throws when git fails. */
export function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim()
}

/** `repo`'s `git config <key>` (repo-local or global), or an error naming it. */
export function gitConfig(repo: string, key: string): string {
  try {
    return git(repo, 'config', key)
  } catch {
    throw new Error(`[superapp-flue] git config ${key} is not set for ${repo}`)
  }
}

/**
 * An error as one line of text. A failed agent run (AgentRunError) carries the settlement's recorded
 * error as its cause: an Error, a plain `{ message }` record, or anything else (as JSON).
 */
export function describeError(error: unknown): string {
  const cause = error instanceof AgentRunError ? error.cause : undefined
  if (cause instanceof Error) return cause.message
  if (typeof cause === 'object' && cause !== null && 'message' in cause)
    return String(cause.message)
  if (cause !== undefined) return JSON.stringify(cause)
  return error instanceof Error ? error.message : String(error)
}
