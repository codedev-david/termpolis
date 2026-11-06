import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'

// Plan P11: resizeTerminal hands on what was drawn for the OLD size before the NEW size is recorded.
//
// Output waits in two places between the pty and everything that reads it: the 8 ms coalescer and the
// remote pump's tick. Both hand bytes on with the size the terminal reports WHEN THEY ARE READ, and
// resizeTerminal used to record the new size first. The order below is the contract: the coalescer's
// held bytes leave (emit), the registered readers run (the remote pump, at the old size), and only then
// is the new size recorded and the pty resized. It lives in its own file so the preamble of
// terminalManager.test.ts, which other work edits, is not touched.

// --- Mocks (the same as terminalManager.test.ts: nothing here reaches a real pty, shell or probe) ---

const mockPty = {
  onData: vi.fn(),
  onExit: vi.fn(),
  write: vi.fn(),
  resize: vi.fn(),
  kill: vi.fn(),
  pid: 12345,
}

vi.mock('node-pty', () => ({ spawn: vi.fn(() => mockPty) }))
// A real folder: the fs mock below does not reach terminalManager's own fs import, so helper files are
// really written (and removed again in afterAll).
const { USER_DATA } = vi.hoisted(() => {
  const base = process.env.RUNNER_TEMP || process.env.TEMP || process.env.TMPDIR || '/tmp'
  return { USER_DATA: `${base}${base.includes('\\') ? '\\' : '/'}termpolis-test-resizeflush-tm-${process.pid}` }
})
vi.mock('electron', () => ({ app: { isPackaged: false, getPath: (name: string) => (name === 'userData' ? USER_DATA : '') } }))
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal() as any
  return { ...actual, existsSync: vi.fn(() => true), writeFileSync: vi.fn() }
})
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal() as any
  return { ...actual, homedir: () => '/home/testuser' }
})
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal() as any
  return { ...actual, execSync: vi.fn() }
})
// What the OS says runs in a terminal is shellAlone.test.ts's; nothing here asks it.
vi.mock('../../src/main/shellAlone', () => ({ shellAlone: vi.fn(async () => true) }))

const { existsSync } = await import('fs')
const { execSync } = await import('child_process')
const { spawnTerminal, resizeTerminal, getTerminalSize, killAll } = await import('../../src/main/terminalManager')
const { onBeforeResize, DISABLE_FLAG: RESIZE_FLUSH_DISABLE_FLAG } = await import('../../src/main/ptyResizeFlush')

afterAll(async () => {
  const { rmSync } = await vi.importActual<typeof import('fs')>('fs')
  rmSync(USER_DATA, { recursive: true, force: true })
})

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(execSync).mockReturnValue(Buffer.from(''))
  vi.mocked(existsSync).mockReturnValue(true)
  mockPty.onData.mockReset()
  mockPty.onExit.mockReset()
  mockPty.write.mockReset()
  mockPty.resize.mockReset()
  mockPty.kill.mockReset()
})

afterEach(() => {
  vi.useRealTimers()
  delete process.env[RESIZE_FLUSH_DISABLE_FLAG]
  // Clean up all terminals between tests so the internal map is fresh
  killAll()
})

/** A terminal that logs, in the order they happen, what it emits, what reads it before a resize and
 *  the pty resize itself -- each with the size getTerminalSize reports at that moment. */
function logged(id: string, emit?: (data: string) => void) {
  const log: string[] = []
  const here = (): string => {
    const size = getTerminalSize(id)
    return size ? `${size.cols}x${size.rows}` : 'gone'
  }
  spawnTerminal(id, '/bin/bash', '/tmp', (data) => {
    emit?.(data)
    log.push(`emit ${data} at ${here()}`)
  })
  mockPty.resize.mockImplementation((cols: number, rows: number) => {
    log.push(`pty.resize ${cols}x${rows}`)
  })
  const feed = mockPty.onData.mock.calls[0][0] as (data: string) => void
  const reader = (readId: string): void => {
    log.push(`reader ${readId} at ${here()}`)
  }
  return { log, feed, reader }
}

