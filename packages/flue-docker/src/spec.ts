import { realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, posix } from 'node:path'

/** The sandbox `cwd`, where the workspace is mounted. */
export const WORKSPACE = '/workspace'

/**
 * What the container runs: it idles until exec'd into. The image's own entrypoint is replaced, so any image works,
 * however it was built.
 */
export const IDLE = { entrypoint: 'sleep', args: ['infinity'] } as const

/** A host path bind-mounted into the container. */
export interface Mount {
  /** Absolute, existing host path. */
  host: string
  /** Absolute container path, outside `/workspace`. */
  container: string
  /** Defaults to `true`; writable mounts must say `readonly: false`. */
  readonly?: boolean
}

/** The container's limits. Each field left out keeps its default. */
export interface Resources {
  /** `docker run --memory`. Defaults to `6g`. */
  memory?: string
  /** `docker run --cpus`. Defaults to `6`. */
  cpus?: number
  /** `docker run --pids-limit`. Defaults to `1024`. */
  pids?: number
}

const DEFAULT_RESOURCES: Required<Resources> = { memory: '6g', cpus: 6, pids: 1024 }

/** The settings a container is created with, validated and with every default applied. */
export interface ContainerSpec {
  image: string
  workspace: string
  mounts: Required<Mount>[]
  env?: Record<string, string>
  user?: string
  resources: Required<Resources>
  network: string
}

export interface DockerOptions {
  /** Image tag or id the container runs. It must provide bash and GNU coreutils/findutils (`stat -c`, `find -printf`): Debian-based, not Alpine/BusyBox. */
  image: string
  /** Host directory bind-mounted read-write at `/workspace`, the sandbox `cwd`. */
  workspace: string
  /** Extra host paths to bind-mount, read-only unless `readonly: false`. */
  mounts?: Mount[]
  /** The container's whole environment: the host's is never forwarded. Values never appear in argv, and cannot hold a newline. */
  env?: Record<string, string>
  /** `docker run --user`. Defaults to the image's own user, which must not be root. */
  user?: string
  /** Memory, CPU and PID limits; defaults `6g`, `6`, `1024`. */
  resources?: Resources
  /** `docker run --network`. Defaults to `bridge`. */
  network?: string
  /** The sandbox key for a Flue instance id: instances with the same key share one container. Defaults to the id itself. */
  key?: (id: string) => string
  /** Where notices go, such as a container being recreated because its spec changed. Defaults to `console.warn`. */
  warn?: (message: string) => void
}

/** `options` validated, with every default applied, or an error naming the workspace or mount that may not be mounted. */
export function containerSpec(options: DockerOptions): ContainerSpec {
  const problem = hostPathProblem(options.workspace)
  if (problem) throw new Error(`[fluex] workspace ${options.workspace}: ${problem}`)
  return {
    image: options.image,
    workspace: options.workspace,
    mounts: validMounts(options.mounts ?? []),
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.user === undefined ? {} : { user: options.user }),
    resources: {
      memory: options.resources?.memory ?? DEFAULT_RESOURCES.memory,
      cpus: options.resources?.cpus ?? DEFAULT_RESOURCES.cpus,
      pids: options.resources?.pids ?? DEFAULT_RESOURCES.pids
    },
    network: options.network ?? 'bridge'
  }
}

/** The mounts with `readonly` defaulted, or an error naming the first one that may not be mounted. */
function validMounts(mounts: Mount[]): Required<Mount>[] {
  const destinations = new Set<string>()
  return mounts.map(mount => {
    const problem =
      hostPathProblem(mount.host) ?? containerPathProblem(mount.container, destinations)
    if (problem) throw new Error(`[fluex] mount ${mount.host} -> ${mount.container}: ${problem}`)
    return { ...mount, readonly: mount.readonly ?? true }
  })
}

/** Why a host path may not be bind-mounted: it must be absolute and exist, and not expose the host's root, home, sockets or devices. */
function hostPathProblem(host: string): string | undefined {
  if (!isAbsolute(host)) return 'host path must be absolute'
  let real: string
  try {
    real = realpathSync(host)
  } catch {
    return 'host path does not exist'
  }
  const stat = statSync(real)
  if (real === '/') return 'host path is / (the host root)'
  const home = realHome()
  if (real === home) return 'host path is the home directory'
  if (home.startsWith(`${real}/`)) return 'host path contains the home directory'
  if (dockerSockets().some(socket => socket.startsWith(`${real}/`)))
    return 'host path contains the Docker socket'
  if (host.endsWith('.sock') || real.endsWith('.sock') || stat.isSocket())
    return 'host path is a socket'
  if (
    real === '/dev' ||
    real.startsWith('/dev/') ||
    stat.isCharacterDevice() ||
    stat.isBlockDevice()
  ) {
    return 'host path is a device'
  }
  return undefined
}

/** The home directory with symlinks resolved, or as given when it does not exist (e.g. `HOME=/nonexistent` on CI). */
function realHome(): string {
  try {
    return realpathSync(homedir())
  } catch {
    return homedir()
  }
}

/**
 * Where the Docker daemon's socket usually lives, each with its directory's symlinks resolved, so a mount of `/var/run`
 * is caught whether the entry sits there (`/run` on Linux) or not. The entry need not exist: any of them may appear later.
 */
function dockerSockets(): string[] {
  return [
    '/var/run/docker.sock',
    '/run/docker.sock',
    join(homedir(), '.docker', 'run', 'docker.sock')
  ].map(socket => {
    try {
      return join(realpathSync(dirname(socket)), basename(socket))
    } catch {
      return socket
    }
  })
}

/** Why a container path may not be a mount destination; records it in `taken`. */
function containerPathProblem(container: string, taken: Set<string>): string | undefined {
  if (!posix.isAbsolute(container)) return 'container path must be absolute'
  const normalized = posix.normalize(container).replace(/(.)\/+$/, '$1')
  const within = (inner: string, outer: string) =>
    inner === outer || inner.startsWith(outer === '/' ? '/' : `${outer}/`)
  if (within(normalized, WORKSPACE) || within(WORKSPACE, normalized))
    return `container path overlaps ${WORKSPACE}`
  if (taken.has(normalized)) return 'container path is mounted twice'
  taken.add(normalized)
  return undefined
}

/** The `docker run` flags that confine the container: no capabilities, no new privileges, bounded resources. */
export function securityArgs(spec: ContainerSpec): string[] {
  const { memory, cpus, pids } = spec.resources
  return [
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--memory',
    memory,
    '--cpus',
    String(cpus),
    '--pids-limit',
    String(pids),
    '--network',
    spec.network,
    ...(spec.user === undefined ? [] : ['--user', spec.user])
  ]
}

/** `--mount` flags for the workspace, read-write at `/workspace`, then each extra mount. */
export function mountArgs(spec: ContainerSpec): string[] {
  return [{ host: spec.workspace, container: WORKSPACE, readonly: false }, ...spec.mounts].flatMap(
    mount => ['--mount', bindMount(mount)]
  )
}

/** A `--mount` value. Docker parses it as CSV, so the paths are quoted to survive `,` `:` and `"`. */
function bindMount({ host, container, readonly }: Required<Mount>): string {
  const quoted = (field: string) => `"${field.replaceAll('"', '""')}"`
  return [
    'type=bind',
    quoted(`source=${host}`),
    quoted(`target=${container}`),
    ...(readonly ? ['readonly'] : [])
  ].join(',')
}
