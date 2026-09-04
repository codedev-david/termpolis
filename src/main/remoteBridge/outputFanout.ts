interface QueuedChunk {
  terminalId: string
  chunk: string
  missed: number
}

/** Default per-device queue. 8x the 32 KB terminal window, so a lagging phone
 *  loses nothing the desktop itself still holds. */
const DEFAULT_CAPACITY_CHARS = 262_144

/** What `drain` hands back: the queued chunk plus a rendered notice when output was
 *  lost. `missed` stays numeric so a client can also count it. */
export interface DrainedChunk extends QueuedChunk {
  marker: string | null
}

export class OutputFanout {
  private readonly subs = new Map<string, Set<string>>()
  private readonly queues = new Map<string, QueuedChunk[]>()

  constructor(private readonly capacityChars: number = DEFAULT_CAPACITY_CHARS) {}

  subscribe(deviceId: string, terminalId: string): void {
    let set = this.subs.get(deviceId)
    if (!set) this.subs.set(deviceId, (set = new Set()))
    set.add(terminalId)
    if (!this.queues.has(deviceId)) this.queues.set(deviceId, [])
  }

  unsubscribe(deviceId: string, terminalId: string): void {
    this.subs.get(deviceId)?.delete(terminalId)
  }

  dropDevice(deviceId: string): void {
    this.subs.delete(deviceId)
    this.queues.delete(deviceId)
  }

  ingest(terminalId: string, slice: { output: string; nextOffset: number; missed: number }): void {
    if (slice.output === '' && slice.missed === 0) return
    for (const [deviceId, terminals] of this.subs) {
      if (!terminals.has(terminalId)) continue
      const q = this.queues.get(deviceId)
      if (!q) continue
      q.push({ terminalId, chunk: slice.output, missed: slice.missed })
      this.trim(q)
    }
  }

  /** Enforces the per-device ceiling, converting evicted chars into a missed count
   *  on the oldest surviving chunk. A visible gap beats an invisible one. */
  private trim(q: QueuedChunk[]): void {
    let total = q.reduce((n, c) => n + c.chunk.length, 0)
    let evicted = 0
    while (total > this.capacityChars && q.length > 0) {
      const overshoot = total - this.capacityChars
      const head = q[0]
      if (head.chunk.length <= overshoot) {
        evicted += head.chunk.length
        total -= head.chunk.length
        q.shift()
      } else {
        head.chunk = head.chunk.slice(overshoot)
        evicted += overshoot
        total -= overshoot
      }
    }
    if (evicted > 0 && q.length > 0) q[0].missed += evicted
  }

  drain(deviceId: string): DrainedChunk[] {
    const q = this.queues.get(deviceId)
    if (!q || q.length === 0) return []
    this.queues.set(deviceId, [])
    // Render the marker here rather than leaving it to each client. Dropped output
    // is the one failure mode of this design that the user cannot detect for
    // themselves -- a silent gap reads as "the agent went quiet", which is
    // indistinguishable from the agent actually being quiet, and they may act on
    // the truncated text believing they saw all of it. Every client must show it,
    // so no client gets the chance to forget.
    return q.map((c) => ({ ...c, marker: c.missed > 0 ? formatGapMarker(c.missed) : null }))
  }
}

/** Human-readable notice for output that was dropped before a device could read it.
 *
 *  Deliberately loud and deliberately explicit about the amount: "some output was
 *  lost" invites the reader to assume it was a little. */
export function formatGapMarker(missed: number): string {
  const amount =
    missed < 1024 ? `${missed} chars` : `${(missed / 1024).toFixed(1)} KB`
  return `
--- ${amount} of output skipped (terminal outran this device) ---
`
}
