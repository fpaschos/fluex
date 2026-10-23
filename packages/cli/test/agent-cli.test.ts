import {
  fauxAssistantMessage,
  fauxText,
  fauxThinking,
  fauxToolCall
} from '@earendil-works/pi-ai/providers/faux'
import { describe, expect, it } from 'vitest'
import { submits, useApp, useFauxCodex } from '@fluex/server/testing'
import type { TestApp } from '@fluex/server/testing'
import { runAgent } from '../src/agent-client.ts'
import type { AgentClientIO, AgentCommand } from '../src/agent-client.ts'
import { closedPort } from './support/port.ts'

const app = useApp()
const codex = useFauxCodex()

/** An echo report as the model submits it (the server's fixture agent). */
const REPORT = { ok: true }

/** One request the client made, as the app saw it. */
interface Sent {
  method: string
  path: string
  body?: unknown
}

/**
 * The app over HTTP as the client sees it, recording each request. The in-process app has no
 * Docker: a sent `sandbox` is recorded but stripped before the agent sees it (it then works on the
 * test's throwaway TARGET_REPO), and `DELETE /sandboxes/<key>` is only recorded.
 */
function overHttp(target: TestApp) {
  const sent: Sent[] = []
  const fetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input)
    const method = init?.method ?? 'GET'
    const path = url.pathname
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined
    sent.push({ method, path, ...(body === undefined ? {} : { body }) })
    if (method === 'DELETE' && path.startsWith('/sandboxes/'))
      return Promise.resolve(new Response(null, { status: 204 }))
    const forwarded = withoutSandbox(body)
    return target.fetch(`${path}${url.search}`, {
      ...init,
      ...(forwarded === undefined ? {} : { body: JSON.stringify(forwarded) })
    })
  }
  return { sent, fetch }
}

function withoutSandbox(body: unknown): unknown {
  if (typeof body !== 'object' || body === null || !('initialData' in body)) return body
  const { sandbox: _, ...initialData } = body.initialData as Record<string, unknown>
  return { ...body, initialData }
}

/** Runs `pnpm agent <name> …` against the app; answers its exit code and output. */
async function agent(
  command: AgentCommand,
  http = overHttp(app),
  initialData?: AgentClientIO['initialData']
) {
  const stdout: string[] = []
  const stderr: string[] = []
  const code = await runAgent(command, {
    url: 'http://app.test',
    fetch: http.fetch,
    stdout: text => stdout.push(text),
    stderr: text => stderr.push(text),
    initialData
  })
  return { code, stdout: stdout.join(''), stderr: stderr.join(''), sent: http.sent }
}

