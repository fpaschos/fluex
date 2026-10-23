import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall
} from '@earendil-works/pi-ai/providers/faux'
import type { FauxProviderHandle } from '@earendil-works/pi-ai/providers/faux'
import { beforeAll } from 'vitest'
import { setProvider } from '@flue/runtime'

/**
 * An offline `openai-codex` provider with the agents' models, registered after the app loaded: it
 * replaces the app's pi subscription for this test file. Scripted with {@link submits}.
 */
export function useFauxCodex(): FauxProviderHandle {
  const faux = fauxProvider({
    provider: 'openai-codex',
    models: [{ id: 'gpt-6-luna' }, { id: 'gpt-6-sol' }]
  })
  beforeAll(() => setProvider(faux.provider))
  return faux
}

/** A model turn that calls `structured_result` with `result`, ending the agent's run. */
export const submits = (result: Parameters<typeof fauxToolCall>[1]) =>
  fauxAssistantMessage(fauxToolCall('structured_result', result), { stopReason: 'toolUse' })
