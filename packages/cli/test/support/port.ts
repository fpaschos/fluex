import { createServer } from 'node:net'
import type { AddressInfo } from 'node:net'

/** A local port nothing listens on: one the OS just handed out, closed again. */
export async function closedPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>(resolve => {
    server.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address() as AddressInfo
  await new Promise(resolve => {
    server.close(resolve)
  })
  return port
}
