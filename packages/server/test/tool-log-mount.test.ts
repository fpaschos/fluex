import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import type { Admission } from '../src/testing/index.ts'
import { submits, useApp, useFauxCodex } from '../src/testing/index.ts'

const app = useApp()
const codex = useFauxCodex()

const REPORT = { ok: true }

/** One echo turn on conversation `id` through the app, until it settles. */
async function echoTurn(id: string) {
  codex.setResponses([submits(REPORT)])
  const response = await app.post(`/agents/echo/${id}`, { kind: 'user', body: 'go' })
  await app.updatesUntilSettled((await response.json()) as Admission)
}

/** The record types the tool log wrote for conversation `id` (runs/<id>/events.jsonl), once it settled. */
async function loggedTypes(id: string): Promise<string[]> {
  return vi.waitFor(() => {
    const lines = readFileSync(`runs/${id}/events.jsonl`, 'utf8').trim().split('\n')
    const types = lines.map(line => (JSON.parse(line) as { type: string }).type)
    if (!types.includes('settled')) throw new Error(`runs/${id}: not settled yet`)
    return types
  }, 10_000)
}

describe('the tool log', () => {
  it("records a turn's model call, tool call and settlement once", async () => {
    await echoTurn('log-1')

    expect(await loggedTypes('log-1')).toEqual(['turn', 'tool_start', 'tool', 'settled'])
  })

  it('records them once after the app reloads its modules (`vite dev` watching)', async () => {
    vi.resetModules()
    await import('./fixture/src/app.ts')

    await echoTurn('log-2')

    expect(await loggedTypes('log-2')).toEqual(['turn', 'tool_start', 'tool', 'settled'])
  })
})
