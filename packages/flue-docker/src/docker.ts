import { resolve } from 'node:path'
import * as v from 'valibot'
import { sandboxFromDriver } from '@flue/runtime'
import type { SandboxDriver, SandboxFactory } from '@flue/runtime'
import { containerIds, oneAtATime } from './containers.ts'
import { checked, dockerCli, parsed, text } from './docker-cli.ts'
import type { DockerCli } from './docker-cli.ts'
import { execCommand } from './exec.ts'
import { fileOperations } from './files.ts'
import { containerName, LABEL, labelArgs, specIdentity, specMismatch } from './identity.ts'
import type { SpecIdentity } from './identity.ts'
import { containerSpec, IDLE, mountArgs, securityArgs, WORKSPACE } from './spec.ts'
import type { ContainerSpec, DockerOptions } from './spec.ts'

export type { DockerOptions } from './spec.ts'

/** How many times a `docker run` that loses a name race re-runs the lookup before giving up. */
const MAX_ATTEMPTS = 3

/** A Flue sandbox factory backed by one long-lived Docker container per sandbox key. */
export function docker(options: DockerOptions, cli: DockerCli = dockerCli): SandboxFactory {
  const { key = id => id, warn = message => console.warn(message) } = options
  const spec = containerSpec({ ...options, workspace: resolve(options.workspace) })
  return {
    async createSandbox({ id }) {
      const sandboxKey = key(id)
      const container = await oneAtATime(cli, sandboxKey, async () => {
        const ready = await ensureContainer(cli, sandboxKey, spec, warn)
        await refuseRoot(cli, ready, spec.image)
        return ready
      })
      return sandboxFromDriver(containerDriver(cli, container), WORKSPACE)
    }
  }
}

/**
 * The running container for `key`: the one found, started if stopped, or a new one when none is usable.
 * Another process may create the container between our lookup and our `docker run`; its name conflict re-runs the lookup.
 */
async function ensureContainer(
  cli: DockerCli,
  key: string,
  spec: ContainerSpec,
  warn: (message: string) => void
): Promise<string> {
  const imageId = await localImage(cli, spec.image)
  const identity = specIdentity(spec, imageId)
  for (let attempt = 1; ; attempt++) {
    const found = await findContainer(cli, key)
    const reused = found && (await reuse(cli, key, found, identity, warn))
    if (reused) return reused
    const created = await createContainer(cli, key, spec, imageId, identity)
    if (created !== undefined) return created
    if (attempt === MAX_ATTEMPTS) {
      throw new Error(
        `[fluex] sandbox ${key}: container ${containerName(key)} stayed taken after ${MAX_ATTEMPTS} attempts`
      )
    }
  }
}

/** The local id of `image`, pulled first when it is not local: `docker run` is then never left to pull. */
async function localImage(cli: DockerCli, image: string): Promise<string> {
  let inspected = await cli(['image', 'inspect', image])
  if (inspected.exitCode !== 0 && /No such image/i.test(inspected.stderr)) {
    // A pull can take minutes: no operation timeout.
    checked(
      await cli(['pull', image], { timeoutMs: Number.POSITIVE_INFINITY }),
      `docker pull ${image}`
    )
    inspected = await cli(['image', 'inspect', image])
  }
  const [{ Id }] = parsed(
    ImageSchema,
    text(checked(inspected, 'docker image inspect')),
    'docker image inspect'
  )
  return Id
}

const ImageSchema = v.tuple([v.object({ Id: v.string() })])
const ContainerSchema = v.tuple([
  v.object({
    Id: v.string(),
    State: v.object({ Status: v.string() }),
    Config: v.object({ Labels: v.nullish(v.record(v.string(), v.string())) })
  })
])

interface FoundContainer {
  id: string
  state: string
  labels: Record<string, string>
}

/** The container labelled with `key`, if one exists. */
async function findContainer(cli: DockerCli, key: string): Promise<FoundContainer | undefined> {
  const [ID] = await containerIds(cli, `label=${LABEL.sandbox}=${key}`)
  if (ID === undefined) return undefined
  const inspected = await cli(['inspect', '--type', 'container', ID])
  // Removed since `docker ps` listed it.
  if (inspected.exitCode !== 0 && /No such (object|container)/i.test(inspected.stderr))
    return undefined
  const [{ Id, State, Config }] = parsed(
    ContainerSchema,
    text(checked(inspected, 'docker inspect')),
    'docker inspect'
  )
  return { id: Id, state: State.Status, labels: Config.Labels ?? {} }
}

/** `found`'s id when it can serve `key` as is or once started or unpaused; otherwise removes it and returns `undefined`. */
async function reuse(
  cli: DockerCli,
  key: string,
  found: FoundContainer,
  identity: SpecIdentity,
  warn: (message: string) => void
): Promise<string | undefined> {
  const mismatch = specMismatch(found.labels, identity)
  if (mismatch !== undefined) {
    warn(`[fluex] sandbox ${key}: recreating container ${containerName(key)}, ${mismatch}`)
  } else if (found.state === 'created' || found.state === 'exited' || found.state === 'paused') {
    // A container that will not start (e.g. a mount gone from the host) is replaced instead.
    const resumed = await cli([found.state === 'paused' ? 'unpause' : 'start', found.id])
    if (resumed.exitCode === 0) return found.id
  } else if (found.state !== 'dead' && found.state !== 'removing') {
    return found.id
  }
  const removed = await cli(['rm', '--force', found.id])
  if (!/No such container/i.test(removed.stderr)) checked(removed, 'docker rm')
  return undefined
}

/** The new container's id, or `undefined` when another process took its name first. */
async function createContainer(
  cli: DockerCli,
  key: string,
  spec: ContainerSpec,
  imageId: string,
  identity: SpecIdentity
): Promise<string | undefined> {
  const result = await cli(
    [
      'run',
      '--detach',
      '--init',
      '--pull',
      'never',
      '--name',
      containerName(key),
      ...labelArgs(key, identity),
      ...mountArgs(spec),
      '-w',
      WORKSPACE,
      '--entrypoint',
      IDLE.entrypoint,
      ...securityArgs(spec),
      imageId,
      ...IDLE.args
    ],
    { envFile: spec.env }
  )
  if (
    result.exitCode !== 0 &&
    /Conflict\. The container name "[^"]*" is already in use/.test(result.stderr)
  )
    return undefined
  return text(checked(result, 'docker run', Object.values(spec.env ?? {}))).trim()
}

/**
 * Removes `container` and throws unless its user is shown to be non-root: the sandbox never runs the model's commands as uid 0.
 * Runs on every `createSandbox`, so a container left behind by a failed removal is refused again rather than reused.
 */
async function refuseRoot(cli: DockerCli, container: string, image: string): Promise<void> {
  const result = await cli(['exec', container, 'id', '-u'])
  const uid = text(result).trim()
  if (result.exitCode === 0 && /^[1-9]\d*$/.test(uid)) return
  await cli(['rm', '--force', container])
  throw new Error(
    result.exitCode === 0 && uid === '0'
      ? `[fluex] image ${image} runs as root (uid 0); set \`user\` to a non-root user`
      : `[fluex] could not check the user of image ${image} (exit ${result.exitCode}): ${result.stderr.trim() || uid}`
  )
}

function containerDriver(cli: DockerCli, container: string): SandboxDriver {
  return { ...fileOperations(cli, container), exec: execCommand(cli, container, WORKSPACE) }
}
