import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createPaneEffects, trackPaneEffects, paneEffectsSnapshot, EFFECTS_VISIBLE_MS, EFFECTS_HIDDEN_MS, type EffectsClock } from '../../src/renderer/src/lib/paneSideEffects'
import { DEFAULT_REPRIME_QUIET_MS } from '../../src/renderer/src/lib/compactionReprime'

// What a pane does for every chunk of its terminal's output besides writing it to xterm (1.54.5, plan package P9): the
// 4 KB window, the diff test, the escape strips, the prompt parse, agent detection, the compaction and session
// controllers, the OSC 633 and error patterns. The base ran ALL of it for EVERY chunk, 125 chunks a second from a
// streaming terminal at main's coalescer ceiling, for every mounted pane, hidden or not. Counters, not wall-clock: how
// many passes run per second, over how many characters, and what is left pending.
//
// Every claim has a NEGATIVE CONTROL in this file: pushing through a pass-per-message function (what the kill switch
// gives, and the base) shows the same offered load costing one pass per message.

/** A virtual clock: nothing here waits for real time. */
function fakeClock(): EffectsClock & { advance: (ms: number) => void; time: () => number; timers: () => number } {
  let t = 1_000_000
  let seq = 0
  const timers = new Map<number, { at: number; fn: () => void }>()
  const fire = (upTo: number): void => {
    for (;;) {
      let next: [number, { at: number; fn: () => void }] | null = null
      for (const entry of timers) if (entry[1].at <= upTo && (next === null || entry[1].at < next[1].at)) next = entry
      if (!next) return
      timers.delete(next[0])
      t = Math.max(t, next[1].at)
      next[1].fn()
    }
  }
  return {
    now: () => t,
    setTimer: (fn, ms) => { const id = ++seq; timers.set(id, { at: t + ms, fn }); return id },
    clearTimer: (h) => { timers.delete(h as number) },
    advance(ms) { const target = t + ms; fire(target); t = target },
    time: () => t,
    timers: () => timers.size,
  }
}

interface Pass { frame: string; messages: number; at: number }

function setup(opts: { visible?: boolean; visibleMs?: number; hiddenMs?: number; maxFrameChars?: number } = {}) {
  const clock = fakeClock()
  const passes: Pass[] = []
  let visible = opts.visible ?? true
  const effects = createPaneEffects({
    run: (frame, messages) => { passes.push({ frame, messages, at: clock.time() }) },
    isVisible: () => visible,
    clock,
    ...(opts.visibleMs !== undefined ? { visibleMs: opts.visibleMs } : {}),
    ...(opts.hiddenMs !== undefined ? { hiddenMs: opts.hiddenMs } : {}),
    ...(opts.maxFrameChars !== undefined ? { maxFrameChars: opts.maxFrameChars } : {}),
  })
  return { clock, passes, effects, setVisible: (v: boolean) => { visible = v } }
}

/** Offer `perSecond` messages a second for `seconds`, spread evenly. Returns the messages offered. */
function offer(h: ReturnType<typeof setup>, perSecond: number, seconds: number, chars = 64): number {
  const step = 1000 / perSecond
  let n = 0
  const total = Math.round(perSecond * seconds)
  for (let i = 0; i < total; i++) {
    h.effects.push('x'.repeat(chars))
    n++
    h.clock.advance(step)
  }
  return n
}

