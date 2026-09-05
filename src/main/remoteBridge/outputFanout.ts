import type { OutputChunk } from './protocol'

/** What the fan-out holds: a wire chunk before its gap notice is rendered. */
type QueuedChunk = Omit<OutputChunk, 'marker'>

/** Default per-device queue. 8x the 32 KB terminal window, so a lagging phone
 *  loses nothing the desktop itself still holds. */
const DEFAULT_CAPACITY_CHARS = 262_144

/** What `drain` hands back: the wire shape exactly, so a drained chunk goes
 *  straight into a frame with no adapter in between.
 *
 *  An alias rather than a second structurally-identical declaration -- that is
 *  how a field gets added to one and not the other. */
export type DrainedChunk = OutputChunk

export class OutputFanout {
  /** One entry per device, holding BOTH what it watches and what is waiting for it.
   *
   *  These were two maps keyed by the same id, which meant every method had to keep
   *  them in step and `ingest` carried a `if (!q) continue` guard against a desync
   *  that no caller could actually cause. One map makes the invariant structural:
   *  a device either has a subscription record with a queue, or it does not exist. */
  private readonly devices = new Map<string, { terminals: Set<string>; queue: QueuedChunk[] }>()

  constructor(private readonly capacityChars: number = DEFAULT_CAPACITY_CHARS) {}

  subscribe(deviceId: string, terminalId: string): void {
    let d = this.devices.get(deviceId)
    if (!d) this.devices.set(deviceId, (d = { terminals: new Set(), queue: [] }))
    d.terminals.add(terminalId)
  }

  unsubscribe(deviceId: string, terminalId: string): void {
    this.devices.get(deviceId)?.terminals.delete(terminalId)
  }

  dropDevice(deviceId: string): void {
    this.devices.delete(deviceId)
  }

  /** Forget every device. Shutdown only -- the bridge is going away, and a
   *  subscription that outlives it keeps main pumping into a process that is no
   *  longer there. */
  dropAll(): void {
    this.devices.clear()
  }

  /** Every terminal at least one device is watching.
   *
   *  Main pumps PTY output for exactly this set and nothing else, so it is the
   *  answer to "which terminals cost anything". A union rather than a per-device
   *  map because the caller would only compute the union anyway, and computing
   *  it in two places is how the two come to disagree. */
  subscribedTerminals(): string[] {
    const all = new Set<string>()
    for (const d of this.devices.values()) for (const t of d.terminals) all.add(t)
    return [...all]
  }

  ingest(terminalId: string, slice: { output: string; nextOffset: number; missed: number }): void {
    if (slice.output === '' && slice.missed === 0) return
    for (const d of this.devices.values()) {
      if (!d.terminals.has(terminalId)) continue
      d.queue.push({ terminalId, chunk: slice.output, missed: slice.missed })
      this.trim(d.queue)
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
    const d = this.devices.get(deviceId)
    if (!d || d.queue.length === 0) return []
    const q = d.queue
    d.queue = []
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
