import { existsSync } from 'node:fs'
import { chmod, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { dockerCli } from '../src/docker-cli.ts'

/**
 * A stand-in `docker` on PATH: `docker sleep <s>` hangs, `docker bytes <n> <stream>` writes n bytes to stdout or stderr,
 * `docker envfile <args>` prints its args, then the mode and contents of the file after `--env-file`,
 * `docker clientenv <args>` prints the client's Docker settings, then the contents of the file after `--env-file`.
 */
const FAKE_DOCKER = `#!/bin/sh
case "$1" in
	sleep) exec sleep "$2" ;;
	bytes) if [ "$3" = stderr ]; then head -c "$2" /dev/zero | tr '\\0' x >&2; else head -c "$2" /dev/zero | tr '\\0' x; fi ;;
	tail) printf 'abcdefghij'; printf 'ABCDEFGHIJ' >&2 ;;
	envfile) echo "$@"; ls -l "$3" | cut -c1-10; cat "$3" ;;
	clientenv) echo "$DOCKER_HOST|$DOCKER_TLS_VERIFY|$DOCKER_CERT_PATH"; cat "$3" ;;
esac
`

beforeAll(async () => {
  const bin = await mkdtemp(join(tmpdir(), 'fluex-fake-docker-'))
  await writeFile(join(bin, 'docker'), FAKE_DOCKER)
  await chmod(join(bin, 'docker'), 0o755)
  vi.stubEnv('PATH', `${bin}${delimiter}${process.env.PATH}`)
})

describe('dockerCli', () => {
  it('throws when a call outlives its operation timeout', async () => {
    const started = Date.now()
    await expect(dockerCli(['sleep', '10'], { timeoutMs: 200 })).rejects.toThrow(
      /docker sleep timed out after 200 ms/
    )
    expect(Date.now() - started).toBeLessThan(3000)
  })

  it('keeps only the last tailBytes of stdout and of stderr', async () => {
    const result = await dockerCli(['tail'], { tailBytes: 4 })

    expect(new TextDecoder().decode(result.stdout)).toBe('ghij')
    expect(result.stderr).toBe('GHIJ')
  })

  it('keeps the tail of output streamed in many chunks', async () => {
    const result = await dockerCli(['bytes', '5000000'], { tailBytes: 1000 })

    expect(result.stdout).toEqual(new Uint8Array(1000).fill('x'.charCodeAt(0)))
  })

  it('keeps nothing with tailBytes 0', async () => {
    const result = await dockerCli(['tail'], { tailBytes: 0 })

    expect(result.stdout).toEqual(new Uint8Array())
    expect(result.stderr).toBe('')
  })

  describe('envFile', () => {
    const run = (envFile: Record<string, string>) =>
      dockerCli(['envfile', '-i', 'ctr'], { envFile })

    it('passes the values in an owner-only --env-file right after the subcommand, and removes it after the call', async () => {
      const result = await run({ PATH: '/container/bin', HOME: '/home/agent', TOKEN: 'a b=c ' })

      const [args, mode, ...lines] = new TextDecoder().decode(result.stdout).split('\n')
      const file = args!.split(' ')[2]!
      expect(args).toBe(`envfile --env-file ${file} -i ctr`)
      expect(mode).toBe('-rw-------')
      expect(lines).toEqual(['PATH=/container/bin', 'HOME=/home/agent', 'TOKEN=a b=c ', ''])
      expect(existsSync(file)).toBe(false)
    })

    it('adds no --env-file when there is no env', async () => {
      const result = await run({})

      expect(new TextDecoder().decode(result.stdout).split('\n')[0]).toBe('envfile -i ctr')
    })

    it.each([
      ['a newline', { TOKEN: 'secret-1\nmore' }],
      ['a carriage return', { TOKEN: 'secret-1\r' }],
      ['a NUL', { TOKEN: 'secret-1\0' }]
    ])('refuses a value containing %s without revealing it', async (_case, envFile) => {
      const error = (await run(envFile).catch((caught: unknown) => caught)) as Error

      expect(error.message).toMatch(
        /\[fluex\] env TOKEN: value contains a newline, carriage return or NUL/
      )
      expect(error.message).not.toContain('secret-1')
    })

    it("leaves the host's Docker client settings to the client, out of the container's env", async () => {
      vi.stubEnv('DOCKER_HOST', 'tcp://docker:2376')
      vi.stubEnv('DOCKER_TLS_VERIFY', '1')
      vi.stubEnv('DOCKER_CERT_PATH', '/certs/client')

      const result = await dockerCli(['clientenv', '-i', 'ctr'], { envFile: { TOKEN: 't' } })

      expect(new TextDecoder().decode(result.stdout)).toBe(
        'tcp://docker:2376|1|/certs/client\nTOKEN=t\n'
      )
    })

    it.each(['', '1X', 'A-B', '#X', 'A B'])('refuses the key %j', async key => {
      await expect(run({ [key]: 'v' })).rejects.toThrow(
        /must be a letter or _ followed by letters, digits or _/
      )
    })
  })
})
