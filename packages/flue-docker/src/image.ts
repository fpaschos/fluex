import { checked, dockerCli, text } from './docker-cli.ts'
import type { DockerCli } from './docker-cli.ts'

export interface BuildImageOptions {
  /** Path to the Dockerfile. */
  dockerfile: string
  /** The build context directory. */
  context: string
  /** Tag given to the built image. */
  tag: string
}

/**
 * Builds the image and returns its id. It always runs `docker build`: Docker's layer cache makes an unchanged build
 * cheap and gives it the same id, while any change to the Dockerfile or its context gives a new id, which recreates
 * the containers of a `docker()` factory using it.
 */
export async function buildImage(
  { dockerfile, context, tag }: BuildImageOptions,
  cli: DockerCli = dockerCli
): Promise<string> {
  // A build can take minutes: no operation timeout.
  const built = await cli(['build', '--quiet', '--file', dockerfile, '--tag', tag, context], {
    timeoutMs: Number.POSITIVE_INFINITY
  })
  const id = text(checked(built, 'docker build')).trim()
  // A builder that does not load its result into the local image store (e.g. buildx's docker-container driver) prints none.
  if (!/^sha256:[0-9a-f]{64}$/.test(id))
    throw new Error(`[fluex] docker build printed no image id for ${tag}`)
  return id
}
