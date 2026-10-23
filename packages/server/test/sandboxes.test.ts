import { describe, expect, it } from 'vitest'
import { sandboxRoutes } from '../src/sandboxes.ts'

/** The sandbox routes, with a remover that only records its keys (or fails with `error`). */
function useRoutes({ error }: { error?: Error } = {}) {
  const removed: string[] = []
  const routes = sandboxRoutes({
    removeSandbox: key => {
      removed.push(key)
      return error ? Promise.reject(error) : Promise.resolve()
    }
  })
  return { removed, remove: (key: string) => routes.request(`/${key}`, { method: 'DELETE' }) }
}

describe('the sandbox route', () => {
  it('removes the sandbox of a key, with 204', async () => {
    const routes = useRoutes()

    const response = await routes.remove('run-20261023-120000-abcd')

    expect(response.status).toBe(204)
    expect(routes.removed).toEqual(['run-20261023-120000-abcd'])
  })

  it('answers 500 with the error when removing fails', async () => {
    const routes = useRoutes({ error: new Error('docker is not running') })

    const response = await routes.remove('my-box')

    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: 'docker is not running' })
  })
})
