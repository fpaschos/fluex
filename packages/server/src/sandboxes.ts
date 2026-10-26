import { Hono } from 'hono'
import type { ErrorHandler } from 'hono'
import { removeSandbox as removeDockerSandbox } from '@fluex/flue-docker'
import { describeError } from './errors.ts'

// The sandbox routes (an app mounts them at /sandboxes): clients remove the sandbox they keyed
// through the app, never through Docker, so they work the same against a remote app. Clients call
// them through @fluex/sdk's `removeSandbox`, or `hc<SandboxRoutes>` (hono/client).
//
//   DELETE /sandboxes/<key>   → 204 once no sandbox is left for the key; 500 { error } when removing fails

/** The routes; `removeSandbox` removes the sandbox of a key (none: a no-op). */
export function sandboxRoutes({
  removeSandbox = removeDockerSandbox
}: { removeSandbox?: (key: string) => Promise<void> } = {}) {
  /** Any error a route throws, as 500 { error }; kept per route when an app mounts these. */
  const failed: ErrorHandler = (error, c) => c.json({ error: describeError(error) }, 500)

  return new Hono()
    .delete('/:key', async c => {
      await removeSandbox(c.req.param('key'))
      return c.body(null, 204)
    })
    .onError(failed)
}

export type SandboxRoutes = ReturnType<typeof sandboxRoutes>
