import * as v from 'valibot'
import type { PiSubscriptionProviderId } from '@fluex/pi-auth'

/**
 * The initial data every agent takes, both optional: the sandbox key to work in (the run id; omitted:
 * the host, see `superapp` in src/sandboxes.ts) and the pi subscription its model runs on (omitted: the
 * app's, src/providers.ts). Agents add their own fields: `agentData({ …AgentFields, … })`.
 */
export const AgentFields = {
  sandbox: v.optional(v.string()),
  subscription: v.optional(v.picklist(['openai-codex'] satisfies PiSubscriptionProviderId[]))
}

/**
 * An agent's initial-data schema: an object of `entries`, `{}` when the creating message sends none
 * (Flue validates `undefined` then, so a bare `POST /agents/<name>/<id>` would be refused). `{}` still
 * goes through the object schema: an agent with a required field (the implementer's `issue`) refuses it.
 */
export const agentData = <const E extends v.ObjectEntries>(entries: E) =>
  v.optional(v.object(entries), {} as v.InferInput<v.ObjectSchema<E, undefined>>)

export const AgentData = agentData(AgentFields)

export type AgentData = v.InferOutput<typeof AgentData>
