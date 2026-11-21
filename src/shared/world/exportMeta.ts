// The `meta` block of an exported Lumopolis page: written by the export in main (src/main/world/export.ts) and
// read by the page's runtime (src/world-export/boot.ts). One type and one check for both sides, browser-safe.
import type { WorldDoc } from './types'

/** A smart export with the model missing from this copy of Termpolis: main answers with it, and the export dialog shows the
 *  same words when the export info says smart Ask isn't available, so the two never differ. */
export const NO_MODEL = "The smart Ask model isn't installed with this copy of Termpolis, so this export can use keyword Ask only."

/**
 * The page's `meta` block. `head7` is the first seven characters of the commit, or '' when the world has none
 * (a design, or a folder without git). `proposalId` is present only on a page that exports one proposal.
 */
export interface PageMeta { project: string; exportedOn: string; head7: string; dirty: boolean; proposalId?: string }

const META_TYPES: Record<string, string> = { project: 'string', exportedOn: 'string', head7: 'string', dirty: 'boolean' }

/** The meta block as the export writes it: a non-boolean `dirty` would otherwise print "(uncommitted changes)". */
export function isMeta(m: unknown): m is PageMeta {
  if (typeof m !== 'object' || m === null) return false
  const x = m as Record<string, unknown>
  return Object.keys(META_TYPES).every((k) => typeof x[k] === META_TYPES[k]) && (x.proposalId === undefined || typeof x.proposalId === 'string')
}

/**
 * The meta block for `doc`: the project is the name the person sees (never derived from the project key), the
 * commit and the dirty flag come from the world's own sourceRevision, and `proposalId` is left out when absent.
 */
export function pageMeta(doc: WorldDoc, opts: { title: string; exportedOn: string; proposalId?: string }): PageMeta {
  return {
    project: opts.title, exportedOn: opts.exportedOn, head7: doc.sourceRevision.head.slice(0, 7), dirty: doc.sourceRevision.dirty === true,
    ...(opts.proposalId !== undefined ? { proposalId: opts.proposalId } : {}),
  }
}
