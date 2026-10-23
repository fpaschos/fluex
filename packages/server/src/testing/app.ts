import { afterAll, beforeAll } from 'vitest'
import type { LoadedFlueNodeApplication } from '@flue/vite'

/** Flue's 202 answer to an agent message. */
export interface Admission {
  streamUrl: string
  offset: string
  submissionId: string
  uid: string
}

/** One chunk of a conversation's updates stream (Flue's streaming protocol); only what tests read. */
export interface Chunk {
  type: string
  submissionId?: string
  outcome?: string
  name?: string
  data?: unknown
}

export interface TestApp {
  fetch(path: string, init?: RequestInit): Promise<Response>
  /** POSTs a JSON body to `path`. */
  post(path: string, body: unknown): Promise<Response>
  /** The admission's updates, long-polled until its `submission-settled` chunk (the last one returned). */
  updatesUntilSettled(admission: Admission): Promise<Chunk[]>
}

/**
 * The app as `vite dev` assembles it (the project's src/app.ts, the scanned agents, db.ts), loaded in
 * this process with no listener. Requests go straight to its `fetch`; stopped after the suite. Needs
 * the `flue()` plugin in the vitest config (its dev-server hook stripped) and `virtual:flue/server`
 * declared, as src/testing/flue-virtual.d.ts does.
 */
export function useApp(): TestApp {
  let app: LoadedFlueNodeApplication | undefined
  beforeAll(async () => {
    const { loadFlueNodeApplication } = await import('virtual:flue/server')
    app = await loadFlueNodeApplication()
  })
  afterAll(async () => {
    await app?.stop()
  })

  const fetch: TestApp['fetch'] = async (path, init) => {
    if (!app) throw new Error('[test] the app is not loaded yet')
    return app.fetch(new Request(new URL(path, 'http://app.test'), init))
  }

  return {
    fetch,
    post: (path, body) =>
      fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
      }),
    async updatesUntilSettled({ streamUrl, offset, submissionId }) {
      const chunks: Chunk[] = []
      for (let next = offset; ;) {
        const query = new URLSearchParams({ view: 'updates', offset: next, live: 'long-poll' })
        const response = await fetch(`${new URL(streamUrl).pathname}?${query.toString()}`)
        if (!response.ok) throw new Error(`[test] updates read: ${response.status}`)
        for (const chunk of (await response.json()) as Chunk[]) {
          chunks.push(chunk)
          if (chunk.type === 'submission-settled' && chunk.submissionId === submissionId)
            return chunks
        }
        const nextOffset = response.headers.get('Stream-Next-Offset')
        if (nextOffset === null) throw new Error('[test] updates read: no Stream-Next-Offset')
        next = nextOffset
      }
    }
  }
}
