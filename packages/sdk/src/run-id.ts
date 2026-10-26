/**
 * `run-20261014-174055-a3f9`: local start time (like automaton's run folders), sortable, and safe in
 * paths, container labels and URLs; the random suffix keeps two runs in the same second apart.
 */
export function newRunId(date = new Date()): string {
  const two = (n: number) => String(n).padStart(2, '0')
  const day = `${date.getFullYear()}${two(date.getMonth() + 1)}${two(date.getDate())}`
  const time = `${two(date.getHours())}${two(date.getMinutes())}${two(date.getSeconds())}`
  const random = [...crypto.getRandomValues(new Uint8Array(2))]
  const suffix = random.map(byte => byte.toString(16).padStart(2, '0')).join('')
  return `run-${day}-${time}-${suffix}`
}
