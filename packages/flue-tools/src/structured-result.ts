import * as v from 'valibot'
import { useAgentFinish, useDataWriter, useTool } from '@flue/runtime'
import type { AgentReply, ToolInputSchema } from '@flue/runtime'

// Structured output of an agent, for the code that drives it: one per agent. The model fills the
// schema through the terminating `structured_result` tool; the tool writes it to the data part
// `name`, which the caller reads with `readStructuredResult(name, reply, schema)`. The model never sees data
// parts, and a tool's `output` never reaches the caller. Schemas are object schemas: tool inputs.

const TOOL = 'structured_result'

/**
 * Mounts the `structured_result` tool. Call it unconditionally, on every render: data-part names
 * are part of the render's identity. A second call in one render throws (duplicate tool name),
 * which keeps it to one result per agent. The schema is the tool's input, so Flue validates the
 * model's result and sends mismatches back for correction. `terminate` ends the run after the
 * call, so `reply.text` is empty; text written before the call stays in the log. A run that would
 * end without a successful call is sent back to make it (Flue's 32-cycle ceiling then fails it).
 */
export function useStructuredResult<S extends ToolInputSchema>(
  name: string,
  schema: S,
  description = 'Submit your result. Call once, as the very last step.'
): void {
  const write = useDataWriter(name, { schema })
  useTool({
    name: TOOL,
    description,
    input: schema,
    run({ data }) {
      write(data)
      const submitted = { output: 'Submitted.', terminate: true }
      return Promise.resolve(submitted)
    }
  })

  // The enforcement seam: the model may stop with text only (it did: "Pick: none", no call).
  useAgentFinish(({ response, append }) => {
    if (response.toolCalls.some(call => call.tool === TOOL && !call.isError)) return
    append({
      kind: 'signal',
      type: 'structured_result_missing',
      body: `You have not called \`${TOOL}\`. Call it now with your result.`
    })
  })
}

/** The agent's last submitted result under `name`, validated again; throws when the run ended without one. */
export function readStructuredResult<S extends ToolInputSchema>(
  name: string,
  reply: AgentReply,
  schema: S
): v.InferOutput<S> {
  const submitted = reply.data[name]?.at(-1)
  if (submitted === undefined)
    throw new Error(`[result] the agent ended without calling ${TOOL} (${name})`)
  return v.parse(schema, submitted)
}
