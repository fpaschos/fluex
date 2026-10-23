import { observe } from '@flue/runtime'
import { toolLog } from '@fluex/flue-tools'

// The tool log, mounted once from src/app.ts: lines go to stderr, records to runs/<id>/events.jsonl.
// `pnpm dev:watch` re-evaluates this module on a save while @flue/runtime (and its subscribers) stays
// loaded, so the previous evaluation's subscriber is removed first: one line per event, not one per reload.

const UNSUBSCRIBE = Symbol.for('superapp-flue.toolLog')
const slot = globalThis as { [UNSUBSCRIBE]?: () => void }
slot[UNSUBSCRIBE]?.()
slot[UNSUBSCRIBE] = observe(toolLog({ runsDir: 'runs' }))
