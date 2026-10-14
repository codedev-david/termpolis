// linkedHistoryRecheck.ts
//
// One pass over the conversation memory that Termpolis 1.50 to 1.52 stored from jobs other
// computers ran here over Linked machines.
//
// Those versions saved a delegated job's session like any other, and the memory indexer read it
// back: the prompt another computer sent and the answer it asked for became this computer's
// memory, and its primer quoted them back to later agents. The indexer now skips such sessions
// (shared/headlessPrompt); this deals with what is already stored.
//
// A delegated session is DEMOTED whole, user and assistant chunks alike, never deleted: recall
// still finds a chunk when nothing better matches, and memory_correct can revoke the demotion. It
// is recorded in the same correction log as an agent's or the user's corrections, so the reason
// travels with it. Finding the whole session takes three steps, because a stored chunk does not
// carry its session id:
//   1. Seeds. A chunk whose hash is one the indexer just computed for a delegated session still
//      on disk; or a chunk that holds the delegation header where a session's opening prompt puts
//      it, read together with the chunk after it, since a long opening turn is cut into 2,000
//      character windows and the header can fall across a cut.
//   2. The rest of each session: the indexer links a session's consecutive chunks with `follows`
//      edges, walked both ways, within one agent's history and one project.
//   3. Only chunks from when Linked machines existed: nothing older can be a delegated session.

import { DELEGATED_CHUNK } from '../shared/headlessPrompt'

export interface StoredChunk {
  id: string
  ts: number
  agentId: string
  content: string
  hash?: string
  project?: string
  projectKey?: string
}

/** The ingested histories a delegated job can have left. agy, which runs Gemini jobs, keeps a
 *  store of its own that Termpolis never reads. */
export type HistoryAgent = 'claude-history' | 'codex-history'
export const HISTORY_AGENTS: readonly HistoryAgent[] = ['claude-history', 'codex-history']

/** Linked machines shipped in 1.50.0, on 2026-10-05: nothing stored from before is a delegated
 *  session. Ingested chunks carry the time the conversation happened, not when it was stored. */
export const LINKED_SINCE = Date.UTC(2026, 9, 5)

export const LINKED_RECHECK_REASON =
  'Re-checked by Termpolis: another linked computer started this session, so it was that ' +
  "computer's job, not this computer's own work. Revoke this correction if it was your own session."

/** The once-per-install marker, in userData. */
export const LINKED_RECHECK_MARKER = 'linked-history-recheck.json'

export interface LinkedRecheckDeps {
  /** Pages of one history's chunks since `since`, newest first, older than `before` when given. */
  list: (opts: { agentId: HistoryAgent; kind: 'message'; since: number; limit: number; before?: number }) => Promise<StoredChunk[]>
  /** `from\0to\0relation` for every edge that touches these ids (memoryGraph's edgeKeysIncident). */
  edgeKeys: (ids: string[]) => Promise<string[]>
  /** The chunk hashes of every delegated session still on disk, from an ingest pass that read
   *  every transcript (conversationIngest's onDelegated). */
  delegatedHashes?: ReadonlySet<string>
  /** Already-corrected ids are left alone: someone decided about them already. */
  isCorrected: (id: string) => boolean
  demote: (id: string, reason: string) => { ok: boolean }
  /** Whether this pass has run on this install before. */
  done: () => boolean
  markDone: () => void
  /** Awaited now and then: every demotion appends to the correction log on the main thread, and
   *  every chunk is matched there. Default: a setImmediate macrotask, which lets IPC and the PTYs
   *  through. */
  yield?: () => Promise<void>
}

export interface LinkedRecheckResult {
  checked: number
  demoted: number
  skipped?: 'already-run'
}

const PAGE = 500
/** Ids per edge lookup, so no one message to the memory host is huge. */
const EDGE_BATCH = 1_000
const YIELD_EVERY_DEMOTIONS = 25
const YIELD_EVERY_CHUNKS = 500
const macrotask = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve))

