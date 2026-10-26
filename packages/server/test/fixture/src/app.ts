import { Hono } from 'hono'
import { scannedAgents } from 'virtual:flue/agents'
import { createAgentRouter } from '@flue/runtime/routing'
import { mountToolLog } from '@fluex/flue-tools'
import { sandboxRoutes } from '../../../src/sandboxes.ts'

// The fixture app the tests load (useApp): an app's route map as a project writes it, with the Echo
// agent and no sandbox, so no Docker and no .env.

mountToolLog({ runsDir: 'runs' }, 'fluex-server-fixture.toolLog')

const app = new Hono()

app.get('/health', c => c.json({ ok: true }))

for (const { identity, agent } of scannedAgents)
  app.route(`/agents/${identity}`, createAgentRouter(agent))

app.route('/sandboxes', sandboxRoutes())

export default app
