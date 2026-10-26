// The client side of the sandbox routes (`DELETE /sandboxes/<key>`, @fluex/server): clients remove the
// sandbox they keyed through the app, never through Docker, so they work the same against a remote app.

export interface RemoveSandboxOptions {
  /** The app's base URL. */
  baseUrl: string
  /** The sandbox key (a run id, or one the client named). */
  key: string
  fetch?: typeof fetch
}

/** Removes the sandbox of `key` through the app; rejects with `<status> <body>` when the app refuses. */
export async function removeSandbox({
  baseUrl,
  key,
  fetch = globalThis.fetch
}: RemoveSandboxOptions): Promise<void> {
  const base = baseUrl.replace(/\/+$/, '')
  const url = `${base}/sandboxes/${encodeURIComponent(key)}`
  const response = await fetch(url, { method: 'DELETE' })
  if (response.ok) return
  const body = await response.text()
  throw new Error(`${response.status} ${body}`)
}
