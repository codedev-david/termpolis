// passCounters.ts
//
// A tiny in-memory ring of "passes": one line of COUNTERS per background pass (reflect-session
// today), so a support bundle can say how many files a pass opened, how many bytes it read and
// how many callers it shared with, without anyone attaching a profiler.
//
// What it is NOT:
//   - never content. Only finite numbers are kept, under short names made of [A-Za-z0-9_.:-]. A
//     path, a transcript line or a message handed in as a value is dropped, not stored.
//   - never an input. Nothing in the app reads these numbers to decide anything: a sampler wired
//     into the loop it measures turns one stall into the next (the v1.25.16 lesson), so this
//     module only records and reports. The diagnostics record reads snapshotPasses() at merge time.
//   - never costly. recordPass is O(1) (a bounded field copy, one ring slot, amortised eviction),
//     touches no disk and no clock beyond Date.now(), and cannot throw. The ring is byte-capped.

export interface PassSnapshot {
  v: 1
  /** When the first pass since start (or reset) was recorded, epoch ms; 0 for none yet. */
  since: number
  /** Passes recorded since start, all kinds, including those that have since left the ring. */
  records: number
  /** Passes that left the ring because of its record or byte cap. */
  dropped: number
  /** Per kind: how many passes, the sum and the largest value of every counter. */
  kinds: Record<string, { n: number; last: number; sum: Record<string, number>; max: Record<string, number> }>
  /** The newest passes still in the ring, oldest first. */
  recent: Array<{ at: number; kind: string; f: Record<string, number> }>
}

export const PASS_LIMITS = {
  /** Passes kept in the ring. */
  maxRecords: 64,
  /** Serialised size of the ring, in bytes (an upper bound: JSON.stringify(recent).length never exceeds it). */
  maxBytes: 16 * 1024,
  /** Counters kept per pass, and distinct counters totalled per kind. */
  maxFields: 12,
  /** Characters kept of a kind or counter name. */
  maxName: 24,
  /** Distinct kinds totalled; later ones fold into "other". */
  maxKinds: 24,
} as const

interface PassRecord {
  at: number
  kind: string
  f: Record<string, number>
  /** Upper bound of this record's JSON, comma included. */
  bytes: number
}

interface KindTotals {
  n: number
  last: number
  sum: Record<string, number>
  max: Record<string, number>
}

// Fixed JSON around a record: {"at":<13 digits>,"kind":"","f":{}},
const RECORD_OVERHEAD = 42
const OTHER = 'other'

const ring: Array<PassRecord | undefined> = new Array(PASS_LIMITS.maxRecords)
let head = 0
let size = 0
let ringBytes = 0
let records = 0
let dropped = 0
let since = 0
let kinds = new Map<string, KindTotals>()

function cleanName(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0) return null
  return raw.slice(0, PASS_LIMITS.maxName).replace(/[^A-Za-z0-9_.:-]/g, '_')
}

/** Only ever called with size >= 1, so the slot at `head` holds a record. */
function evictOldest(): void {
  const old = ring[head] as PassRecord
  ring[head] = undefined
  head = (head + 1) % PASS_LIMITS.maxRecords
  size--
  ringBytes -= old.bytes
  dropped++
}

/** Keep the numbers of `fields` under short safe names, at most maxFields of them. Anything else is dropped. */
function sanitizeFields(fields: unknown): { f: Record<string, number>; bytes: number } {
  const f: Record<string, number> = {}
  let bytes = 0
  let kept = 0
  if (!fields || typeof fields !== 'object') return { f, bytes }
  for (const key of Object.keys(fields)) {
    if (kept >= PASS_LIMITS.maxFields) break
    const name = cleanName(key)
    const value = (fields as Record<string, unknown>)[key]
    if (name === null || typeof value !== 'number' || !Number.isFinite(value)) continue
    if (name in f) continue
    f[name] = value
    bytes += name.length + 4 + String(value).length
    kept++
  }
  return { f, bytes }
}

function addToKind(name: string, at: number, f: Record<string, number>): void {
  let k = kinds.get(name)
  if (!k) {
    if (kinds.size >= PASS_LIMITS.maxKinds && name !== OTHER) return addToKind(OTHER, at, f)
    k = { n: 0, last: 0, sum: {}, max: {} }
    kinds.set(name, k)
  }
  k.n++
  k.last = at
  for (const key of Object.keys(f)) {
    const known = key in k.sum
    if (!known && Object.keys(k.sum).length >= PASS_LIMITS.maxFields) continue
    const v = f[key]
    k.sum[key] = (known ? k.sum[key] : 0) + v
    k.max[key] = known ? Math.max(k.max[key], v) : v
  }
}

/**
 * Record one pass. `fields` are counters (numbers); everything else in it is ignored. Never throws.
 */
export function recordPass(kind: string, fields: Record<string, number>): void {
  try {
    const name = cleanName(kind)
    if (name === null) return
    // Build the whole record before touching shared state, so a hostile `fields` cannot leave the ring half-updated.
    const { f, bytes: fieldBytes } = sanitizeFields(fields)
    const at = Date.now()
    const bytes = RECORD_OVERHEAD + name.length + fieldBytes

    if (size === PASS_LIMITS.maxRecords) evictOldest()
    ring[(head + size) % PASS_LIMITS.maxRecords] = { at, kind: name, f, bytes }
    size++
    ringBytes += bytes
    // +2: the brackets around the array. A record alone never empties the ring.
    while (ringBytes + 2 > PASS_LIMITS.maxBytes && size > 1) evictOldest()

    if (records === 0) since = at
    records++
    addToKind(name, at, f)
  } catch {
    /* diagnostics must never break the pass they describe */
  }
}

/** A copy of what has been recorded: JSON-safe, counters only. */
export function snapshotPasses(): PassSnapshot {
  const recent: PassSnapshot['recent'] = []
  for (let i = 0; i < size; i++) {
    const r = ring[(head + i) % PASS_LIMITS.maxRecords] as PassRecord // the `size` slots from `head` are all filled
    recent.push({ at: r.at, kind: r.kind, f: { ...r.f } })
  }
  const out: PassSnapshot['kinds'] = {}
  for (const [name, k] of kinds) out[name] = { n: k.n, last: k.last, sum: { ...k.sum }, max: { ...k.max } }
  return { v: 1, since, records, dropped, kinds: out, recent }
}

/** Test seam: forget everything. */
export function resetPasses(): void {
  ring.fill(undefined)
  head = 0
  size = 0
  ringBytes = 0
  records = 0
  dropped = 0
  since = 0
  kinds = new Map()
}
