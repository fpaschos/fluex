import { init } from '@flue/runtime'
import type { Agent, AgentReply } from '@flue/runtime'

// One agent turn, for flows. The server prints only the tool log (`mountToolLog`); the
// assistant's text is for clients, which read it from the API. The server owns signals: Ctrl-C
// stops it, not one turn.

export interface AskOptions {
  /** Flue's dedup key: the same key and body answer the original submission, another body 409s. */
  idempotencyKey?: string
}

/**
 * Sends `message` to the agent instance `id` and waits for the settled reply. `initialData` applies
 * only when this call creates the conversation (Flue ignores it on an existing one). A failed or
 * aborted run rejects with AgentRunError, so callers' `finally`s run.
 */
export async function ask(
  agent: Agent,
  id: string,
  initialData?: Record<string, unknown>,
  message = 'go',
  { idempotencyKey }: AskOptions = {}
): Promise<AgentReply> {
  const handle = init(agent, { id })
  const receipt = await handle.dispatch({ message, initialData, idempotencyKey })
  return handle.read(receipt)
}
