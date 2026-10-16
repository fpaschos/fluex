import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai'
import type { FauxResponseFactory } from '@earendil-works/pi-ai'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { init, useModel, useSandbox } from '@flue/runtime'
import type { SandboxFactory } from '@flue/runtime'
import { local, start } from '@flue/runtime/node'
import { withSandboxTools, withSkills } from '../src/filters.ts'
import { withInterceptors } from '../src/interceptors.ts'
import type { ToolInterceptor } from '../src/interceptors.ts'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fluex-filters-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** The tool names a factory offers over a real local sandbox rooted at `dir`. */
async function toolNames(factory: SandboxFactory) {
  const sandbox = await factory.createSandbox({ id: 'test' })
  const tools = factory.tools!(sandbox, { subagents: {} })
  return tools.map(tool => tool.name)
}

/** Workspace skills `<dir>/.agents/skills/<name>/SKILL.md`. */
function workspaceSkills(...names: string[]) {
  for (const name of names) {
    const skillDir = join(dir, '.agents', 'skills', name)
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      `---\nname: ${name}\ndescription: Skill ${name}.\n---\nInstructions of ${name}.\n`
    )
  }
}

/** Run a Flue agent over `factory` with a scripted model that activates `skill`: its skill catalog, and the activation result. */
async function offerOf(factory: SandboxFactory, skill: string) {
  const offer = { catalog: [] as string[], activation: '' }
  const faux = fauxProvider({ provider: 'faux', models: [{ id: 'model' }] })

  const activate: FauxResponseFactory = context => {
    const system = JSON.stringify(context.messages[0])
    const entries = system.matchAll(/- \*\*([\w-]+)\*\* — Skill /g)
    const skillName = (match: RegExpExecArray) => match[1]!
    offer.catalog = [...entries].map(skillName)
    const call = fauxToolCall('activate_skill', { name: skill })
    return fauxAssistantMessage(call)
  }
  const finish: FauxResponseFactory = context => {
    const last = context.messages.at(-1)
    offer.activation = JSON.stringify(last)
    return fauxAssistantMessage('done')
  }
  faux.setResponses([activate, finish])

  function probe() {
    useModel('faux/model')
    useSandbox(factory)
    return 'You are a probe.'
  }

  const flue = await start({ agents: [probe], providers: [faux.provider] })
  try {
    const agent = init(probe, { id: 'probe' })
    const receipt = await agent.dispatch({ message: 'go' })
    await agent.read(receipt)
  } finally {
    await flue.stop()
  }
  return offer
}

describe('withSandboxTools', () => {
  it('removes the excluded tools', async () => {
    const readOnly = withSandboxTools(local({ cwd: dir }), { exclude: ['write', 'edit'] })
    expect(await toolNames(readOnly)).toEqual(['read', 'bash', 'grep', 'glob'])
  })

  it('keeps exactly the listed tools', async () => {
    const searcher = withSandboxTools(local({ cwd: dir }), { only: ['grep', 'read'] })
    expect(await toolNames(searcher)).toEqual(['read', 'grep'])
  })
})

describe('withSkills', () => {
  it('offers only the listed skills, and activating another one fails', async () => {
    workspaceSkills('a', 'b')
    const offer = await offerOf(withSkills(local({ cwd: dir }), { only: ['a'] }), 'b')
    expect(offer.catalog).toEqual(['a'])
    expect(offer.activation).toContain('Skill \\"b\\" is not available')
  })

  it('hides the excluded skills', async () => {
    workspaceSkills('a', 'b', 'c')
    const offer = await offerOf(withSkills(local({ cwd: dir }), { exclude: ['b', 'c'] }), 'a')
    expect(offer.catalog).toEqual(['a'])
    expect(offer.activation).toContain('Instructions of a')
  })
})

/** What a composed factory does: the tools it offers, the skills it lists, the tool calls it intercepts. */
async function effectsOf(factory: SandboxFactory, seen: string[]) {
  const sandbox = await factory.createSandbox({ id: 'test' })
  const tools = factory.tools!(sandbox, { subagents: {} })
  const bash = tools.find(tool => tool.name === 'bash')!
  await bash.execute('call-bash', { command: 'echo hi' })
  const skills = await sandbox.readdir('.agents/skills')
  return {
    tools: tools.map(tool => tool.name),
    skills: skills.sort(),
    intercepted: seen
  }
}

describe('composing filters', () => {
  const tracer = (seen: string[]): ToolInterceptor => ({
    intercept: async (call, next) => {
      seen.push(call.tool)
      return next()
    }
  })
  const readOnly = (f: SandboxFactory) => withSandboxTools(f, { exclude: ['write', 'edit'] })
  const onlyA = (f: SandboxFactory) => withSkills(f, { only: ['a'] })
  const traced = (seen: string[]) => (f: SandboxFactory) => withInterceptors(f, tracer(seen))

  type Wrap = (f: SandboxFactory) => SandboxFactory
  const allTools = ['read', 'write', 'edit', 'bash', 'grep', 'glob']
  const readOnlyTools = ['read', 'bash', 'grep', 'glob']
  const pairs = [
    {
      name: 'withSandboxTools and withSkills',
      wraps: (_seen: string[]): Wrap[] => [readOnly, onlyA],
      expected: { tools: readOnlyTools, skills: ['a'], intercepted: [] }
    },
    {
      name: 'withSandboxTools and withInterceptors',
      wraps: (seen: string[]): Wrap[] => [readOnly, traced(seen)],
      expected: { tools: readOnlyTools, skills: ['a', 'b'], intercepted: ['bash'] }
    },
    {
      name: 'withSkills and withInterceptors',
      wraps: (seen: string[]): Wrap[] => [onlyA, traced(seen)],
      expected: { tools: allTools, skills: ['a'], intercepted: ['bash'] }
    }
  ]

  for (const { name, wraps, expected } of pairs) {
    for (const order of ['as listed', 'reversed']) {
      it(`${name} give both effects, composed ${order}`, async () => {
        workspaceSkills('a', 'b')
        const seen: string[] = []
        const listed = wraps(seen)
        const [outer, inner] = order === 'as listed' ? listed : listed.reverse()
        const composed = outer!(inner!(local({ cwd: dir })))
        expect(await effectsOf(composed, seen)).toEqual(expected)
      })
    }
  }

  it('stacks repeated excludes as a union and repeated onlys as an intersection', async () => {
    workspaceSkills('a', 'b', 'c')
    const sandbox = local({ cwd: dir })

    const noWrite = withSandboxTools(sandbox, { exclude: ['write'] })
    const noWriteNoEdit = withSandboxTools(noWrite, { exclude: ['edit'] })
    expect(await toolNames(noWriteNoEdit)).toEqual(['read', 'bash', 'grep', 'glob'])

    const readers = withSandboxTools(sandbox, { only: ['read', 'grep', 'bash'] })
    const searchers = withSandboxTools(readers, { only: ['grep', 'glob', 'bash'] })
    expect(await toolNames(searchers)).toEqual(['bash', 'grep'])

    const noA = withSkills(sandbox, { exclude: ['a'] })
    const noAnoB = withSkills(noA, { exclude: ['b'] })
    const excluded = await offerOf(noAnoB, 'c')
    expect(excluded.catalog).toEqual(['c'])

    const ab = withSkills(sandbox, { only: ['a', 'b'] })
    const bc = withSkills(ab, { only: ['b', 'c'] })
    const intersected = await offerOf(bc, 'b')
    expect(intersected.catalog).toEqual(['b'])
  })
})
