// tailFile — the asynchronous pass that every fs.watch event and every poll now makes after attach
// (src/main/transcriptWatchers/baseWatcher.ts). Its failure arms need fs.promises to misbehave on
// cue (a stat that fails, an open that fails, a read that comes back short or empty, a stop() that
// lands while a read is in flight), which a real disk will not do, so fs.promises.stat/open are
// hooked while everything else, the attach-time synchronous pass and the real files, stays real.
// fs.watch is made to throw so the poll is the only thing that wakes the tail: no real event can
// make a pass happen at a moment the test did not choose.
//
// Time is the poll's: fake. Disk is real, so a pass finishes in real time; `until` therefore moves the
// fake clock a little, yields real time, and checks a COUNTER or the delivered lines, never a delay.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const realSetTimeout = globalThis.setTimeout

const H = vi.hoisted(() => ({
  stat: null as null | ((p: string) => Promise<{ size: number }>),
  open: null as null | ((p: string) => Promise<unknown>),
  opens: 0,
  stats: 0,
  /** When set, fs.watch hands out these instead of throwing: every call is recorded. */
  watch: null as null | { calls: Array<{ path: string; listener: (event: string, filename: string | null) => void; closed: number; errors: Array<(e: unknown) => void> }> },
}))

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  const promises = {
    ...actual.promises,
    stat: (...a: unknown[]) => {
      H.stats++
      return H.stat ? H.stat(String(a[0])) : (actual.promises.stat as unknown as (...x: unknown[]) => Promise<unknown>)(...a)
    },
    open: (...a: unknown[]) => {
      H.opens++
      return H.open ? H.open(String(a[0])) : (actual.promises.open as unknown as (...x: unknown[]) => Promise<unknown>)(...a)
    },
  }
  const patched = {
    ...actual,
    promises,
    watch: (...a: unknown[]) => {
      if (!H.watch) throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' })
      const rec = { path: String(a[0]), listener: a[2] as (event: string, filename: string | null) => void, closed: 0, errors: [] as Array<(e: unknown) => void> }
      H.watch.calls.push(rec)
      return {
        close() { rec.closed++ },
        on(ev: string, cb: (e: unknown) => void) { if (ev === 'error') rec.errors.push(cb); return this },
      }
    },
  }
  return { ...patched, default: patched }
})

import { tailFile, MAX_READ_BYTES } from '../../src/main/transcriptWatchers/baseWatcher'
import { setWatchGatesPaused } from '../../src/main/watchGuard'

let dir: string
let file: string
const enoent = (): Error => Object.assign(new Error('ENOENT'), { code: 'ENOENT' })

/** Move the fake clock in small steps, yielding real time each step, until `cond` holds. */
async function until(cond: () => boolean, label = 'condition'): Promise<void> {
  for (let i = 0; i < 600 && !cond(); i++) {
    await vi.advanceTimersByTimeAsync(250)
    await new Promise<void>((r) => realSetTimeout(r, 4))
  }
  if (!cond()) throw new Error(`never reached: ${label}`)
}

/** Let any pass that is already going finish its real I/O (and nothing new start). */
async function drain(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await vi.advanceTimersByTimeAsync(0)
    await new Promise<void>((r) => realSetTimeout(r, 15))
  }
}

/** A fake file handle over the real file: reads at most `give` bytes (default all), and says so. */
function handleOver(give?: number, delayMs = 0) {
  const closed = { n: 0 }
  return {
    closed,
    handle: {
      async read(buf: Buffer, off: number, len: number, pos: number) {
        if (delayMs) await new Promise<void>((r) => realSetTimeout(r, delayMs))
        const src = fs.readFileSync(file)
        const n = Math.min(give ?? len, len, Math.max(0, src.length - pos))
        src.copy(buf, off, pos, pos + n)
        return { bytesRead: n, buffer: buf }
      },
      async close() { closed.n++ },
    },
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  H.stat = null
  H.open = null
  H.opens = 0
  H.stats = 0
  H.watch = null
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'termpolis-tail-'))
  file = path.join(dir, 'session.jsonl')
  fs.writeFileSync(file, '')
})
afterEach(() => {
  setWatchGatesPaused(false)
  vi.useRealTimers()
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* temp */ }
})

