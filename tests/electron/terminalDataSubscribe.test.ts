import { describe, it, expect, vi } from 'vitest'
import {
  createTerminalDataRouting,
  registerTerminalDataRouting,
  GRACE_CHUNKS,
  MAX_LISTENED_IDS,
  type TerminalDataRouting,
  type TerminalDataTarget,
} from '../../src/main/terminalDataRouting'
import { getTypingTraceSnapshot } from '../../src/main/typingTrace'

// Which terminals' output main pushes to the renderer as `terminal:data` (1.54.5, plan package P9).
//
// The base sent EVERY chunk of EVERY terminal to the renderer, whether or not anything there listened: a hidden swarm
// worker (no pane) cost a structured clone, an IPC message, a bridge crossing per mounted pane and a handler run for
// every chunk. Counters, not wall-clock: how many `terminal:data` sends reach a window, per terminal.
//
// Every claim has a NEGATIVE CONTROL in this file: a router with the kill switch on (enabled: false) is the base's
// behaviour (it sends all of it), and the same scenario shows what routing changes.

interface FakeWindow extends TerminalDataTarget {
  sends: Array<unknown[]>
}

/** `'none'` = a window double that has no webContents id at all (a unit-test mock of BrowserWindow). */
function fakeWindow(webContentsId: number | 'none' = 1): FakeWindow {
  const sends: Array<unknown[]> = []
  return {
    sends,
    webContents: { id: webContentsId === 'none' ? undefined : webContentsId, send: (...args: unknown[]) => { sends.push(args) } },
  }
}

const sentIds = (w: FakeWindow): string[] => w.sends.map((a) => a[1] as string)

/** A terminal the page has spoken of (a pane that mounted and left): it has no grace chunks left. */
function spokenOf(routing: TerminalDataRouting, sender: number | undefined, id: string, epoch = 1): void {
  routing.note(sender, { id, epoch }, true)
  routing.note(sender, { id, epoch }, false)
}