describe('resizeTerminal hands on what was drawn for the old size before it records the new one', () => {
  it('flushes the coalescer first: what it holds goes out at the OLD size, once, ahead of the pty resize', () => {
    vi.useFakeTimers()
    const t = logged('rf1')
    t.feed('A') // idle: out at once, and it opens the 8 ms window
    t.feed('B') // inside the window: held
    resizeTerminal('rf1', 120, 40)
    expect(t.log).toEqual(['emit A at 80x24', 'emit B at 80x24', 'pty.resize 120x40'])
    expect(getTerminalSize('rf1')).toEqual({ cols: 120, rows: 40 })
    // The window ran out with nothing left in it: the flush was the one and only delivery.
    vi.advanceTimersByTime(50)
    expect(t.log).toEqual(['emit A at 80x24', 'emit B at 80x24', 'pty.resize 120x40'])
  })

  it('runs the order the plan lists: coalescer flush, emit, the remote flush, pty.resize', () => {
    vi.useFakeTimers()
    const t = logged('rf2')
    const off = onBeforeResize(t.reader)
    try {
      t.feed('A')
      t.feed('B')
      resizeTerminal('rf2', 120, 40)
      expect(t.log).toEqual([
        'emit A at 80x24',
        'emit B at 80x24', // the coalescer's flush, emitting what it held
        'reader rf2 at 80x24', // the remote host's pump, reading it at the size it was drawn for
        'pty.resize 120x40',
      ])
      expect(getTerminalSize('rf2')).toEqual({ cols: 120, rows: 40 })
    } finally {
      off()
    }
  })

  it('hands every reader the id of the terminal being resized, and none for a terminal that is not there', () => {
    const seen: string[] = []
    const off = onBeforeResize((id) => seen.push(id))
    try {
      spawnTerminal('rf2a', '/bin/bash', '/tmp', vi.fn())
      spawnTerminal('rf2b', '/bin/bash', '/tmp', vi.fn())
      resizeTerminal('rf2a', 100, 30)
      resizeTerminal('rf2b', 110, 31)
      resizeTerminal('ghost', 120, 32)
      expect(seen).toEqual(['rf2a', 'rf2b'])
    } finally {
      off()
    }
  })

  it('flushes nothing for a resize to the size the terminal already has, but still resizes the pty', () => {
    vi.useFakeTimers()
    const t = logged('rf3')
    const off = onBeforeResize(t.reader)
    try {
      t.feed('A')
      t.feed('B') // held
      resizeTerminal('rf3', 80, 24) // the spawn size: nothing changes for any reader
      expect(t.log).toEqual(['emit A at 80x24', 'pty.resize 80x24'])
      // B leaves on the coalescer's own schedule, undisturbed.
      vi.advanceTimersByTime(8)
      expect(t.log).toEqual(['emit A at 80x24', 'pty.resize 80x24', 'emit B at 80x24'])
      vi.advanceTimersByTime(8) // the window that followed B runs out empty: idle again
      // And a real change, with something held again, flushes (the other half of the control).
      t.feed('C')
      t.feed('D')
      resizeTerminal('rf3', 90, 24)
      expect(t.log.slice(3)).toEqual(['emit C at 80x24', 'emit D at 80x24', 'reader rf3 at 80x24', 'pty.resize 90x24'])
      // A second resize to the size it now has is the same-size case again.
      t.feed('E')
      t.feed('F')
      resizeTerminal('rf3', 90, 24)
      expect(t.log.slice(7)).toEqual(['emit E at 90x24', 'pty.resize 90x24'])
    } finally {
      off()
    }
  })

  it('treats a change in rows alone, or in cols alone, as a change', () => {
    vi.useFakeTimers()
    const t = logged('rf3b')
    const off = onBeforeResize(t.reader)
    try {
      t.feed('A')
      resizeTerminal('rf3b', 80, 40) // rows only
      resizeTerminal('rf3b', 100, 40) // cols only
      expect(t.log.filter((line) => line.startsWith('reader'))).toEqual(['reader rf3b at 80x24', 'reader rf3b at 80x40'])
    } finally {
      off()
    }
  })

  it('with nothing held, the flush emits nothing extra', () => {
    vi.useFakeTimers()
    const t = logged('rf4')
    t.feed('A')
    vi.advanceTimersByTime(8) // the window ran out: idle again
    resizeTerminal('rf4', 120, 40)
    expect(t.log).toEqual(['emit A at 80x24', 'pty.resize 120x40'])
  })

  it("does not flush when the kill switch is on: today's order, the held bytes go out after the resize", () => {
    vi.useFakeTimers()
    process.env[RESIZE_FLUSH_DISABLE_FLAG] = '1'
    const t = logged('rf5')
    const off = onBeforeResize(t.reader)
    try {
      t.feed('A')
      t.feed('B')
      resizeTerminal('rf5', 120, 40)
      expect(t.log).toEqual(['emit A at 80x24', 'pty.resize 120x40'])
      vi.advanceTimersByTime(8)
      // The bug the flush exists for: B was drawn for 80x24 and goes out when the terminal says 120x40.
      expect(t.log).toEqual(['emit A at 80x24', 'pty.resize 120x40', 'emit B at 120x40'])
    } finally {
      off()
    }
  })

  it("still resizes when the flush throws: the consumer of the output is not the resize's business", () => {
    vi.useFakeTimers()
    const t = logged('rf6', (data) => {
      if (data === 'B') throw new Error('the window is gone')
    })
    const off = onBeforeResize(t.reader)
    try {
      t.feed('A')
      t.feed('B') // held; its emit will throw
      expect(() => resizeTerminal('rf6', 120, 40)).not.toThrow()
      expect(mockPty.resize).toHaveBeenCalledWith(120, 40)
      expect(getTerminalSize('rf6')).toEqual({ cols: 120, rows: 40 })
      // The readers after the failed flush still ran, at the old size.
      expect(t.log).toEqual(['emit A at 80x24', 'reader rf6 at 80x24', 'pty.resize 120x40'])
    } finally {
      off()
    }
  })

  it('still resizes when a reader throws', () => {
    spawnTerminal('rf7', '/bin/bash', '/tmp', vi.fn())
    const off = onBeforeResize(() => {
      throw new Error('the bridge is down')
    })
    try {
      expect(() => resizeTerminal('rf7', 120, 40)).not.toThrow()
      expect(mockPty.resize).toHaveBeenCalledWith(120, 40)
      expect(getTerminalSize('rf7')).toEqual({ cols: 120, rows: 40 })
    } finally {
      off()
    }
  })

  it('records the new size even when the pty refuses it, after the flush has run', () => {
    spawnTerminal('rf8', '/bin/bash', '/tmp', vi.fn())
    mockPty.resize.mockImplementation(() => {
      throw new Error('pty closed')
    })
    const seen: string[] = []
    const off = onBeforeResize((id) => seen.push(id))
    try {
      expect(() => resizeTerminal('rf8', 120, 40)).not.toThrow()
      expect(seen).toEqual(['rf8'])
      expect(getTerminalSize('rf8')).toEqual({ cols: 120, rows: 40 })
    } finally {
      off()
    }
  })
})
