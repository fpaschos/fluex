import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { agentCli } from '../src/agent.ts'
import { closedPort } from './support/port.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** Runs `agentCli(args)` against FLUE_URL `url`; answers its exit code and output. */
async function pnpmAgent(args: string[], url: string) {
  const stdout: string[] = []
  const stderr: string[] = []
  vi.stubEnv('FLUE_URL', url)
  const out = (chunk: string | Uint8Array) => {
    stdout.push(String(chunk))
    return true
  }
  const err = (chunk: string | Uint8Array) => {
    stderr.push(String(chunk))
    return true
  }
  vi.spyOn(process.stdout, 'write').mockImplementation(out)
  vi.spyOn(process.stderr, 'write').mockImplementation(err)
  vi.spyOn(console, 'error').mockImplementation((line: unknown) => stderr.push(`${String(line)}\n`))
  vi.spyOn(console, 'log').mockImplementation((line: unknown) => stdout.push(`${String(line)}\n`))
  vi.spyOn(console, 'info').mockImplementation((line: unknown) => stdout.push(`${String(line)}\n`))
  const code = await agentCli(args)
  vi.restoreAllMocks()
  return { code, stdout: stdout.join(''), stderr: stderr.join('') }
}

/**
 * Every module `entry` loads: the files it reaches through relative imports, and the packages they
 * name. `import type` is erased at runtime, so it loads nothing.
 */
function importGraph(entry: string): { files: string[]; packages: string[] } {
  const files = new Set<string>()
  const packages = new Set<string>()
  const visit = (file: string) => {
    if (files.has(file)) return
    files.add(file)
    for (const [, type, specifier] of readFileSync(file, 'utf8').matchAll(
      /^(?:import|export)\s+(type\s+)?(?:[^']*?\s+from\s+)?'([^']+)'/gm
    )) {
      if (type !== undefined || specifier === undefined) continue
      if (specifier.startsWith('.')) visit(resolve(dirname(file), specifier))
      else packages.add(specifier)
    }
  }
  visit(entry)
  return { files: [...files], packages: [...packages] }
}

describe('agentCli', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('says to start the app when none answers at FLUE_URL, and answers 1', async () => {
    const run = await pnpmAgent(['echo'], `http://127.0.0.1:${await closedPort()}`)

    expect(run.code).toBe(1)
    expect(run.stdout).toBe('')
    expect(run.stderr).toContain('start `pnpm dev` or set FLUE_URL')
  })

  it('sends -m and --id as typed, not as numbers', async () => {
    // A fake app: records the message, then serves no agent.
    const posted: { path: string; body: unknown }[] = []
    const server = createServer((request, response) => {
      let body = ''
      request.on('data', (chunk: Buffer) => (body += chunk.toString()))
      request.on('end', () => {
        posted.push({ path: request.url ?? '', body: JSON.parse(body || 'null') as unknown })
        response.writeHead(404).end()
      })
    })
    await new Promise<void>(done => {
      server.listen(0, '127.0.0.1', done)
    })
    const { port } = server.address() as AddressInfo

    const run = await pnpmAgent(['echo', '-m', '3.10', '--id', '007'], `http://127.0.0.1:${port}`)
    server.close()

    expect(run.code).toBe(2)
    expect(posted).toEqual([{ path: '/agents/echo/007', body: { kind: 'user', body: '3.10' } }])
  })

  it('refuses an unknown option with 2', async () => {
    const run = await pnpmAgent(['echo', '--env', '.env'], `http://127.0.0.1:${await closedPort()}`)

    expect(run.code).toBe(2)
    expect(run.stderr).toContain('--env')
  })

  it('refuses a missing agent name with 2', async () => {
    const run = await pnpmAgent([], `http://127.0.0.1:${await closedPort()}`)

    expect(run.code).toBe(2)
    expect(run.stderr).toContain('missing required args')
  })

  it('loads no server, no Docker and no Vite: it is only a client of the app', () => {
    const { packages } = importGraph(join(ROOT, 'src/index.ts'))
    const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>
    }

    expect(
      packages.filter(name =>
        /^(@fluex\/server|@fluex\/flue-docker|vite|@flue\/vite|virtual:)/.test(name)
      )
    ).toEqual([])
    expect(packages).toContain('@fluex/sdk')
    expect(Object.keys(manifest.dependencies)).not.toContain('@fluex/server')
  })
})
