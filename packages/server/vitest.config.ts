import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import { flue } from '@flue/vite'

// The tests load the fixture app (test/fixture/src) through flue(), as `vite dev` would. flue()'s
// dev-server hook would also boot it (and load ./.env) in vitest's own process: stripped, as in an
// app's own vitest config. Fails loudly if the plugin is renamed.
const plugins = flue()
if (!plugins.some(plugin => plugin.name === 'flue'))
  throw new Error('[vitest.config] no `flue` plugin to strip its dev-server hook from')

export default defineConfig({
  root: fileURLToPath(new URL('test/fixture', import.meta.url)),
  plugins: plugins.map(plugin =>
    plugin.name === 'flue' ? { ...plugin, configureServer: undefined } : plugin
  ),
  test: {
    name: '@fluex/server',
    dir: fileURLToPath(new URL('test', import.meta.url)),
    include: ['**/*.test.ts'],
    setupFiles: [fileURLToPath(new URL('test/support/env.ts', import.meta.url))],
    // Run through Vite, not Node: Flue's bootstrap imports the virtual modules, and the fluex
    // packages export raw .ts.
    server: { deps: { inline: ['@flue/vite', /^@fluex\//] } }
  }
})