describe('pnpm agent', () => {
  it('prints the settled reply as { id, text, data } and exits 0', async () => {
    codex.setResponses([submits(REPORT)])

    const run = await agent({ name: 'echo' })

    expect(run.code).toBe(0)
    expect(JSON.parse(run.stdout)).toEqual({
      id: expect.stringMatching(/^run-\d{8}-\d{6}-[0-9a-f]{4}-echo$/),
      text: '',
      data: { echo: [REPORT] }
    })
  })

  it("streams the assistant's text to stderr, under the conversation id, and its thinking", async () => {
    codex.setResponses([
      fauxAssistantMessage(
        [
          fauxThinking('which tools?'),
          fauxText('checking the tools\nall there'),
          fauxToolCall('structured_result', REPORT)
        ],
        { stopReason: 'toolUse' }
      )
    ])

    const run = await agent({ name: 'echo' })

    const { id } = JSON.parse(run.stdout) as { id: string }
    expect(run.stderr).toContain(`[${id}] thinking\n  which tools?\n`)
    expect(run.stderr).toContain(`[${id}] assistant\n  checking the tools\n  all there\n`)
  })

  it("creates a conversation with its run's sandbox, merged with --data", async () => {
    codex.setResponses([submits(REPORT)])

    const run = await agent({ name: 'echo', data: '{"subscription":"openai-codex","extra":1}' })

    const { id } = JSON.parse(run.stdout) as { id: string }
    const runId = id.replace(/-echo$/, '')
    expect(run.sent[0]).toEqual({
      method: 'POST',
      path: `/agents/echo/${id}`,
      body: {
        kind: 'user',
        body: 'go',
        initialData: { sandbox: runId, subscription: 'openai-codex', extra: 1 }
      }
    })
  })

  it("starts a new conversation from the project's initial data, --data over it", async () => {
    codex.setResponses([submits(REPORT)])
    const defaults = (runId: string) => ({ sandbox: runId, subscription: 'openai-codex', extra: 0 })

    const run = await agent({ name: 'echo', data: '{"extra":1}' }, overHttp(app), defaults)

    const { id } = JSON.parse(run.stdout) as { id: string }
    const runId = id.replace(/-echo$/, '')
    expect(run.sent[0]).toMatchObject({
      body: { initialData: { sandbox: runId, subscription: 'openai-codex', extra: 1 } }
    })
    expect(run.sent.at(-1)).toEqual({ method: 'DELETE', path: `/sandboxes/${runId}` })
  })

  it('continues a conversation with --id, sending -m and no initial data', async () => {
    codex.setResponses([submits(REPORT), submits(REPORT)])
    const first = await agent({ name: 'echo' })
    const { id } = JSON.parse(first.stdout) as { id: string }

    const run = await agent({ name: 'echo', id, message: 'again' })

    expect(run.code).toBe(0)
    expect(JSON.parse(run.stdout)).toMatchObject({ id, data: { echo: [REPORT] } })
    expect(run.sent[0]).toEqual({
      method: 'POST',
      path: `/agents/echo/${id}`,
      body: { kind: 'user', body: 'again' }
    })
  })

  it("removes its own run's sandbox through the app afterwards", async () => {
    codex.setResponses([submits(REPORT)])

    const run = await agent({ name: 'echo' })

    const runId = (JSON.parse(run.stdout) as { id: string }).id.replace(/-echo$/, '')
    expect(run.sent.at(-1)).toEqual({ method: 'DELETE', path: `/sandboxes/${runId}` })
  })

  it('keeps a sandbox named in --data, and a continued conversation’s', async () => {
    codex.setResponses([submits(REPORT), submits(REPORT)])

    const named = await agent({ name: 'echo', data: '{"sandbox":"my-box"}' })
    const { id } = JSON.parse(named.stdout) as { id: string }
    const continued = await agent({ name: 'echo', id })

    expect([named.code, continued.code]).toEqual([0, 0])
    expect([...named.sent, ...continued.sent].filter(s => s.method === 'DELETE')).toEqual([])
  })

  it("prints a failed run's error and exits 1, still removing its sandbox", async () => {
    codex.setResponses([]) // the model has nothing to answer: the run fails

    const run = await agent({ name: 'echo' })

    expect(run.code).toBe(1)
    expect(run.stdout).toBe('')
    expect(run.stderr).toContain('[fluex] failed: ')
    expect(run.stderr).toContain('No more faux responses queued')
    expect(run.sent.at(-1)).toMatchObject({ method: 'DELETE' })
  })

  it('aborts the run on its signal, waits for it to settle aborted, exits 130', async () => {
    const started = Promise.withResolvers<void>()
    codex.setResponses([
      // A model that answers only once its call is aborted, like a real provider stopping mid-stream.
      async (_, options) => {
        started.resolve()
        const signal = options?.signal
        if (signal && !signal.aborted)
          await new Promise(resolve => {
            signal.addEventListener('abort', resolve, { once: true })
          })
        return fauxAssistantMessage('', { stopReason: 'aborted' })
      }
    ])
    const interrupt = new AbortController()
    const http = overHttp(app)
    const stderr: string[] = []

    const running = runAgent(
      { name: 'echo' },
      {
        url: 'http://app.test',
        fetch: http.fetch,
        stdout: () => {},
        stderr: text => stderr.push(text),
        signal: interrupt.signal
      }
    )
    await started.promise
    interrupt.abort()

    expect(await running).toBe(130)
    expect(stderr.join('')).toContain('[fluex] aborted')
    expect(http.sent).toContainEqual({ method: 'POST', path: expect.stringMatching(/\/abort$/) })
    expect(http.sent.at(-1)).toMatchObject({ method: 'DELETE' })
  })

  it('keeps its sandbox when it loses the run before it settles, and exits 1', async () => {
    codex.setResponses([submits(REPORT)])
    const http = overHttp(app)
    // The app admits the message, then the client can no longer read the conversation.
    const lost = {
      sent: http.sent,
      fetch: (input: string | URL | Request, init?: RequestInit) =>
        (init?.method ?? 'GET') === 'GET'
          ? Promise.resolve(new Response('{"error":{"type":"gone"}}', { status: 400 }))
          : http.fetch(input, init)
    }

    const run = await agent({ name: 'echo' }, lost)

    expect(run.code).toBe(1)
    expect(run.sent.filter(s => s.method === 'DELETE')).toEqual([])
    expect(run.stderr).toMatch(/sandbox run-\S+ kept: pnpm sandbox rm run-/)
  })

  it('names an agent the app does not serve and exits 2', async () => {
    const run = await agent({ name: 'no-such-agent' })

    expect(run.code).toBe(2)
    expect(run.stderr).toContain('unknown agent no-such-agent')
  })

  it('says to start the app when none answers at the URL, and exits 1', async () => {
    const stderr: string[] = []

    const code = await runAgent(
      { name: 'echo' },
      {
        url: `http://127.0.0.1:${await closedPort()}`,
        stdout: () => {},
        stderr: text => stderr.push(text)
      }
    )

    expect(code).toBe(1)
    expect(stderr.join('')).toContain('start `pnpm dev` or set FLUE_URL')
  })

  it('refuses --data with --id, exit 2, sending nothing', async () => {
    const run = await agent({ name: 'echo', id: 'run-x-echo', data: '{"issue":1}' })

    expect(run.code).toBe(2)
    expect(run.stderr).toContain('--data')
    expect(run.sent).toEqual([])
  })

  it('refuses --data that is not a JSON object, exit 2', async () => {
    const run = await agent({ name: 'echo', data: '[1]' })

    expect(run.code).toBe(2)
    expect(run.sent).toEqual([])
  })
})