describe('the per-pass side effects: how often they run', () => {
  it('125 messages a second offered to a pane on screen: at most 4 passes a second per terminal (the base: 125)', () => {
    const h = setup({ visible: true })
    const seconds = 10
    const offered = offer(h, 125, seconds)
    expect(offered).toBe(1250)
    // The first pass is the leading edge (a lone prompt is handled at once); after it, one per 250 ms.
    expect(h.passes.length).toBeLessThanOrEqual(4 * seconds + 1)
    expect(h.passes.length).toBeGreaterThanOrEqual(4 * seconds - 1)
    // In any 1 s window of the run, at most 4 passes (5 would be 5 within [t, t+1000]).
    for (let i = 0; i + 4 < h.passes.length; i++) {
      expect(h.passes[i + 4].at - h.passes[i].at).toBeGreaterThanOrEqual(1000)
    }
    expect(h.effects.stats()).toMatchObject({ messages: 1250, passes: h.passes.length })
  })

  it('NEGATIVE CONTROL: a pass per message (the kill switch, and the base) is 125 passes a second for the same load', () => {
    const clock = fakeClock()
    let passes = 0
    const perMessage = (_data: string): void => { passes++ }
    const step = 1000 / 125
    for (let i = 0; i < 1250; i++) { perMessage('x'.repeat(64)); clock.advance(step) }
    expect(passes / 10).toBe(125)
  })

  it('every character offered is in exactly one pass, in order, and the message counts add up', () => {
    const h = setup()
    const sent: string[] = []
    for (let i = 0; i < 1000; i++) {
      const piece = `<${i}>`
      sent.push(piece)
      h.effects.push(piece)
      h.clock.advance(3)
    }
    h.clock.advance(1000) // let the last trailing pass run
    expect(h.passes.map((p) => p.frame).join('')).toBe(sent.join(''))
    expect(h.passes.reduce((n, p) => n + p.messages, 0)).toBe(1000)
    expect(h.effects.stats()).toMatchObject({ messages: 1000, pendingChars: 0, pendingMessages: 0, droppedChars: 0 })
  })

  it('a lone message after quiet runs at once (the first prompt after Enter is parsed with no delay)', () => {
    const h = setup()
    h.clock.advance(5000)
    h.effects.push('$ ')
    expect(h.passes).toHaveLength(1)
    expect(h.passes[0]).toMatchObject({ frame: '$ ', messages: 1 })
    expect(h.clock.timers()).toBe(0)
  })

  it('a message inside the window is not dropped: exactly one pass is scheduled for when the window ends, and it sees all of them', () => {
    const h = setup()
    h.effects.push('echo')          // leading edge, runs now
    h.clock.advance(30)
    h.effects.push('\r\n')
    h.clock.advance(30)
    h.effects.push('$ ')            // the prompt, 60 ms later: must not be lost
    expect(h.passes).toHaveLength(1)
    expect(h.clock.timers()).toBe(1)
    h.clock.advance(190)
    expect(h.passes).toHaveLength(2)
    expect(h.passes[1]).toMatchObject({ frame: '\r\n$ ', messages: 2 })
    expect(h.passes[1].at - h.passes[0].at).toBe(250)
    expect(h.clock.timers()).toBe(0)
  })

  it('a clock that steps BACK (a time sync, a resume) does not leave the next pass waiting out the whole step', () => {
    const h = setup()
    h.effects.push('a')                      // leading edge at t0
    expect(h.passes).toHaveLength(1)
    h.clock.advance(-3_600_000)              // the wall clock jumps back an hour
    h.effects.push('b')                      // inside what would now be "the future" of the last pass
    expect(h.clock.timers()).toBe(1)
    h.clock.advance(EFFECTS_VISIBLE_MS + 1)  // one window later, not one hour
    expect(h.passes).toHaveLength(2)
    expect(h.passes[1]).toMatchObject({ frame: 'b', messages: 1 })
  })

  it('a message exactly one window after the last pass runs at once (the window is "at least", not "more than")', () => {
    const h = setup()
    h.effects.push('a')
    expect(h.passes).toHaveLength(1)
    h.clock.advance(EFFECTS_VISIBLE_MS) // exactly one window
    h.effects.push('b')
    expect(h.passes).toHaveLength(2)
    expect(h.clock.timers()).toBe(0)
    // ... and one millisecond short of it is deferred, to the end of the window.
    h.clock.advance(EFFECTS_VISIBLE_MS - 1)
    h.effects.push('c')
    expect(h.passes).toHaveLength(2)
    expect(h.clock.timers()).toBe(1)
    h.clock.advance(1)
    expect(h.passes).toHaveLength(3)
  })

  it('nothing runs and nothing is armed while nothing arrives', () => {
    const h = setup()
    h.clock.advance(60_000)
    expect(h.passes).toHaveLength(0)
    expect(h.clock.timers()).toBe(0)
  })
})

describe('the per-pass side effects: the windows against what consumes them', () => {
  it("a pane that streams is heard from at least twice inside compaction's quiet timer, hidden or not (or the timer would fire in the middle of a compaction)", () => {
    expect(EFFECTS_HIDDEN_MS * 2).toBeLessThanOrEqual(DEFAULT_REPRIME_QUIET_MS)
    expect(EFFECTS_VISIBLE_MS).toBeLessThan(EFFECTS_HIDDEN_MS)
  })

  it('the window defaults are what the plan names: at most 4 passes a second on screen, about 1 a second behind it', () => {
    expect(1000 / EFFECTS_VISIBLE_MS).toBeLessThanOrEqual(4)
    expect(1000 / EFFECTS_HIDDEN_MS).toBeLessThanOrEqual(1)
  })
})

