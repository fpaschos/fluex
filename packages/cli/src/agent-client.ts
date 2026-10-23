import {
  createFlueClient,
  FlueApiError,
  FlueExecutionError,
  newRunId,
  removeSandbox as removeAppSandbox
} from '@fluex/sdk'
import type { AgentSendResult, FlueClient } from '@fluex/sdk'
import { createLinePresenter } from './line-presenter.ts'

// The core of `pnpm agent` (src/agent.ts is its shell): one agent turn on the running app, over
// HTTP only. Everything it shows comes from the API.

/** What `pnpm agent <name> [-m <message>] [--data <json>] [--id <id>]` asks for. */
export interface AgentCommand {
  name: string
  /** Default `go`. */
  message?: string
  /** JSON object merged into a new conversation's initial data. */
  data?: string
  /** An existing conversation to continue (no initial data). */
  id?: string
}

/** Where the client talks to and writes. */
export interface AgentClientIO {
  /** The app's base URL (`FLUE_URL`). */
  url: string
  fetch?: typeof fetch
  stdout(text: string): void
  /** Gets the assistant's text and thinking as they stream, and the client's messages. */
  stderr(text: string): void
  /** Dims the thinking on stderr (a terminal). */
  color?: boolean
  /** Aborts the run (the first Ctrl-C); the client still waits for it to settle. */
  signal?: AbortSignal
  /**
   * A new conversation's initial data, before `--data` is merged over it: the project's defaults.
   * Default `{ sandbox: runId }`, the run's own sandbox, removed after the run.
   */
  initialData?: (runId: string) => Record<string, unknown>
}

/** How a run the app admitted ended for the client; only `lost` may still be going on the app. */
type Outcome =
  | { kind: 'completed'; text: string; data: Record<string, unknown[]> }
  | { kind: 'failed' | 'aborted' | 'lost'; message: string }

const EXIT = { completed: 0, failed: 1, lost: 1, aborted: 130 } as const

/** Runs one turn of `command`; answers the exit code. */
export async function runAgent(command: AgentCommand, io: AgentClientIO): Promise<number> {
  const say = (text: string) => io.stderr(`[fluex] ${text}\n`)

  if (command.id !== undefined && command.data !== undefined) {
    say('--data applies only to a new conversation; drop it with --id')
    return 2
  }
  const data = parseData(command.data)
  if (!data) {
    say('--data takes a JSON object')
    return 2
  }

  const base = io.url.replace(/\/+$/, '')
  const fetch = io.fetch ?? globalThis.fetch
  const runId = newRunId()
  const id = command.id ?? `${runId}-${command.name}`
  // Initial data only creates a conversation; a continued one keeps the sandbox it was created with.
  const defaults = io.initialData ?? (key => ({ sandbox: key }))
  const initialData = command.id === undefined ? { ...defaults(runId), ...data } : undefined
  const client = createFlueClient({ url: `${base}/agents/${command.name}/${id}`, fetch })

  let admission: AgentSendResult
  try {
    admission = await client.send({
      message: { kind: 'user', body: command.message ?? 'go' },
      initialData
    })
  } catch (error) {
    // The app routes only the agents it serves; the client keeps no list of them.
    if (error instanceof FlueApiError && error.status === 404) {
      say(`unknown agent ${command.name}`)
      return 2
    }
    // fetch rejects with a TypeError when nothing answers at the URL.
    if (error instanceof TypeError)
      say(`no app at ${base} (${causeOf(error)}): start \`pnpm dev\` or set FLUE_URL`)
    else say(`failed: ${messageOf(error)}`)
    return 1
  }

  const outcome = await follow(client, admission, id, io)
  if (outcome.kind === 'completed')
    io.stdout(`${JSON.stringify({ id, text: outcome.text, data: outcome.data }, null, 2)}\n`)
  else say(outcome.kind === 'aborted' ? 'aborted' : `${outcome.kind}: ${outcome.message}`)

  // Only a sandbox keyed by this run is ours to remove; one named in --data, or a continued
  // conversation's, is kept. A run the client lost may still be using it.
  if (initialData?.sandbox === runId) {
    if (outcome.kind === 'lost') say(`sandbox ${runId} kept: pnpm sandbox rm ${runId}`)
    else await removeSandbox(base, fetch, runId, say)
  }
  return EXIT[outcome.kind]
}

/** Reads the admitted run until it settles, showing its text; the signal asks the app to abort it. */
async function follow(
  client: FlueClient,
  admission: AgentSendResult,
  id: string,
  io: AgentClientIO
): Promise<Outcome> {
  const abort = () => {
    client
      .abort()
      .catch((error: unknown) => io.stderr(`[fluex] abort failed: ${messageOf(error)}\n`))
  }
  if (io.signal?.aborted) abort()
  else io.signal?.addEventListener('abort', abort, { once: true })
  const onEvent = createLinePresenter(id, admission.submissionId, {
    write: line => io.stderr(`${line}\n`),
    color: io.color
  })
  try {
    const { text, data } = await client.read(admission, { onEvent })
    return { kind: 'completed', text, data }
  } catch (error) {
    if (error instanceof FlueExecutionError && error.failure !== 'terminal_event_missing')
      return { kind: error.failure, message: messageOf(error.error ?? error) }
    return { kind: 'lost', message: messageOf(error) }
  } finally {
    io.signal?.removeEventListener('abort', abort)
  }
}

/** Removes the sandbox of `key` through the app; a failure is only reported. */
async function removeSandbox(
  base: string,
  fetch: typeof globalThis.fetch,
  key: string,
  say: (text: string) => void
) {
  try {
    await removeAppSandbox({ baseUrl: base, key, fetch })
  } catch (error) {
    say(`removing sandbox ${key} failed (${messageOf(error)}); pnpm sandbox rm ${key}`)
  }
}

/** `--data` as an object (none: `{}`), or undefined when it is not a JSON object. */
function parseData(json: string | undefined): Record<string, unknown> | undefined {
  if (json === undefined) return {}
  let data: unknown
  try {
    data = JSON.parse(json)
  } catch {
    return undefined
  }
  return typeof data === 'object' && data !== null && !Array.isArray(data)
    ? (data as Record<string, unknown>)
    : undefined
}

/** An error, or a settlement's recorded `{ message }`, as text. */
const messageOf = (error: unknown): string =>
  typeof error === 'object' && error !== null && 'message' in error
    ? String(error.message)
    : JSON.stringify(error)

/** Why fetch failed (`connect ECONNREFUSED …`): its cause's message, else its own. */
const causeOf = (error: TypeError): string =>
  error.cause instanceof Error ? error.cause.message : error.message
