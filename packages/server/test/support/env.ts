import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The fixture app's ./data/flue.db and runs/ are relative to the working directory: a temp one.
process.chdir(mkdtempSync(join(tmpdir(), 'fluex-server-cwd-')))
