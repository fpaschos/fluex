import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { defineSandbox } from '../src/define-sandbox.ts'
import type { DockerCli, DockerResult } from '../src/docker-cli.ts'

const IMAGE_ID = `sha256:${'a'.repeat(64)}`

/** A `docker` that builds `IMAGE_ID` and refuses everything else; records each command. */
function buildOnlyDocker() {
  const commands: string[] = []
  const cli: DockerCli = args => {
    const command = args[0] ?? ''
    commands.push(command)
    if (command !== 'build') return Promise.reject(new Error(`[test] no docker ${command}`))
    const built: DockerResult = {
      stdout: new TextEncoder().encode(`${IMAGE_ID}\n`),
      stderr: '',
      exitCode: 0
    }
    return Promise.resolve(built)
  }
  return { cli, commands }
}

describe('defineSandbox', () => {
  it('without a key, gives the host with the workspace as cwd and env plus localEnv', async () => {
    const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'fluex-define-sandbox-')))
    const sandboxes = defineSandbox({
      workspace,
      image: { dockerfile: 'Dockerfile', context: '.', tag: 'unused' },
      env: { FROM_ENV: 'env' },
      localEnv: { FROM_LOCAL: 'local' }
    })

    const sandbox = await sandboxes().createSandbox({ id: 'conv-a' })
    const result = await sandbox.exec('echo "$PWD $FROM_ENV $FROM_LOCAL"')

    expect(result.stdout.trim()).toBe(`${workspace} env local`)
  })

  it('with a key, builds the image once across the factories it hands out', async () => {
    const docker = buildOnlyDocker()
    const sandboxes = defineSandbox(
      {
        workspace: tmpdir(),
        image: { dockerfile: 'Dockerfile', context: '.', tag: 'test-image' }
      },
      docker.cli
    )

    await expect(sandboxes('key-a').createSandbox({ id: 'conv-a' })).rejects.toThrow('[test]')
    await expect(sandboxes('key-b').createSandbox({ id: 'conv-b' })).rejects.toThrow('[test]')

    expect(docker.commands.filter(command => command === 'build')).toEqual(['build'])
  })
})
