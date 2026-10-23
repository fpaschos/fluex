import type { Agent, AgentReply } from '@flue/runtime'

// What a flow sees (src/flows/runs.ts). A run's status on the wire, RunStatus, is @fluex/sdk's.

/** One run of a flow, as the flow sees it. */
export interface FlowRun {
  /** The run id (`newRunId`): the prefix of its conversation ids and its sandbox key. */
  readonly id: string
  /**
   * One turn of `agent` as the step `step`: conversation `<id>-<step>`, idempotency key
   * `<id>:<step>`, so sending the same step again answers the original submission (another body: 409).
   */
  ask(agent: Agent, step: string, initialData?: Record<string, unknown>): Promise<AgentReply>
}

/** A flow: plain code driving agents for one run, resolving to the run's result. */
export type Flow = (run: FlowRun) => Promise<unknown>
