import { defineConfig } from 'vitest/config'

// One project per package: a package brings its own vitest.config.ts (@fluex/server loads a fixture
// app through flue()); the others run test/**/*.test.ts with the defaults.
export default defineConfig({
  test: {
    projects: ['packages/*']
  }
})
