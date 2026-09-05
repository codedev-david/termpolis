import { describe, it, expect, vi } from 'vitest'
import type { OutputSlice } from '../../src/main/remoteBridge/protocol'
import { createOutputPump } from '../../src/main/remoteOutputPump'

/** A hand-driven clock. Real timers would make every assertion here a race, and
 *  the whole point of the pump is WHEN it sends, not just what. */
function fakeTimers() {
  let pending: (() => void) | null = null
  let handle = 0
  let live = 0
  return {
    get pendingCount() {
      return live
    },
    setTimer(fn: () => void) {
      live++
      pending = fn
      return ++handle
    },
    clearTimer() {
      live--
      pending = null
    },
    /** Fire whatever the pump scheduled, as the event loop eventually would. */
    tick() {
      const fn = pending
      pending = null
      live--
      fn?.()
    },
  }
}

/** A terminal whose output is appended to and read from by offset, the same
 *  contract `readOutputFrom` has in main. */
function fakeTerminals(initial: Record<string, string> = {}) {
  const text: Record<string, string> = { ...initial }
  const missedAt: Record<string, number> = {}
  return {
    write(id: string, s: string) {
      text[id] = (text[id] ?? '') + s
    },
    /** Pretend `n` chars fell out of the window before the reader arrived. */
    setMissed(id: string, n: number) {
      missedAt[id] = n
    },
    read(id: string, fromOffset: number): OutputSlice {
      const all = text[id] ?? ''
      const missed = missedAt[id] ?? 0
      missedAt[id] = 0
      return { output: all.slice(fromOffset), nextOffset: all.length, missed }
    },
  }
}

function harness(initial: Record<string, string> = {}) {
  const timers = fakeTimers()
  const terminals = fakeTerminals(initial)
  const sent: Array<{ terminalId: string; slice: OutputSlice }> = []
  const pump = createOutputPump({
    read: (id, from) => terminals.read(id, from),
    send: (terminalId, slice) => sent.push({ terminalId, slice }),
    setTimer: (fn, ms) => timers.setTimer(fn, ms),
    clearTimer: (h) => timers.clearTimer(h),
    intervalMs: 50,
  })
  return { pump, timers, terminals, sent }
}

