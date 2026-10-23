import { Hono } from 'hono'
import { removeSandbox as removeDockerSandbox } from '@fluex/flue-docker'
import { ask } from '../ask.ts'
import { newRunId } from '../run-id.ts'
import { describeError } from '../utils.ts'
import type { Flow, FlowRun, RunStatus } from './run-types.ts'

// The flow routes (src/app.ts mounts them at /flows), written by hand: no flows kit yet
// (docs/server.md §10). A run lives in memory and is lost on restart.
//
//   POST /flows/<flow>         → 202 { runId }; the flow runs in the background
//   GET  /flows/runs/<runId>   → { status, step?, steps, result?, error? }, 404 when unknown

/** The `FlowRun` a flow gets: each `ask` is a step of `run`, named in its status. */
function flowRun(id: string, run: RunStatus): FlowRun {
  return {
    id,
    ask(agent, step, initialData) {
      const conversation = `${id}-${step}`
      run.step = step
      if (!run.steps.includes(conversation)) run.steps.push(conversation)
      return ask(agent, conversation, initialData, 'go', { idempotencyKey: `${id}:${step}` })
    }
  }
}

/** The routes for `flows`; `removeSandbox` removes a run's sandbox (keyed by its id) at its end. */
export function flowRoutes(
  flows: Record<string, Flow>,
  { removeSandbox = removeDockerSandbox }: { removeSandbox?: (key: string) => Promise<void> } = {}
): Hono {
  const runs = new Map<string, RunStatus>()
  // One run at a time: every run shares TARGET_REPO's working tree, the Gradle home and the backlog
  // (docs/server.md §10).
  let inFlight: string | undefined
  const routes = new Hono()

  routes.post('/:flow', c => {
    const flow = flows[c.req.param('flow')]
    if (!flow) return c.json({ error: 'no such flow' }, 404)
    if (inFlight !== undefined) return c.json({ error: `${inFlight} is still running` }, 409)
    const id = newRunId()
    inFlight = id
    const run: RunStatus = { status: 'running', steps: [] }
    runs.set(id, run)
    void execute(flow, id, run)
    return c.json({ runId: id }, 202)
  })

  routes.get('/runs/:runId', c => {
    const run = runs.get(c.req.param('runId'))
    if (!run) return c.json({ error: 'no such run' }, 404)
    return c.json(run)
  })

  /** Runs `flow`, removes its sandbox (a failure is only logged), then settles `run`. */
  async function execute(flow: Flow, id: string, run: RunStatus) {
    let outcome: Pick<RunStatus, 'status' | 'result' | 'error'>
    try {
      outcome = { status: 'done', result: await flow(flowRun(id, run)) }
    } catch (error) {
      outcome = { status: 'failed', error: describeError(error) }
    }
    // Settle only once the sandbox is gone: the client exits on settle, and the next run may start.
    try {
      await removeSandbox(id)
    } catch (error) {
      console.error(`[flows] ${id}: removing its sandbox failed: ${describeError(error)}`)
    }
    delete run.step
    Object.assign(run, outcome)
    inFlight = undefined
  }

  return routes
}
