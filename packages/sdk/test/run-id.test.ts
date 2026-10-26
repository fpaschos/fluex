import { describe, expect, it } from 'vitest'
import { newRunId } from '../src/run-id.ts'

describe('newRunId', () => {
  it('names the run by its local start time, with a random hex suffix', () => {
    const id = newRunId(new Date(2026, 9, 14, 17, 40, 55))

    expect(id).toMatch(/^run-20261014-174055-[0-9a-f]{4}$/)
  })

  it('keeps two runs of the same second apart', () => {
    const date = new Date(2026, 0, 2, 3, 4, 5)
    const ids = new Set(Array.from({ length: 20 }, () => newRunId(date)))

    expect(ids.size).toBeGreaterThan(1)
  })
})
