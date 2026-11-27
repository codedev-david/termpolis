// Lumopolis id migration (WP5): the id rules changed once (group.ts uniqueIds and idSlug, compile.ts externals), so a
// world compiled before the change may hold ids the new rules no longer give: `b-root` for a part named only in emoji
// or a non-Latin script, `-2`/`-3` collision suffixes, a bare `x-`, or one orb for two hosts that slug alike. What a
// person attached to those ids (notes, hand-set service names, positions, a design's matches) follows the part to its
// new id. Pure: compile.ts renames its previous doc and the listed annotations with the map, and asks the annotation
// store to rename the saved file once (annotations.ts rename). A part is only ever renamed to a part that is the same
// thing: the same files for a building or district, the same host or agent for an orb, the same two ends for a line.
import type { Claim, External, WorldDoc, WorldEdge } from '../../shared/world/types'
import type { Grouping } from './group'
import { edgeId } from './group'

/** An id a collision or the unicode fallback shaped (a `--` suffix, a `u` short-hash slug), or one only the old rules gave (`-2`, `root`). */
const SHAPED = /--|(^|-)u[0-9a-f]{6}(-|$)/
const OLD_SHAPED = /-\d+$|^[bd]-root(-|$)/
/** A building or district whose files are all the same moves to its new id when either id was shaped by a collision or a
 *  fallback: a part whose name changed with the same files (both ids plain) is a new part, as before, and is labelled again. */
const shapedPair = (from: string, to: string): boolean => SHAPED.test(to) || SHAPED.test(from) || OLD_SHAPED.test(from)

/** The key two orbs share when they are the same orb: their kind and their host in punycode (compile.ts hostOf). */
export type OrbKey = (x: Pick<External, 'kind' | 'name'>) => string

const filesKey = (files: string[]): string => [...files].sort().join('\0')

/** Pairs each old id that vanished with the one new id that appeared and has the same key; ids with a shared key are left alone. */
function pairUp(old: Map<string, string>, now: Map<string, string>, keep: (from: string, to: string) => boolean, out: Map<string, string>): void {
  const byKey = (m: Map<string, string>, other: Map<string, string>): Map<string, string | null> => {
    const r = new Map<string, string | null>()
    for (const [id, k] of m) if (!other.has(id)) r.set(k, r.has(k) ? null : id)
    return r
  }
  const gone = byKey(old, now)
  const came = byKey(now, old)
  for (const [k, from] of gone) {
    const to = came.get(k)
    if (from !== null && to && keep(from, to)) out.set(from, to)
  }
}

/**
 * Old id → new id for every part of `previous` the id rules renamed: buildings and districts holding exactly the same
 * files (shapedPair), orbs of the same kind and host, and the lines between renamed ends. It runs on every compile, so a
 * part a new sibling's collision renames later keeps what was attached to it too. Empty when nothing was renamed.
 */
export function idRenames(
  previous: WorldDoc,
  g: Grouping,
  ext: { externals: readonly External[]; edges: readonly WorldEdge[] },
  orbKey: OrbKey
): Map<string, string> {
  const out = new Map<string, string>()
  pairUp(
    new Map(previous.buildings.map((b) => [b.id, filesKey(b.members)])),
    new Map(g.buildings.map((b) => [b.id, filesKey(b.members)])),
    shapedPair,
    out
  )
  const districtFiles = (ds: { id: string }[], bs: { districtId: string; members: string[] }[]): Map<string, string> =>
    new Map(ds.map((d) => [d.id, filesKey(bs.filter((b) => b.districtId === d.id).flatMap((b) => b.members))]))
  pairUp(districtFiles(previous.districts, previous.buildings), districtFiles(g.districts, g.buildings), shapedPair, out)
  pairUp(new Map(previous.externals.map((x) => [x.id, orbKey(x)])), new Map(ext.externals.map((x) => [x.id, orbKey(x)])), () => true, out)
  if (out.size === 0) return out
  const m = (id: string): string => out.get(id) ?? id
  const nowEdges = new Set([...g.edges.map((e) => edgeId(e)), ...ext.edges.map((e) => e.id)])
  const oldEdges = new Set(previous.edges.map((e) => e.id))
  const taken = new Set<string>()
  const left: WorldEdge[] = []
  for (const e of previous.edges) {
    if (nowEdges.has(e.id)) continue
    const to = edgeId({ from: m(e.from), to: m(e.to) })
    if (nowEdges.has(to) && !oldEdges.has(to)) {
      out.set(e.id, to)
      taken.add(to)
    } else left.push(e)
  }
  // A line to an orb that held two hosts (G09) goes to the orb of the host its label names: an orb's line is labelled
  // with what the code calls, so the same building and label is the same line.
  const orbs = new Set(previous.externals.map((x) => x.id))
  pairUp(
    new Map(left.filter((e) => orbs.has(e.to)).map((e) => [e.id, `${m(e.from)}\0${e.label}`])),
    new Map(ext.edges.filter((e) => !oldEdges.has(e.id) && !taken.has(e.id)).map((e) => [e.id, `${e.from}\0${e.label}`])),
    () => true,
    out
  )
  return out
}

