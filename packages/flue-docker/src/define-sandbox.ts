import type { SandboxFactory } from '@flue/runtime'
import { local } from '@flue/runtime/node'
import { dockerCli } from './docker-cli.ts'
import type { DockerCli } from './docker-cli.ts'
import { docker } from './docker.ts'
import { buildImage } from './image.ts'
import type { BuildImageOptions } from './image.ts'
import type { DockerOptions } from './spec.ts'

// The sandbox factory for one target project, in two steps: `defineSandbox(config)` once per project (the repo
// path, the image, env and mounts), then `(key?)` per client, run or agent.

export interface SandboxConfig extends Omit<DockerOptions, 'image' | 'key'> {
  /** Built on the first Docker sandbox of the process, then reused. */
  image: BuildImageOptions
  /** Added to `env` on the host only: what the container gets another way (image, mounts). */
  localEnv?: Record<string, string>
}

/**
 * The sandboxes of one project. With a key, the Docker container of that key: every factory with
 * the same key finds the same container, and whoever picks the key removes it (`removeSandbox`).
 * Without, the host itself, with the same env and `workspace` as cwd.
 */
export function defineSandbox(
  { image, localEnv, ...options }: SandboxConfig,
  cli: DockerCli = dockerCli
): (key?: string) => SandboxFactory {
  // An unchanged build is cached by Docker; a changed one yields a new image id, which recreates
  // the containers. A failed build is retried next time.
  let imageId: Promise<string> | undefined
  const built = () => {
    imageId ??= buildImage(image, cli).catch(error => {
      imageId = undefined
      throw error
    })
    return imageId
  }

  return key => {
    if (key === undefined)
      return local({ cwd: options.workspace, env: { ...options.env, ...localEnv } })
    return {
      async createSandbox(sandboxOptions) {
        return docker({ ...options, image: await built(), key: () => key }, cli).createSandbox(
          sandboxOptions
        )
      }
    }
  }
}
