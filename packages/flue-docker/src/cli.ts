import { parseArgs } from 'node:util'
import { listSandboxes, pruneSandboxes, removeSandbox } from '@fluex/flue-docker'
import type { SandboxInfo } from '@fluex/flue-docker'

// `pnpm sandbox ls|rm <key>|prune [--state <state>]`: the fluex sandbox containers, selected by
// their fluex labels (never by name). A key is the Flue instance id printed after each run.

const USAGE = 'usage: pnpm sandbox ls | rm <key> | prune [--state <state>]'
const HEADERS = ['KEY', 'STATE', 'CREATED', 'NAME', 'IMAGE']

function table(sandboxes: SandboxInfo[]): string {
  const rows = sandboxes.map(s => [
    s.key,
    s.state,
    s.created.toISOString(),
    s.name,
    s.image.replace(/^sha256:/, '').slice(0, 12)
  ])
  const all = [HEADERS, ...rows]
  const widths = HEADERS.map((_, i) => Math.max(...all.map(row => row[i]?.length ?? 0)))
  return all
    .map(row =>
      row
        .map((cell, i) => cell.padEnd(widths[i] ?? 0))
        .join('  ')
        .trimEnd()
    )
    .join('\n')
}

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { state: { type: 'string' } }
})
const [command, key] = positionals

if (command === 'ls' && key === undefined) {
  const sandboxes = await listSandboxes()
  console.log(sandboxes.length > 0 ? table(sandboxes) : 'no sandboxes')
} else if (command === 'rm' && key !== undefined && positionals.length === 2) {
  await removeSandbox(key)
  console.log(`no sandbox left for ${key}`)
} else if (command === 'prune' && key === undefined) {
  const removed = await pruneSandboxes(values.state === undefined ? {} : { state: values.state })
  console.log(removed.length > 0 ? `removed:\n${table(removed)}` : 'nothing to remove')
} else {
  console.error(USAGE)
  process.exitCode = 2
}