describe('terminal:data routing: what main sends to the renderer', () => {
  it('sends everything until a page has announced what it listens to (existing behaviour, and every harness without a preload)', () => {
    const routing = createTerminalDataRouting()
    const win = fakeWindow()
    expect(routing.send(win, 'a', 'hello', 5)).toBe(true)
    expect(routing.send(win, 'b', 'world', 5)).toBe(true)
    expect(win.sends).toEqual([['terminal:data', 'a', 'hello', 5], ['terminal:data', 'b', 'world', 5]])
    expect(routing.stats()).toMatchObject({ sent: 2, skipped: 0, armed: false })
  })

  it('sends 0 terminal:data for an id nothing listens to (after its grace), and every chunk of the one a pane listens to', () => {
    const routing = createTerminalDataRouting()
    const win = fakeWindow()
    routing.note(1, { id: 'pane', epoch: 10 }, true)
    for (let i = 0; i < 1000; i++) {
      routing.send(win, 'pane', `p${i}`, i)
      routing.send(win, 'worker-1', `w${i}`, i)
      routing.send(win, 'worker-2', `w${i}`, i)
    }
    // Each worker was sent its first GRACE_CHUNKS chunks (see the grace tests) and nothing after them.
    expect(sentIds(win).filter((id) => id === 'worker-1')).toHaveLength(GRACE_CHUNKS)
    expect(sentIds(win).filter((id) => id === 'worker-2')).toHaveLength(GRACE_CHUNKS)
    expect(sentIds(win).filter((id) => id === 'pane')).toHaveLength(1000)
    expect(routing.stats()).toMatchObject({ sent: 1000 + 2 * GRACE_CHUNKS, skipped: 2 * (1000 - GRACE_CHUNKS), ids: 1, armed: true })
    // And once the grace is spent, a further chunk is not sent at all: the counter that matters for a terminal with no pane.
    const before = win.sends.length
    for (let i = 0; i < 500; i++) { routing.send(win, 'worker-1', 'x'); routing.send(win, 'worker-2', 'x') }
    expect(win.sends.length).toBe(before)
  })

  it('NEGATIVE CONTROL: with the kill switch on, the same traffic is sent in full (the base)', () => {
    const routing = createTerminalDataRouting({ enabled: false })
    const win = fakeWindow()
    routing.note(1, { id: 'pane', epoch: 10 }, true)
    for (let i = 0; i < 1000; i++) {
      routing.send(win, 'pane', `p${i}`, i)
      routing.send(win, 'worker-1', `w${i}`, i)
      routing.send(win, 'worker-2', `w${i}`, i)
    }
    expect(win.sends).toHaveLength(3000)
    expect(routing.stats()).toMatchObject({ sent: 3000, skipped: 0, armed: false })
  })

  describe("the grace: a terminal's first chunks are sent even before anything announced it", () => {
    it("a launch that announces all a round trip after the shell started loses none of the shell's first output", () => {
      const routing = createTerminalDataRouting()
      const win = fakeWindow()
      routing.note(1, { id: 'someone-elses-pane', epoch: 1 }, true) // routing is armed
      // The shell speaks (two chunks) before main has read the launch's { all: true }...
      routing.send(win, 'fresh', 'Microsoft Windows banner', 1)
      routing.send(win, 'fresh', 'C:> ', 2)
      routing.note(1, { all: true, epoch: 1 }, true) // ...which then arrives
      routing.send(win, 'fresh', 'later', 3)
      expect(win.sends.map((a) => a[2])).toEqual(['Microsoft Windows banner', 'C:> ', 'later'])
    })

    it('NEGATIVE CONTROL: the same race without the grace would lose the first two chunks (a terminal whose grace is used up)', () => {
      const routing = createTerminalDataRouting()
      const win = fakeWindow()
      routing.note(1, { id: 'someone-elses-pane', epoch: 1 }, true)
      spokenOf(routing, 1, 'old')
      routing.send(win, 'old', 'banner')
      routing.send(win, 'old', 'prompt')
      expect(win.sends).toHaveLength(0)
    })

    it('exactly GRACE_CHUNKS are free per terminal, counted per terminal, and an announced id never spends any', () => {
      const routing = createTerminalDataRouting()
      const win = fakeWindow()
      routing.note(1, { id: 'pane', epoch: 1 }, true)
      for (let i = 0; i < GRACE_CHUNKS + 5; i++) { routing.send(win, 'a', 'x'); routing.send(win, 'b', 'x') }
      expect(sentIds(win).filter((id) => id === 'a')).toHaveLength(GRACE_CHUNKS)
      expect(sentIds(win).filter((id) => id === 'b')).toHaveLength(GRACE_CHUNKS)
      expect(routing.stats().skipped).toBe(10)
      // A pane that mounts and leaves again does not give the terminal a fresh grace.
      spokenOf(routing, 1, 'c')
      const before = win.sends.length
      routing.send(win, 'c', 'x')
      expect(win.sends.length).toBe(before)
    })

    it('is not spent while routing is not filtering at all (everything is sent then), and reset() forgets it', () => {
      const routing = createTerminalDataRouting()
      const win = fakeWindow()
      for (let i = 0; i < GRACE_CHUNKS * 2; i++) routing.send(win, 'w', 'x') // nothing announced: sent, grace untouched
      routing.note(1, { id: 'pane', epoch: 1 }, true)
      for (let i = 0; i < GRACE_CHUNKS + 10; i++) routing.send(win, 'w', 'x')
      expect(sentIds(win).filter((id) => id === 'w')).toHaveLength(GRACE_CHUNKS * 2 + GRACE_CHUNKS)
      expect(routing.stats().graced).toBe(2) // w, and the announced pane (marked as spoken of)
      routing.reset()
      expect(routing.stats().graced).toBe(0)
    })

    it('remembers at most 1,024 terminals: the oldest are forgotten (and would only get their free chunks again)', () => {
      const routing = createTerminalDataRouting()
      const win = fakeWindow()
      routing.note(1, { id: 'pane', epoch: 1 }, true)
      for (let i = 0; i < 1500; i++) routing.send(win, `worker-${i}`, 'x')
      expect(routing.stats().graced).toBeLessThanOrEqual(1024)
      expect(win.sends).toHaveLength(1500) // each was a first chunk: all sent
    })
  })

  it('passes the chunk and where it ends in the stream through untouched, as the base did: 4 arguments', () => {
    const routing = createTerminalDataRouting()
    const win = fakeWindow()
    routing.note(1, { id: 'a', epoch: 1 }, true)
    routing.send(win, 'a', '\x1b[31mred\x1b[0m', 42)
    routing.send(win, 'a', 'no offset')
    expect(win.sends[0]).toEqual(['terminal:data', 'a', '\x1b[31mred\x1b[0m', 42])
    expect(win.sends[1]).toEqual(['terminal:data', 'a', 'no offset', undefined])
    expect(win.sends[1]).toHaveLength(4)
  })

  it('stops sending an id when its last pane unsubscribes, and sends it again when a pane mounts again', () => {
    const routing = createTerminalDataRouting()
    const win = fakeWindow()
    routing.note(1, { id: 'a', epoch: 1 }, true)
    routing.send(win, 'a', '1')
    routing.note(1, { id: 'a', epoch: 1 }, false)
    routing.send(win, 'a', '2')
    routing.note(1, { id: 'a', epoch: 1 }, true)
    routing.send(win, 'a', '3')
    expect(win.sends.map((a) => a[2])).toEqual(['1', '3'])
  })

  it('sends every terminal while something listens to ALL of them (a launch waiting for its shell), and only the listened ones after', () => {
    const routing = createTerminalDataRouting()
    const win = fakeWindow()
    routing.note(1, { id: 'pane', epoch: 1 }, true)
    spokenOf(routing, 1, 'other') // its grace is not what is under test here
    routing.send(win, 'other', 'before')
    routing.note(1, { all: true, epoch: 1 }, true)
    routing.send(win, 'other', 'during')
    routing.note(1, { all: true, epoch: 1 }, false)
    routing.send(win, 'other', 'after')
    routing.send(win, 'pane', 'still')
    expect(win.sends.map((a) => a[2])).toEqual(['during', 'still'])
    expect(routing.stats().all).toBe(false)
  })

  it('an unsubscribe for an id nobody announced changes nothing, and never arms the router', () => {
    const routing = createTerminalDataRouting()
    const win = fakeWindow()
    routing.note(1, { id: 'ghost', epoch: 1 }, false)
    expect(routing.stats().armed).toBe(false)
    routing.send(win, 'x', '1')
    expect(win.sends).toHaveLength(1)
  })
})