describe('createOutputPump', () => {
  it('coalesces many markDirty calls into a single flush', () => {
    // This is the whole reason the pump exists. A held key produces a PTY write
    // per character; without the schedule-if-not-pending guard each one would
    // cross the process boundary on its own.
    const h = harness()
    h.pump.setSubscriptions(['t1'])
    const setTimer = vi.spyOn(h.timers, 'setTimer')
    for (let i = 0; i < 50; i++) {
      h.terminals.write('t1', 'x')
      h.pump.markDirty('t1')
    }
    expect(setTimer).toHaveBeenCalledTimes(1)
    expect(h.sent).toEqual([])
    h.timers.tick()
    expect(h.sent).toEqual([{ terminalId: 't1', slice: { output: 'x'.repeat(50), nextOffset: 50, missed: 0 } }])
  })

  it('sends contiguous slices by carrying nextOffset forward', () => {
    // The offset is the pump's whole memory of a terminal. Re-reading from 0
    // would resend the entire window every tick; never advancing would send the
    // same chunk forever.
    const h = harness()
    h.pump.setSubscriptions(['t1'])
    h.terminals.write('t1', 'hello')
    h.pump.markDirty('t1')
    h.timers.tick()
    h.terminals.write('t1', ' world')
    h.pump.markDirty('t1')
    h.timers.tick()
    expect(h.sent.map((s) => s.slice.output)).toEqual(['hello', ' world'])
    expect(h.sent[1].slice.nextOffset).toBe(11)
  })

  it('sends a slice that is only a missed count, with no output', () => {
    // Dropped output is the one failure the user cannot detect for themselves.
    // A slice whose text is empty but whose `missed` is not still has to travel,
    // or the gap notice never reaches the phone.
    const h = harness()
    h.pump.setSubscriptions(['t1'])
    h.terminals.setMissed('t1', 4096)
    h.pump.markDirty('t1')
    h.timers.tick()
    expect(h.sent).toEqual([{ terminalId: 't1', slice: { output: '', nextOffset: 0, missed: 4096 } }])
  })

  it('sends nothing when there is neither new output nor a gap', () => {
    const h = harness()
    h.pump.setSubscriptions(['t1'])
    h.pump.markDirty('t1')
    h.timers.tick()
    expect(h.sent).toEqual([])
  })

  it('ignores a terminal nobody is subscribed to', () => {
    // The point of the subscription set: main pays the serialisation cost only
    // for terminals a phone is actually watching.
    const h = harness()
    h.pump.setSubscriptions(['t1'])
    h.terminals.write('t2', 'noise')
    h.pump.markDirty('t2')
    h.timers.tick()
    expect(h.sent).toEqual([])
  })

  it('flushes a terminal one last time as it leaves the subscription set', () => {
    // Output written between the last tick and the unsubscribe is already on the
    // phone's screen conceptually -- it asked for it. Dropping it silently
    // truncates the transcript at an arbitrary point.
    const h = harness()
    h.pump.setSubscriptions(['t1'])
    h.terminals.write('t1', 'tail end')
    h.pump.setSubscriptions([])
    expect(h.sent).toEqual([{ terminalId: 't1', slice: { output: 'tail end', nextOffset: 8, missed: 0 } }])
  })

  it('forgets a terminal offset on dropTerminal so a reused id starts clean', () => {
    // Terminal ids are reused across a session. A stale offset would make the
    // new terminal's first read start mid-stream, hiding its opening output.
    const h = harness()
    h.pump.setSubscriptions(['t1'])
    h.terminals.write('t1', '12345')
    h.pump.markDirty('t1')
    h.timers.tick()
    h.pump.dropTerminal('t1')
    h.pump.markDirty('t1')
    h.timers.tick()
    expect(h.sent.map((s) => s.slice.output)).toEqual(['12345', '12345'])
  })

  it('does not read a terminal that closed mid-burst', () => {
    // dropTerminal cancels the dirt the closing terminal had queued, so the tick
    // it was heading for finds nothing to do.
    const h = harness()
    h.pump.setSubscriptions(['t1'])
    h.terminals.write('t1', 'gone')
    h.pump.markDirty('t1')
    h.pump.dropTerminal('t1')
    h.timers.tick()
    expect(h.sent).toEqual([])
  })

  it('leaves the subscription in place when a terminal is dropped', () => {
    // The subscribed set belongs to the bridge and is mirrored down here.
    // Dropping an id locally would put the two out of step with no message that
    // puts them back -- the bridge announces only when its OWN set changes, so a
    // phone still subscribed to a reused id would never be re-added, and its
    // screen would go quiet with nothing to explain it.
    const h = harness()
    h.pump.setSubscriptions(['t1'])
    h.pump.dropTerminal('t1')
    h.terminals.write('t1', 'reused terminal, same id')
    h.pump.markDirty('t1')
    h.timers.tick()
    expect(h.sent.map((s) => s.slice.output)).toEqual(['reused terminal, same id'])
  })

  it('flushNow sends immediately and cancels the pending timer', () => {
    const h = harness()
    h.pump.setSubscriptions(['t1'])
    h.terminals.write('t1', 'now')
    h.pump.markDirty('t1')
    h.pump.flushNow()
    expect(h.sent.map((s) => s.slice.output)).toEqual(['now'])
    expect(h.timers.pendingCount).toBe(0)
    // And the cancelled timer must not fire a second, empty flush later.
    h.timers.tick()
    expect(h.sent).toHaveLength(1)
  })

  it('stop clears a pending timer and ignores later dirt', () => {
    // The pump outlives nothing: when remote is switched off, a timer still
    // holding a closure over `send` would push into a bridge that is gone.
    const h = harness()
    h.pump.setSubscriptions(['t1'])
    h.terminals.write('t1', 'late')
    h.pump.markDirty('t1')
    h.pump.stop()
    expect(h.timers.pendingCount).toBe(0)
    h.pump.markDirty('t1')
    expect(h.timers.pendingCount).toBe(0)
    h.timers.tick()
    expect(h.sent).toEqual([])
  })

  it('re-subscribing a terminal resumes from where it left off', () => {
    const h = harness()
    h.pump.setSubscriptions(['t1'])
    h.terminals.write('t1', 'abc')
    h.pump.markDirty('t1')
    h.timers.tick()
    h.pump.setSubscriptions([])
    h.terminals.write('t1', 'def')
    h.pump.setSubscriptions(['t1'])
    h.pump.markDirty('t1')
    h.timers.tick()
    expect(h.sent.map((s) => s.slice.output)).toEqual(['abc', 'def'])
  })

  it('keeps sending other terminals when one read throws', () => {
    // A read is a map lookup in main, but the pump runs on a timer with no
    // caller to catch for it: one bad terminal must not stop the rest.
    const timers = fakeTimers()
    const sent: string[] = []
    const pump = createOutputPump({
      read: (id) => {
        if (id === 'bad') throw new Error('boom')
        return { output: id, nextOffset: 1, missed: 0 }
      },
      send: (terminalId) => sent.push(terminalId),
      setTimer: (fn, ms) => timers.setTimer(fn, ms),
      clearTimer: (h) => timers.clearTimer(h),
    })
    pump.setSubscriptions(['bad', 'good'])
    pump.markDirty('bad')
    pump.markDirty('good')
    timers.tick()
    expect(sent).toEqual(['good'])
  })
})
