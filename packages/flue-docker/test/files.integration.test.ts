import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import type { Sandbox } from '@flue/runtime'
import { docker } from '../src/index.ts'
import {
  describeIntegration,
  removeTestContainersAfterAll,
  tempWorkspace,
  TEST_IMAGE,
  TEST_USER,
  testKey
} from './support/integration.ts'

describeIntegration('file operations against real Docker', () => {
  removeTestContainersAfterAll()

  let workspace: string
  let sandbox: Sandbox
  beforeAll(async () => {
    workspace = await tempWorkspace()
    sandbox = await docker({ image: TEST_IMAGE, user: TEST_USER, workspace }).createSandbox({
      id: testKey('files')
    })
  })

  describe('content', () => {
    it('round-trips text through the host workspace', async () => {
      await sandbox.writeFile('notes/hello.txt', 'héllo\nwörld\n')

      expect(await sandbox.readFile('notes/hello.txt')).toBe('héllo\nwörld\n')
      expect(await readFile(join(workspace, 'notes/hello.txt'), 'utf8')).toBe('héllo\nwörld\n')
    })

    it('round-trips every byte value exactly', async () => {
      const bytes = Uint8Array.from({ length: 256 }, (_, i) => i)
      await sandbox.writeFile('bytes.bin', bytes)

      expect(await sandbox.readFileBuffer('bytes.bin')).toEqual(bytes)
    })

    it('keeps a leading UTF-8 BOM, as fs.readFile does', async () => {
      await sandbox.writeFile('bom.txt', Uint8Array.from([0xef, 0xbb, 0xbf, 0x61]))

      expect(await sandbox.readFile('bom.txt')).toBe('\uFEFFa')
    })

    it('writes and reads back a ~5 MB file', async () => {
      const big = 'x'.repeat(5 * 1024 * 1024)
      await sandbox.writeFile('big.txt', big)

      expect((await sandbox.stat('big.txt')).size).toBe(big.length)
      expect(await sandbox.readFile('big.txt')).toBe(big)
    })

    it('reads and writes a path with spaces, quotes, $ and a newline', async () => {
      const path = `odd dir/it's "q" $HOME\nline.txt`
      await sandbox.writeFile(path, 'odd')

      expect(await sandbox.readFile(path)).toBe('odd')
      expect(await sandbox.readdir('odd dir')).toEqual([`it's "q" $HOME\nline.txt`])
      expect(await readFile(join(workspace, path), 'utf8')).toBe('odd')
    })
  })

  describe('metadata and directories', () => {
    it('stats a file and a directory', async () => {
      await sandbox.writeFile('meta/file.txt', 'four')

      expect(await sandbox.stat('meta/file.txt')).toMatchObject({
        isFile: true,
        isDirectory: false,
        isSymbolicLink: false,
        size: 4
      })
      expect(await sandbox.stat('meta')).toMatchObject({
        isFile: false,
        isDirectory: true,
        isSymbolicLink: false
      })
      const { mtime } = await sandbox.stat('meta/file.txt')
      expect(Math.abs(mtime!.getTime() - Date.now())).toBeLessThan(60_000)
    })

    it('lists, creates and removes directories', async () => {
      await sandbox.mkdir('tree/a/b', { recursive: true })
      await sandbox.writeFile('tree/a/f.txt', '')

      expect((await sandbox.readdir('tree/a')).sort()).toEqual(['b', 'f.txt'])
      expect(await sandbox.exists('tree/a/b')).toBe(true)
      await expect(sandbox.mkdir('tree/a/b')).rejects.toMatchObject({ code: 'EEXIST' })
      await expect(sandbox.rm('tree/a')).rejects.toMatchObject({ code: 'EISDIR' })
      await expect(sandbox.readdir('tree/a/f.txt')).rejects.toMatchObject({ code: 'ENOTDIR' })

      await sandbox.rm('tree', { recursive: true })
      expect(await sandbox.exists('tree')).toBe(false)
      await sandbox.rm('tree', { force: true })
    })

    it('follows a symlink inside the workspace and reports it as one', async () => {
      await sandbox.mkdir('linked/target', { recursive: true })
      await sandbox.writeFile('linked/target/in.txt', 'in')
      await sandbox.exec('ln -s target linked/dir && ln -s target/in.txt linked/file')

      expect(await sandbox.stat('linked/dir')).toMatchObject({
        isDirectory: true,
        isSymbolicLink: true
      })
      expect(await sandbox.stat('linked/file')).toMatchObject({
        isFile: true,
        isSymbolicLink: true,
        size: 2
      })
      expect(await sandbox.readdir('linked/dir')).toEqual(['in.txt'])
      await sandbox.rm('linked/dir')
      expect(await sandbox.exists('linked/target/in.txt')).toBe(true)
    })

    it('resolves a symlink pointing outside /workspace inside the container, not on the host', async () => {
      // /etc/debian_version exists only in the container; the host (macOS) has none.
      await sandbox.exec('ln -s /etc/debian_version outside && ln -s /etc etc-dir')

      expect(await sandbox.readFile('outside')).toBe(
        (await sandbox.exec('cat /etc/debian_version')).stdout
      )
      expect(await sandbox.stat('outside')).toMatchObject({ isFile: true, isSymbolicLink: true })
      expect(await sandbox.readdir('etc-dir')).toContain('debian_version')
      expect(await sandbox.exists('outside')).toBe(true)
    })

    it('reports a dangling symlink as missing', async () => {
      await sandbox.exec('ln -s /nowhere dangling')

      expect(await sandbox.exists('dangling')).toBe(false)
      await expect(sandbox.stat('dangling')).rejects.toMatchObject({ code: 'ENOENT' })
    })
  })

  it('classifies an error by its message, not by error text inside the path', async () => {
    await sandbox.mkdir('No such file or directory', { recursive: true })

    await expect(sandbox.readFile('No such file or directory')).rejects.toMatchObject({
      code: 'EISDIR'
    })
  })

  describe('missing paths fail like local()', () => {
    it.each([
      ['readFile', (s: Sandbox) => s.readFile('missing.txt')],
      ['stat', (s: Sandbox) => s.stat('missing.txt')],
      ['readdir', (s: Sandbox) => s.readdir('missing')],
      ['rm', (s: Sandbox) => s.rm('missing.txt')]
    ])('%s rejects with ENOENT', async (_name, operation) => {
      await expect(operation(sandbox)).rejects.toMatchObject({
        code: 'ENOENT',
        path: expect.stringMatching(/^\/workspace\/missing/)
      })
    })
  })
})
