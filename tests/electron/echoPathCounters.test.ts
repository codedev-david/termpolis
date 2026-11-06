// 1.54.5 wire step, wp4: the main-process half of the echo path, proven with counters (never wall-clock ratios).
//
// A key typed into terminal A goes terminal:write (traced) -> pty -> A's output coalescer (ptyCoalescer.ts) ->
// appendOutput -> terminal:data to the window (terminalDataRouting.ts) -> the echo-trace mark (T2). While terminal
// B floods (a build, an agent redraw), the question is whether A's echo ever waits behind B's output inside this
// process, and whether any of these steps does more than O(chunk) work per chunk or per keystroke.
//
// The chain below is the one src/main/index.ts builds in its spawnTerminal onData callback, made of the real modules
// on a fake clock: real createOutputCoalescer, real appendOutput, real createTerminalDataRouting, real
// createTypingTrace. Everything counted is a number of messages, characters or calls.

import { describe, it, expect } from 'vitest'
import { createOutputCoalescer, DEFAULT_WINDOW_MS, DEFAULT_MAX_PENDING_CHARS, type OutputCoalescer } from '../../src/main/ptyCoalescer'
import { appendOutput, type OutputBuffers, MAX_TERMINAL_BUFFER_CHARS } from '../../src/main/terminalOutputBuffer'
import { createTerminalDataRouting, GRACE_CHUNKS } from '../../src/main/terminalDataRouting'
import { createTypingTrace } from '../../src/main/typingTrace'

/** A fake millisecond clock with the timer surface the coalescer takes. */
function fakeClock() {
  let t = 0
  let seq = 0
  const timers = new Map<number, { at: number; fn: () => void }>()
  return {
    now: () => t,
    setTimer: (fn: () => void, ms: number): unknown => { const id = ++seq; timers.set(id, { at: t + ms, fn }); return id },
    clearTimer: (h: unknown): void => { timers.delete(h as number) },
    armed: () => timers.size,
    /** Move to t+ms, firing due timers in time order (a timer armed by a firing one runs if it is due too). */
    advance(ms: number): void {
      const end = t + ms
      for (;;) {
        let next: [number, { at: number; fn: () => void }] | null = null
        for (const e of timers) if (e[1].at <= end && (next === null || e[1].at < next[1].at)) next = e
        if (next === null) break
        timers.delete(next[0])
        t = next[1].at
        next[1].fn()
      }
      t = end
    },
  }
}

interface Sent { id: string; data: string; end?: number }

/** The index.ts onData chain for a set of terminals, with every step counted. */
function rig(opts: { announce?: (r: ReturnType<typeof createTerminalDataRouting>) => void } = {}) {
  const clock = fakeClock()
  const buffers: OutputBuffers = new Map()
  const routing = createTerminalDataRouting()
  opts.announce?.(routing)
  const sent: Sent[] = []
  const target = { webContents: { id: 1, send: (_ch: string, id: unknown, data: unknown, end?: unknown) => { sent.push({ id: id as string, data: data as string, end: end as number }) } } }
  const trace = createTypingTrace({
    env: {}, now: clock.now, wallNow: clock.now,
    setInterval: () => 0, clearInterval: () => {}, openLoopDelay: () => null, observeGc: () => null,
  })
  const pushed = new Map<string, number>()
  const coalescers = new Map<string, OutputCoalescer>()
  const counts = { emits: 0, emitChars: 0, emitsInsidePush: 0 }
  let insidePush = false
  function terminal(id: string): OutputCoalescer {
    const c = createOutputCoalescer((data) => {
      counts.emits++
      counts.emitChars += data.length
      if (insidePush) counts.emitsInsidePush++
      // ── the body of index.ts's spawnTerminal onData callback ──
      const end = appendOutput(buffers, id, data)
      routing.send(target, id, data, end)
      trace.noteTerminalOutput(id)
    }, { setTimer: clock.setTimer, clearTimer: clock.clearTimer })
    coalescers.set(id, c)
    return c
  }
  /** node-pty's onData: one chunk from the OS. */
  function chunk(id: string, data: string): void {
    pushed.set(id, (pushed.get(id) ?? 0) + data.length)
    insidePush = true
    try { coalescers.get(id)!.push(data) } finally { insidePush = false }
  }
  /** The traced terminal:write handler, a key stamped with the renderer's clock (as echoTrace.ts does). */
  const write = trace.traceTerminalWrite((_e: unknown, _p: { id: string; data: string; t?: number }) => { /* pty.write */ })
  return { clock, buffers, routing, sent, trace, counts, pushed, terminal, chunk, write }
}

