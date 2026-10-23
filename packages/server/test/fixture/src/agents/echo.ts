'use agent'
import * as v from 'valibot'
import { useModel } from '@flue/runtime'
import { agentData, useStructuredResult } from '@fluex/flue-tools'

/** The fixture agent: no sandbox; its model (faux in tests) reports `{ ok }` into the reply's `data.echo`. */
export function Echo() {
  useModel('openai-codex/gpt-6-luna')
  useStructuredResult('echo', v.object({ ok: v.boolean() }))
  return 'go'
}
Echo.agentName = 'echo'
Echo.initialData = agentData({
  sandbox: v.optional(v.string()),
  subscription: v.optional(v.picklist(['openai-codex']))
})
