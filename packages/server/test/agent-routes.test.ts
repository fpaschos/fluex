import { describe, expect, it } from 'vitest'
import type { Admission } from './support/app.ts'
import { useApp } from './support/app.ts'
import { submits, useFauxCodex } from './support/model.ts'

const app = useApp()
const codex = useFauxCodex()

/** A smoke report as the model submits it. */
const REPORT = {
  astGrep: true,
  fd: true,
  rg: true,
  build: { ok: true, exitCode: 0, durationSeconds: 12 },
  skills: [{ name: 'ast-grep', found: true, used: true }]
}

describe('the app', () => {
  it('answers its health route', async () => {
    const response = await app.fetch('/health')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
  })
})

describe('an agent route', () => {
  it('accepts a message to a new conversation with 202 and where to read its stream', async () => {
    codex.setResponses([submits(REPORT)])

    const response = await app.post('/agents/smoke/accept-1', {
      kind: 'user',
      body: 'go',
      initialData: { subscription: 'openai-codex' }
    })

    expect(response.status).toBe(202)
    const admission = (await response.json()) as Admission
    expect(admission).toEqual({
      streamUrl: expect.stringContaining('/agents/smoke/accept-1'),
      offset: expect.any(String),
      submissionId: expect.any(String),
      uid: expect.any(String)
    })
    await app.updatesUntilSettled(admission) // the run takes the scripted response before the next test
  })

  it('creates a conversation without initial data', async () => {
    codex.setResponses([submits(REPORT)])

    const response = await app.post('/agents/smoke/bare-1', { kind: 'user', body: 'go' })

    expect(response.status).toBe(202)
    await app.updatesUntilSettled((await response.json()) as Admission)
  })

  it('refuses initial data that does not match the agent schema, with 400', async () => {
    const response = await app.post('/agents/smoke/invalid-1', {
      kind: 'user',
      body: 'go',
      initialData: { subscription: 'no-such-subscription' }
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: { type: 'invalid_request' } })
  })

  it("streams the agent's run until it settles, with its result data", async () => {
    codex.setResponses([submits(REPORT)])

    const response = await app.post('/agents/smoke/stream-1', {
      kind: 'user',
      body: 'go',
      initialData: {}
    })
    const chunks = await app.updatesUntilSettled((await response.json()) as Admission)

    expect(chunks.at(-1)).toMatchObject({ type: 'submission-settled', outcome: 'completed' })
    expect(chunks).toContainEqual(
      expect.objectContaining({ type: 'data-part', name: 'smoke', data: REPORT })
    )
  })
})
