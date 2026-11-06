import type { OutputChunk } from './protocol'

/** What the fan-out holds: a wire chunk before its gap notice is rendered. */
type QueuedChunk = Omit<OutputChunk, 'marker'>

/** Default per-device queue. 8x the 32 KB terminal window, so a lagging phone
 *  loses nothing the desktop itself still holds. */
const DEFAULT_CAPACITY_CHARS = 262_144

/** A queue that holds more than this many chunks of ONE terminal is replaced by one screen of it (see
 *  `FanoutOptions.screenOf`). Sixteen whole-region edits is already more than a phone that comes back can
 *  use: it is shown the last of them, and every one it is sent costs it a re-parse of the whole copy. */
export const COLLAPSE_AFTER_CHUNKS = 16

/** A whole screen as one edit: the flattener's `snapshot`, in the same numbering as every edit `ingest`
 *  queues. Structural, so the fan-out never imports the emulator. */
export interface ScreenView {
  replaceFrom: number
  text: string
}

export interface FanoutOptions {
  /** The whole screen of a terminal as it stands, or null when there is none to give. With it, a device
   *  that falls behind is not evicted from the head: once its queue holds more than `collapseAfter` chunks of
   *  one terminal they are replaced by ONE screen (see `reseed`), and nothing the device missed is lost
   *  from what it will show -- it is shown the screen. Without it, the queue is today's. */
  screenOf?: (terminalId: string) => ScreenView | null
  collapseAfter?: number
}

/** What `drain` hands back: the wire shape exactly, so a drained chunk goes
 *  straight into a frame with no adapter in between.
 *
 *  An alias rather than a second structurally-identical declaration -- that is
 *  how a field gets added to one and not the other. */
export type DrainedChunk = OutputChunk

/** The anchor of a chunk that carries nothing and makes the NEXT anchored chunk
 *  replace a phone's whole copy.
 *
 *  An anchor at 0 does not do that on its own. The phone keeps what sits before
 *  an anchor by counting back from the end of its copy -- `held.length -
 *  (outputEnd - replaceFrom)` -- and a gap notice it draws into its copy is not
 *  counted in `outputEnd`. After one, the copy runs a notice longer than its
 *  end mark says, so a screen anchored at 0 kept that much of the OLD copy's
 *  head above itself: a stray "Claude Code" over the real one, or the stub of a
 *  notice. For good, too -- every later anchor counts back the same way -- and
 *  one notice longer with every gap.
 *
 *  An anchor past the end of any copy is the case the phone clamps: it keeps
 *  everything, adds nothing and takes the anchor as its new end. Counted back
 *  from there, the next anchor keeps nothing at all, so whatever comes next is
 *  the whole copy, however far the copy had drifted. Every phone since 1.1.0
 *  applies chunks that way and accepts any whole number here, so this needs no
 *  new phone. A notice `trim` folds into one is wiped by the screen behind it,
 *  which is right: what was lost came before a whole new screen, not out of it. */
export const FORGET_FROM = Number.MAX_SAFE_INTEGER

function forgetting(terminalId: string): QueuedChunk {
  return { terminalId, chunk: '', missed: 0, replaceFrom: FORGET_FROM }
}

/** What the fan-out holds for one device. */
interface Device {
  terminals: Set<string>
  queue: QueuedChunk[]
  /** Per terminal, where in the stream the furthest gap notice this device was SENT sits in its copy -- or
   *  `Infinity` when a notice came with no anchor, which is a place nobody can name. A notice is in the
   *  phone's copy but not in its end mark, which every anchor counts back from; see `gapAt`. */
  gaps: Map<string, number>
}

export class OutputFanout {
  /** One entry per device, holding BOTH what it watches and what is waiting for it.
   *
   *  These were two maps keyed by the same id, which meant every method had to keep
   *  them in step and `ingest` carried a `if (!q) continue` guard against a desync
   *  that no caller could actually cause. One map makes the invariant structural:
   *  a device either has a subscription record with a queue, or it does not exist. */
  private readonly devices = new Map<string, Device>()
  private readonly screenOf: FanoutOptions['screenOf']
  private readonly collapseAfter: number

  constructor(
    private readonly capacityChars: number = DEFAULT_CAPACITY_CHARS,
    options: FanoutOptions = {},
  ) {
    this.screenOf = options.screenOf
    this.collapseAfter = options.collapseAfter ?? COLLAPSE_AFTER_CHUNKS
  }

