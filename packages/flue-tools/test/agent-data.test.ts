import * as v from 'valibot'
import { describe, expect, it } from 'vitest'
import { agentData } from '../src/agent-data.ts'

describe('agentData', () => {
  it('takes no initial data as {}', () => {
    const schema = agentData({ sandbox: v.optional(v.string()) })

    expect(v.parse(schema, undefined)).toEqual({})
  })

  it('refuses initial data that does not match its entries', () => {
    const schema = agentData({ subscription: v.optional(v.picklist(['openai-codex'])) })

    expect(v.safeParse(schema, { subscription: 'no-such-subscription' }).success).toBe(false)
  })

  it('refuses no initial data when an entry is required', () => {
    const schema = agentData({ issue: v.number() })

    expect(v.safeParse(schema, undefined).success).toBe(false)
  })
})