describe('terminal:data routing: a new page, an old page, two windows', () => {
  it("a reloaded page (a newer epoch) starts from nothing: the old page's ids are not carried over", () => {
    const routing = createTerminalDataRouting()
    const win = fakeWindow()
    routing.note(1, { id: 'a', epoch: 100 }, true)
    routing.note(1, { id: 'b', epoch: 100 }, true)
    // The page reloads: its preload announces under a newer epoch and only the panes that mounted again.
    routing.note(1, { id: 'b', epoch: 200 }, true)
    for (let i = 0; i < GRACE_CHUNKS + 5; i++) routing.send(win, 'a', 'a') // a was spoken of: no grace, and no longer listened to
    routing.send(win, 'b', 'b')
    expect(win.sends.map((a) => a[2])).toEqual(['b'])
  })

  it('messages from the page that was replaced (an older epoch) are ignored, however late they arrive', () => {
    const routing = createTerminalDataRouting()
    const win = fakeWindow()
    routing.note(1, { id: 'a', epoch: 200 }, true)
    routing.note(1, { id: 'a', epoch: 100 }, false) // the dead page's cleanup, arriving after the new page's subscribe
    routing.note(1, { id: 'z', epoch: 100 }, true) // and a late subscribe of the dead page
    routing.send(win, 'a', 'a')
    // z is not listened to: only its grace chunks get through, however many are sent.
    for (let i = 0; i < GRACE_CHUNKS + 20; i++) routing.send(win, 'z', 'z')
    expect(sentIds(win).filter((id) => id === 'a')).toHaveLength(1)
    expect(sentIds(win).filter((id) => id === 'z')).toHaveLength(GRACE_CHUNKS)
  })

  it('a window main is not tracking is sent everything (fail open), not just its first chunks, and a newer sender takes over the tracking', () => {
    const routing = createTerminalDataRouting()
    const first = fakeWindow(1)
    const second = fakeWindow(2)
    routing.note(1, { id: 'a', epoch: 1 }, true)
    // Window 2 has announced nothing: EVERY chunk goes to it, far past any grace.
    for (let i = 0; i < GRACE_CHUNKS + 20; i++) routing.send(second, 'unlisted', 'x')
    expect(second.sends).toHaveLength(GRACE_CHUNKS + 20)
    second.sends.length = 0
    routing.note(2, { id: 'b', epoch: 1 }, true) // window 2's page announces: it is the tracked one now
    spokenOf(routing, 2, 'old')
    routing.send(second, 'old', 'y')
    routing.send(second, 'b', 'z')
    expect(second.sends.map((a) => a[2])).toEqual(['z'])
    // ... and window 1 is the untracked one: everything goes to it.
    for (let i = 0; i < GRACE_CHUNKS + 20; i++) routing.send(first, 'unlisted', 'q')
    expect(first.sends).toHaveLength(GRACE_CHUNKS + 20)
  })

  it('treats a window without an id (a test double) as one consistent sender', () => {
    const routing = createTerminalDataRouting()
    const win = fakeWindow('none')
    routing.note(undefined, { id: 'a', epoch: 1 }, true)
    spokenOf(routing, undefined, 'b')
    routing.send(win, 'a', '1')
    routing.send(win, 'b', '2')
    expect(win.sends.map((a) => a[2])).toEqual(['1'])
  })
})

