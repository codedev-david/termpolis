// shedWatch — a watch that stops listening when it is being shouted at (src/main/shedWatch.ts).
//
// The point, in one measured line (David's laptop, Windows 11, Defender on, Node 24): every event the OS
// delivers costs the receiving thread about 1.5 ms of its own CPU whatever the listener does, so a run gate
// that merely stops RUNNING a handler during a flood still pays for every event of the flood. The only way to
// stop paying is to stop receiving. These tests count what matters: events handed to the listener, OS
// handles opened and closed, timers armed, and `onResume` calls, on an injected clock and an injected
// watch function, so nothing depends on time or a disk.
import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  openSheddingWatch,
  SHED_EVENTS_PER_SECOND,
  SHED_BACKOFF_BASE_MS,
  SHED_BACKOFF_MAX_MS,
  SHED_CALM_MS,
  type ShedFsWatchFn,
  type SheddingWatchOptions,
} from '../../src/main/shedWatch'

type Listener = (event: string, filename: string | Buffer | null) => void

interface Opened {
  listener: Listener
  closed: number
  errors: Array<(e: unknown) => void>
}

function harness(over: { throwOnOpen?: (n: number) => boolean; noEmitter?: boolean; emitterThrows?: boolean; opts?: Partial<SheddingWatchOptions> } = {}) {
  let t = 1_000_000
  let seq = 0
  let setCalls = 0
  const timers = new Map<number, { at: number; fn: () => void }>()
  const opened: Opened[] = []
  const events: Array<[string, string | null]> = []
  const logs: string[] = []
  let resumed = 0
  let attempts = 0
  const fsWatch: ShedFsWatchFn = (_p, _o, l) => {
    attempts++
    if (over.throwOnOpen?.(attempts)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    const rec: Opened = { listener: l, closed: 0, errors: [] }
    opened.push(rec)
    if (over.noEmitter) return { close() { rec.closed++ } }
    return {
      close() { rec.closed++ },
      on(ev: 'error', cb: (e: unknown) => void) {
        if (over.emitterThrows) throw new Error('no emitter')
        if (ev === 'error') rec.errors.push(cb)
        return this
      },
    }
  }
  const w = openSheddingWatch(fsWatch, '/p', { recursive: true, persistent: false }, (e, f) => { events.push([e, typeof f === 'string' ? f : null]) }, {
    now: () => t,
    setTimer: (fn, ms) => { setCalls++; const id = ++seq; timers.set(id, { at: t + ms, fn }); return id },
    clearTimer: (id) => { timers.delete(id as number) },
    log: (m) => { logs.push(m) },
    onResume: () => { resumed++ },
    ...over.opts,
  })
  return {
    w, opened, events, logs, timers,
    get resumed(): number { return resumed },
    get setCalls(): number { return setCalls },
    get attempts(): number { return attempts },
    /** Move the clock and fire every timer that comes due, in order. */
    advance(ms: number): void {
      const end = t + ms
      for (;;) {
        const due = [...timers.entries()].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
        if (!due) break
        timers.delete(due[0])
        t = Math.max(t, due[1].at)
        due[1].fn()
      }
      t = end
    },
    /** The clock steps back (NTP, a manual change). */
    back(ms: number): void { t -= ms },
    /** `n` events at the current instant, through the CURRENT handle. */
    burst(n: number, name = 'a.ts'): void {
      const h = opened[opened.length - 1]
      for (let i = 0; i < n; i++) h.listener('change', name)
    },
  }
}

describe('openSheddingWatch', () => {
  afterEach(() => { vi.useRealTimers() })

  it('passes every event through up to the limit in a second, and exposes the numbers it uses', () => {
    const h = harness()
    h.burst(SHED_EVENTS_PER_SECOND)
    expect(h.events).toHaveLength(SHED_EVENTS_PER_SECOND)
    expect(h.w.shed).toBe(false)
    expect(h.opened).toHaveLength(1)
    expect([SHED_EVENTS_PER_SECOND, SHED_BACKOFF_BASE_MS, SHED_BACKOFF_MAX_MS, SHED_CALM_MS]).toEqual([200, 4000, 60_000, 30_000])
  })

  it('the 201st event in a second closes the OS watch: the listener has heard 200, the tipping event is dropped', () => {
    const h = harness()
    h.burst(201)
    expect(h.events).toHaveLength(200)
    expect(h.w.shed).toBe(true)
    expect(h.w.sheds).toBe(1)
    expect(h.opened[0].closed).toBe(1)
  })

  it('a storm of 100,000 events costs the listener 200 of them, however many the OS still had queued', () => {
    const h = harness()
    const first = h.opened[0]
    for (let i = 0; i < 100_000; i++) first.listener('change', `f${i % 500}.ts`)
    expect(h.events).toHaveLength(200)
    expect(h.opened).toHaveLength(1) // no second handle yet
    expect(h.setCalls).toBe(1) // one timer for the reopening, not one per event
    expect(h.w.sheds).toBe(1) // and it was closed once, not once per event
    expect(h.opened[0].closed).toBe(1)
  })

  it('a new second starts a new count: 150 events, a second later 150 more, is no storm', () => {
    const h = harness()
    h.burst(150)
    h.advance(1000)
    h.burst(150)
    h.advance(1000)
    h.burst(150)
    expect(h.events).toHaveLength(450)
    expect(h.w.shed).toBe(false)
  })

  it('a clock stepped BACK does not turn a calm stream into a storm', () => {
    const h = harness()
    h.burst(150)
    h.back(5000)
    h.burst(150) // 300 events by the count, but on a clock that went backwards: a new window
    h.advance(1000)
    h.burst(150)
    expect(h.events).toHaveLength(450)
    expect(h.w.shed).toBe(false)
  })

  it('reopens after 4 s, once, tells the owner once, and listens again', () => {
    const h = harness()
    h.burst(201)
    h.advance(3999)
    expect(h.opened).toHaveLength(1)
    expect(h.resumed).toBe(0)
    h.advance(1)
    expect(h.opened).toHaveLength(2)
    expect(h.resumed).toBe(1)
    expect(h.w.shed).toBe(false)
    h.burst(5, 'again.ts')
    expect(h.events.slice(-5).map((e) => e[1])).toEqual(Array(5).fill('again.ts'))
  })

  it('keeps trying at 8, 16, 32 and then 60 s while it keeps tripping, and never longer', () => {
    const h = harness()
    const waits: number[] = []
    for (let i = 0; i < 7; i++) {
      h.burst(201)
      const before = h.opened.length
      let waited = 0
      while (h.opened.length === before) { h.advance(1000); waited += 1000; if (waited > 70_000) break }
      waits.push(waited)
    }
    expect(waits).toEqual([4000, 8000, 16_000, 32_000, 60_000, 60_000, 60_000])
  })

  it('the schedule starts again after 30 s of calm, so a rare storm is always met with the short wait', () => {
    const h = harness()
    h.burst(201)
    h.advance(4000) // reopened; the next wait would be 8 s
    h.advance(SHED_CALM_MS + 1000) // a calm stretch
    h.burst(201) // a new storm
    h.advance(3999)
    expect(h.opened).toHaveLength(2)
    h.advance(1)
    expect(h.opened).toHaveLength(3) // 4 s again, not 8
  })

  it('a reopen that is refused (the directory is gone) is tried again at the next step, and owner is told only on success', () => {
    const h = harness({ throwOnOpen: (n) => n === 2 || n === 3 })
    h.burst(201)
    h.advance(4000) // attempt 2: refused
    expect(h.attempts).toBe(2)
    expect(h.resumed).toBe(0)
    expect(h.w.shed).toBe(true)
    h.advance(8000) // attempt 3: refused again
    expect(h.attempts).toBe(3)
    h.advance(16_000) // attempt 4: works
    expect(h.attempts).toBe(4)
    expect(h.resumed).toBe(1)
    expect(h.w.shed).toBe(false)
  })

  it('the first open throws, exactly as fs.watch does', () => {
    expect(() => harness({ throwOnOpen: () => true })).toThrow(/ENOENT/)
  })

  it('close() while listening closes the handle; while shed it cancels the reopening; both are idempotent', () => {
    const a = harness()
    a.w.close()
    a.w.close()
    expect(a.opened[0].closed).toBe(1)
    a.burst(10)
    expect(a.events).toHaveLength(0)

    const b = harness()
    b.burst(201)
    expect(b.timers.size).toBe(1)
    b.w.close()
    expect(b.timers.size).toBe(0)
    b.advance(120_000)
    expect(b.opened).toHaveLength(1)
    expect(b.resumed).toBe(0)
  })

  it('a reopening timer that fires after close() does nothing', () => {
    const h = harness()
    h.burst(201)
    const [, t] = [...h.timers.entries()][0]
    h.w.close() // clears the timer; but a timer already due may still run
    t.fn()
    expect(h.opened).toHaveLength(1)
    expect(h.resumed).toBe(0)
  })

  it('error listeners are attached to the handle in hand and to every one it reopens, and `on` chains', () => {
    const h = harness()
    const cb = vi.fn()
    expect(h.w.on('error', cb)).toBe(h.w)
    expect(h.opened[0].errors).toEqual([cb])
    h.burst(201)
    h.advance(4000)
    expect(h.opened[1].errors).toEqual([cb])
    h.opened[1].errors[0](new Error('EPERM'))
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('error listeners can be added while it is shed: the next handle gets them', () => {
    const h = harness()
    h.burst(201)
    const cb = vi.fn()
    h.w.on('error', cb)
    h.advance(4000)
    expect(h.opened[1].errors).toEqual([cb])
  })

  it('a watch without an event emitter, or whose emitter throws, still works', () => {
    const a = harness({ noEmitter: true })
    a.w.on('error', () => {})
    a.burst(201)
    a.advance(4000)
    expect(a.opened).toHaveLength(2)

    const b = harness({ emitterThrows: true })
    expect(() => b.w.on('error', () => {})).not.toThrow()
    b.burst(201)
    b.advance(4000)
    expect(b.opened).toHaveLength(2)
  })

  it('says so once when it closes, then at most once a minute, and a logger that throws is harmless', () => {
    const h = harness({ opts: { label: 'repo/src' } })
    h.burst(201)
    expect(h.logs).toHaveLength(1)
    expect(h.logs[0]).toMatch(/repo\/src: more than 200 events in a second; not listening for 4 s/)
    h.advance(4000)
    h.burst(201) // trips again 4 s later: no new line yet
    expect(h.logs).toHaveLength(1)
    h.advance(8000 + 60_000)
    h.burst(201) // more than a minute after the first line
    expect(h.logs).toHaveLength(2)

    const t = harness({ opts: { log: () => { throw new Error('logger') } } })
    expect(() => t.burst(201)).not.toThrow()
  })

  it('an owner whose onResume throws does not break the watch', () => {
    const h = harness({ opts: { onResume: () => { throw new Error('owner') } } })
    h.burst(201)
    expect(() => h.advance(4000)).not.toThrow()
    expect(h.w.shed).toBe(false)
  })

  it('works without an onResume or a log', () => {
    let t = 0
    const timers: Array<() => void> = []
    const opened: Listener[] = []
    const w = openSheddingWatch((_p, _o, l) => { opened.push(l); return { close() {} } }, '/p', {}, () => {}, {
      now: () => t, setTimer: (fn) => { timers.push(fn); return timers.length }, clearTimer: () => {},
    })
    for (let i = 0; i < 201; i++) opened[0]('change', 'x')
    t += 4000
    timers[0]()
    expect(opened).toHaveLength(2)
    expect(w.shed).toBe(false)
  })

  it('uses the real timers and clock by default, and does not keep the process alive while waiting', async () => {
    vi.useFakeTimers()
    const opened: Listener[] = []
    const w = openSheddingWatch((_p, _o, l) => { opened.push(l); return { close() {} } }, '/p', {}, () => {})
    for (let i = 0; i < 201; i++) opened[0]('change', 'x')
    expect(w.shed).toBe(true)
    await vi.advanceTimersByTimeAsync(4000)
    expect(opened).toHaveLength(2)
    expect(w.shed).toBe(false)
    for (let i = 0; i < 201; i++) opened[1]('change', 'x')
    w.close() // clears the real timer it armed
    await vi.advanceTimersByTimeAsync(120_000)
    expect(opened).toHaveLength(2)
  })

  it('the limit and the schedule are options', () => {
    const h = harness({ opts: { eventsPerSecond: 10, backoffBaseMs: 100, backoffMaxMs: 250, calmMs: 1 } })
    h.burst(11)
    expect(h.events).toHaveLength(10)
    h.advance(100)
    expect(h.opened).toHaveLength(2)
    h.advance(5) // not calm for 1 ms? it was: the next trip restarts at the base
    h.burst(11)
    h.advance(100)
    expect(h.opened).toHaveLength(3)
  })

  it('Buffer names are passed through untouched', () => {
    const h = harness()
    const seen: Array<string | Buffer | null> = []
    const w = openSheddingWatch((_p, _o, l) => { h.opened.push({ listener: l, closed: 0, errors: [] }); return { close() {} } }, '/p', {}, (_e, f) => { seen.push(f) })
    h.opened[h.opened.length - 1].listener('change', Buffer.from('x'))
    expect(Buffer.isBuffer(seen[0])).toBe(true)
    w.close()
  })
})
