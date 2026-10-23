import type { ConversationStreamChunk } from '@flue/sdk'

// One agent turn the way `flue run` shows it: the assistant's text and thinking, line by line, as
// the client reads the conversation's updates. Tool calls are left to the server's tool log.

export interface PresenterOptions {
  /** Writes one line (no trailing newline). */
  write: (line: string) => void
  /** Dims the thinking (ANSI), for a terminal. */
  color?: boolean
}

/**
 * Prints assistant text and thinking line by line, under a `[<id>] assistant` / `thinking` heading.
 * Ported from `flue run`'s line presenter (@flue/cli `src/lib/line-event-presenter.ts`, Apache-2.0),
 * without its tool lines. Only messages of `submissionId` are shown: on a continued conversation the
 * stream also replays earlier messages.
 */
export function createLinePresenter(
  id: string,
  submissionId: string,
  { write, color = false }: PresenterOptions
): (chunk: ConversationStreamChunk) => void {
  const dim = (value: string) => (color ? `\x1b[2m${value}\x1b[22m` : value)
  const ours = new Set<string>()
  let kind: 'text' | 'reasoning' | undefined
  let buffer = ''
  const format = (line: string) => (kind === 'reasoning' ? dim(`  ${line}`) : `  ${line}`)
  const flush = () => {
    if (buffer) write(format(buffer))
    buffer = ''
  }
  return chunk => {
    if (chunk.type === 'message-started') {
      if (chunk.submissionId === undefined || chunk.submissionId === submissionId)
        ours.add(chunk.messageId)
    } else if (chunk.type === 'message-delta') {
      if (!ours.has(chunk.messageId)) return
      if (chunk.kind !== kind) {
        flush()
        kind = chunk.kind
        write(kind === 'reasoning' ? dim(`[${id}] thinking`) : `[${id}] assistant`)
      }
      const lines = (buffer + chunk.delta).split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) write(format(line))
    } else if (
      chunk.type === 'tool-input' ||
      chunk.type === 'message-completed' ||
      chunk.type === 'submission-settled'
    ) {
      flush()
      kind = undefined
    }
  }
}