describe('terminal:data routing: bounded', () => {
  it('a page that announces more terminals than any real window holds turns routing off (fail open) instead of growing without bound', () => {
    const routing = createTerminalDataRouting()
    const win = fakeWindow()
    for (let i = 0; i < MAX_LISTENED_IDS; i++) routing.note(1, { id: `t${i}`, epoch: 1 }, true)
    // NEGATIVE CONTROL, in the same test: AT the cap routing still filters.
    expect(routing.stats()).toMatchObject({ armed: true, ids: MAX_LISTENED_IDS })
    for (let i = 0; i < GRACE_CHUNKS + 5; i++) routing.send(win, 'unlistened', 'x')
    expect(win.sends).toHaveLength(GRACE_CHUNKS) // only the grace got through
    // One more and it gives up: everything is sent from here on.
    win.sends.length = 0
    routing.note(1, { id: 'one-too-many', epoch: 1 }, true)
    expect(routing.stats()).toMatchObject({ armed: false, ids: 0 })
    for (let i = 0; i < GRACE_CHUNKS + 5; i++) routing.send(win, 'unlistened', 'x')
    expect(win.sends).toHaveLength(GRACE_CHUNKS + 5)
    // It stays given up: a valid subscribe afterwards does not bring filtering back (the page that overflowed is broken).
    win.sends.length = 0
    routing.note(1, { id: 'later-valid', epoch: 1 }, true)
    expect(routing.stats().armed).toBe(false)
    for (let i = 0; i < GRACE_CHUNKS + 5; i++) routing.send(win, 'unlistened-too', 'x')
    expect(win.sends).toHaveLength(GRACE_CHUNKS + 5)
  })
})

describe('terminal:data routing: fails open', () => {
  it('a malformed announcement turns routing off for the rest of the process: everything is sent, even after valid announcements', () => {
    const bad: unknown[] = [undefined, null, 'a', 7, {}, { epoch: 1 }, { id: '', epoch: 1 }, { id: 5, epoch: 1 }, { id: 'a' }, { id: 'a', epoch: 'x' }, { id: 'a', epoch: NaN }, { all: false, epoch: 1 }, { id: 'x'.repeat(5000), epoch: 1 }, { id: 'a', all: true, epoch: 1 }]
    for (const msg of bad) {
      const routing = createTerminalDataRouting()
      const win = fakeWindow()
      routing.note(1, { id: 'a', epoch: 1 }, true)
      routing.note(1, msg, true)
      routing.note(1, { id: 'b', epoch: 1 }, true)
      for (let i = 0; i < GRACE_CHUNKS + 5; i++) routing.send(win, 'never-announced', 'x') // past any grace
      expect(win.sends, JSON.stringify(msg)).toHaveLength(GRACE_CHUNKS + 5)
      expect(routing.stats().armed).toBe(false)
    }
  })

  it('the kill switch ignores every announcement and sends everything', () => {
    const routing = createTerminalDataRouting({ enabled: false })
    const win = fakeWindow()
    routing.note(1, { id: 'a', epoch: 1 }, true)
    routing.send(win, 'b', 'x')
    expect(win.sends).toHaveLength(1)
    expect(routing.stats()).toMatchObject({ armed: false, ids: 0 })
  })

  it('a missing window is a no-op, not a throw (the window was closed between two chunks)', () => {
    const routing = createTerminalDataRouting()
    expect(routing.send(null, 'a', 'x', 1)).toBe(false)
    expect(routing.send(undefined, 'a', 'x', 1)).toBe(false)
    expect(routing.stats()).toMatchObject({ sent: 0, skipped: 0 })
  })

  it('reset() forgets everything: back to sending all', () => {
    const routing = createTerminalDataRouting()
    const win = fakeWindow()
    routing.note(1, { id: 'a', epoch: 1 }, true)
    spokenOf(routing, 1, 'other')
    routing.reset()
    routing.send(win, 'other', 'x')
    expect(win.sends).toHaveLength(1)
  })

  it('reset() also forgets that routing gave up: after it the router filters again', () => {
    const routing = createTerminalDataRouting()
    routing.note(1, { id: 'a', epoch: 1 }, true)
    routing.note(1, 'not an announcement', true) // gives up
    routing.note(1, { id: 'b', epoch: 1 }, true)
    expect(routing.stats().armed).toBe(false)
    routing.reset()
    routing.note(1, { id: 'a', epoch: 1 }, true)
    expect(routing.stats().armed).toBe(true)
  })
})

