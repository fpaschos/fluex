import { AgentRunError } from '@flue/runtime'

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
