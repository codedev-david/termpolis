import { afterEach, describe, expect, it } from 'vitest'
import {
  PHONE_RESYNC_DISABLE_FLAG,
  QUIET_MS,
  QUIET_TICK_MS,
  QuietWatch,
  phoneResyncDisabled,
  safeToRewriteLive,
  systemClock,
} from '../../src/main/remoteBridge/phoneResync'
import { manualClock } from './fixtures/manualClock'

afterEach(() => {
  delete process.env[PHONE_RESYNC_DISABLE_FLAG]
})

describe('the kill switch', () => {
  it.each([
    [undefined, false],
    ['', false],
    ['0', false],
    ['false', false],
    ['FALSE', false],
    ['1', true],
    ['true', true],
    ['yes', true],
  ])('%j switches the resync off: %s', (value, off) => {
    expect(phoneResyncDisabled({ [PHONE_RESYNC_DISABLE_FLAG]: value })).toBe(off)
  })

  it('reads the real environment by default', () => {
    expect(phoneResyncDisabled()).toBe(false)
    process.env[PHONE_RESYNC_DISABLE_FLAG] = '1'
    expect(phoneResyncDisabled()).toBe(true)
  })
})

describe('the manual clock the tests below stand on', () => {
  it('runs an interval at each of its ticks, in order, and never jumps past one', () => {
    const clock = manualClock()
    const seen: number[] = []
    clock.setInterval(() => seen.push(clock.now()), 100)
    clock.setInterval(() => seen.push(-clock.now()), 150)
    clock.advance(310)
    expect(seen).toEqual([100, -150, 200, 300, -300])
    expect(clock.now()).toBe(310)
    expect(clock.ticks()).toBe(5)
  })

  it('stops an interval that was cleared, and counts what is still armed', () => {
    const clock = manualClock()
    let n = 0
    const a = clock.setInterval(() => (n += 1), 10)
    clock.setInterval(() => (n += 100), 10)
    expect(clock.armed()).toBe(2)
    clock.clearInterval(a)
    expect(clock.armed()).toBe(1)
    clock.advance(30)
    expect(n).toBe(300)
  })
})