describe('echo path, main side: a typed echo never waits behind another terminal\'s output', () => {
  it('B floods 1 chunk per ms for 2 s; every echo on idle A leaves inside its own pty callback, with 0 B messages ahead of it in this process', () => {
    const r = rig()
    const a = r.terminal('A')
    const b = r.terminal('B')
    void a; void b
    const MS = 2_000
    const B_CHUNK = 'b'.repeat(200)
    let keys = 0
    let echoes = 0
    let bSentWhileEchoPending = 0
    let echoPendingFor: number | null = null
    let maxEchoDelayMs = 0
    for (let ms = 0; ms < MS; ms++) {
      r.chunk('B', B_CHUNK)
      if (ms % 37 === 5) {
        // A key typed into A; its echo comes back from the pty one ms later, while B keeps flooding.
        r.write({}, { id: 'A', data: 'x', t: r.clock.now() })
        keys++
        echoPendingFor = r.clock.now()
      }
      r.clock.advance(1)
      if (echoPendingFor !== null) {
        const before = r.sent.length
        const bBefore = r.sent.filter((s) => s.id === 'B').length
        r.chunk('A', 'x')
        const after = r.sent.slice(before)
        // Inside A's push: exactly one message went out, and it was A's.
        expect(after.map((s) => s.id)).toEqual(['A'])
        bSentWhileEchoPending += r.sent.filter((s) => s.id === 'B').length - bBefore
        maxEchoDelayMs = Math.max(maxEchoDelayMs, r.clock.now() - echoPendingFor)
        echoes++
        echoPendingFor = null
      }
    }
    r.clock.advance(DEFAULT_WINDOW_MS) // B's last window closes
    expect(keys).toBe(echoes)
    expect(keys).toBeGreaterThan(50)
    expect(bSentWhileEchoPending).toBe(0)
    // Every echo was emitted synchronously from its pty callback (the leading edge), never held for a window.
    expect(r.counts.emitsInsidePush).toBeGreaterThanOrEqual(keys)
    // The echo trace agrees: T2 (write -> first output byte out) counted every key, and none expired.
    const snap = r.trace.snapshot()
    expect(snap.t2.n).toBe(keys)
    expect(snap.t2.expired).toBe(0)
    expect(snap.t2.max).toBe(1) // the fake pty's 1 ms round trip, nothing added on top
    // B is coalesced: at most one message per window (+ the leading-edge one after each idle), so at most one B
    // message can sit in the IPC channel ahead of any later echo per window, and it is bounded in size.
    const bSends = r.sent.filter((s) => s.id === 'B')
    expect(bSends.length).toBeLessThanOrEqual(Math.ceil(MS / DEFAULT_WINDOW_MS) + 1)
    expect(Math.max(...bSends.map((s) => s.data.length))).toBeLessThanOrEqual(DEFAULT_MAX_PENDING_CHARS)
    expect(Math.max(...bSends.map((s) => s.data.length))).toBeLessThanOrEqual(DEFAULT_WINDOW_MS * B_CHUNK.length)
    expect(maxEchoDelayMs).toBe(1)
  })

  it('a hidden B (no pane listening) puts nothing in the channel once its grace is spent', () => {
    const r = rig({ announce: (routing) => routing.note(1, { id: 'A', epoch: 1 }, true) })
    r.terminal('A'); r.terminal('B')
    for (let ms = 0; ms < 500; ms++) { r.chunk('B', 'b'.repeat(100)); r.clock.advance(1) }
    r.clock.advance(DEFAULT_WINDOW_MS)
    const bSends = r.sent.filter((s) => s.id === 'B').length
    const stats = r.routing.stats()
    expect(stats.skipped + bSends).toBe(r.counts.emits)
    expect(bSends).toBe(GRACE_CHUNKS) // the bounded grace for a terminal no pane announced yet, then nothing
    expect(stats.skipped).toBe(r.counts.emits - GRACE_CHUNKS)
    // ...and its output is still kept for a pane that mounts later (appendOutput ran for every emit).
    expect(r.buffers.get('B')!.total).toBe(500 * 100)
    r.chunk('A', 'x')
    expect(r.sent[r.sent.length - 1].id).toBe('A')
  })

  it('when A itself is streaming (an agent redraw in the same pane) an echo is held at most one window: the bound, counted', () => {
    const r = rig()
    r.terminal('A')
    let worst = 0
    for (let k = 0; k < 40; k++) {
      // A streams for 20 ms, then the user's echo arrives mid-stream.
      for (let ms = 0; ms < 20; ms++) { r.chunk('A', 'o'.repeat(50)); r.clock.advance(1) }
      r.write({}, { id: 'A', data: 'x', t: r.clock.now() })
      const at = r.clock.now()
      const before = r.counts.emitChars
      r.chunk('A', 'x')
      let waited = 0
      while (r.counts.emitChars === before) { r.clock.advance(1); waited++ }
      worst = Math.max(worst, r.clock.now() - at)
      expect(waited).toBeLessThanOrEqual(DEFAULT_WINDOW_MS)
      r.clock.advance(DEFAULT_WINDOW_MS * 2) // idle again
    }
    expect(worst).toBeLessThanOrEqual(DEFAULT_WINDOW_MS)
    expect(r.trace.snapshot().t2.max).toBeLessThanOrEqual(DEFAULT_WINDOW_MS)
  })
})

