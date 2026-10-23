// What the fluex routes answer on the wire, for any client.

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