describe('QuietWatch', () => {
  function watch(onQuiet: (id: string) => void = () => undefined) {
    const clock = manualClock()
    const quiet: string[] = []
    const w = new QuietWatch(clock, (id) => {
      quiet.push(id)
      onQuiet(id)
    })
    return { clock, quiet, w }
  }

  it('says nothing, and arms nothing, until a terminal prints', () => {
    const { clock, quiet } = watch()
    clock.advance(60_000)
    expect(quiet).toEqual([])
    expect(clock.armed()).toBe(0)
    expect(clock.ticks()).toBe(0)
  })

  it('calls back once after QUIET_MS without output, and not at QUIET_MS minus one tick', () => {
    const { clock, quiet, w } = watch()
    w.touch('t1')
    clock.advance(QUIET_MS - QUIET_TICK_MS)
    expect(quiet).toEqual([])
    clock.advance(QUIET_TICK_MS)
    expect(quiet).toEqual(['t1'])
  })

  it('starts the quiet period over on every output', () => {
    const { clock, quiet, w } = watch()
    w.touch('t1')
    // A terminal that prints every 1.5 s is never quiet for 2 s.
    for (let i = 0; i < 20; i += 1) {
      clock.advance(1_500)
      w.touch('t1')
    }
    expect(quiet).toEqual([])
    clock.advance(QUIET_MS + QUIET_TICK_MS)
    expect(quiet).toEqual(['t1'])
  })

  it('calls back once per burst, not once per tick, and goes back to sleep', () => {
    const { clock, quiet, w } = watch()
    w.touch('t1')
    clock.advance(QUIET_MS + QUIET_TICK_MS)
    expect(clock.armed()).toBe(0)
    const ticks = clock.ticks()
    clock.advance(60_000)
    expect(quiet).toEqual(['t1'])
    // Disarmed: the clock ran no callback at all while nothing was pending.
    expect(clock.ticks()).toBe(ticks)
  })

  it('watches terminals independently, with one interval between them', () => {
    const { clock, quiet, w } = watch()
    w.touch('t1')
    clock.advance(1_000)
    w.touch('t2')
    expect(clock.armed()).toBe(1)
    clock.advance(QUIET_MS - 1_000 + QUIET_TICK_MS)
    expect(quiet).toEqual(['t1'])
    expect(clock.armed()).toBe(1)
    clock.advance(1_000)
    expect(quiet).toEqual(['t1', 't2'])
    expect(clock.armed()).toBe(0)
  })

  it('arms again for the next burst', () => {
    const { clock, quiet, w } = watch()
    w.touch('t1')
    clock.advance(QUIET_MS + QUIET_TICK_MS)
    w.touch('t1')
    expect(clock.armed()).toBe(1)
    clock.advance(QUIET_MS + QUIET_TICK_MS)
    expect(quiet).toEqual(['t1', 't1'])
  })

  it('lets a callback touch the terminal it was told about: it is watched again, not lost', () => {
    const clock = manualClock()
    const quiet: string[] = []
    const w: QuietWatch = new QuietWatch(clock, (id) => {
      quiet.push(id)
      if (quiet.length === 1) w.touch(id)
    })
    w.touch('t1')
    clock.advance(QUIET_MS + QUIET_TICK_MS)
    expect(quiet).toEqual(['t1'])
    // Touched again inside that very tick: still pending, so still watching.
    expect(clock.armed()).toBe(1)
    clock.advance(QUIET_MS + QUIET_TICK_MS)
    expect(quiet).toEqual(['t1', 't1'])
    expect(clock.armed()).toBe(0)
  })

  it('survives a callback that throws: the next terminal is still told, and the watch still sleeps', () => {
    const { clock, quiet, w } = watch((id) => {
      if (id === 't1') throw new Error('the rewrite failed')
    })
    w.touch('t1')
    w.touch('t2')
    expect(() => clock.advance(QUIET_MS + QUIET_TICK_MS)).not.toThrow()
    expect(quiet).toEqual(['t1', 't2'])
    expect(clock.armed()).toBe(0)
  })

  it('asks the clock again at the next output when it could not give an interval', () => {
    // A watch that believed itself armed after the clock refused would never look again, whatever printed.
    const clock = manualClock()
    const give = clock.setInterval.bind(clock)
    let refuse = true
    clock.setInterval = (fn, ms) => {
      if (refuse) throw new Error('no timer to be had')
      return give(fn, ms)
    }
    const quiet: string[] = []
    const w = new QuietWatch(clock, (id) => quiet.push(id))
    expect(() => w.touch('t1')).toThrow('no timer to be had')
    expect(clock.armed()).toBe(0)
    refuse = false
    w.touch('t1')
    expect(clock.armed()).toBe(1)
    clock.advance(QUIET_MS + QUIET_TICK_MS)
    expect(quiet).toEqual(['t1'])
    expect(clock.armed()).toBe(0)
  })

  it('stop forgets what was pending and clears its interval; stopping twice is harmless', () => {
    const { clock, quiet, w } = watch()
    w.touch('t1')
    w.stop()
    w.stop()
    expect(clock.armed()).toBe(0)
    clock.advance(60_000)
    expect(quiet).toEqual([])
  })

  it('honours the periods it was built with', () => {
    const clock = manualClock()
    const quiet: string[] = []
    const w = new QuietWatch(clock, (id) => quiet.push(id), 300, 100)
    w.touch('t1')
    clock.advance(299)
    expect(quiet).toEqual([])
    clock.advance(1)
    expect(quiet).toEqual(['t1'])
  })
})

describe('systemClock', () => {
  it('is monotonic milliseconds', () => {
    const a = systemClock.now()
    const b = systemClock.now()
    expect(b).toBeGreaterThanOrEqual(a)
  })

  it('runs an interval until it is cleared, without keeping the process alive', async () => {
    let handle: unknown
    let runs = 0
    await new Promise<void>((resolve) => {
      handle = systemClock.setInterval(() => {
        runs += 1
        if (runs === 2) resolve()
      }, 1)
    })
    systemClock.clearInterval(handle)
    expect(runs).toBe(2)
    // unref()'d: a timer that cannot hold the event loop open.
    expect((handle as { hasRef(): boolean }).hasRef()).toBe(false)
  })
})

describe('safeToRewriteLive', () => {
  it('is safe for a copy that holds no gap notice, wherever the live region starts', () => {
    expect(safeToRewriteLive(null, 0)).toBe(true)
    expect(safeToRewriteLive(null, 500)).toBe(true)
  })

  it('is safe for a notice at or before the start of the live region', () => {
    expect(safeToRewriteLive(400, 500)).toBe(true)
    // AT it: an anchor there keeps the notice and nothing else.
    expect(safeToRewriteLive(500, 500)).toBe(true)
  })

  it('is not safe for a notice inside the region it would replace', () => {
    expect(safeToRewriteLive(501, 500)).toBe(false)
    expect(safeToRewriteLive(Infinity, 500)).toBe(false)
  })

  it('is never safe for a notice when the screen starts at 0: a forget would wipe the notice unread', () => {
    expect(safeToRewriteLive(0, 0)).toBe(false)
    expect(safeToRewriteLive(7, 0)).toBe(false)
  })
})