describe('echo path, main side: work per PTY chunk and per keystroke is O(chunk)', () => {
  it('every character crosses each step once: chars emitted = chars pushed, messages <= chunks, nothing re-sent', () => {
    const r = rig()
    r.terminal('A'); r.terminal('B'); r.terminal('C')
    let chunks = 0
    for (let ms = 0; ms < 3_000; ms++) {
      for (const id of ['A', 'B', 'C']) {
        const len = 1 + ((ms * 7 + id.charCodeAt(0)) % 900)
        r.chunk(id, id.toLowerCase().repeat(len))
        chunks++
      }
      r.clock.advance(1)
    }
    r.clock.advance(DEFAULT_WINDOW_MS)
    const pushedTotal = [...r.pushed.values()].reduce((s, n) => s + n, 0)
    expect(r.counts.emitChars).toBe(pushedTotal)
    expect(r.sent.reduce((s, m) => s + m.data.length, 0)).toBe(pushedTotal)
    expect(r.counts.emits).toBeLessThanOrEqual(chunks)
    expect(r.sent.length).toBe(r.counts.emits)
    // Each message carries where it ends in its terminal's stream: strictly increasing, no gap, no overlap.
    for (const id of ['A', 'B', 'C']) {
      let prev = 0
      for (const m of r.sent.filter((s) => s.id === id)) { expect(m.end).toBe(prev + m.data.length); prev = m.end! }
      expect(prev).toBe(r.pushed.get(id))
    }
    // The replay window stays bounded however much went through it (appendOutput's own O(chunk) tests pin the slice).
    for (const id of ['A', 'B', 'C']) {
      const w = r.buffers.get(id)!
      expect(w.chunks.reduce((s, c) => s + c.length, 0)).toBeLessThanOrEqual(MAX_TERMINAL_BUFFER_CHARS)
    }
    // No timer per chunk: at most one armed window per terminal at any time.
    expect(r.clock.armed()).toBeLessThanOrEqual(3)
  })

  it('a keystroke costs O(1) in the trace: the pending-echo map stays bounded however many terminals are typed into', () => {
    const r = rig()
    // 1,000 keys stamped into 1,000 different terminals that never echo (worst case for the pending map).
    for (let i = 0; i < 1_000; i++) r.write({}, { id: 't' + i, data: 'x', t: r.clock.now() })
    r.terminal('t999')
    r.chunk('t999', 'x')
    // The map was capped (MAX_PENDING_T2) and cleared, never grown per key; the last key still measured.
    expect(r.trace.snapshot().t2.n).toBe(1)
    expect(r.trace.snapshot().ipc['terminal:write'].count).toBe(1_000)
  })
})
