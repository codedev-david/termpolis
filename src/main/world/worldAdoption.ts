// WP5 (X02): a world key is its root's project key, and on Linux that key now keeps the folder's case, where every
// build before WP5 lowercased it. A world opened on Linux after the update gets a new key, so its saved world (the hand
// labels and positions in it) and its line in the recent list would be left under the old one. The first time such a
// world opens, this brings them along (annotations follow by adoptAnnotationAliases).
//
// It copies and never moves: the old world file stays where it was, so going back to an older build still finds it. It
// never overwrites a world the new key already has (that one is the newer), only takes over a recent-list line whose
// folder is this one, never throws, and never logs (keys and content stay out of the log).
import type { WorldDoc } from '../../shared/world/types'
import type { WorldEntry, WorldSource } from './sources'

export interface WorldAdoptionDeps {
  store: { load(projectKey: string): Promise<WorldDoc | null>; save(doc: WorldDoc): Promise<void> }
  /** Whether a world is saved under the key (a file check: the world itself is not read). */
  hasWorld(projectKey: string): Promise<boolean>
  registry: {
    list(): Promise<WorldEntry[]>
    upsert(s: WorldSource, title?: string): Promise<WorldEntry>
    remove(key: string): Promise<void>
  }
  /** The registry key of a source (keyForSource). */
  keyOf(s: WorldSource): string
}

export interface WorldAdoption {
  /** The older key whose world was copied to the new key, if any. */
  world?: string
  /** The older keys whose recent-list lines now sit under the new key. */
  entries: string[]
}

/** Brings a world saved under an older key of its root (`aliasKeys`, in order) to `key`. Resolves with what it moved. */
export async function adoptWorldAliases(key: string, aliasKeys: readonly string[], deps: WorldAdoptionDeps): Promise<WorldAdoption> {
  const out: WorldAdoption = { entries: [] }
  const others = aliasKeys.filter((k, i) => k && k !== key && aliasKeys.indexOf(k) === i)
  if (!key || others.length === 0) return out
  try {
    if (!(await deps.hasWorld(key))) {
      for (const old of others) {
        const doc = await deps.store.load(old).catch(() => null)
        if (!doc) continue
        if (await deps.hasWorld(key)) break // the world host saved the new key's own world meanwhile
        await deps.store.save({ ...doc, projectKey: key })
        out.world = old
        break
      }
    }
  } catch {
    // the world is compiled afresh under the new key: the old file stays as it was
  }
  try {
    const entries = await deps.registry.list()
    const hasNew = entries.some((e) => e.key === key)
    for (const e of entries) {
      if (!others.includes(e.key) || e.source.kind === 'design' || deps.keyOf(e.source) !== key) continue
      if (!hasNew && out.entries.length === 0) await deps.registry.upsert(e.source, e.title)
      await deps.registry.remove(e.key)
      out.entries.push(e.key)
    }
  } catch {
    // the older line stays in the recent list; opening it still opens this folder
  }
  return out
}