/** One session's chunks share an agent and a project; a walk that reaches another of either has
 *  left the session. */
const scopeOf = (c: StoredChunk): string => `${c.agentId}\0${c.projectKey ?? c.project ?? ''}`

/** Demote every delegated session stored since Linked machines shipped, once per install. A store
 *  that can't be read throws and leaves the pass unmarked, so the next indexer pass tries again; a
 *  demotion that fails is simply not counted. */
export async function recheckLinkedHistory(deps: LinkedRecheckDeps): Promise<LinkedRecheckResult> {
  if (deps.done()) return { checked: 0, demoted: 0, skipped: 'already-run' }
  const pause = deps.yield ?? macrotask

  const byId = new Map<string, StoredChunk>()
  for (const agentId of HISTORY_AGENTS) {
    let before: number | undefined
    for (;;) {
      const page = await deps.list({ agentId, kind: 'message', since: LINKED_SINCE, limit: PAGE, ...(before !== undefined ? { before } : {}) })
      let fresh = 0
      for (const chunk of page) {
        if (byId.has(chunk.id)) continue
        // Only what the pass reads: a listed entry also carries its vector, and there are
        // thousands of these.
        const { id, ts, agentId: agent, content, hash, project, projectKey } = chunk
        byId.set(id, { id, ts, agentId: agent, content, hash, project, projectKey })
        fresh++
      }
      if (page.length < PAGE || fresh === 0) break
      // The next page starts AT the oldest timestamp seen, not below it, so chunks that share it
      // and didn't fit on this page are not skipped; byId drops the ones already read. Every
      // listed chunk is at least LINKED_SINCE, so its timestamp is never missing.
      before = page[page.length - 1].ts + 1
    }
  }

  // The `follows` backbone among them, both ways. An edge between two batches comes back twice.
  const nextOf = new Map<string, string[]>()
  const prevOf = new Map<string, string[]>()
  const seenEdges = new Set<string>()
  const ids = [...byId.keys()]
  for (let i = 0; i < ids.length; i += EDGE_BATCH) {
    for (const key of await deps.edgeKeys(ids.slice(i, i + EDGE_BATCH))) {
      const [from, to, relation] = key.split('\0')
      if (relation !== 'follows' || seenEdges.has(key) || !byId.has(from) || !byId.has(to)) continue
      seenEdges.add(key)
      nextOf.set(from, [...(nextOf.get(from) ?? []), to])
      prevOf.set(to, [...(prevOf.get(to) ?? []), from])
    }
  }

  const seeds: string[] = []
  let matched = 0
  for (const chunk of byId.values()) {
    const seed =
      (chunk.hash !== undefined && deps.delegatedHashes?.has(chunk.hash) === true) ||
      DELEGATED_CHUNK.test(chunk.content) ||
      (nextOf.get(chunk.id) ?? []).some((next) => DELEGATED_CHUNK.test(chunk.content + (byId.get(next) as StoredChunk).content))
    if (seed) seeds.push(chunk.id)
    if (++matched % YIELD_EVERY_CHUNKS === 0) await pause()
  }

  const session = new Set<string>(seeds)
  const queue = [...seeds]
  while (queue.length > 0) {
    const id = queue.pop() as string
    const scope = scopeOf(byId.get(id) as StoredChunk)
    for (const next of [...(nextOf.get(id) ?? []), ...(prevOf.get(id) ?? [])]) {
      if (session.has(next) || scopeOf(byId.get(next) as StoredChunk) !== scope) continue
      session.add(next)
      queue.push(next)
    }
  }

  let demoted = 0
  let attempts = 0
  for (const id of session) {
    if (deps.isCorrected(id)) continue
    try {
      if (deps.demote(id, LINKED_RECHECK_REASON).ok) demoted++
    } catch { /* left as it is */ }
    if (++attempts % YIELD_EVERY_DEMOTIONS === 0) await pause()
  }
  deps.markDone()
  return { checked: byId.size, demoted }
}