describe('registerTerminalDataRouting: the two IPC channels', () => {
  it('registers terminal:subscribe and terminal:unsubscribe, and tells the router who sent them', () => {
    const handlers = new Map<string, (e: unknown, msg: unknown) => void>()
    const ipc = { on: vi.fn((channel: string, h: (e: unknown, msg: unknown) => void) => { handlers.set(channel, h) }) }
    const routing = createTerminalDataRouting()
    registerTerminalDataRouting(ipc, routing)
    expect([...handlers.keys()].sort()).toEqual(['terminal:subscribe', 'terminal:unsubscribe'])
    const win = fakeWindow(9)
    handlers.get('terminal:subscribe')!({ sender: { id: 9 } }, { id: 'a', epoch: 1 })
    handlers.get('terminal:subscribe')!({ sender: { id: 9 } }, { id: 'b', epoch: 1 })
    handlers.get('terminal:unsubscribe')!({ sender: { id: 9 } }, { id: 'b', epoch: 1 })
    routing.send(win, 'a', '1')
    routing.send(win, 'b', '2')
    handlers.get('terminal:unsubscribe')!({ sender: { id: 9 } }, { id: 'a', epoch: 1 })
    routing.send(win, 'a', '3')
    expect(win.sends.map((a) => a[2])).toEqual(['1'])
  })

  it('an event without a sender is one consistent anonymous sender (no throw)', () => {
    const handlers = new Map<string, (e: unknown, msg: unknown) => void>()
    const routing = createTerminalDataRouting()
    registerTerminalDataRouting({ on: (c, h) => { handlers.set(c, h as (e: unknown, msg: unknown) => void) } }, routing)
    handlers.get('terminal:subscribe')!({}, { id: 'a', epoch: 1 })
    handlers.get('terminal:subscribe')!(undefined, { id: 'b', epoch: 1 })
    spokenOf(routing, undefined, 'c')
    const win = fakeWindow('none')
    routing.send(win, 'a', '1')
    routing.send(win, 'b', '2')
    routing.send(win, 'c', '3')
    expect(win.sends.map((a) => a[2])).toEqual(['1', '2'])
  })

  it('uses the process-wide router by default', async () => {
    const mod = await import('../../src/main/terminalDataRouting')
    const handlers = new Map<string, (e: unknown, msg: unknown) => void>()
    mod.registerTerminalDataRouting({ on: (c, h) => { handlers.set(c, h as (e: unknown, msg: unknown) => void) } })
    expect(handlers.size).toBe(2)
    mod.terminalDataRouting.reset()
    const win = fakeWindow(5)
    handlers.get('terminal:subscribe')!({ sender: { id: 5 } }, { id: 'only', epoch: 1 })
    spokenOf(mod.terminalDataRouting, 5, 'else')
    expect(mod.sendTerminalData(win, 'only', 'x', 1)).toBe(true)
    expect(mod.sendTerminalData(win, 'else', 'x', 1)).toBe(false)
    mod.terminalDataRouting.reset()
  })
})

