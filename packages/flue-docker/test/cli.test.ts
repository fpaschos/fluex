import { afterEach, describe, expect, it, vi } from 'vitest'
import { sandboxCli } from '../src/cli.ts'

describe('sandboxCli', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('prints the usage on stderr and answers 2 for an unknown command', async () => {
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {})

    const code = await sandboxCli(['bogus'])

    expect(code).toBe(2)
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('usage: pnpm sandbox ls'))
  })
})
