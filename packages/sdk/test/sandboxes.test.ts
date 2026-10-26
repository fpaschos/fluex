import { describe, expect, it } from 'vitest'
import { removeSandbox } from '../src/sandboxes.ts'

/** A fetch that answers `response` and records each request as `<method> <url>`. */
function recordingFetch(response: () => Response) {
  const sent: string[] = []
  const fetch = (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input)
    sent.push(`${init?.method ?? 'GET'} ${url}`)
    return Promise.resolve(response())
  }
  return { sent, fetch }
}

describe('removeSandbox', () => {
  it('sends DELETE <baseUrl>/sandboxes/<key>', async () => {
    const http = recordingFetch(() => new Response(null, { status: 204 }))

    await removeSandbox({ baseUrl: 'http://app.test/', key: 'run-x', fetch: http.fetch })

    expect(http.sent).toEqual(['DELETE http://app.test/sandboxes/run-x'])
  })

  it('rejects with the status and body when the app refuses', async () => {
    const http = recordingFetch(() => new Response('{"error":"docker is down"}', { status: 500 }))

    const removing = removeSandbox({ baseUrl: 'http://app.test', key: 'k', fetch: http.fetch })

    await expect(removing).rejects.toThrow('500 {"error":"docker is down"}')
  })
})