describe('the per-pass side effects: a pane that is not on screen', () => {
  it('runs a slow pass (1 a second), not none: compaction, session reflection and agent detection of a background agent still see its output', () => {
    const h = setup({ visible: false })
    const seconds = 10
    offer(h, 125, seconds)
    expect(h.passes.length).toBeGreaterThan(0)
    expect(h.passes.length).toBeLessThanOrEqual(1 * seconds + 1)
    // Nothing was lost on the way: what the passes saw plus what still waits is everything offered.
    const seen = h.passes.reduce((n, p) => n + p.frame.length, 0)
    expect(seen + h.effects.stats().pendingChars).toBe(64 * 1250)
  })

  it('shown again: the pending pass runs at once (flush), so the pane\'s state is current the moment it is looked at', () => {
    const h = setup({ visible: false })
    h.effects.push('a')            // leading edge
    h.clock.advance(100)
    h.effects.push('b')
    h.effects.push('c')            // pending behind the 1 s hidden window
    expect(h.passes).toHaveLength(1)
    h.setVisible(true)
    h.effects.flush()
    expect(h.passes).toHaveLength(2)
    expect(h.passes[1]).toMatchObject({ frame: 'bc', messages: 2 })
    expect(h.clock.timers()).toBe(0)
  })

  it('a flush with nothing pending runs nothing', () => {
    const h = setup()
    h.effects.flush()
    h.effects.push('a')
    h.effects.flush()
    expect(h.passes).toHaveLength(1)
  })

  it('a pane that is shown while a slow pass is pending gets the fast window, not the rest of the slow one', () => {
    const h = setup({ visible: false })
    h.effects.push('a')            // runs now (leading)
    h.clock.advance(10)
    h.effects.push('b')            // hidden: due in 990 ms
    h.setVisible(true)
    h.effects.push('c')            // visible: due 240 ms after the first pass, sooner than the slow timer
    h.clock.advance(235)
    expect(h.passes).toHaveLength(1)
    h.clock.advance(10)
    expect(h.passes).toHaveLength(2)
    expect(h.passes[1].frame).toBe('bc')
  })

  it('hidden again after being shown: back to the slow window', () => {
    const h = setup({ visible: true })
    h.effects.push('a')
    h.setVisible(false)
    h.clock.advance(100)
    h.effects.push('b')
    h.clock.advance(300)
    expect(h.passes).toHaveLength(1) // 400 ms after the first: a visible pane would have run by now
    h.clock.advance(700)
    expect(h.passes).toHaveLength(2)
  })
})

