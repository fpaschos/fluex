import { observe } from '@flue/runtime'
import { toolLog } from './tool-log.ts'
import type { ToolLogOptions } from './tool-log.ts'

/**
 * Mounts the tool log once per process, under `key`: a re-evaluation of the caller (a `vite dev`
 * reload, while @flue/runtime and its subscribers stay loaded) unsubscribes the previous mount
 * first, so each event is logged once, not once per reload.
 */
export function mountToolLog(options: ToolLogOptions, key = 'fluex.toolLog'): () => void {
  const slotKey = Symbol.for(key)
  const slot = globalThis as { [k: symbol]: (() => void) | undefined }
  slot[slotKey]?.()
  const unsubscribe = observe(toolLog(options))
  slot[slotKey] = unsubscribe
  return unsubscribe
}
