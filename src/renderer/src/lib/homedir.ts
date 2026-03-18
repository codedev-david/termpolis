// Fetches homedir from main process once and caches the result.
// Use this instead of Node.js homedir() — unavailable in renderer.
let cached: string | null = null

export async function getHomedir(): Promise<string> {
  if (cached !== null) return cached
  const res = await window.termpolis.getHomedir()
  cached = (res.success && res.data) ? res.data : '~'
  return cached
}
