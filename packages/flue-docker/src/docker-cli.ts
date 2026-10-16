import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execa } from 'execa'
import * as v from 'valibot'

export interface DockerResult {
  stdout: Uint8Array
  stderr: string
  exitCode: number
}

export interface DockerCallOptions {
  stdin?: string | Uint8Array
  /** Hold the child's stdin open, unwritten, until it exits: `docker exec -i` then sees it close only when this client ends. */
  holdStdin?: boolean
  /**
   * Container env for `docker run` or `docker exec`: written to an owner-only file passed as `--env-file` right after
   * the subcommand, so values reach neither argv nor the `docker` client's own environment. Values cannot hold a newline.
   */
  envFile?: Record<string, string>
  /** Operation timeout; a call that outlives it throws. Defaults to 30 s; `Infinity` for a model's command, which has its own deadline. */
  timeoutMs?: number
  signal?: AbortSignal
  /** Keep only the last this-many bytes of stdout and of stderr, so a runaway command cannot exhaust memory. */
  tailBytes?: number
}

/** One `docker` invocation. Every Docker call fluex makes goes through this seam. */
export type DockerCli = (args: string[], options?: DockerCallOptions) => Promise<DockerResult>

const OPERATION_TIMEOUT_MS = 30_000

/** The real `docker` CLI, run without a shell. A non-zero exit is returned, not thrown; a timeout is thrown. */
export const dockerCli: DockerCli = (args, options = {}) =>
  withEnvFile(options.envFile ?? {}, envFileArgs => {
    const [subcommand, ...rest] = args
    return runDocker(subcommand === undefined ? [] : [subcommand, ...envFileArgs, ...rest], options)
  })

async function runDocker(args: string[], options: DockerCallOptions): Promise<DockerResult> {
  const timeoutMs = options.timeoutMs ?? OPERATION_TIMEOUT_MS
  const stdout = new Tail(options.tailBytes)
  const stderr = new Tail(options.tailBytes)
  const subprocess = execa('docker', args, {
    ...(options.holdStdin
      ? { stdin: 'pipe' }
      : options.stdin === undefined
        ? { stdin: 'ignore' }
        : { input: options.stdin }),
    timeout: Number.isFinite(timeoutMs) ? timeoutMs : undefined,
    cancelSignal: options.signal,
    encoding: 'buffer',
    buffer: false,
    reject: false
  })
  subprocess.stdout.on('data', (chunk: Uint8Array) => stdout.push(chunk))
  subprocess.stderr.on('data', (chunk: Uint8Array) => stderr.push(chunk))
  const result = await subprocess
  if (result.timedOut) {
    throw new Error(`[fluex] docker ${args[0]} timed out after ${timeoutMs} ms`)
  }
  return {
    stdout: stdout.bytes(),
    stderr: new TextDecoder().decode(stderr.bytes()),
    exitCode: result.exitCode ?? 1
  }
}

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Runs `call` with `--env-file <path>` for `env` (none when empty), deleting the file afterwards. */
async function withEnvFile<T>(
  env: Record<string, string>,
  call: (envFileArgs: string[]) => Promise<T>
): Promise<T> {
  const entries = Object.entries(env)
  if (entries.length === 0) return call([])
  for (const [key, value] of entries) {
    // Docker reads the file line by line: `#` starts a comment, a trailing `\r` is dropped.
    if (!ENV_KEY.test(key))
      throw new Error(`[fluex] env ${key}: must be a letter or _ followed by letters, digits or _`)
    if (/[\n\r\0]/.test(value))
      throw new Error(`[fluex] env ${key}: value contains a newline, carriage return or NUL`)
  }
  const dir = await mkdtemp(join(tmpdir(), 'fluex-env-'))
  try {
    const file = join(dir, 'env')
    await writeFile(file, entries.map(([key, value]) => `${key}=${value}\n`).join(''), {
      mode: 0o600
    })
    return await call(['--env-file', file])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** The last `limit` bytes of a stream, dropping whole chunks from the front as it grows. */
class Tail {
  private readonly limit: number
  private readonly chunks: Uint8Array[] = []
  private size = 0

  constructor(limit = Number.POSITIVE_INFINITY) {
    this.limit = limit
  }

  push(chunk: Uint8Array) {
    this.chunks.push(chunk)
    this.size += chunk.length
    while (this.chunks.length > 1 && this.size - this.chunks[0]!.length >= this.limit) {
      this.size -= this.chunks.shift()!.length
    }
  }

  bytes(): Uint8Array {
    const all = new Uint8Array(this.size)
    let offset = 0
    for (const chunk of this.chunks) {
      all.set(chunk, offset)
      offset += chunk.length
    }
    return all.subarray(Math.max(0, all.length - this.limit))
  }
}

/** UTF-8 text of a call's stdout. A leading BOM is kept, as Node's `fs.readFile(path, 'utf8')` does. */
export const text = (result: { stdout: Uint8Array }) =>
  new TextDecoder('utf-8', { ignoreBOM: true }).decode(result.stdout)

/**
 * Whether a `docker exec` failed because its container is stopped or removed, judged by the daemon's own message.
 * Only at the very start of stderr: a command may quote the message later in its own output.
 */
export const containerGone = (stderr: string) =>
  /^Error response from daemon: (No such container|container \S+ is not running)/.test(stderr)

/** `result`, or an error carrying its stderr with every value in `secrets` replaced by `***`. */
export function checked<T extends { exitCode: number; stderr: string }>(
  result: T,
  what: string,
  secrets: string[] = []
): T {
  if (result.exitCode !== 0) {
    throw new Error(
      `[fluex] ${what} failed (exit ${result.exitCode}): ${redact(result.stderr.trim(), secrets)}`
    )
  }
  return result
}

/** `text` with each non-empty secret replaced by `***`, longest first so a secret containing another goes whole. */
function redact(text: string, secrets: string[]): string {
  return secrets
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
    .reduce((redacted, secret) => redacted.replaceAll(secret, '***'), text)
}

/**
 * `raw` parsed as JSON and checked against `schema`, or an error naming the `docker` call. Only the paths and expected
 * types of the problems are reported: Docker's output can hold container env values.
 */
export function parsed<const S extends v.GenericSchema>(
  schema: S,
  raw: string,
  what: string
): v.InferOutput<S> {
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    throw new Error(`[fluex] ${what} returned unexpected output: not JSON`)
  }
  const result = v.safeParse(schema, json)
  if (result.success) return result.output
  const problems = result.issues.map(
    issue => `${v.getDotPath(issue) ?? '(root)'}: expected ${issue.expected ?? issue.kind}`
  )
  throw new Error(`[fluex] ${what} returned unexpected output: ${problems.join('; ')}`)
}
