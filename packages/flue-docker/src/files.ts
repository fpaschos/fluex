import { SandboxDiedError } from '@flue/runtime'
import type { FileStat, SandboxDriver } from '@flue/runtime'
import { containerGone, text } from './docker-cli.ts'
import type { DockerCli, DockerResult } from './docker-cli.ts'

type FileOperations = Omit<SandboxDriver, 'exec'>

/**
 * The driver's file verbs, each one `docker exec … bash -c <script> bash <path>`.
 * The path only ever travels as `$1`, so no quoting can turn it into shell code.
 */
export function fileOperations(cli: DockerCli, container: string): FileOperations {
  type Operation = keyof FileOperations
  const run = async (
    operation: Operation,
    syscall: string,
    script: string,
    path: string,
    stdin?: Uint8Array
  ): Promise<DockerResult> => {
    const interactive = stdin === undefined ? [] : ['-i']
    // LC_ALL=C keeps coreutils' error messages in English, so `fileError` can classify them.
    const args = [
      'exec',
      ...interactive,
      container,
      'bash',
      '-c',
      `export LC_ALL=C; ${script}`,
      'bash',
      path
    ]
    const result = await cli(args, { stdin })
    if (result.exitCode === 0) return result
    if (containerGone(result.stderr)) throw new SandboxDiedError({ operation, reason: 'stopped' })
    throw fileError(result.stderr, syscall, path)
  }

  const readFileBuffer = async (path: string, operation: Operation = 'readFileBuffer') =>
    (await run(operation, 'open', 'cat -- "$1"', path)).stdout

  return {
    async readFile(path) {
      return text({ stdout: await readFileBuffer(path, 'readFile') })
    },
    readFileBuffer: path => readFileBuffer(path),
    async writeFile(path, content) {
      const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content
      await run('writeFile', 'open', 'cat > "$1"', path, bytes)
    },
    async stat(path) {
      const script = `s=$(stat -L -c '%F|%s|%.3Y' -- "$1") || exit; if [ -L "$1" ]; then echo "$s|1"; else echo "$s|0"; fi`
      return parseStat(text(await run('stat', 'stat', script, path)), path)
    },
    async readdir(path) {
      const script = `cd -- "$1" && find . -mindepth 1 -maxdepth 1 -printf '%f\\0'`
      const names = text(await run('readdir', 'scandir', script, path))
      return names.split('\0').filter(Boolean)
    },
    async exists(path) {
      const answer = text(
        await run('exists', 'access', 'if [ -e "$1" ]; then echo 1; else echo 0; fi', path)
      )
      return answer.trim() === '1'
    },
    async mkdir(path, options) {
      await run('mkdir', 'mkdir', options?.recursive ? 'mkdir -p -- "$1"' : 'mkdir -- "$1"', path)
    },
    async rm(path, options) {
      const flags = `${options?.recursive ? ' -r' : ''}${options?.force ? ' -f' : ''}`
      await run('rm', 'rm', `rm${flags} -- "$1"`, path)
    }
  }
}

/** `stat -L -c '%F|%s|%.3Y'` plus a symlink flag, e.g. `regular file|13|1791925318.187|0`. */
function parseStat(line: string, path: string): FileStat {
  const [type, size, mtime, symlink] = line.trim().split('|')
  if (type === undefined || symlink === undefined) {
    throw new Error(
      `[fluex] flue-docker: unexpected stat output for '${path}': ${JSON.stringify(line)}`
    )
  }
  return {
    isFile: type.startsWith('regular'),
    isDirectory: type === 'directory',
    isSymbolicLink: symlink === '1',
    size: Number(size),
    mtime: new Date(Number(mtime) * 1000)
  }
}

/** coreutils / bash messages and the Node error code `local()` would raise for them. */
const ERRNO: [message: string, code: string, description: string][] = [
  ['No such file or directory', 'ENOENT', 'no such file or directory'],
  ['Not a directory', 'ENOTDIR', 'not a directory'],
  ['Is a directory', 'EISDIR', 'illegal operation on a directory'],
  ['File exists', 'EEXIST', 'file already exists'],
  ['Directory not empty', 'ENOTEMPTY', 'directory not empty'],
  ['Permission denied', 'EACCES', 'permission denied']
]

/** An error shaped like Node's `fs` errors (`code`, `syscall`, `path`), so a missing path reads as on `local()`. */
function fileError(stderr: string, syscall: string, path: string): Error {
  // `cat: '/a': Is a directory`: the strerror text follows the last ': '; what precedes it may echo the path.
  const reason = stderr.trim().split(': ').at(-1) ?? ''
  const known = ERRNO.find(([message]) => reason === message)
  if (known === undefined) {
    return new Error(`[fluex] flue-docker: ${syscall} '${path}' failed: ${stderr.trim()}`)
  }
  const [, code, description] = known
  return Object.assign(new Error(`${code}: ${description}, ${syscall} '${path}'`), {
    code,
    syscall,
    path
  })
}
