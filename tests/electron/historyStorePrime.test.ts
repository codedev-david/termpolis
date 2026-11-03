// historyStore: the first Enter of a session used to read and parse the whole history file (1.26 MiB on a real profile)
// synchronously on the main thread. Start-up reads it now, on the thread pool (primeHistory), and an Enter that comes
// before the read has finished is kept and merged in. Counters only.
// IMPORT ORDER: the counters first (they patch fs before the module under test loads).
import { arm, disarm, describeCounts, uninstall } from '../helpers/mainThreadCounters'
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const H = vi.hoisted(() => ({ dir: '' }))
vi.mock('electron', () => ({ app: { getPath: () => H.dir } }))

type Mod = typeof import('../../src/main/historyStore')
let mod: Mod
const file = (): string => path.join(H.dir, 'history.json')

beforeEach(async () => {
  H.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hist-prime-'))
  vi.resetModules()
  mod = await import('../../src/main/historyStore')
})
afterEach(async () => {
  await mod.flushHistoryNow()
  try { fs.rmSync(H.dir, { recursive: true, force: true }) } catch { /* best effort */ }
})
afterAll(() => { uninstall() })

const seed = (n: number): void => {
  const t1 = Array.from({ length: n }, (_, i) => ({ terminalId: 't1', terminalName: 'One', command: `old ${i}`, timestamp: i + 1 }))
  fs.writeFileSync(file(), JSON.stringify({ t1 }))
}

describe('primeHistory', () => {
  it('reads the file without a synchronous call, and appending after it costs none either (counted)', async () => {
    seed(500)
    arm()
    await mod.primeHistory()
    for (let i = 0; i < 100; i++) mod.appendCommand('t1', 'One', `new ${i}`)
    expect(describeCounts(disarm())).toBe('')
    expect(mod.searchHistory('old 499')).toHaveLength(1)
    expect(mod.searchHistory('new 99')).toHaveLength(1)
  })

  it('an Enter before the read has finished is kept and lands after the older commands', async () => {
    seed(3)
    const primed = mod.primeHistory()
    mod.appendCommand('t1', 'One', 'typed while reading') // before the file came back
    await primed
    const all = mod.searchHistory('')
    expect(all.map((e) => e.command)).toEqual(['typed while reading', 'old 2', 'old 1', 'old 0']) // newest first
  })

  it('persists what it merged, so the early Enter survives a restart', async () => {
    seed(2)
    const primed = mod.primeHistory()
    mod.appendCommand('t1', 'One', 'early')
    await primed
    await mod.flushHistoryNow()
    const onDisk = JSON.parse(fs.readFileSync(file(), 'utf8')) as Record<string, Array<{ command: string }>>
    expect(onDisk.t1.map((e) => e.command)).toEqual(['old 0', 'old 1', 'early'])
  })

  it('a missing or damaged file is an empty history, not a failure', async () => {
    await mod.primeHistory()
    expect(mod.searchHistory('')).toEqual([])
    vi.resetModules()
    mod = await import('../../src/main/historyStore')
    fs.writeFileSync(file(), '{ not json')
    await mod.primeHistory()
    mod.appendCommand('t2', 'Two', 'fine')
    expect(mod.searchHistory('fine')).toHaveLength(1)
  })

  it('a file holding null or an array is not a history map: it reads as empty, and is never re-read on every append', async () => {
    fs.writeFileSync(file(), 'null')
    await mod.primeHistory()
    mod.appendCommand('t1', 'One', 'a')
    mod.appendCommand('t1', 'One', 'b')
    expect(mod.searchHistory('').map((e) => e.command).sort()).toEqual(['a', 'b'])
  })

  it('without a prime (a test, an old caller) the first append still reads the file, as it always did', async () => {
    seed(2)
    mod.appendCommand('t1', 'One', 'direct')
    expect(mod.searchHistory('').map((e) => e.command)).toContain('old 1')
    expect(mod.searchHistory('direct')).toHaveLength(1)
  })

  it('a history asked for (read synchronously) while the prime is still reading keeps its answer: the late prime changes nothing', async () => {
    seed(2)
    const priming = mod.primeHistory()
    mod.appendCommand('t1', 'One', 'typed meanwhile') // an Enter before the read finished
    expect(mod.searchHistory('').length).toBe(3) // the search could not wait: it read the file itself, and kept the Enter
    await priming
    expect(mod.searchHistory('').length).toBe(3) // not 5: the Enter is not merged twice, the file is not read over the cache
    mod.appendCommand('t1', 'One', 'after')
    expect(mod.searchHistory('').length).toBe(4)
  })

  it('two primes at once read once and keep every command typed meanwhile', async () => {
    seed(1)
    const a = mod.primeHistory()
    const b = mod.primeHistory()
    mod.appendCommand('t1', 'One', 'typed meanwhile')
    await Promise.all([a, b])
    expect(mod.searchHistory('').length).toBe(2)
  })

  it('priming twice, or after the cache exists, is harmless', async () => {
    seed(1)
    await mod.primeHistory()
    await mod.primeHistory()
    mod.appendCommand('t1', 'One', 'x')
    await mod.primeHistory()
    expect(mod.searchHistory('').length).toBe(2)
  })
})
