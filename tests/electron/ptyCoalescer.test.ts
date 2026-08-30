import { describe, it, expect, vi } from 'vitest'
import {
  createOutputCoalescer,
  DEFAULT_WINDOW_MS,
  DEFAULT_MAX_PENDING_CHARS,
} from '../../src/main/ptyCoalescer'

/** A fake clock that only advances when a test says so, so window behaviour is asserted
 *  exactly rather than raced against a real timer. */
function fakeClock() {
  let next = 1
  const timers = new Map<number, () => void>()
  return {
    setTimer: (fn: () => void): unknown => {
      const handle = next++
      timers.set(handle, fn)
      return handle
    },
    clearTimer: (handle: unknown): void => {
      timers.delete(handle as number)
    },
    /** Fire every timer currently armed. Timers armed *by* those callbacks stay armed. */
    tick: (): void => {
      const due = [...timers.entries()]
      for (const [handle, fn] of due) {
        timers.delete(handle)
        fn()
      }
    },
    armed: (): number => timers.size,
  }
}

const harness = (opts: { maxPendingChars?: number } = {}) => {
  const clock = fakeClock()
  const emitted: string[] = []
  const c = createOutputCoalescer(d => emitted.push(d), {
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    ...opts,
  })
  return { clock, emitted, c }
}

describe('ptyCoalescer', () => {
  it('emits the first chunk after idle synchronously — keystroke echo is never delayed', () => {
    const { emitted, c } = harness()
    c.push('a')
    expect(emitted).toEqual(['a'])
  })

  it('batches chunks that arrive while output is already flowing', () => {
    const { clock, emitted, c } = harness()
    c.push('first')
    c.push('b')
    c.push('c')
    c.push('d')
    expect(emitted).toEqual(['first'])
    clock.tick()
    expect(emitted).toEqual(['first', 'bcd'])
  })

  it('preserves byte order and loses nothing across many windows', () => {
    const { clock, emitted, c } = harness()
    const chunks = Array.from({ length: 500 }, (_, i) => `${i}|`)
    for (const [i, chunk] of chunks.entries()) {
      c.push(chunk)
      if (i % 7 === 6) clock.tick()
    }
    c.flush()
    expect(emitted.join('')).toBe(chunks.join(''))
    // The whole point: far fewer messages than chunks.
    expect(emitted.length).toBeLessThan(chunks.length / 4)
  })

  it('keeps the window alive while output keeps arriving, then goes idle', () => {
    const { clock, emitted, c } = harness()
    c.push('a')
    c.push('b')
    clock.tick()
    expect(emitted).toEqual(['a', 'b'])
    // Output kept coming, so a fresh window is armed rather than dropping to idle.
    expect(clock.armed()).toBe(1)
    clock.tick()
    // Nothing arrived in that window: idle, so the next chunk is immediate again.
    expect(clock.armed()).toBe(0)
    c.push('c')
    expect(emitted).toEqual(['a', 'b', 'c'])
  })

  it('flushes early once the pending batch is large enough to stop mattering', () => {
    const { emitted, c } = harness({ maxPendingChars: 10 })
    c.push('start')
    c.push('12345')
    expect(emitted).toEqual(['start'])
    c.push('67890')
    expect(emitted).toEqual(['start', '1234567890'])
  })

  it('ignores empty chunks instead of spending a message on them', () => {
    const { emitted, c } = harness()
    c.push('')
    expect(emitted).toEqual([])
    c.push('a')
    c.push('')
    c.flush()
    expect(emitted).toEqual(['a'])
  })

  it('flush is a no-op when nothing is pending', () => {
    const { emitted, c } = harness()
    c.flush()
    expect(emitted).toEqual([])
    c.push('a')
    c.flush()
    c.flush()
    expect(emitted).toEqual(['a'])
  })

  it('flush cancels the armed window so the next chunk is immediate', () => {
    const { clock, emitted, c } = harness()
    c.push('a')
    c.push('b')
    c.flush()
    expect(emitted).toEqual(['a', 'b'])
    expect(clock.armed()).toBe(0)
    c.push('c')
    expect(emitted).toEqual(['a', 'b', 'c'])
  })

  it('dispose delivers trailing output — a shell\'s last line is never dropped', () => {
    const { emitted, c } = harness()
    c.push('running…')
    c.push('\nexit 0\n')
    c.dispose()
    expect(emitted).toEqual(['running…', '\nexit 0\n'])
  })

  it('drops everything pushed after dispose', () => {
    const { emitted, c } = harness()
    c.push('a')
    c.dispose()
    c.push('late')
    expect(emitted).toEqual(['a'])
  })

  it('uses real timers when none are injected', async () => {
    const emitted: string[] = []
    const c = createOutputCoalescer(d => emitted.push(d), { windowMs: 1 })
    c.push('a')
    c.push('b')
    expect(emitted).toEqual(['a'])
    await vi.waitFor(() => expect(emitted).toEqual(['a', 'b']))
    c.dispose()
  })

  it('clears the real timer on dispose so a torn-down terminal arms nothing', () => {
    // A window long enough that it is certainly still armed when dispose runs — the
    // point is that the default clearTimer cancels it, not that it never fired.
    const emitted: string[] = []
    const c = createOutputCoalescer(d => emitted.push(d), { windowMs: 60_000 })
    c.push('a')
    c.push('b')
    c.dispose()
    expect(emitted).toEqual(['a', 'b'])
  })

  it('defaults stay under one frame and above the per-message overhead point', () => {
    expect(DEFAULT_WINDOW_MS).toBeLessThan(1000 / 60)
    expect(DEFAULT_MAX_PENDING_CHARS).toBe(65_536)
  })
})