describe('the per-pass side effects: bounded memory, failing open', () => {
  it('keeps at most maxFrameChars of a flood (the newest), counts what it dropped, and never lets pending grow', () => {
    const h = setup({ maxFrameChars: 1000 })
    h.effects.push('start')               // leading pass, now empty
    h.clock.advance(1)
    for (let i = 0; i < 500; i++) h.effects.push(`[${String(i).padStart(4, '0')}]`) // 6 chars each: 3000 chars in 1 window
    const stats = h.effects.stats()
    expect(stats.pendingChars).toBeLessThanOrEqual(1000)
    expect(stats.droppedChars).toBe(3000 - stats.pendingChars)
    h.clock.advance(300)
    const frame = h.passes[1].frame
    expect(frame.length).toBeLessThanOrEqual(1000)
    expect(frame.endsWith('[0499]')).toBe(true)       // the newest survives
    expect(h.passes[1].messages).toBe(500)            // and the pass knows how many messages it stands for
  })

  it('a flood of one-character messages under a tiny cap stays tiny, and the consumed prefix is released (the array does not grow with the flood)', () => {
    const h = setup({ maxFrameChars: 10 })
    h.effects.push('0')                    // leading pass
    h.clock.advance(1)
    const flood = 5000
    for (let i = 0; i < flood; i++) h.effects.push(String(i % 10))
    expect(h.effects.stats()).toMatchObject({ pendingChars: 10, pendingMessages: flood, droppedChars: flood - 10 })
    h.clock.advance(300)
    expect(h.passes[1].frame).toBe('0123456789'.slice(0, 10)) // the newest ten: 4990..4999 mod 10 = 0..9
    expect(h.passes[1].messages).toBe(flood)
  })

  it('when only ONE chunk survives the cap it is that chunk (not the first slot of the array): the frame is the newest ten', () => {
    const h = setup({ maxFrameChars: 10 })
    h.effects.push('lead')
    h.clock.advance(1)
    h.effects.push('aaaa')            // 4
    h.effects.push('bbbbbbbbbb')      // 10: 14 > 10, the whole first chunk goes, one is left
    h.clock.advance(300)
    expect(h.passes[1].frame).toBe('bbbbbbbbbb')
    expect(h.passes[1].messages).toBe(2)
    expect(h.effects.stats().droppedChars).toBe(4)
  })

  it('one message bigger than the cap keeps its tail', () => {
    const h = setup({ maxFrameChars: 100 })
    h.effects.push('lead')
    h.clock.advance(1)
    h.effects.push('a'.repeat(250) + 'END')
    h.clock.advance(300)
    expect(h.passes[1].frame).toHaveLength(100)
    expect(h.passes[1].frame.endsWith('END')).toBe(true)
    expect(h.effects.stats().droppedChars).toBe(153)
  })

  it('cancel() drops the scheduled pass and what is pending, and a later message starts clean', () => {
    const h = setup()
    h.effects.push('a')
    h.effects.push('b')
    expect(h.clock.timers()).toBe(1)
    h.effects.cancel()
    expect(h.clock.timers()).toBe(0)
    expect(h.effects.stats().pendingChars).toBe(0)
    h.clock.advance(1000)
    expect(h.passes).toHaveLength(1)
    h.effects.push('c')
    expect(h.passes).toHaveLength(2)
    expect(h.passes[1].frame).toBe('c')
  })

  it('a pass that throws leaves the bookkeeping straight: the next message runs a pass, nothing stays "scheduled"', () => {
    const clock = fakeClock()
    let boom = true
    const seen: string[] = []
    const effects = createPaneEffects({
      run: (frame) => { if (boom) { boom = false; throw new Error('detector exploded') } seen.push(frame) },
      isVisible: () => true,
      clock,
    })
    expect(() => effects.push('a')).toThrow('detector exploded')
    expect(effects.stats()).toMatchObject({ failures: 1, pendingChars: 0 })
    clock.advance(300)
    effects.push('b')
    expect(seen).toEqual(['b'])
  })

  it('a pass that throws from the timer still leaves the next one possible', () => {
    const clock = fakeClock()
    const seen: string[] = []
    let calls = 0
    const effects = createPaneEffects({
      run: (frame) => { calls++; if (calls === 2) throw new Error('late failure'); seen.push(frame) },
      isVisible: () => true,
      clock,
    })
    effects.push('a')   // pass 1
    clock.advance(10)
    effects.push('b')   // pending
    expect(() => clock.advance(300)).toThrow('late failure')
    effects.push('c')
    clock.advance(300)
    expect(seen).toEqual(['a', 'c'])
  })

  it('an empty message still counts as one (activity), and costs no characters', () => {
    const h = setup()
    h.effects.push('')
    expect(h.passes).toHaveLength(1)
    expect(h.passes[0]).toMatchObject({ frame: '', messages: 1 })
  })

  it('the stats are numbers only', () => {
    const h = setup()
    h.effects.push('abc')
    for (const v of Object.values(h.effects.stats())) expect(typeof v).toBe('number')
  })
})

describe('the per-pass side effects: the real clock', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('with no clock given it runs on setTimeout and Date.now, looked up when used (a test may install fake timers later)', () => {
    const passes: string[] = []
    const effects = createPaneEffects({ run: (frame) => { passes.push(frame) }, isVisible: () => true })
    effects.push('a')
    vi.advanceTimersByTime(100) // the clock under test moves: a Date.now captured before the fake timers were installed would not
    effects.push('b')
    expect(passes).toEqual(['a'])
    vi.advanceTimersByTime(149) // 249 ms after 'a'
    expect(passes).toEqual(['a'])
    vi.advanceTimersByTime(2) // 251 ms after 'a'
    expect(passes).toEqual(['a', 'b'])
  })
})

describe('the counters an e2e spec reads (window.__termpolis_pane_effects)', () => {
  it('a tracked pane is listed by terminal id with its numbers; stopping removes it', () => {
    const h = setup()
    const stop = trackPaneEffects('term-a', h.effects)
    h.effects.push('abc')
    h.effects.push('def')
    const snap = paneEffectsSnapshot()
    expect(snap['term-a']).toMatchObject({ messages: 2, passes: 1, pendingMessages: 1, pendingChars: 3 })
    for (const v of Object.values(snap['term-a'])) expect(typeof v).toBe('number')
    stop()
    expect(paneEffectsSnapshot()['term-a']).toBeUndefined()
  })

  it("a remount takes over the id: the old pane stopping afterwards must not remove the new pane's counters", () => {
    const oldPane = setup()
    const newPane = setup()
    const stopOld = trackPaneEffects('term-b', oldPane.effects)
    const stopNew = trackPaneEffects('term-b', newPane.effects)
    newPane.effects.push('x')
    stopOld()
    expect(paneEffectsSnapshot()['term-b']).toMatchObject({ messages: 1 })
    stopNew()
    expect(paneEffectsSnapshot()['term-b']).toBeUndefined()
  })
})
