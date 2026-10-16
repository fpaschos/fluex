import { readFile, writeFile } from 'node:fs/promises'
import type { ApiKeyAuth, AuthResult, OAuthAuth, OAuthCredential } from '@earendil-works/pi-ai'
import lockfile from 'proper-lockfile'

/** Same lock contract as the pi CLI's `AuthStorage`, so both can refresh the shared file safely. */
const LOCK_STALE_MS = 30_000
const LOCK_RETRIES = { retries: 40, factor: 1.5, minTimeout: 20, maxTimeout: 1_000 }
/** pi-ai refreshes tokens with less than five minutes left; do the same. */
const DEFAULT_MIN_VALIDITY_MS = 5 * 60 * 1000

export class PiAuthError extends Error {
  override name = 'PiAuthError'
}

export interface AuthFileResolverOptions {
  providerId: string
  authPath: string
  oauth: OAuthAuth
  minValidityMs?: number
  now?: () => number
}

/**
 * An `ApiKeyAuth` whose `resolve()` reads the OAuth credential the pi CLI stored in
 * `auth.json`, refreshing it under the file lock when it is about to expire.
 */
export function authFileApiKeyAuth(options: AuthFileResolverOptions): ApiKeyAuth {
  const { providerId, authPath, oauth } = options
  const minValidityMs = options.minValidityMs ?? DEFAULT_MIN_VALIDITY_MS
  const now = options.now ?? Date.now
  const expiresSoon = (credential: OAuthCredential) => now() + minValidityMs >= credential.expires

  const refreshUnderLock = async (signal: AbortSignal): Promise<OAuthCredential> => {
    let release: (() => Promise<void>) | undefined
    try {
      release = await lockfile.lock(authPath, {
        realpath: false,
        stale: LOCK_STALE_MS,
        retries: LOCK_RETRIES
      })
      // Re-read under the lock: another process (pi or a parallel run) may have refreshed already.
      const all = await readAuthFile(authPath)
      const current = requireOAuthCredential(all, providerId, authPath)
      if (!expiresSoon(current)) return current
      const refreshed = await oauth.refresh(current, signal)
      await writeFile(
        authPath,
        `${JSON.stringify({ ...all, [providerId]: refreshed }, null, 2)}\n`,
        {
          encoding: 'utf8',
          mode: 0o600
        }
      )
      return refreshed
    } finally {
      await release?.().catch(() => {})
    }
  }

  return {
    name: `pi auth.json (${oauth.name})`,
    async check() {
      const all = await readAuthFile(authPath).catch(() => undefined)
      return all?.[providerId]?.type === 'oauth' ? { type: 'oauth', source: authPath } : undefined
    },
    async resolve({ signal }): Promise<AuthResult> {
      let credential = requireOAuthCredential(await readAuthFile(authPath), providerId, authPath)
      if (expiresSoon(credential)) credential = await refreshUnderLock(signal)
      return { auth: await oauth.toAuth(credential), source: authPath }
    }
  }
}

type AuthFile = Record<string, { type?: string } & Record<string, unknown>>

async function readAuthFile(authPath: string): Promise<AuthFile> {
  let text: string
  try {
    text = await readFile(authPath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new PiAuthError(`[fluex] ${authPath} not found. Run \`pi\` and \`/login\` first.`)
    }
    throw error
  }
  try {
    return JSON.parse(text) as AuthFile
  } catch {
    // Never echo file contents: they hold tokens.
    throw new PiAuthError(`[fluex] ${authPath} is not valid JSON.`)
  }
}

function requireOAuthCredential(
  all: AuthFile,
  providerId: string,
  authPath: string
): OAuthCredential {
  const entry = all[providerId]
  if (
    entry?.type !== 'oauth' ||
    typeof entry.access !== 'string' ||
    typeof entry.refresh !== 'string' ||
    typeof entry.expires !== 'number'
  ) {
    throw new PiAuthError(
      `[fluex] No OAuth credential for "${providerId}" in ${authPath}. Run \`pi\` and \`/login\` for that provider.`
    )
  }
  return entry as OAuthCredential
}
