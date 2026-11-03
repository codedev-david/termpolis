// memoryTraceSources.ts
//
// What the background memory work adds to the typing trace (typingTrace.ts), so a support bundle can say which part of
// Termpolis was busy while someone typed: how many conversation-ingest, indexer and reflect passes ran and what each one
// cost (passCounters.ts), and whether the brain runs in its own process or ON the main thread (memoryClient.ts).
//
// The typing block is NUMBERS ONLY by contract: every leaf is null, a boolean or a finite number, and a NAME may only be
// a key (tests/electron/diagnosticsFields.test.ts walks them). Two things here are not, so this reshapes them:
//   - snapshotPasses() lists the recent passes with their kind as a string VALUE; here they are grouped under the kind
//     instead, so the kind is a key. The totals are passed through as they are.
//   - the host's mode is a word; here it is a code (MEMORY_HOST_CODES) plus two booleans, with the unavailable state's
//     numbers beside it. The state's `reason` is a sentence, and a sentence can name a path: it is not carried.
//
// Nothing here is an input to anything. It only reads state other modules already keep, when a snapshot is asked for (a
// bug report, the support bundle), never on a timer and never on a hot path: a sampler wired into the loop it measures
// turns one stall into the next (the v1.25.16 lesson). A reader that throws is left out of the snapshot by the trace
// itself, so a broken source costs its own field and nothing else.

import { snapshotPasses, type PassSnapshot } from './passCounters'
import type { MemoryUnavailableInfo } from './memoryFallbackGuard'

/** The memory host's modes (memoryClient.ts) as numbers. The codes are fixed: a graph of them must not change meaning. */
export const MEMORY_HOST_CODES = { host: 0, inproc: 1, unavailable: 2, starting: 3, unstarted: 4 } as const

type RecentByKind = Record<string, Array<{ at: number; f: Record<string, number> }>>

/** snapshotPasses() with `recent` grouped under each pass's kind (oldest first), so no string is left as a value. */
export type PassesTrace = Omit<PassSnapshot, 'recent'> & { recent: RecentByKind }

export function passesForTrace(read: () => PassSnapshot = snapshotPasses): PassesTrace {
  const s = read()
  const grouped = new Map<string, RecentByKind[string]>()
  for (const r of s.recent) {
    let list = grouped.get(r.kind)
    if (!list) { list = []; grouped.set(r.kind, list) }
    list.push({ at: r.at, f: r.f })
  }
  // fromEntries defines OWN properties, so a kind called "__proto__" is a key like any other and not a prototype write.
  return { v: s.v, since: s.since, records: s.records, dropped: s.dropped, kinds: s.kinds, recent: Object.fromEntries(grouped) }
}

export interface MemoryHostTrace {
  /** MEMORY_HOST_CODES[mode]; -1 for a mode this build does not know. */
  mode: number
  /** The brain runs in its own process (the good case). */
  hosted: boolean
  /** The brain runs ON the main thread: the slow fallback that stalls launch and typing. */
  onMain: boolean
  /** The brain could not start and is being retried in the background. */
  unavailable: boolean
  /** Starts that have failed in a row; 0 when none. */
  attempt: number
  retrying: boolean
  /** Milliseconds to the next try; null while one runs or when memory is not unavailable. */
  retryInMs: number | null
  storeMB: number | null
  limitMB: number | null
}

const finite = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

export function memoryHostForTrace(mode: string, info: Partial<MemoryUnavailableInfo> = {}): MemoryHostTrace {
  const known = Object.prototype.hasOwnProperty.call(MEMORY_HOST_CODES, mode)
  return {
    mode: known ? MEMORY_HOST_CODES[mode as keyof typeof MEMORY_HOST_CODES] : -1,
    hosted: mode === 'host',
    onMain: mode === 'inproc',
    unavailable: mode === 'unavailable',
    attempt: finite(info.attempt) ?? 0,
    retrying: info.retrying === true,
    retryInMs: finite(info.retryInMs),
    storeMB: finite(info.storeMB),
    limitMB: finite(info.limitMB),
  }
}

export interface MemoryTraceDeps {
  /** memoryClient's memoryHostMode. */
  hostMode: () => string
  /** memoryFallbackGuard's memoryUnavailableInfo. */
  unavailable: () => Partial<MemoryUnavailableInfo>
}

/** Plug both into the trace: `typing.extra.passes` and `typing.extra.memoryHost`. The readers run only when a snapshot is taken. */
export function registerMemoryTraceSources(register: (name: string, read: () => unknown) => void, deps: MemoryTraceDeps): void {
  register('passes', () => passesForTrace())
  register('memoryHost', () => memoryHostForTrace(deps.hostMode(), deps.unavailable()))
}
