import { describe, it, expect, vi } from 'vitest'
import type { OutputSlice } from '../../src/main/remoteBridge/protocol'
import { createOutputPump } from '../../src/main/remoteOutputPump'

/** A hand-driven clock. Real timers would make every assertion here a race, and
 *  the whole point of the pump is WHEN it sends, not just what. */
function fakeTimers() {
  let pending: (() => void) | null = null
  let handle = 0
  let live = 0
  let lastDelay = -1
  const cleared: unknown[] = []
  return {
    get pendingCount() {
      return live
    },
    /** What the pump asked to wait, and what it later cancelled. Recorded rather
     *  than ignored: the coalescing interval IS the feature -- a pump that
     *  scheduled at 0ms would pass every other assertion in this file. */
    get lastDelay() {
      return lastDelay
    },
    cleared,
    setTimer(fn: () => void, ms: number) {
      live++
      pending = fn
      lastDelay = ms
      return ++handle
    },
    clearTimer(h: unknown) {
      cleared.push(h)
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
  // `reset` is recorded only when it is set, so an assertion about an ordinary
  // incremental slice reads the same as it always has.
  const sent: Array<{ terminalId: string; slice: OutputSlice; reset?: true }> = []
  const pump = createOutputPump({
    read: (id, from) => terminals.read(id, from),
    send: (terminalId, slice, reset) =>
      sent.push(reset === true ? { terminalId, slice, reset } : { terminalId, slice }),
    setTimer: (fn, ms) => timers.setTimer(fn, ms),
    clearTimer: (h) => timers.clearTimer(h),
    intervalMs: 50,
  })
  /** Subscribe, then forget the opening reads that subscribing sends -- for the
   *  tests about what happens AFTER a phone is watching. The opening read has a
   *  describe block of its own below. */
  function watching(ids: string[]): void {
    pump.setSubscriptions(ids)
    sent.length = 0
  }
  return { pump, timers, terminals, sent, watching }
}

describe('createOutputPump', () => {
  it('coalesces many markDirty calls into a single flush', () => {
    // This is the whole reason the pump exists. A held key produces a PTY write
    // per character; without the schedule-if-not-pending guard each one would
    // cross the process boundary on its own.
    const h = harness()
    h.watching(['t1'])
    const setTimer = vi.spyOn(h.timers, 'setTimer')
    for (let i = 0; i < 50; i++) {
      h.terminals.write('t1', 'x')
      h.pump.markDirty('t1')
    }
    expect(setTimer).toHaveBeenCalledTimes(1)
    // At the interval, not immediately: a 0ms schedule would still be one timer
    // per burst and would pass the count above while sending on every keystroke.
    expect(h.timers.lastDelay).toBe(50)
    expect(h.sent).toEqual([])
    h.timers.tick()
    expect(h.sent).toEqual([{ terminalId: 't1', slice: { output: 'x'.repeat(50), nextOffset: 50, missed: 0 } }])
  })

  it('sends contiguous slices by carrying nextOffset forward', () => {
    // The offset is the pump's whole memory of a terminal. Re-reading from 0
    // would resend the entire window every tick; never advancing would send the
    // same chunk forever.
    const h = harness()
    h.watching(['t1'])
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
    h.watching(['t1'])
    h.terminals.setMissed('t1', 4096)
    h.pump.markDirty('t1')
    h.timers.tick()
    expect(h.sent).toEqual([{ terminalId: 't1', slice: { output: '', nextOffset: 0, missed: 4096 } }])
  })

  it('sends nothing when there is neither new output nor a gap', () => {
    const h = harness()
    h.watching(['t1'])
    h.pump.markDirty('t1')
    h.timers.tick()
    expect(h.sent).toEqual([])
  })

  it('ignores a terminal nobody is subscribed to', () => {
    // The point of the subscription set: main pays the serialisation cost only
    // for terminals a phone is actually watching.
    const h = harness()
    h.watching(['t1'])
    h.terminals.write('t2', 'noise')
    h.pump.markDirty('t2')
    h.timers.tick()
    expect(h.sent).toEqual([])
  })

  it('does not read a terminal as it leaves the subscription set', () => {
    // By the time main hears a terminal left, the bridge has already dropped
    // the subscription AND the screen it kept for it. A last read has nowhere to
    // go -- it used to be sent anyway, and it planted a fresh screen in the
    // bridge holding one stray slice, which the next phone to open that terminal
    // was then sent edits against. The dirt it had queued goes with it.
    const h = harness()
    h.watching(['t1'])
    h.terminals.write('t1', 'tail end')
    h.pump.markDirty('t1')
    h.pump.setSubscriptions([])
    expect(h.sent).toEqual([])
    h.timers.tick()
    expect(h.sent).toEqual([])
  })

  it('forgets a terminal offset on dropTerminal so a reused id starts clean', () => {
    // Terminal ids are reused across a session. A stale offset would make the
    // new terminal's first read start mid-stream, hiding its opening output --
    // and it has to be an OPENING read, or the bridge draws the new terminal on
    // top of what the old one left.
    const h = harness()
    h.watching(['t1'])
    h.terminals.write('t1', '12345')
    h.pump.markDirty('t1')
    h.timers.tick()
    h.pump.dropTerminal('t1')
    h.pump.markDirty('t1')
    h.timers.tick()
    expect(h.sent).toEqual([
      { terminalId: 't1', slice: { output: '12345', nextOffset: 5, missed: 0 } },
      { terminalId: 't1', slice: { output: '12345', nextOffset: 5, missed: 0 }, reset: true },
    ])
  })

  it('does not read a terminal that closed mid-burst', () => {
    // dropTerminal cancels the dirt the closing terminal had queued, so the tick
    // it was heading for finds nothing to do.
    const h = harness()
    h.watching(['t1'])
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
    h.watching(['t1'])
    h.pump.dropTerminal('t1')
    h.terminals.write('t1', 'reused terminal, same id')
    h.pump.markDirty('t1')
    h.timers.tick()
    expect(h.sent).toEqual([
      { terminalId: 't1', slice: { output: 'reused terminal, same id', nextOffset: 24, missed: 0 }, reset: true },
    ])
  })

  it('flushNow sends immediately and cancels the pending timer', () => {
    const h = harness()
    h.watching(['t1'])
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
    h.watching(['t1'])
    h.terminals.write('t1', 'late')
    h.pump.markDirty('t1')
    h.pump.stop()
    expect(h.timers.pendingCount).toBe(0)
    h.pump.markDirty('t1')
    expect(h.timers.pendingCount).toBe(0)
    h.timers.tick()
    expect(h.sent).toEqual([])
  })

  it('does not read a terminal that stays subscribed across a change', () => {
    // Only a terminal that JOINS is read on a change. Reading the survivors too
    // would send whatever the tick was about to send anyway, a tick early and out
    // of band -- and on every subscription change a phone makes.
    const h = harness()
    h.watching(['t1', 't2'])
    h.terminals.write('t1', 'stays')
    h.terminals.write('t2', 'goes')
    h.pump.setSubscriptions(['t1'])
    expect(h.sent).toEqual([])
  })

  it('flushNow after stop sends nothing', () => {
    // stop() cancels the pending timer, but flushNow is a public entry point and
    // reaches `flush` directly -- an unguarded one would push into a bridge the
    // caller has already torn down.
    const h = harness()
    h.watching(['t1'])
    h.terminals.write('t1', 'too late')
    h.pump.markDirty('t1')
    h.pump.stop()
    h.pump.flushNow()
    expect(h.sent).toEqual([])
  })

  it('setSubscriptions after stop reads nothing, not even a joining terminal', () => {
    // The bridge can announce a subscription change while main is shutting the
    // pump down. The opening read a joining terminal normally earns would be
    // sent into a bridge that is already gone.
    const h = harness({ t2: 'joining' })
    h.watching(['t1'])
    h.terminals.write('t1', 'tail')
    h.pump.stop()
    h.pump.setSubscriptions(['t2'])
    expect(h.sent).toEqual([])
  })

  it('starts a re-subscribed terminal over from the whole window', () => {
    // Between the two subscriptions nobody was watching, so the bridge let its
    // screen go; resuming mid-stream would hand it a fragment with nothing to
    // draw it on. The phone gets the whole window again, marked as a reset.
    const h = harness()
    h.watching(['t1'])
    h.terminals.write('t1', 'abc')
    h.pump.markDirty('t1')
    h.timers.tick()
    h.pump.setSubscriptions([])
    h.terminals.write('t1', 'def')
    h.pump.setSubscriptions(['t1'])
    expect(h.sent).toEqual([
      { terminalId: 't1', slice: { output: 'abc', nextOffset: 3, missed: 0 } },
      { terminalId: 't1', slice: { output: 'abcdef', nextOffset: 6, missed: 0 }, reset: true },
    ])
  })

  it('keeps sending other terminals when one read throws', () => {
    // A read is a map lookup in main, but the pump runs on a timer with no
    // caller to catch for it: one bad terminal must not stop the rest -- not at
    // the opening read, and not at a tick.
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
    expect(sent).toEqual(['good'])
    sent.length = 0
    pump.markDirty('bad')
    pump.markDirty('good')
    timers.tick()
    expect(sent).toEqual(['good'])
  })
})

describe('createOutputPump: the opening read', () => {
  it('sends an idle terminal the moment a phone starts watching it', () => {
    // The reported bug. A terminal that already printed its screen and then went
    // quiet -- an agent's TUI waiting at its prompt -- is never marked dirty
    // again, because nothing new is written to it. Reading only on dirt meant a
    // phone that opened it saw a blank screen until the user typed, when the
    // echo finally made it dirty. Joining the watched set is itself the reason
    // to read: no markDirty, no tick.
    const h = harness({ t1: 'Claude Code\n> waiting for input' })
    h.pump.setSubscriptions(['t1'])
    expect(h.sent).toEqual([
      {
        terminalId: 't1',
        slice: { output: 'Claude Code\n> waiting for input', nextOffset: 31, missed: 0 },
        reset: true,
      },
    ])
    expect(h.timers.pendingCount).toBe(0)
  })

  it('sends an empty terminal too, so the bridge can clear what a phone held', () => {
    // Nothing on screen is still a screen. Skipping the empty read would leave
    // the bridge -- and so the phone -- holding whatever it had from before.
    const h = harness()
    h.pump.setSubscriptions(['t1'])
    expect(h.sent).toEqual([{ terminalId: 't1', slice: { output: '', nextOffset: 0, missed: 0 }, reset: true }])
  })

  it('does not report history that scrolled away before anyone watched as lost', () => {
    // A read from the start of the window always "misses" what fell out of it
    // before anyone asked. Passing that on paints "1.2 MB skipped (terminal
    // outran this device)" over every busy terminal a phone opens -- nothing
    // outran the phone; it was not watching yet. A REAL gap afterwards still
    // travels.
    const h = harness({ t1: 'screen' })
    h.terminals.setMissed('t1', 1_200_000)
    h.pump.setSubscriptions(['t1'])
    h.terminals.setMissed('t1', 10)
    h.pump.markDirty('t1')
    h.timers.tick()
    expect(h.sent).toEqual([
      { terminalId: 't1', slice: { output: 'screen', nextOffset: 6, missed: 0 }, reset: true },
      { terminalId: 't1', slice: { output: '', nextOffset: 6, missed: 10 } },
    ])
  })

  it('reads on from the opening read rather than from the start again', () => {
    const h = harness({ t1: 'abc' })
    h.pump.setSubscriptions(['t1'])
    h.terminals.write('t1', 'def')
    h.pump.markDirty('t1')
    h.timers.tick()
    expect(h.sent[1]).toEqual({ terminalId: 't1', slice: { output: 'def', nextOffset: 6, missed: 0 } })
  })

  it('reads only the terminals that joined', () => {
    // A second phone opening a second terminal must not resend the first.
    const h = harness({ t1: 'one', t2: 'two' })
    h.watching(['t1'])
    h.pump.setSubscriptions(['t1', 't2'])
    expect(h.sent).toEqual([{ terminalId: 't2', slice: { output: 'two', nextOffset: 3, missed: 0 }, reset: true }])
  })

  it('does not send a terminal twice when it was already dirty as it joined', () => {
    // The opening read took everything the pending tick was going to, so the
    // tick finds nothing new.
    const h = harness()
    h.terminals.write('t1', 'x')
    h.pump.markDirty('t1')
    h.pump.setSubscriptions(['t1'])
    h.timers.tick()
    expect(h.sent).toEqual([{ terminalId: 't1', slice: { output: 'x', nextOffset: 1, missed: 0 }, reset: true }])
  })

  it('retries an opening read that threw as an opening read', () => {
    // Nothing was stored for it, so the next read still starts from the top and
    // still tells the bridge to start over.
    const h = harness({ t1: 'first' })
    let fail = true
    const sent: Array<{ slice: OutputSlice; reset: boolean }> = []
    const pump = createOutputPump({
      read: (id, from) => {
        if (fail) {
          fail = false
          throw new Error('boom')
        }
        return h.terminals.read(id, from)
      },
      send: (_id, slice, reset) => sent.push({ slice, reset }),
      setTimer: (fn, ms) => h.timers.setTimer(fn, ms),
      clearTimer: (t) => h.timers.clearTimer(t),
    })
    pump.setSubscriptions(['t1'])
    expect(sent).toEqual([])
    h.terminals.write('t1', ' then more')
    pump.markDirty('t1')
    h.timers.tick()
    expect(sent).toEqual([{ slice: { output: 'first then more', nextOffset: 15, missed: 0 }, reset: true }])
  })
})