describe('terminal:data routing: the process-wide router honours the kill switch env', () => {
  it('TERMPOLIS_TERMINAL_DATA_ROUTING=0 at load means everything is sent; any other value routes', async () => {
    const before = process.env.TERMPOLIS_TERMINAL_DATA_ROUTING
    try {
      process.env.TERMPOLIS_TERMINAL_DATA_ROUTING = '0'
      vi.resetModules()
      const off = await import('../../src/main/terminalDataRouting')
      off.terminalDataRouting.note(1, { id: 'a', epoch: 1 }, true)
      spokenOf(off.terminalDataRouting, 1, 'b')
      expect(off.terminalDataRouting.send(fakeWindow(1), 'b', 'x')).toBe(true)

      process.env.TERMPOLIS_TERMINAL_DATA_ROUTING = '1'
      vi.resetModules()
      const on = await import('../../src/main/terminalDataRouting')
      on.terminalDataRouting.note(1, { id: 'a', epoch: 1 }, true)
      spokenOf(on.terminalDataRouting, 1, 'b')
      expect(on.terminalDataRouting.send(fakeWindow(1), 'b', 'x')).toBe(false)
    } finally {
      if (before === undefined) delete process.env.TERMPOLIS_TERMINAL_DATA_ROUTING
      else process.env.TERMPOLIS_TERMINAL_DATA_ROUTING = before
      vi.resetModules()
    }
  })
})

describe('terminal:data routing: wiring in src/main/index.ts', () => {
  it('both PTY pump sites send through the router, and the router is registered', async () => {
    const { readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    const src = readFileSync(resolve(__dirname, '../../src/main/index.ts'), 'utf8')
    // The two hot sites (terminal:create and the MCP create_terminal pump) hand the chunk and its end offset on.
    expect(src.match(/sendTerminalData\(mainWindow, id, data, end\)/g)).toHaveLength(2)
    // No PTY chunk bypasses it: the 4-argument direct send is gone. (The strict-mode banner and the e2e injector send
    // 3-argument events straight to a pane that is listening, on purpose.)
    expect(src).not.toMatch(/webContents\.send\('terminal:data', id, data, end\)/)
    expect(src).toMatch(/registerTerminalDataRouting\(ipcMain\)/)
  })
})

describe('terminal:data routing: what the typing trace carries', () => {
  const traced = (): Record<string, number> => getTypingTraceSnapshot().extra.terminalData as Record<string, number>

  it('registering the handlers puts the counters in the typing trace (numbers only), and they follow the traffic', () => {
    const routing = createTerminalDataRouting()
    registerTerminalDataRouting({ on: () => undefined }, routing)
    expect(traced()).toEqual({ sent: 0, skipped: 0, ids: 0, armed: 0, all: 0, graced: 0 })
    const win = fakeWindow()
    routing.note(1, { id: 'pane', epoch: 1 }, true)
    for (let i = 0; i < GRACE_CHUNKS + 10; i++) routing.send(win, 'worker', 'x')
    routing.send(win, 'pane', 'y')
    expect(traced()).toEqual({ sent: GRACE_CHUNKS + 1, skipped: 10, ids: 1, armed: 1, all: 0, graced: 2 })
    routing.note(1, { all: true, epoch: 1 }, true)
    expect(traced().all).toBe(1)
    for (const v of Object.values(traced())) expect(typeof v).toBe('number')
  })

  it('NEGATIVE CONTROL: the trace reads the router that was registered LAST, not a fixed one', () => {
    const first = createTerminalDataRouting()
    const second = createTerminalDataRouting()
    registerTerminalDataRouting({ on: () => undefined }, first)
    first.send(fakeWindow(), 'a', 'x')
    expect(traced().sent).toBe(1)
    registerTerminalDataRouting({ on: () => undefined }, second)
    expect(traced().sent).toBe(0)
    second.send(fakeWindow(), 'a', 'x')
    second.send(fakeWindow(), 'b', 'x')
    expect(traced().sent).toBe(2)
  })

  it('a disabled router is traced as not armed (the kill switch shows in the diagnostics)', () => {
    const routing = createTerminalDataRouting({ enabled: false })
    registerTerminalDataRouting({ on: () => undefined }, routing)
    routing.note(1, { id: 'pane', epoch: 1 }, true)
    routing.send(fakeWindow(), 'other', 'x')
    expect(traced()).toMatchObject({ sent: 1, skipped: 0, armed: 0 })
  })
})
