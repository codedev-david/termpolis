import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { writeFile, rename } from 'fs/promises'
import { join } from 'path'

vi.mock('fs')
// Something in the main-process import chain pulls in fs/promises as a default import, so
// the mock has to satisfy both shapes or the module graph fails to load.
vi.mock('fs/promises', () => {
  const mod = { writeFile: vi.fn(async () => {}), rename: vi.fn(async () => {}) }
  return { ...mod, default: mod }
})
vi.mock('electron', () => ({ app: { getPath: () => '/fake/userData' } }))

const {
  appendCommand, searchHistory, flushHistoryNow, flushHistorySync, resetHistoryCache,
} = await import('../../src/main/historyStore')

const HISTORY_PATH = join('/fake/userData', 'history.json')
const TMP_PATH = `${HISTORY_PATH}.tmp`

/** The payload of the Nth background write, parsed back. */
function written(call = 0): any {
  return JSON.parse(vi.mocked(writeFile).mock.calls[call][1] as string)
}

function seed(data: unknown): void {
  vi.mocked(existsSync).mockReturnValue(true)
  vi.mocked(readFileSync).mockReturnValue(JSON.stringify(data) as any)
}

beforeEach(() => {
  vi.clearAllMocks()
  resetHistoryCache()
  vi.mocked(writeFile).mockResolvedValue(undefined as never)
  vi.mocked(rename).mockResolvedValue(undefined as never)
})

describe('appendCommand', () => {
  it('appends a command to history', async () => {
    vi.mocked(existsSync).mockReturnValue(false)
    appendCommand('t1', 'T1', 'ls -la')
    await flushHistoryNow()
    expect(written().t1[0].command).toBe('ls -la')
  })

  it('prunes entries beyond 1000 per terminal', async () => {
    seed({
      t1: Array.from({ length: 1000 }, (_, i) => ({
        terminalId: 't1', terminalName: 'T1', command: `cmd${i}`, timestamp: i,
      })),
    })
    appendCommand('t1', 'T1', 'new-cmd')
    await flushHistoryNow()
    expect(written().t1.length).toBe(1000)
    expect(written().t1[999].command).toBe('new-cmd')
  })

  it('ignores a blank command without scheduling any write', async () => {
    vi.mocked(existsSync).mockReturnValue(false)
    appendCommand('t1', 'T1', '   ')
    await flushHistoryNow()
    expect(writeFile).not.toHaveBeenCalled()
  })

  it('trims the stored command', async () => {
    vi.mocked(existsSync).mockReturnValue(false)
    appendCommand('t1', 'T1', '  git status  ')
    await flushHistoryNow()
    expect(written().t1[0].command).toBe('git status')
  })

  // The whole point of the rewrite: Enter must not touch the disk on the thread that
  // pumps terminal output. Anything that reintroduces a synchronous write here is a
  // typing-latency regression, not a style change.
  it('NEVER writes synchronously on append — no blocking write on the PTY thread', () => {
    vi.mocked(existsSync).mockReturnValue(false)
    appendCommand('t1', 'T1', 'ls')
    expect(writeFileSync).not.toHaveBeenCalled()
    expect(writeFile).not.toHaveBeenCalled()
  })

  it('reads the file at most once no matter how many commands are appended', async () => {
    seed({})
    appendCommand('t1', 'T1', 'one')
    appendCommand('t1', 'T1', 'two')
    appendCommand('t1', 'T1', 'three')
    await flushHistoryNow()
    expect(vi.mocked(readFileSync)).toHaveBeenCalledTimes(1)
  })

  it('coalesces a burst of appends into a single write', async () => {
    seed({})
    for (let i = 0; i < 25; i++) appendCommand('t1', 'T1', `cmd${i}`)
    await flushHistoryNow()
    expect(writeFile).toHaveBeenCalledTimes(1)
    expect(written().t1.length).toBe(25)
  })

  it('keeps separate terminals separate', async () => {
    seed({})
    appendCommand('t1', 'T1', 'ls')
    appendCommand('t2', 'T2', 'pwd')
    await flushHistoryNow()
    expect(written().t1[0].command).toBe('ls')
    expect(written().t2[0].command).toBe('pwd')
  })
})

describe('flushHistoryNow', () => {
  it('writes to a temp file and renames it into place', async () => {
    vi.mocked(existsSync).mockReturnValue(false)
    appendCommand('t1', 'T1', 'ls')
    await flushHistoryNow()
    expect(vi.mocked(writeFile).mock.calls[0][0]).toBe(TMP_PATH)
    expect(rename).toHaveBeenCalledWith(TMP_PATH, HISTORY_PATH)
  })

  it('writes compact JSON, not indented', async () => {
    vi.mocked(existsSync).mockReturnValue(false)
    appendCommand('t1', 'T1', 'ls')
    await flushHistoryNow()
    expect(vi.mocked(writeFile).mock.calls[0][1]).not.toContain('\n')
  })

  it('does nothing when there is nothing pending', async () => {
    await flushHistoryNow()
    expect(writeFile).not.toHaveBeenCalled()
  })

  it('shares one write between concurrent callers', async () => {
    seed({})
    appendCommand('t1', 'T1', 'ls')
    await Promise.all([flushHistoryNow(), flushHistoryNow(), flushHistoryNow()])
    expect(writeFile).toHaveBeenCalledTimes(1)
  })

  it('persists an append that lands while a write is already in flight', async () => {
    seed({})
    let release: () => void = () => {}
    vi.mocked(writeFile).mockImplementationOnce(
      () => new Promise<void>(resolve => { release = resolve }) as never,
    )
    appendCommand('t1', 'T1', 'first')
    const flushing = flushHistoryNow()
    appendCommand('t1', 'T1', 'second')
    release()
    await flushing
    // The second append must not be stranded in memory by the in-flight write.
    expect(writeFile).toHaveBeenCalledTimes(2)
    expect(written(1).t1.map((e: any) => e.command)).toEqual(['first', 'second'])
  })

  it('survives a failing write without throwing', async () => {
    vi.mocked(existsSync).mockReturnValue(false)
    vi.mocked(writeFile).mockRejectedValueOnce(new Error('EACCES') as never)
    appendCommand('t1', 'T1', 'ls')
    await expect(flushHistoryNow()).resolves.toBeUndefined()
  })
})

