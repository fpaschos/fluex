import * as v from 'valibot'

/**
 * An agent's initial-data schema: an object of `entries`, `{}` when the creating message sends none
 * (Flue validates `undefined` then, so a bare `POST /agents/<name>/<id>` would be refused). `{}` still
 * goes through the object schema: an agent with a required field (the implementer's `issue`) refuses it.
 */
export const agentData = <const E extends v.ObjectEntries>(entries: E) =>
  v.optional(v.object(entries), {} as v.InferInput<v.ObjectSchema<E, undefined>>)
