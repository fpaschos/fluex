import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import type { Admission } from './support/app.ts'
import { useApp } from './support/app.ts'
import { submits, useFauxCodex } from './support/model.ts'

const app = useApp()
const codex = useFauxCodex()

const REPORT = {
  astGrep: true,
  fd: true,
  rg: true,
  build: { ok: true, exitCode: 0 },
  skills: []
}

/** One smoke turn on conversation `id` through the app, until it settles. */
async function smokeTurn(id: string) {
  codex.setResponses([submits(REPORT)])
  const response = await app.post(`/agents/smoke/${id}`, { kind: 'user', body: 'go' })
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
    await smokeTurn('log-1')

    expect(await loggedTypes('log-1')).toEqual(['turn', 'tool_start', 'tool', 'settled'])
  })

  it('records them once after the app reloads its modules (`pnpm dev:watch`)', async () => {
    vi.resetModules()
    await import('../src/observability.ts')

    await smokeTurn('log-2')

    expect(await loggedTypes('log-2')).toEqual(['turn', 'tool_start', 'tool', 'settled'])
  })
})
