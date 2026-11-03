// AC1: the primitive every hot path uses instead of a *Sync call. Everything is a COUNTER: fs calls
// made, operations in flight, operations waiting, operations shed. No wall-clock ratios.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { OffMainFiles, QueueFullError, DEFAULT_SOON_MS, type FsPromisesLike } from '../../src/main/offMainFiles'

/** A fake fs.promises that records every call, in order, can hold writes open, and can lack folders. */
function fakeFs(opts: { hold?: boolean; failWrites?: number; needDirs?: boolean } = {}) {
  const calls: string[] = []
  const held: Array<() => void> = []
  const dirs = new Set<string>()
  let inFlight = 0
  let maxInFlight = 0
  let failLeft = opts.failWrites ?? 0
  const data = new Map<string, string>()
  const gate = async (): Promise<void> => {
    inFlight++
    maxInFlight = Math.max(maxInFlight, inFlight)
    try {
      if (opts.hold) await new Promise<void>((r) => held.push(r))
      else await Promise.resolve()
    } finally {
      inFlight--
    }
  }
  const dirOf = (p: string): string => p.slice(0, p.lastIndexOf('/'))
  const needDir = (p: string): void => {
    if (opts.needDirs && !dirs.has(dirOf(p))) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
  }
  const fs: FsPromisesLike = {
    async mkdir(p) { calls.push(`mkdir ${p}`); dirs.add(String(p)) },
    async writeFile(p, d) {
      calls.push(`write ${p}`)
      await gate()
      needDir(p)
      if (failLeft > 0) { failLeft--; throw new Error('disk on fire') }
      data.set(p, String(d))
    },
    async appendFile(p, d) {
      calls.push(`append ${p}`)
      await gate()
      needDir(p)
      data.set(p, (data.get(p) ?? '') + d)
    },
    async readFile(p) {
      calls.push(`read ${p}`)
      await gate()
      return data.get(p) ?? ''
    },
  }
  return { fs, calls, data, held, get maxInFlight() { return maxInFlight } }
}

const writes = (calls: string[]): string[] => calls.filter((c) => c.startsWith('write ') || c.startsWith('append '))

afterEach(() => { vi.useRealTimers() })

