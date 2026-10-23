import type { Agent, AgentReply } from '@flue/runtime'

// The types of the flow routes (src/flows/runs.ts): what a flow sees, and a run's status on the wire.

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

/** A run's status, as `GET /flows/runs/<runId>` answers it. */
export interface RunStatus {
  status: 'running' | 'done' | 'failed'
  /** The step running now; only while the run is `running`. */
  step?: string
  /** The conversation ids of the steps started so far, readable at /agents/<name>/<id>. */
  steps: string[]
  result?: unknown
  error?: string
}