/** `doc` with every id the map names renamed: the parts and their ends, positions, service names and the design's matches. */
export function renameDoc(doc: WorldDoc, map: ReadonlyMap<string, string>): WorldDoc {
  if (map.size === 0) return doc
  const m = (id: string): string => map.get(id) ?? id
  const keys = <T>(o: Record<string, T>): Record<string, T> => Object.fromEntries(Object.entries(o).map(([k, v]) => [m(k), v]))
  return {
    ...doc,
    districts: doc.districts.map((d) => ({ ...d, id: m(d.id), members: d.members.map(m) })),
    buildings: doc.buildings.map((b) => ({ ...b, id: m(b.id), districtId: m(b.districtId) })),
    edges: doc.edges.map((e) => ({ ...e, id: m(e.id), from: m(e.from), to: m(e.to) })),
    externals: doc.externals.map((x) => ({ ...x, id: m(x.id) })),
    layout: { ...doc.layout, positions: keys(doc.layout.positions) },
    runtimeNames: keys(doc.runtimeNames),
    ...(doc.runtimeHandSet ? { runtimeHandSet: doc.runtimeHandSet.map(m) } : {}),
    layers: {
      ...doc.layers,
      plan: doc.layers.plan.map((p) => ({
        ...p,
        ...(p.reconcile
          ? {
              reconcile: {
                ...p.reconcile,
                matched: Object.fromEntries(Object.entries(p.reconcile.matched).map(([k, v]) => [k, m(v)])),
                extra: p.reconcile.extra.map(m),
                changed: p.reconcile.changed.map(m)
              }
            }
          : {}),
        ...(p.removes ? { removes: p.removes.map(m) } : {})
      }))
    }
  }
}

/**
 * Annotations with every renamed item's claims moved to its new id, after any the new id already has, a claim held
 * under both kept once (the store caps what it writes). The input is returned as is when the map names none of its ids.
 */
export function renameClaims(byItem: Record<string, Claim[]>, map: ReadonlyMap<string, string>): Record<string, Claim[]> {
  if (!Object.keys(byItem).some((id) => map.has(id))) return byItem
  const out: Record<string, Claim[]> = Object.create(null)
  for (const [id, list] of Object.entries(byItem)) {
    if (!map.has(id)) out[id] = list
  }
  for (const [id, list] of Object.entries(byItem)) {
    const to = map.get(id)
    if (to === undefined) continue
    const have = out[to] ?? []
    const seen = new Set(have.map((c) => JSON.stringify(c)))
    out[to] = [...have, ...list.filter((c) => !seen.has(JSON.stringify(c)))]
  }
  return out
}

/**
 * WP5 fix I2: annotations with every renamed item's claims also under its new id, after any the new id already has, a claim
 * held under both kept once; the old ids keep theirs, so a migration that stops part way loses nothing (the store caps what
 * it writes). The input is returned as is when no claim needs copying. `from`, when given, is what each id copies (the claims
 * the annotation store shows under it, holdb-codex-review); `byItem` is still what is copied into and kept.
 */
export function copyClaims(byItem: Record<string, Claim[]>, map: ReadonlyMap<string, string>, from: Record<string, Claim[]> = byItem): Record<string, Claim[]> {
  let out: Record<string, Claim[]> | null = null
  for (const [id, list] of Object.entries(from)) {
    const to = map.get(id)
    if (to === undefined || to === id) continue
    const have = (out ?? byItem)[to] ?? []
    const seen = new Set(have.map((c) => JSON.stringify(c)))
    const add = list.filter((c) => !seen.has(JSON.stringify(c)))
    if (add.length === 0) continue
    if (out === null) out = Object.assign(Object.create(null), byItem) as Record<string, Claim[]>
    out[to] = [...have, ...add]
  }
  return out ?? byItem
}
