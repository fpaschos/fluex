import { Hono } from 'hono'
import { removeSandbox as removeDockerSandbox } from '@fluex/flue-docker'
import { describeError } from './utils.ts'

// The sandbox routes (src/app.ts mounts them at /sandboxes): clients remove the sandbox they keyed
// through the app, never through Docker, so they work the same against a remote app. Clients call
// them through `hc<SandboxRoutes>` (hono/client).
//
//   DELETE /sandboxes/<key>   → 204 once no sandbox is left for the key; 500 { error } when removing fails

/** The routes; `removeSandbox` removes the sandbox of a key (none: a no-op). */
export function sandboxRoutes({
  removeSandbox = removeDockerSandbox
}: { removeSandbox?: (key: string) => Promise<void> } = {}) {
  return new Hono().delete('/:key', async c => {
    try {
      await removeSandbox(c.req.param('key'))
    } catch (error) {
      return c.json({ error: describeError(error) }, 500)
    }
    return c.body(null, 204)
  })
}

export type SandboxRoutes = ReturnType<typeof sandboxRoutes>