describe('OffMainFiles', () => {
  it('writes a state file once per burst, with the last content (1,000 asks, 1 fs write)', async () => {
    const f = fakeFs()
    const io = new OffMainFiles({ fs: f.fs })
    const ps: Array<Promise<void>> = []
    for (let i = 0; i < 1000; i++) ps.push(io.write('/s/ledger.json', `v${i}`))
    await Promise.all(ps)
    expect(writes(f.calls)).toEqual(['write /s/ledger.json'])
    expect(f.data.get('/s/ledger.json')).toBe('v999')
    expect(io.stats().coalesced).toBe(999)
    expect(io.stats().queued).toBe(0)
  })

  it('sends lines asked for together out in ONE append, in order', async () => {
    const f = fakeFs()
    const io = new OffMainFiles({ fs: f.fs })
    const ps: Array<Promise<void>> = []
    for (let i = 0; i < 1000; i++) ps.push(io.append('/s/events.jsonl', `line${i}\n`))
    await Promise.all(ps)
    expect(writes(f.calls)).toEqual(['append /s/events.jsonl'])
    const lines = (f.data.get('/s/events.jsonl') as string).trimEnd().split('\n')
    expect(lines).toHaveLength(1000)
    expect(lines[0]).toBe('line0')
    expect(lines[999]).toBe('line999')
  })

  it('keeps a path\'s operations in the order they were asked, never merging across a different kind', async () => {
    const f = fakeFs()
    const io = new OffMainFiles({ fs: f.fs })
    await Promise.all([io.write('/s/a', 'W1'), io.append('/s/a', 'A1'), io.write('/s/a', 'W2'), io.append('/s/a', 'A2')])
    expect(writes(f.calls)).toEqual(['write /s/a', 'append /s/a', 'write /s/a', 'append /s/a'])
    expect(f.data.get('/s/a')).toBe('W2A2')
  })

  it('makes the folder only when the write finds it missing: one fs call in the usual case', async () => {
    const f = fakeFs({ needDirs: true })
    const io = new OffMainFiles({ fs: f.fs })
    await io.write('/s/sub/a', '1')
    expect(f.calls).toEqual(['write /s/sub/a', 'mkdir /s/sub', 'write /s/sub/a'])
    f.calls.length = 0
    await io.write('/s/sub/a', '2')
    await io.append('/s/sub/b', 'x') // another file, the folder exists by now
    expect(f.calls).toEqual(['write /s/sub/a', 'append /s/sub/b'])
  })

  it('never has more operations in flight than its concurrency, however many paths ask', async () => {
    const f = fakeFs({ hold: true })
    const io = new OffMainFiles({ fs: f.fs, concurrency: 2, maxQueued: 1000 })
    const ps: Array<Promise<void>> = []
    for (let i = 0; i < 60; i++) ps.push(io.write(`/s/f${i}`, 'x'))
    for (let guard = 0; guard < 400 && (f.held.length > 0 || io.stats().queued > 0); guard++) {
      await new Promise<void>((r) => setImmediate(r))
      f.held.shift()?.()
    }
    await Promise.all(ps)
    expect(f.maxInFlight).toBeLessThanOrEqual(2)
    expect(io.stats().maxInFlight).toBeLessThanOrEqual(2)
    expect(io.stats().writes).toBe(60)
  })

  it('sheds work past its queue bound and says so (a counter, not a hang, not a crash)', async () => {
    const f = fakeFs({ hold: true })
    const shed: string[] = []
    const io = new OffMainFiles({ fs: f.fs, concurrency: 1, maxQueued: 5, onShed: (w) => shed.push(w) })
    const ok: Array<Promise<void>> = []
    for (let i = 0; i < 5; i++) ok.push(io.write(`/s/f${i}`, 'x'))
    await expect(io.write('/s/overflow', 'x')).rejects.toBeInstanceOf(QueueFullError)
    expect(io.stats().shedOps).toBe(1)
    expect(shed).toEqual(['queue'])
    for (let guard = 0; guard < 200 && io.stats().queued > 0; guard++) {
      await new Promise<void>((r) => setImmediate(r))
      f.held.shift()?.()
    }
    await Promise.all(ok)
    expect(io.stats().queued).toBe(0)
    expect(io.stats().maxQueued).toBe(5)
  })

  it('holds a bounded number of characters per path, shedding the OLDEST lines first', async () => {
    const f = fakeFs()
    const io = new OffMainFiles({ fs: f.fs, maxAppendChars: 10 * 1024 })
    const ps: Array<Promise<void>> = []
    for (let i = 0; i < 100; i++) ps.push(io.append('/s/log', `${String(i).padStart(4, '0')}${'x'.repeat(1020)}\n`))
    await Promise.all(ps)
    const out = f.data.get('/s/log') as string
    expect(out.length).toBeLessThanOrEqual(10 * 1024 + 1025)
    expect(out.includes('0099')).toBe(true) // the newest line survived
    expect(out.includes('0000')).toBe(false) // the oldest did not
    expect(io.stats().shedChars).toBeGreaterThan(0)
  })

  it('a failed write rejects its caller, frees its slot, and does not stop the next one', async () => {
    const f = fakeFs({ failWrites: 1 })
    const io = new OffMainFiles({ fs: f.fs })
    await expect(io.write('/s/a', 'x')).rejects.toThrow('disk on fire')
    expect(io.stats().queued).toBe(0)
    await io.write('/s/a', 'y')
    expect(f.data.get('/s/a')).toBe('y')
  })

  it('run() serialises multi-step work per key, and later appends queue after it', async () => {
    const f = fakeFs()
    const io = new OffMainFiles({ fs: f.fs })
    const order: string[] = []
    const first = io.append('/s/log', 'before\n')
    const rotate = io.run('/s/log', async () => { order.push('rotate-start'); await Promise.resolve(); order.push('rotate-end') })
    const after = io.append('/s/log', 'after\n') // must NOT join the append queued in front of the rotation
    await Promise.all([first, rotate, after])
    expect(order).toEqual(['rotate-start', 'rotate-end'])
    expect(writes(f.calls)).toEqual(['append /s/log', 'append /s/log'])
    expect(io.stats().runs).toBe(1)
  })

  it('reads through the bounded gate', async () => {
    const f = fakeFs()
    f.data.set('/s/x', 'hello')
    const io = new OffMainFiles({ fs: f.fs })
    expect(await io.read('/s/x')).toBe('hello')
    expect(io.stats().reads).toBe(1)
  })

  it('idle() settles once everything has been written', async () => {
    const f = fakeFs()
    const io = new OffMainFiles({ fs: f.fs })
    void io.write('/s/a', '1')
    void io.append('/s/b', '2')
    await io.idle()
    expect(f.data.get('/s/a')).toBe('1')
    expect(f.data.get('/s/b')).toBe('2')
    expect(io.stats().queued).toBe(0)
  })
})

