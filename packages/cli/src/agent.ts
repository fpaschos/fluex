import { cac } from 'cac'
import { runAgent } from './agent-client.ts'

// `pnpm agent <name> [-m <message>] [--data <json>] [--id <id>]` (`pnpm smoke`, `pnpm planner`,
// `pnpm implement`): one agent turn on the running app (`pnpm dev`, or FLUE_URL), over HTTP only.
// This is the shell (argv, env, Ctrl-C, exit code); src/cli/agent-client.ts does the turn:
// - a new conversation `<runId>-<name>` gets `sandbox` (the run id) and `subscription` (openai-codex)
//   unless --data names them. A sandbox keyed by the run id is removed through the app afterwards;
//   one you named, or a continued conversation's (--id), is kept (`pnpm sandbox rm <key>`).
// - the assistant's text and thinking stream to stderr; the tool log stays on the app's terminal.
// - stdout gets only the result, { id, text, data }. Exit 0 completed, 1 failed, 2 usage, 130 aborted.
// - Ctrl-C aborts the run and waits for it to settle; a second Ctrl-C exits at once, keeping the sandbox.
//
//   pnpm agent planner
//   pnpm agent implementer --data '{"issue":65}'
//   pnpm agent implementer --data '{"issue":65,"sandbox":"my-box"}'
//   pnpm agent implementer --id run-20261014-190112-7c3e-implementer -m "ktlint failed, fix it"

/** An option as mri parses it: a numeric value (`--id 42`) as a number, a bare flag as `true`. */
type Value = string | number | boolean | undefined

interface Options {
  message: Value
  data?: Value
  id?: Value
}

/**
 * Option `names`' value as typed: cac has no string options, so mri reads `-m 3.10` as 3.1 and
 * `--id 007` as 7. Falls back to the parsed `value`.
 */
function text(names: string[], value: Value): string | undefined {
  const argv = process.argv.slice(2)
  let typed: string | undefined
  for (const [i, arg] of argv.entries()) {
    if (arg === '--') break
    for (const name of names) {
      if (arg === name) typed = argv[i + 1]
      else if (arg.startsWith(`${name}=`)) typed = arg.slice(name.length + 1)
    }
  }
  return typed ?? (value === undefined ? undefined : String(value))
}

/** One turn of `name`; the first Ctrl-C aborts it, a second exits at once. */
async function agent(name: string, options: Options): Promise<number> {
  const interrupt = new AbortController()
  process.on('SIGINT', () => {
    if (!interrupt.signal.aborted) {
      process.stderr.write('[fluex] aborting (Ctrl-C again to exit now, keeping the sandbox)\n')
      interrupt.abort()
      return
    }
    process.stderr.write(
      '[fluex] exited; the sandbox is kept: pnpm sandbox ls, pnpm sandbox rm <key>\n'
    )
    process.exit(130)
  })
  return runAgent(
    {
      name,
      message: text(['-m', '--message'], options.message),
      data: text(['--data'], options.data),
      id: text(['--id'], options.id)
    },
    {
      url: process.env.FLUE_URL ?? 'http://localhost:3000',
      stdout: value => process.stdout.write(value),
      stderr: value => process.stderr.write(value),
      color: process.stderr.isTTY,
      signal: interrupt.signal
    }
  )
}

const cli = cac('pnpm agent')
cli
  .command('<name>', 'One agent turn on the running app')
  .option('-m, --message <message>', 'The message', { default: 'go' })
  .option('--data <json>', "Merged into a new conversation's initial data")
  .option('--id <id>', 'Continue this conversation (no --data)')
  .action(async (name: unknown, options: Options) => {
    process.exitCode = await agent(String(name), options)
  })
cli.help()

try {
  cli.parse(process.argv, { run: false })
  if (!cli.options.help && !cli.matchedCommand) {
    cli.outputHelp()
    process.exitCode = 2
  } else await cli.runMatchedCommand()
} catch (error) {
  // cac's usage errors (a missing name, an unknown option) exit 2; runAgent answers its own.
  console.error(`[fluex] ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = error instanceof Error && error.name === 'CACError' ? 2 : 1
}
