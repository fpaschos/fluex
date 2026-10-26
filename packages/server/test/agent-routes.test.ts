import { describe, expect, it } from 'vitest'
import type { Admission } from './support/index.ts'
import { submits, useApp, useFauxCodex } from './support/index.ts'

const app = useApp()
const codex = useFauxCodex()

/** An echo report as the model submits it. */
const REPORT = { ok: true }

describe('an agent route', () => {
  it('accepts a message to a new conversation with 202 and where to read its stream', async () => {
    codex.setResponses([submits(REPORT)])

    const response = await app.post('/agents/echo/accept-1', {
      kind: 'user',
      body: 'go',
      initialData: { subscription: 'openai-codex' }
    })

    expect(response.status).toBe(202)
    const admission = (await response.json()) as Admission
    expect(admission).toEqual({
      streamUrl: expect.stringContaining('/agents/echo/accept-1'),
      offset: expect.any(String),
      submissionId: expect.any(String),
      uid: expect.any(String)
    })
    await app.updatesUntilSettled(admission) // the run takes the scripted response before the next test
  })

  it('creates a conversation without initial data', async () => {
    codex.setResponses([submits(REPORT)])

    const response = await app.post('/agents/echo/bare-1', { kind: 'user', body: 'go' })

    expect(response.status).toBe(202)
    await app.updatesUntilSettled((await response.json()) as Admission)
  })

  it('refuses initial data that does not match the agent schema, with 400', async () => {
    const response = await app.post('/agents/echo/invalid-1', {
      kind: 'user',
      body: 'go',
      initialData: { subscription: 'no-such-subscription' }
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: { type: 'invalid_request' } })
  })

  it("streams the agent's run until it settles, with its result data", async () => {
    codex.setResponses([submits(REPORT)])

    const response = await app.post('/agents/echo/stream-1', {
      kind: 'user',
      body: 'go',
      initialData: {}
    })
    const chunks = await app.updatesUntilSettled((await response.json()) as Admission)

    expect(chunks.at(-1)).toMatchObject({ type: 'submission-settled', outcome: 'completed' })
    expect(chunks).toContainEqual(
      expect.objectContaining({ type: 'data-part', name: 'echo', data: REPORT })
    )
  })
})