describe('OffMainFiles.writeSoon', () => {
  it('writes once per delay however often it is asked (10,000 asks, 1 write), with the latest content', async () => {
    vi.useFakeTimers()
    const f = fakeFs()
    const io = new OffMainFiles({ fs: f.fs })
    for (let i = 0; i < 10_000; i++) io.writeSoon('/s/session.json', `v${i}`)
    expect(f.calls).toEqual([]) // nothing yet: the timer is the only thing armed
    await vi.advanceTimersByTimeAsync(DEFAULT_SOON_MS - 1)
    expect(f.calls).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    await io.idle()
    expect(writes(f.calls)).toEqual(['write /s/session.json'])
    expect(f.data.get('/s/session.json')).toBe('v9999')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps writing during a steady trickle (it is a throttle, not a debounce): one write per delay', async () => {
    vi.useFakeTimers()
    const f = fakeFs()
    const io = new OffMainFiles({ fs: f.fs })
    for (let t = 0; t < 10; t++) {
      io.writeSoon('/s/a', `v${t}`, { delayMs: 1000 })
      await vi.advanceTimersByTimeAsync(400)
    }
    await vi.advanceTimersByTimeAsync(1000)
    await io.idle()
    // 4,000 ms of asking every 400 ms: 4 writes, never 0.
    expect(writes(f.calls).length).toBe(4)
  })

  it('an explicit write() takes the place of a write that was waiting on its timer', async () => {
    vi.useFakeTimers()
    const f = fakeFs()
    const io = new OffMainFiles({ fs: f.fs })
    io.writeSoon('/s/a', 'soon')
    await io.write('/s/a', 'now')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(writes(f.calls)).toEqual(['write /s/a'])
    expect(f.data.get('/s/a')).toBe('now')
  })
})

describe('OffMainFiles on the real file system', () => {
  it('round-trips a write, an append and a read, and flushSync() lands what was still waiting', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'omf-'))
    try {
      const io = new OffMainFiles()
      await io.write(join(dir, 'sub', 'state.json'), '{"a":1}')
      await io.append(join(dir, 'sub', 'log.txt'), 'one\n')
      await io.append(join(dir, 'sub', 'log.txt'), 'two\n')
      expect(readFileSync(join(dir, 'sub', 'state.json'), 'utf8')).toBe('{"a":1}')
      expect(await io.read(join(dir, 'sub', 'log.txt'))).toBe('one\ntwo\n')

      // Asked for, not yet started, or waiting on its timer: the quit handler's flushSync() must not lose it.
      const lost = io.write(join(dir, 'late', 'state.json'), 'late')
      const lostAppend = io.append(join(dir, 'late', 'log.txt'), 'late\n')
      io.writeSoon(join(dir, 'late', 'soon.json'), 'soon')
      io.flushSync()
      expect(readFileSync(join(dir, 'late', 'state.json'), 'utf8')).toBe('late')
      expect(readFileSync(join(dir, 'late', 'log.txt'), 'utf8')).toBe('late\n')
      await Promise.allSettled([lost, lostAppend])
      await io.idle()
      // ...and what was already queued does not write it a second time.
      expect(readFileSync(join(dir, 'late', 'log.txt'), 'utf8')).toBe('late\n')
      expect(readFileSync(join(dir, 'late', 'soon.json'), 'utf8')).toBe('soon')
      expect(existsSync(join(dir, 'late'))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