describe('tailFile: the asynchronous pass', () => {
  it('reads what was appended after attach, on the poll', async () => {
    const seen: string[] = []
    const t = tailFile(file, (l) => { seen.push(l) })
    fs.appendFileSync(file, 'one\ntwo\n')
    await until(() => seen.length === 2, 'two lines')
    expect(seen).toEqual(['one', 'two'])
    t.stop()
  })

  it('does not open the file when nothing grew: an idle poll is a stat and no more', async () => {
    fs.writeFileSync(file, 'a\nb\n')
    const t = tailFile(file, () => {}, { startAtEnd: true })
    H.opens = 0
    H.stats = 0
    await until(() => H.stats >= 3, 'three idle passes')
    expect(H.opens).toBe(0)
    t.stop()
  })

  it('survives a stat that fails (the file is gone) and picks the file up when it is back', async () => {
    const seen: string[] = []
    const t = tailFile(file, (l) => { seen.push(l) })
    H.stat = async () => { throw enoent() }
    await until(() => H.stats >= 1, 'a pass that met the failing stat')
    await drain()
    expect(seen).toEqual([])
    H.stat = null
    fs.appendFileSync(file, 'back\n')
    await until(() => seen.length === 1, 'the line after the file came back')
    expect(seen).toEqual(['back'])
    t.stop()
  })

  it('does not advance the offset when the open fails, so the next pass delivers the same lines', async () => {
    const seen: string[] = []
    const t = tailFile(file, (l) => { seen.push(l) })
    fs.appendFileSync(file, 'x\ny\n')
    H.open = async () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }) }
    await until(() => H.opens >= 1, 'a pass that met the failing open')
    await drain()
    expect(seen).toEqual([])
    H.open = null
    await until(() => seen.length === 2, 'the lines after the open worked')
    expect(seen).toEqual(['x', 'y'])
    t.stop()
  })

  it('advances by the bytes actually read when a read comes back short, and loses nothing', async () => {
    const seen: string[] = []
    const t = tailFile(file, (l) => { seen.push(l) })
    fs.appendFileSync(file, 'p\nq\nrr\n')
    const first = handleOver(4) // "p\nq\n" of the 7 bytes
    H.open = async () => first.handle
    await until(() => seen.length === 2, 'the short read delivered')
    expect(seen).toEqual(['p', 'q'])
    expect(first.closed.n).toBe(1) // the handle is closed even though the read was short
    H.open = null
    await until(() => seen.length === 3, 'the rest')
    expect(seen).toEqual(['p', 'q', 'rr'])
    t.stop()
  })

  it('treats an empty read as nothing yet and reads again later', async () => {
    const seen: string[] = []
    const t = tailFile(file, (l) => { seen.push(l) })
    fs.appendFileSync(file, 'late\n')
    const empty = handleOver(0)
    H.open = async () => empty.handle
    await until(() => empty.closed.n >= 1, 'a pass that read zero bytes')
    expect(seen).toEqual([])
    H.open = null
    await until(() => seen.length === 1, 'the line on the next pass')
    expect(seen).toEqual(['late'])
    t.stop()
  })

  it('resets to the start when the file shrank (rotated) and reads the new content', async () => {
    fs.writeFileSync(file, 'aaa\nbbb\nccc\n')
    const seen: string[] = []
    const t = tailFile(file, (l) => { seen.push(l) }) // the attach pass reads all three, offset 12
    expect(seen).toEqual(['aaa', 'bbb', 'ccc'])
    fs.writeFileSync(file, 'n\n')
    await until(() => seen.length === 4, 'the line of the rotated file')
    expect(seen).toEqual(['aaa', 'bbb', 'ccc', 'n'])
    t.stop()
  })

  it('reads in MAX_READ_BYTES pieces, one pass each, never skipping bytes', async () => {
    const line = 'z'.repeat(1023) + '\n'
    const count = Math.ceil((MAX_READ_BYTES * 2 + 5000) / line.length)
    const seen: string[] = []
    const t = tailFile(file, (l) => { seen.push(l) })
    fs.appendFileSync(file, line.repeat(count))
    await until(() => seen.length === count, 'every line of a 4 MB append')
    expect(seen).toHaveLength(count)
    t.stop()
  })

  it('a stop() that lands while the stat is pending ends the pass before it opens anything', async () => {
    const seen: string[] = []
    const t = tailFile(file, (l) => { seen.push(l) })
    fs.appendFileSync(file, 'never\n')
    let release: (() => void) | null = null
    H.stat = () => new Promise((resolve) => { release = () => resolve({ size: 6 }) })
    await until(() => release !== null, 'a pass waiting on its stat')
    t.stop()
    H.opens = 0
    ;(release as unknown as () => void)()
    await drain()
    expect(H.opens).toBe(0)
    expect(seen).toEqual([])
  })

  it('a stop() that lands while the read is in flight closes the handle and delivers nothing', async () => {
    const seen: string[] = []
    const t = tailFile(file, (l) => { seen.push(l) })
    fs.appendFileSync(file, 'dropped\n')
    const slow = handleOver(undefined, 150)
    H.open = async () => slow.handle
    await until(() => H.opens >= 1, 'a pass that reached its open')
    t.stop()
    await until(() => slow.closed.n >= 1, 'the handle closed')
    await drain()
    expect(seen).toEqual([])
  })

  it('a consumer that throws on one line does not lose the next', async () => {
    const seen: string[] = []
    const t = tailFile(file, (l) => { seen.push(l); if (l === 'bad') throw new Error('parser') })
    fs.appendFileSync(file, 'bad\ngood\n')
    await until(() => seen.length === 2, 'both lines')
    expect(seen).toEqual(['bad', 'good'])
    t.stop()
  })

  it('reads nothing while the governor has the gates paused, then catches up with the lines it missed', async () => {
    const seen: string[] = []
    const t = tailFile(file, (l) => { seen.push(l) })
    setWatchGatesPaused(true)
    fs.appendFileSync(file, 'a\nb\n')
    H.stats = 0
    await vi.advanceTimersByTimeAsync(20_000) // a dozen polls
    await drain()
    expect(H.stats).toBe(0)
    expect(seen).toEqual([])
    setWatchGatesPaused(false)
    await until(() => seen.length === 2, 'the lines after resume')
    expect(seen).toEqual(['a', 'b'])
    t.stop()
  })

  it('a transcript written hundreds of times a second: the OS watch is closed after 200 events, the poll still reads it, and the reopening asks for ONE read', async () => {
    H.watch = { calls: [] }
    const seen: string[] = []
    const t = tailFile(file, (l) => { seen.push(l) })
    expect(H.watch.calls).toHaveLength(1)
    const first = H.watch.calls[0]
    // 100,000 write notifications in one instant: the listener hears 200 of them
    fs.appendFileSync(file, 'one\n')
    for (let i = 0; i < 100_000; i++) first.listener('change', null)
    expect(first.closed).toBe(1)
    // the poll reads the file regardless (it is the safety net the watch never replaced)
    await until(() => seen.length === 1, 'the poll read the line while the watch was shut')
    expect(seen).toEqual(['one'])
    // after the back-off a new watch is opened (the owner is told once), and it listens again
    await until(() => H.watch!.calls.length === 2, 'the reopening')
    expect(H.watch.calls[1].closed).toBe(0)
    fs.appendFileSync(file, 'two\n')
    H.watch.calls[1].listener('change', null)
    await until(() => seen.length === 2, 'the line after the reopening')
    t.stop()
    expect(H.watch.calls[1].closed).toBe(1)
  })

  it('an error from the OS watch closes it and leaves the poll to do the reading', async () => {
    H.watch = { calls: [] }
    const seen: string[] = []
    const t = tailFile(file, (l) => { seen.push(l) })
    H.watch.calls[0].errors.forEach((cb) => cb(new Error('EPERM')))
    expect(H.watch.calls[0].closed).toBeGreaterThanOrEqual(1)
    fs.appendFileSync(file, 'polled\n')
    await until(() => seen.length === 1, 'the polled line')
    t.stop()
  })

  it('stop() is idempotent and ends the poll: no pass is made afterwards', async () => {
    const t = tailFile(file, () => {})
    t.stop()
    t.stop()
    H.stats = 0
    await vi.advanceTimersByTimeAsync(10_000)
    await drain()
    expect(H.stats).toBe(0)
  })
})