describe('flushHistorySync', () => {
  it('writes straight to the real path on shutdown', () => {
    vi.mocked(existsSync).mockReturnValue(false)
    appendCommand('t1', 'T1', 'ls')
    flushHistorySync()
    expect(writeFileSync).toHaveBeenCalledWith(HISTORY_PATH, expect.any(String), 'utf-8')
    expect(JSON.parse(vi.mocked(writeFileSync).mock.calls[0][1] as string).t1[0].command).toBe('ls')
  })

  it('does nothing when there is nothing pending', () => {
    flushHistorySync()
    expect(writeFileSync).not.toHaveBeenCalled()
  })

  it('does not write twice when the async flush already ran', async () => {
    vi.mocked(existsSync).mockReturnValue(false)
    appendCommand('t1', 'T1', 'ls')
    await flushHistoryNow()
    flushHistorySync()
    expect(writeFileSync).not.toHaveBeenCalled()
  })

  it('survives a failing write without throwing', () => {
    vi.mocked(existsSync).mockReturnValue(false)
    vi.mocked(writeFileSync).mockImplementationOnce(() => { throw new Error('EACCES') })
    appendCommand('t1', 'T1', 'ls')
    expect(() => flushHistorySync()).not.toThrow()
  })
})

describe('searchHistory', () => {
  it('returns entries matching query across all terminals', () => {
    seed({
      t1: [{ terminalId: 't1', terminalName: 'T1', command: 'git status', timestamp: 1 }],
      t2: [{ terminalId: 't2', terminalName: 'T2', command: 'npm install', timestamp: 2 }],
    })
    const results = searchHistory('git')
    expect(results).toHaveLength(1)
    expect(results[0].command).toBe('git status')
  })

  it('returns results sorted by recency descending', () => {
    seed({
      t1: [
        { terminalId: 't1', terminalName: 'T1', command: 'git log', timestamp: 100 },
        { terminalId: 't1', terminalName: 'T1', command: 'git status', timestamp: 200 },
      ],
    })
    const results = searchHistory('git')
    expect(results[0].timestamp).toBe(200)
  })

  it('matches case-insensitively', () => {
    seed({ t1: [{ terminalId: 't1', terminalName: 'T1', command: 'GIT Status', timestamp: 1 }] })
    expect(searchHistory('git status')).toHaveLength(1)
  })

  it('serves repeated searches from memory rather than re-reading the file', () => {
    seed({ t1: [{ terminalId: 't1', terminalName: 'T1', command: 'ls', timestamp: 1 }] })
    searchHistory('l')
    searchHistory('l')
    searchHistory('l')
    expect(vi.mocked(readFileSync)).toHaveBeenCalledTimes(1)
  })

  it('sees commands appended since the last flush', () => {
    seed({})
    appendCommand('t1', 'T1', 'unflushed-command')
    expect(searchHistory('unflushed')).toHaveLength(1)
  })
})

describe('loading a damaged or missing file', () => {
  it('treats a missing file as empty history', () => {
    vi.mocked(existsSync).mockReturnValue(false)
    expect(searchHistory('anything')).toEqual([])
    expect(readFileSync).not.toHaveBeenCalled()
  })

  it('treats unparseable JSON as empty history', () => {
    vi.mocked(existsSync).mockReturnValue(true)
    vi.mocked(readFileSync).mockReturnValue('{ not json' as any)
    expect(searchHistory('anything')).toEqual([])
  })

  // `null` and arrays parse successfully but are not a terminalId->entries map. Storing one
  // as the cache would leave it falsy or array-shaped, re-reading the file on every single
  // append — exactly the blocking read this store exists to avoid.
  it('treats a JSON null as empty history without re-reading on every append', () => {
    seed(null)
    appendCommand('t1', 'T1', 'ls')
    appendCommand('t1', 'T1', 'pwd')
    expect(vi.mocked(readFileSync)).toHaveBeenCalledTimes(1)
    expect(searchHistory('ls')).toHaveLength(1)
  })

  it('treats a JSON array as empty history', () => {
    seed([1, 2, 3])
    expect(searchHistory('anything')).toEqual([])
  })
})

describe('resetHistoryCache', () => {
  it('forces the next read to come from disk again', () => {
    seed({ t1: [{ terminalId: 't1', terminalName: 'T1', command: 'first', timestamp: 1 }] })
    expect(searchHistory('first')).toHaveLength(1)

    resetHistoryCache()
    seed({ t1: [{ terminalId: 't1', terminalName: 'T1', command: 'second', timestamp: 2 }] })
    expect(searchHistory('first')).toHaveLength(0)
    expect(searchHistory('second')).toHaveLength(1)
  })

  it('drops a pending write instead of leaving a stale timer armed', async () => {
    vi.mocked(existsSync).mockReturnValue(false)
    appendCommand('t1', 'T1', 'ls')
    resetHistoryCache()
    await flushHistoryNow()
    expect(writeFile).not.toHaveBeenCalled()
  })
})
