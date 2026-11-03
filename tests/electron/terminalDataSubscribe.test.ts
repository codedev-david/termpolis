import { describe, it, expect, vi } from 'vitest'
import {
  createTerminalDataRouting,
  registerTerminalDataRouting,
  type TerminalDataTarget,
} from '../../src/main/terminalDataRouting'

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

describe('terminal:data routing: what main sends to the renderer', () => {
  it('sends everything until a page has announced what it listens to (existing behaviour, and every harness without a preload)', () => {
    const routing = createTerminalDataRouting()
    const win = fakeWindow()
    expect(routing.send(win, 'a', 'hello', 5)).toBe(true)
    expect(routing.send(win, 'b', 'world', 5)).toBe(true)
    expect(win.sends).toEqual([['terminal:data', 'a', 'hello', 5], ['terminal:data', 'b', 'world', 5]])
    expect(routing.stats()).toMatchObject({ sent: 2, skipped: 0, armed: false })
  })

  it('sends 0 terminal:data for an id nothing listens to, and every chunk of the one a pane listens to', () => {
    const routing = createTerminalDataRouting()
    const win = fakeWindow()
    routing.note(1, { id: 'pane', epoch: 10 }, true)
    for (let i = 0; i < 1000; i++) {
      routing.send(win, 'pane', `p${i}`, i)
      routing.send(win, 'worker-1', `w${i}`, i)
      routing.send(win, 'worker-2', `w${i}`, i)
    }
    expect(sentIds(win).filter((id) => id === 'worker-1' || id === 'worker-2')).toEqual([])
    expect(sentIds(win).filter((id) => id === 'pane')).toHaveLength(1000)
    expect(routing.stats()).toMatchObject({ sent: 1000, skipped: 2000, ids: 1, armed: true })
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
    routing.send(win, 'other', 'before')
    routing.note(1, { all: true, epoch: 1 }, true)
    routing.send(win, 'other', 'during')
    routing.note(1, { all: true, epoch: 1 }, false)
    routing.send(win, 'other', 'after')
    routing.send(win, 'pane', 'still')
    expect(win.sends.map((a) => a[2])).toEqual(['during', 'still'])
    expect(routing.stats().all).toBe(false)
  })

  it('a unsubscribe for an id nobody announced changes nothing, and never arms the router', () => {
    const routing = createTerminalDataRouting()
    const win = fakeWindow()
    routing.note(1, { id: 'ghost', epoch: 1 }, false)
    expect(routing.stats().armed).toBe(false)
    routing.send(win, 'x', '1')
    expect(win.sends).toHaveLength(1)
  })
})

describe('terminal:data routing: a new page, an old page, two windows', () => {
  it('a reloaded page (a newer epoch) starts from nothing: the old page\'s ids are not carried over', () => {
    const routing = createTerminalDataRouting()
    const win = fakeWindow()
    routing.note(1, { id: 'a', epoch: 100 }, true)
    routing.note(1, { id: 'b', epoch: 100 }, true)
    // The page reloads: its preload announces under a newer epoch and only the panes that mounted again.
    routing.note(1, { id: 'b', epoch: 200 }, true)
    routing.send(win, 'a', 'a')
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
    routing.send(win, 'z', 'z')
    expect(win.sends.map((a) => a[2])).toEqual(['a'])
  })

  it('a window main is not tracking is sent everything (fail open), and a newer sender takes over the tracking', () => {
    const routing = createTerminalDataRouting()
    const first = fakeWindow(1)
    const second = fakeWindow(2)
    routing.note(1, { id: 'a', epoch: 1 }, true)
    routing.send(second, 'unlisted', 'x')
    expect(second.sends).toHaveLength(1)
    routing.note(2, { id: 'b', epoch: 1 }, true)
    routing.send(second, 'unlisted', 'y')
    routing.send(second, 'b', 'z')
    expect(second.sends.map((a) => a[2])).toEqual(['x', 'z'])
    routing.send(first, 'unlisted', 'q')
    expect(first.sends).toHaveLength(1)
  })

  it('treats a window without an id (a test double) as one consistent sender', () => {
    const routing = createTerminalDataRouting()
    const win = fakeWindow('none')
    routing.note(undefined, { id: 'a', epoch: 1 }, true)
    routing.send(win, 'a', '1')
    routing.send(win, 'b', '2')
    expect(win.sends.map((a) => a[2])).toEqual(['1'])
  })
})

describe('terminal:data routing: fails open', () => {
  it('a malformed announcement turns routing off for the rest of the process: everything is sent, even after valid announcements', () => {
    const bad: unknown[] = [undefined, null, 'a', 7, {}, { epoch: 1 }, { id: '', epoch: 1 }, { id: 5, epoch: 1 }, { id: 'a' }, { id: 'a', epoch: 'x' }, { id: 'a', epoch: NaN }, { all: false, epoch: 1 }, { id: 'x'.repeat(5000), epoch: 1 }]
    for (const msg of bad) {
      const routing = createTerminalDataRouting()
      const win = fakeWindow()
      routing.note(1, { id: 'a', epoch: 1 }, true)
      routing.note(1, msg, true)
      routing.note(1, { id: 'b', epoch: 1 }, true)
      routing.send(win, 'never-announced', 'x')
      expect(win.sends, JSON.stringify(msg)).toHaveLength(1)
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
    routing.reset()
    routing.send(win, 'other', 'x')
    expect(win.sends).toHaveLength(1)
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
      expect(off.terminalDataRouting.send(fakeWindow(1), 'b', 'x')).toBe(true)

      process.env.TERMPOLIS_TERMINAL_DATA_ROUTING = '1'
      vi.resetModules()
      const on = await import('../../src/main/terminalDataRouting')
      on.terminalDataRouting.note(1, { id: 'a', epoch: 1 }, true)
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