  subscribe(deviceId: string, terminalId: string): void {
    let d = this.devices.get(deviceId)
    if (!d) this.devices.set(deviceId, (d = { terminals: new Set(), queue: [], gaps: new Map() }))
    d.terminals.add(terminalId)
  }

  unsubscribe(deviceId: string, terminalId: string): void {
    const d = this.devices.get(deviceId)
    if (d === undefined) return
    d.terminals.delete(terminalId)
    d.gaps.delete(terminalId)
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

  /** The devices watching one terminal.
   *
   *  Status pushes go to exactly these and no others. Being in this list already
   *  means the device holds `read`: a subscribe from a device without it is
   *  refused before it reaches the fan-out, and a grant withdrawn later drops the
   *  device from it outright. So this IS the authorisation check for a status
   *  frame, not a lookup that still needs one. */
  subscribersOf(terminalId: string): string[] {
    const ids: string[] = []
    for (const [deviceId, d] of this.devices) if (d.terminals.has(terminalId)) ids.push(deviceId)
    return ids
  }

  /** The terminals one device is watching. Empty for a device that has never
   *  subscribed, which is the same answer as one that has unsubscribed from
   *  everything -- neither is owed anything. */
  terminalsOf(deviceId: string): string[] {
    return [...(this.devices.get(deviceId)?.terminals ?? [])]
  }

  ingest(
    terminalId: string,
    slice: { output: string; nextOffset: number; missed: number; replaceFrom?: number | null },
  ): void {
    // Nothing to add, nothing lost, and nothing to take away. An empty chunk
    // WITH an anchor is not nothing: it truncates the phone's copy to that
    // point. That is how a screen that got shorter -- a menu closing, a cleared
    // terminal -- reaches the phone, and it used to be dropped right here, which
    // left the old lines on the phone until something else happened to redraw
    // over them.
    if (slice.output === '' && slice.missed === 0 && (slice.replaceFrom ?? null) === null) return
    for (const d of this.devices.values()) {
      if (!d.terminals.has(terminalId)) continue
      // Anchored at 0 is a whole screen -- main's opening read, a new grid's first
      // edit, a screen redrawn from its first char -- and has to replace the
      // whole copy, which the anchor alone does not (see `FORGET_FROM`).
      if (slice.replaceFrom === 0) d.queue.push(forgetting(terminalId))
      d.queue.push({
        terminalId,
        chunk: slice.output,
        missed: slice.missed,
        replaceFrom: slice.replaceFrom ?? null,
      })
      this.collapse(d, terminalId)
      this.trim(d.queue)
    }
  }

  /** Queue one terminal's whole screen for ONE device -- the one that has just
   *  opened it, and no other.
   *
   *  `view` is the screen as a single edit (the flattener's `snapshot`), in the
   *  same numbering as every edit `ingest` queues, so whatever arrives after it
   *  applies on top of it. `clear` makes it replace the device's whole copy
   *  rather than the end of it (see `FORGET_FROM`). So does a screen anchored at
   *  0 whatever `clear` says: it is the whole screen, and drawn over the end of
   *  a copy the phone has written a gap notice into, it would keep that much of
   *  the copy's head above itself.
   *
   *  Refused for a terminal the device is not watching. The watch list is the
   *  `read` check (see `subscribersOf`), and a queue is the one place output
   *  leaves this process for a phone. */
  seed(
    deviceId: string,
    terminalId: string,
    view: { replaceFrom: number; text: string },
    clear: boolean,
  ): void {
    const d = this.devices.get(deviceId)
    if (!d?.terminals.has(terminalId)) return
    if (clear || view.replaceFrom === 0) d.queue.push(forgetting(terminalId))
    d.queue.push({ terminalId, chunk: view.text, missed: 0, replaceFrom: view.replaceFrom })
    this.trim(d.queue)
  }

  /** Replace everything queued for ONE device on ONE terminal with its whole screen.
   *
   *  For a device that has come back: the edits it missed are a list of whole-region repaints measured
   *  against a copy it may no longer hold in the state they assume (nothing on the wire says a frame
   *  arrived), and a screen is the same information once, in a form that is right whatever the copy was.
   *  It always goes behind a forget -- the phone's copy is replaced, not drawn over -- so what the phone
   *  held before, history above the screen included, is gone: the honest limit, the same as a phone
   *  opening a terminal that is already watched. What is queued for the device's OTHER terminals stays
   *  where it is, in order.
   *
   *  Refused for a terminal the device is not watching, like `seed`: the watch list is the `read` check. */
  reseed(deviceId: string, terminalId: string, screen: ScreenView): void {
    const d = this.devices.get(deviceId)
    if (!d?.terminals.has(terminalId)) return
    this.replaceQueued(d, terminalId, screen)
    this.trim(d.queue)
  }

  /** What is waiting for a device, counted: the numbers a test or a gauge reads without draining it. */
  queuedFor(deviceId: string): { chunks: number; chars: number } {
    const q = this.devices.get(deviceId)?.queue ?? []
    return { chunks: q.length, chars: q.reduce((n, c) => n + c.chunk.length, 0) }
  }

  /** Where in the stream a gap notice sits in a device's copy of a terminal, or null when it holds none.
   *
   *  A notice is drawn into the phone's copy but not counted in its end mark, so afterwards the copy runs a
   *  notice longer than the mark says, and an edit anchored BEFORE the notice keeps that much of the old text
   *  it meant to cut (see `FORGET_FROM`). A rewrite of the live region has to know whether it would. Only
   *  notices the device was actually SENT count -- a queued one is not in its copy yet -- and a screen behind
   *  a forget replaces the copy, notices and all. `Infinity` is a notice with no anchor: where it was drawn
   *  is the end of a copy this fan-out does not track. */
  gapAt(deviceId: string, terminalId: string): number | null {
    return this.devices.get(deviceId)?.gaps.get(terminalId) ?? null
  }

  private replaceQueued(d: Device, terminalId: string, screen: ScreenView): void {
    d.queue = d.queue.filter((c) => c.terminalId !== terminalId)
    d.queue.push(forgetting(terminalId), {
      terminalId,
      chunk: screen.text,
      missed: 0,
      replaceFrom: screen.replaceFrom,
    })
  }

  /** A device that has fallen behind is held to a screen, not to the head of a list of edits.
   *
   *  Evicting the head keeps the NEWEST edits, each measured against a copy the older ones built and the
   *  phone no longer gets, and reports the loss -- while the screen those edits add up to is a few KB. So once
   *  a terminal has more than `collapseAfter` chunks queued for one device they are replaced by its screen as
   *  it stands now, which is where the edit that was just queued has already taken it. The loss counts the
   *  replaced chunks carried go with them: what was lost came before a whole new screen, not out of it.
   *
   *  Counted per terminal, so a device watching several is never made to give up one terminal's edits for
   *  another's. A terminal with no screen to give (`screenOf` says null, or there is no `screenOf`) is left
   *  to the ceiling in `trim`, as before. */
  private collapse(d: Device, terminalId: string): void {
    if (this.screenOf === undefined) return
    let held = 0
    for (const c of d.queue) if (c.terminalId === terminalId) held += 1
    if (held <= this.collapseAfter) return
    const screen = this.screenOf(terminalId)
    if (screen !== null) this.replaceQueued(d, terminalId, screen)
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
        // The offset counted from the start of text that no longer starts here.
        // Honouring it now would truncate the receiver back to a point this
        // shortened chunk can no longer refill, so the piece becomes a plain
        // append -- the gap it leaves is what the `missed` count below is for.
        head.replaceFrom = null
      }
    }
    if (evicted > 0 && q.length > 0) q[0].missed += evicted
  }

  drain(deviceId: string): DrainedChunk[] {
    const d = this.devices.get(deviceId)
    if (!d || d.queue.length === 0) return []
    const q = d.queue
    d.queue = []
    for (const c of q) {
      // A notice goes into the copy where the chunk that carries it is anchored -- or at the end of the
      // copy, which is nowhere the fan-out knows, when the chunk has no anchor...
      if (c.missed > 0) d.gaps.set(c.terminalId, Math.max(d.gaps.get(c.terminalId) ?? 0, c.replaceFrom ?? Infinity))
      // ...and a forget empties the copy, notice and all: whatever a forget itself carried was drawn into
      // the copy and wiped by the screen behind it.
      if (c.replaceFrom === FORGET_FROM) d.gaps.delete(c.terminalId)
    }
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
