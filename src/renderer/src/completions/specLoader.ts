export interface CompletionSpec {
  name: string
  description: string
  subcommands?: CompletionSpec[]
  options?: CompletionOption[]
}

export interface CompletionOption {
  name: string[]
  description: string
}

const specCache = new Map<string, CompletionSpec | null>()
const MAX_CACHE_SIZE = 100

export async function loadSpec(command: string): Promise<CompletionSpec | null> {
  if (specCache.has(command)) return specCache.get(command)!
  // Evict oldest entry if cache is full
  if (specCache.size >= MAX_CACHE_SIZE) {
    const firstKey = specCache.keys().next().value
    if (firstKey !== undefined) specCache.delete(firstKey)
  }
  try {
    const mod = await import(`./specs/${command}.json`)
    const spec = mod.default as CompletionSpec
    specCache.set(command, spec)
    return spec
  } catch {
    specCache.set(command, null)
    return null
  }
}

export function clearSpecCache(): void {
  specCache.clear()
}
