import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import { flue } from '@flue/vite'

// The client tests run against @fluex/server's fixture app (useApp), loaded through flue() as in the
// server's own vitest.config.ts: its root, its offline setup, flue()'s dev-server hook stripped.
const plugins = flue()
if (!plugins.some(plugin => plugin.name === 'flue'))
  throw new Error('[vitest.config] no `flue` plugin to strip its dev-server hook from')

export default defineConfig({
  root: fileURLToPath(new URL('../server/test/fixture', import.meta.url)),
  plugins: plugins.map(plugin =>
    plugin.name === 'flue' ? { ...plugin, configureServer: undefined } : plugin
  ),
  test: {
    name: '@fluex/cli',
    dir: fileURLToPath(new URL('test', import.meta.url)),
    include: ['**/*.test.ts'],
    setupFiles: [fileURLToPath(new URL('../server/test/support/env.ts', import.meta.url))],
    server: { deps: { inline: ['@flue/vite', /^@fluex\//] } }
  }
})
