// WP5 (X02): a world key is its root's project key, and on Linux that key now keeps the folder's case, where every
// build before WP5 lowercased it. A world opened on Linux after the update gets a new key, so its saved world (the hand
// labels and positions in it) and its line in the recent list would be left under the old one. The first time such a
// world opens, this brings them along (annotations follow by adoptAnnotationAliases).
//
// It copies and never moves: the old world file stays where it was, so going back to an older build still finds it. It
// never overwrites a world the new key already has (that one is the newer), only takes over a recent-list line whose
// folder is this one, never throws, and never logs (keys and content stay out of the log).
//
// WP5 fix I1: the lowercased key is also the key of the folder spelled in lower case. A Linux `~/App` takes the world saved
// under it only when the caller found no other folder at `~/app` (liveProjectKeyAliases) and the recent list holds that key
// for `~/App` itself, spelled case for case; a key it cannot place stays where it is.
//
// HOLD-B #17 (WP5 N1): the first open moves that line to the new key, so a later open no longer sees it. A lowered key whose
// annotations could not be copied then stays in the record the annotation adoption keeps beside the new key's file
// (pendingAdoptionKeys), and that record shows it is this folder's: it was handed over as this folder's when it was written.
// So the copy is tried again on a later open, and the saved views follow it too.
import type { WorldDoc } from '../../shared/world/types'
import { pendingAdoptionKeys } from './annotations'
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
  /** WP5 fix I1: the older keys made by lowercasing the root on a platform that keeps case (loweredAliasKeys). Such a key is
   *  also the key of the folder spelled in lower case (`~/app` beside `~/App`), so it is adopted from only when the recent list
   *  holds it for this very folder, spelled case for case. */
  lowered?: ReadonlySet<string>
  /** HOLD-B #17: the user-data folder of the world's annotations. A lowered key the recent list no longer shows for this
   *  folder is still this folder's while the record beside the new key's annotations holds it (pendingAdoptionKeys). */
  annotationsDir?: string
}

export interface WorldAdoption {
  /** The older key whose world was copied to the new key, if any. */
  world?: string
  /** The older keys whose recent-list lines now sit under the new key. */
  entries: string[]
  /** The older keys this root's saved data may be adopted from (its annotations, its saved views): `aliasKeys` less the
   *  lowered ones not shown to be this folder's. */
  aliases: string[]
}

/** Brings a world saved under an older key of its root (`aliasKeys`, in order) to `key`. Resolves with what it moved. */
export async function adoptWorldAliases(key: string, aliasKeys: readonly string[], deps: WorldAdoptionDeps): Promise<WorldAdoption> {
  const out: WorldAdoption = { entries: [], aliases: [] }
  const unique = aliasKeys.filter((k, i) => k && k !== key && aliasKeys.indexOf(k) === i)
  if (!key || unique.length === 0) return out
  // Listed once, before anything is copied: the lines that show which folder each older key was.
  const listed = await deps.registry.list().catch(() => null)
  const shown = (old: string): boolean =>
    !deps.lowered?.has(old) || !!listed?.some((e) => e.key === old && e.source.kind !== 'design' && deps.keyOf(e.source) === key)
  // The record is read only when a lowered key is not shown (on Linux, every open after the first): one small file, most often missing.
  let recorded: string[] = []
  if (deps.annotationsDir !== undefined && !unique.every(shown)) recorded = await pendingAdoptionKeys(deps.annotationsDir, key)
  const others = unique.filter((old) => shown(old) || recorded.includes(old))
  out.aliases = others
  if (others.length === 0) return out
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
  if (listed === null) return out // the older line stays in the recent list; opening it still opens this folder
  try {
    const hasNew = listed.some((e) => e.key === key)
    for (const e of listed) {
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
