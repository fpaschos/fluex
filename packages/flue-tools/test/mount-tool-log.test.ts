import { describe, expect, it, vi } from 'vitest'
import { mountToolLog } from '../src/mount-tool-log.ts'

/** Flue's `observe`, counting the subscribers left mounted. */
const subscribers = vi.hoisted(() => new Set<unknown>())
vi.mock('@flue/runtime', async original => ({
  ...(await original<typeof import('@flue/runtime')>()),
  observe: (subscriber: unknown) => {
    subscribers.add(subscriber)
    return () => subscribers.delete(subscriber)
  }
}))

describe('mountToolLog', () => {
  it('leaves one subscriber when mounted twice under the same key (a reload)', () => {
    mountToolLog({ runsDir: 'runs' }, 'test.reload')
    mountToolLog({ runsDir: 'runs' }, 'test.reload')

    expect(subscribers.size).toBe(1)
  })

  it('keeps the mounts of different keys apart', () => {
    subscribers.clear()

    mountToolLog({ runsDir: 'runs' }, 'test.a')
    mountToolLog({ runsDir: 'runs' }, 'test.b')

    expect(subscribers.size).toBe(2)
  })

  it('answers the unsubscribe of its mount', () => {
    subscribers.clear()

    const unsubscribe = mountToolLog({ runsDir: 'runs' }, 'test.unsubscribe')
    unsubscribe()

    expect(subscribers.size).toBe(0)
  })
})
