import { setTimeout as sleep } from 'node:timers/promises'
import { describe, expect, it } from 'vitest'
import { Smoke } from '../src/agents/smoke/smoke.ts'
import type { Flow } from '../src/flows/run-types.ts'
import { flowRoutes } from '../src/flows/runs.ts'
import { useApp } from './support/app.ts'
import { submits, useFauxCodex } from './support/model.ts'

/** A promise settled from outside: the fake flow ends when the test says so. */
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** The flow routes around `flows`, with a sandbox remover that only records its keys. */
function useRoutes(flows: Record<string, Flow>) {
  const removed: string[] = []
  const routes = flowRoutes(flows, {
    removeSandbox: key => {
      removed.push(key)
      return Promise.resolve()
    }
  })
  return {
    removed,
    start: async (flow: string) => routes.request(`/${flow}`, { method: 'POST' }),
    status: async (runId: string) => routes.request(`/runs/${runId}`)
  }
}

/** Polls the run's status until `done` says so, and answers that status. */
async function waitFor(
  status: (runId: string) => Promise<Response>,
  runId: string,
  done: (body: { status: string; steps: string[] }) => boolean
) {
  for (;;) {
    const body = (await (await status(runId)).json()) as { status: string; steps: string[] }
    if (done(body)) return body
    await sleep(5)
  }
}

/** Polls the run's status until it is no longer `running`. */
const settled = (status: (runId: string) => Promise<Response>, runId: string) =>
  waitFor(status, runId, body => body.status !== 'running')

describe('a flow run', () => {
  it('starts with 202 and its run id, runs, then reports its result', async () => {
    const end = deferred<unknown>()
    const routes = useRoutes({ 'run-issue': () => end.promise })

    const response = await routes.start('run-issue')

    expect(response.status).toBe(202)
    const { runId } = (await response.json()) as { runId: string }
    expect(runId).toMatch(/^run-\d{8}-\d{6}-[0-9a-f]{4}$/)
    expect(await (await routes.status(runId)).json()).toEqual({ status: 'running', steps: [] })

    end.resolve({ picked: null })

    expect(await settled(routes.status, runId)).toEqual({
      status: 'done',
      steps: [],
      result: { picked: null }
    })
  })

  it('reports a flow that throws as failed, with its error', async () => {
    const end = deferred<unknown>()
    const routes = useRoutes({ 'run-issue': () => end.promise })
    const { runId } = (await (await routes.start('run-issue')).json()) as { runId: string }

    end.reject(new Error('the planner gave up'))

    expect(await settled(routes.status, runId)).toEqual({
      status: 'failed',
      steps: [],
      error: 'the planner gave up'
    })
  })

  it.each([
    ['succeeds', (end: ReturnType<typeof deferred>) => end.resolve({ picked: null })],
    ['fails', (end: ReturnType<typeof deferred>) => end.reject(new Error('boom'))]
  ])('removes its sandbox when the flow %s', async (_, settle) => {
    const end = deferred<unknown>()
    const routes = useRoutes({ 'run-issue': () => end.promise })
    const { runId } = (await (await routes.start('run-issue')).json()) as { runId: string }
    expect(routes.removed).toEqual([])

    settle(end)
    await settled(routes.status, runId)

    expect(routes.removed).toEqual([runId])
  })

  it('refuses a second run with 409 while one is in flight, and takes one after it ends', async () => {
    const end = deferred<unknown>()
    const routes = useRoutes({ 'run-issue': () => end.promise })
    const { runId } = (await (await routes.start('run-issue')).json()) as { runId: string }

    const second = await routes.start('run-issue')

    expect(second.status).toBe(409)
    expect(await second.json()).toEqual({ error: expect.stringContaining(runId) })

    end.resolve(null)
    await settled(routes.status, runId)
    expect((await routes.start('run-issue')).status).toBe(202)
  })

  it('answers 404 for an unknown run id', async () => {
    const routes = useRoutes({ 'run-issue': () => Promise.resolve(null) })

    const response = await routes.status('run-20260101-000000-0000')

    expect(response.status).toBe(404)
  })
})

describe("a flow run's steps", () => {
  useApp() // the Flue runtime the steps' agents run in
  const codex = useFauxCodex()
  const REPORT = {
    astGrep: true,
    fd: true,
    rg: true,
    build: { ok: true, exitCode: 0, durationSeconds: 1 },
    skills: []
  }

  it('names the step running now and lists its conversation id', async () => {
    const answer = deferred<void>()
    codex.setResponses([
      async () => {
        await answer.promise
        return submits(REPORT)
      }
    ])
    const routes = useRoutes({
      'run-issue': async run => (await run.ask(Smoke, 'smoke', {})).data
    })
    const { runId } = (await (await routes.start('run-issue')).json()) as { runId: string }

    expect(await waitFor(routes.status, runId, body => body.steps.length > 0)).toEqual({
      status: 'running',
      step: 'smoke',
      steps: [`${runId}-smoke`]
    })

    answer.resolve()

    expect(await settled(routes.status, runId)).toEqual({
      status: 'done',
      steps: [`${runId}-smoke`],
      result: { smoke: [REPORT] }
    })
  })

  it('sends a step again as the original submission, without another model run', async () => {
    codex.setResponses([submits(REPORT)])
    const routes = useRoutes({
      'run-issue': async run => {
        const first = await run.ask(Smoke, 'smoke', {})
        const again = await run.ask(Smoke, 'smoke', {})
        return { first: first.submissionId, again: again.submissionId, data: again.data }
      }
    })
    const { runId } = (await (await routes.start('run-issue')).json()) as { runId: string }

    const run = (await settled(routes.status, runId)) as { result?: Record<string, unknown> }

    expect(run).toMatchObject({ status: 'done', steps: [`${runId}-smoke`] })
    expect(run.result?.again).toBe(run.result?.first)
    expect(run.result?.data).toEqual({ smoke: [REPORT] })
    expect(codex.getPendingResponseCount()).toBe(0)
  })
})
