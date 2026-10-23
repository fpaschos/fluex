import { sqlite } from '@flue/runtime/node'

// Relative to the working directory: a temp directory per test run (test/support/env.ts).
export default sqlite('./data/flue.db')
