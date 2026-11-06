import React from 'react'
import { render, act, cleanup } from '@testing-library/react'
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { FitAddon } from '@xterm/addon-fit'
import type { Terminal } from '@xterm/xterm'

// How a pane's output travels through the renderer's write scheduler (1.54.5, plan package P8), against a REAL
// xterm and the REAL scheduler (the same setup as TerminalPaneResize.test.tsx: a Terminal subclass that only
// supplies a cell size, the real FitAddon, the real throttle for the kill-switch path).
//
// The older pane suites drive the pane with a MOCK xterm that never calls its write callback and assert on
// write(data) with one argument; they are pinned to the output throttle (the kill switch's path) and cannot
// say anything about the scheduler, whose in-flight accounting is nothing without acks. What is counted here
// is what reaches a real xterm and what the scheduler says it did: which panes it holds, the order of its
// hand-overs, what is in flight, what a resize waited for.
//
// Every claim has a NEGATIVE CONTROL in this file: the kill switch gives the pane its own throttle again, and
// the same scenario has to show what the scheduler changes.

// ---- shared state for the mock factories -------------------------------------------------------
const h = vi.hoisted(() => ({
  terms: [] as Array<Terminal>, // every real Terminal a pane created, in creation order
  cell: { width: 9, height: 17 },
}))

// The REAL Terminal, plus a cell size. jsdom has no layout, so xterm measures its cell as 0 x 0 and
// FitAddon.proposeDimensions() answers undefined; everything else (the parser, the write buffer, resize
// and reflow, selection) is xterm's own.
vi.mock('@xterm/xterm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@xterm/xterm')>()
  class LayoutTerminal extends actual.Terminal {
    constructor(opts?: ConstructorParameters<typeof actual.Terminal>[0]) {
      super(opts)
      h.terms.push(this)
    }
    open(parent: HTMLElement): void {
      super.open(parent)
      const core = (this as unknown as { _core: { _renderService: object } })._core
      Object.defineProperty(core._renderService, 'dimensions', {
        configurable: true,
        get: () => ({
          css: { canvas: { width: 0, height: 0 }, cell: { ...h.cell } },
          device: { canvas: { width: 0, height: 0 }, cell: { ...h.cell }, char: { width: h.cell.width, height: h.cell.height, left: 0, top: 0 } },
        }),
      })
    }
  }
  return { ...actual, Terminal: LayoutTerminal }
})

vi.mock('@xterm/addon-webgl', () => ({ WebglAddon: function () { this.dispose = vi.fn(); this.onContextLoss = vi.fn() } }))
vi.mock('@xterm/xterm/css/xterm.css', () => ({}))
vi.mock('uuid', () => ({ v4: vi.fn(() => 'mock-uuid-1234') }))
vi.mock('../../src/renderer/src/themes/terminalThemes', () => ({
  getTheme: vi.fn(() => ({ background: '#1e1e1e', foreground: '#d4d4d4' })),
}))

const mockGetState = vi.hoisted(() => vi.fn())
vi.mock('../../src/renderer/src/store/terminalStore', () => {
  const fn = vi.fn((selector?: (s: unknown) => unknown) => {
    const state = mockGetState()
    return selector ? selector(state) : state
  })
  Object.assign(fn, { getState: mockGetState })
  return { useTerminalStore: fn }
})

vi.mock('../../src/renderer/src/completions/completionEngine', () => ({ getCompletions: vi.fn(() => Promise.resolve([])) }))
vi.mock('../../src/renderer/src/corrections/correctionEngine', () => ({ getSuggestion: vi.fn(() => Promise.resolve(null)) }))
vi.mock('../../src/renderer/src/lib/promptParser', () => ({
  parsePromptFromOutput: vi.fn(() => ({ cwd: null, gitBranch: undefined })),
}))
vi.mock('../../src/renderer/src/lib/outputPatterns', () => ({
  DIFF_PATTERN: /^diff --git /m,
  ERROR_PATTERN: /command not found|not recognized/i,
  COMPACTION_PATTERN: /compacting conversation/i,
}))
vi.mock('../../src/renderer/src/hooks/useCompletionDropdown', () => ({
  useCompletionDropdown: vi.fn(() => ({
    suggestions: [], selectedIndex: 0, dropdownPosition: { x: 0, y: 0 }, dropdownVisible: false,
    dismissDropdown: vi.fn(), triggerCompletions: vi.fn(), acceptSuggestion: vi.fn(), handleDropdownKeyIntercept: vi.fn(() => false),
    isDropdownVisibleRef: { current: false }, suggestionsRef: { current: [] }, autocompleteEnabledRef: { current: true },
  })),
}))
vi.mock('../../src/renderer/src/hooks/useAgentDetection', () => ({
  useAgentDetection: vi.fn(() => ({ detectedAgent: null, processAgentDetection: vi.fn(), agentDetectedRef: { current: false } })),
}))
vi.mock('../../src/renderer/src/hooks/useSessionRecording', () => ({
  useSessionRecording: vi.fn(() => ({
    isRecording: false, startRecording: vi.fn(), stopRecording: vi.fn(), appendRecordingEntry: vi.fn(), isRecordingRef: { current: false },
  })),
}))
vi.mock('../../src/renderer/src/lib/voice/voiceEngines', () => ({
  createVoiceEngine: () => ({ transcribe: vi.fn(), warm: vi.fn(async () => {}), dispose: vi.fn() }),
}))
vi.mock('../../src/renderer/src/components/CompletionDropdown/CompletionDropdown', () => ({ CompletionDropdown: () => <div /> }))
vi.mock('../../src/renderer/src/components/CommandFix/CommandFixBanner', () => ({ CommandFixBanner: () => <div /> }))
vi.mock('../../src/renderer/src/components/StatusBar/TerminalStatusBar', () => ({ TerminalStatusBar: () => <div /> }))
vi.mock('../../src/renderer/src/components/DiffViewer/DiffViewer', () => ({ DiffViewer: () => <div /> }))
vi.mock('../../src/renderer/src/components/PinnedOutput/PinnedOutput', () => ({ PinnedOutput: () => <div /> }))

// ---- window.termpolis, the ResizeObserver, the layout --------------------------------------------
const mockResizeTerminal = vi.fn()
const mockReadTerminalBuffer = vi.fn()
const dataCbs: Array<(id: string, data: string, end?: number) => void> = []
const observers: Array<{ cb: () => void; el: Element }> = []

/** What getComputedStyle reports for each pane's container (FitAddon reads width and height from it). */
const layout = new WeakMap<Element, { width: number; height: number }>()
let defaultLayout = { width: 1000, height: 600 }
const realGetComputedStyle = window.getComputedStyle.bind(window)
const realMatchMedia = (window as { matchMedia?: unknown }).matchMedia

beforeAll(() => {
  ;(window as unknown as { termpolis: unknown }).termpolis = {
    writeToTerminal: vi.fn(),
    readTerminalBuffer: mockReadTerminalBuffer,
    onTerminalData: vi.fn((cb: (id: string, data: string, end?: number) => void) => { dataCbs.push(cb); return vi.fn() }),
    appendHistory: vi.fn(),
    exportTerminal: vi.fn(),
    resizeTerminal: mockResizeTerminal,
    createTerminal: vi.fn(() => Promise.resolve()),
    killTerminal: vi.fn(),
    clipboardWriteText: vi.fn(() => Promise.resolve({ success: true })),
    clipboardReadText: vi.fn(() => Promise.resolve({ success: true, data: 'pasted-text' })),
    clipboardWriteRich: vi.fn(() => Promise.resolve({ success: true })),
    listAISessions: vi.fn().mockResolvedValue({ success: true, data: [] }),
    groqGetKeyStatus: vi.fn(async () => ({ success: true, data: { connected: true, hint: 'gsk_test' } })),
    detectAgents: vi.fn(async () => ({ success: true, data: { claude: true, codex: true, agy: true } })),
    secondOpinion: vi.fn(() => Promise.resolve({ success: true, data: { feedback: 'looks fine' } })),
    clearTerminalBuffer: vi.fn(() => Promise.resolve({ success: true, data: {} })),
    platformInfo: { platform: 'win32', windowsPty: { backend: 'conpty', buildNumber: 22631 } },
  }
  // xterm's open() asks for matchMedia, which jsdom does not have.
  ;(window as unknown as { matchMedia: unknown }).matchMedia = (q: string) => ({
    matches: false, media: q, onchange: null,
    addEventListener: () => undefined, removeEventListener: () => undefined,
    addListener: () => undefined, removeListener: () => undefined, dispatchEvent: () => false,
  })
  vi.stubGlobal('ResizeObserver', class {
    private cb: () => void
    constructor(cb: () => void) { this.cb = cb }
    observe(el: Element): void { observers.push({ cb: this.cb, el }) }
    unobserve(): void {}
    disconnect(): void {
      for (let i = observers.length - 1; i >= 0; i--) if (observers[i].cb === this.cb) observers.splice(i, 1)
    }
  })
  // FitAddon sizes the grid from the container's computed width and height and the .xterm element's padding.
  window.getComputedStyle = ((el: Element, pseudo?: string | null) => {
    const real = realGetComputedStyle(el, pseudo)
    const isXterm = el.classList?.contains('xterm') === true
    const isContainer = Array.from(el.children ?? []).some((c) => c.classList.contains('xterm'))
    if (!isXterm && !isContainer) return real
    return new Proxy(real, {
      get(target, prop) {
        if (prop === 'getPropertyValue') {
          return (name: string): string => {
            if (isContainer) {
              const l = layout.get(el) ?? defaultLayout
              if (name === 'width') return `${l.width}px`
              if (name === 'height') return `${l.height}px`
            }
            if (isXterm && name.startsWith('padding-')) return '4px'
            return target.getPropertyValue(name)
          }
        }
        const v = Reflect.get(target, prop)
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v
      },
    }) as CSSStyleDeclaration
  }) as typeof window.getComputedStyle
})

afterAll(() => {
  window.getComputedStyle = realGetComputedStyle
  ;(window as unknown as { matchMedia: unknown }).matchMedia = realMatchMedia
  vi.unstubAllGlobals()
})

// Import after every mock is registered.
import { TerminalPane } from '../../src/renderer/src/components/TerminalPane/TerminalPane'
import { DEFAULT_KEYBINDINGS } from '../../src/renderer/src/lib/keybindings'

const BASE = { terminalName: 'Terminal', shellType: 'bash' as const, cwd: '/home/user', fontSize: 14, theme: 'dark', fontFamily: 'monospace' }
const paneEl = (id: string, visible: boolean, fontSize = 14): React.ReactElement => (
  <TerminalPane key={id} {...BASE} fontSize={fontSize} terminalId={id} isVisible={visible} />
)

let view: ReturnType<typeof render> | null = null
const mount = async (panes: Array<[string, boolean]>): Promise<void> => {
  await act(async () => { view = render(<>{panes.map(([id, visible]) => paneEl(id, visible))}</>) })
}
const remount = async (panes: Array<[string, boolean]>, fontSize = 14): Promise<void> => {
  await act(async () => { view!.rerender(<>{panes.map(([id, visible]) => paneEl(id, visible, fontSize))}</>) })
}
const settle = async (ms: number): Promise<void> => {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
}
const fireObservers = (): void => { act(() => { observers.slice().forEach((o) => o.cb()) }) }
const term = (i = 0): Terminal => h.terms[i]
const sizeOf = (t: Terminal): [number, number] => [t.cols, t.rows]
const containerOf = (t: Terminal): HTMLElement => t.element!.parentElement as HTMLElement
const sentFor = (id: string): Array<[number, number]> =>
  mockResizeTerminal.mock.calls.filter((c) => c[0] === id).map((c) => [c[1], c[2]] as [number, number])
/** The pty was told at least once, and every time it was told the grid xterm has now (a mount may tell it more than once). */
const expectToldTheGrid = (id: string, t: Terminal): void => {
  const sent = sentFor(id)
  expect(sent.length).toBeGreaterThan(0)
  for (const s of sent) expect(s).toEqual(sizeOf(t))
}

import { resetWriteScheduler, DEFAULT_LIMITS as D, type SchedulerStats } from '../../src/renderer/src/lib/writeScheduler'
import { prng } from '../renderer/helpers/schedulerHarness'

/** The scheduler's counters, as the e2e specs read them. */
const sched = (): SchedulerStats => (window as unknown as { __termpolis_write_scheduler: () => SchedulerStats }).__termpolis_write_scheduler()
const hasSchedulerHook = (): boolean => typeof (window as unknown as { __termpolis_write_scheduler?: unknown }).__termpolis_write_scheduler === 'function'

let activeId: string | undefined

beforeEach(() => {
  vi.useFakeTimers()
  // Frames as timers, so the real scheduler runs under the fake clock (performance.now is faked as well).
  vi.stubGlobal('requestAnimationFrame', (cb: () => void) => setTimeout(() => cb(), 16))
  vi.stubGlobal('cancelAnimationFrame', (id: ReturnType<typeof setTimeout>) => clearTimeout(id))
  resetWriteScheduler()
  delete (window as unknown as { __termpolis_write_scheduler?: unknown }).__termpolis_write_scheduler
  h.terms.length = 0
  observers.length = 0
  dataCbs.length = 0
  activeId = undefined
  defaultLayout = { width: 1000, height: 600 }
  mockResizeTerminal.mockReset()
  mockReadTerminalBuffer.mockReset()
  mockReadTerminalBuffer.mockResolvedValue({ success: true, data: { output: '' } })
  window.localStorage.clear()
  window.localStorage.setItem('termpolis.echoTrace', '0') // the echo trace is not what is under test
  mockGetState.mockImplementation(() => ({
    terminals: ['a', 'b', 'c', 'term-1'].map((id) => ({ id, isSwarm: false })),
    activeTerminalId: activeId,
    addTerminal: vi.fn(), removeTerminal: vi.fn(), focusActiveTerminal: vi.fn(), setShowSettings: vi.fn(),
    focusNonce: 0, autocompleteEnabled: true, allowAppMouseControl: false, voiceSettings: { enabled: false },
    keybindings: { ...DEFAULT_KEYBINDINGS }, customKeybindings: [],
  }))
})

afterEach(() => {
  cleanup()
  view = null
  vi.restoreAllMocks()
  vi.useRealTimers()
  resetWriteScheduler() // the header's afterAll unstubs the globals (ResizeObserver is stubbed once, for the file)
})

const bufferLines = (t: Terminal): string[] => {
  const b = t.buffer.active
  const out: string[] = []
  for (let y = 0; y < b.length; y++) out.push(b.getLine(y)?.translateToString(true) ?? '')
  return out
}

/** Every write a pane's xterm gets, in order, with the pane it went to (`ids`: the panes in the order they were mounted). */
function recordWrites(ids: string[]): Array<{ id: string; chars: number }> {
  const log: Array<{ id: string; chars: number }> = []
  h.terms.forEach((t, i) => {
    const real = t.write.bind(t)
    vi.spyOn(t, 'write').mockImplementation(((data: string, cb?: () => void) => {
      log.push({ id: ids[i], chars: data.length })
      return real(data, cb)
    }) as typeof t.write)
  })
  return log
}

describe('TerminalPane output through the write scheduler: real xterm, real scheduler', () => {
  // ---------------------------------------------------------------------------------------------
  describe('registration', () => {
    it('a mounted pane is registered, its output is written through the scheduler, and it leaves when it unmounts', async () => {
      await mount([['a', true]])
      await settle(500)
      expect(sched().panes).toBe(1)
      await act(async () => { dataCbs[0]('a', 'x'.repeat(20_000) + '\r\nthrough the scheduler\r\n') })
      await settle(200)
      expect(bufferLines(term())).toContain('through the scheduler')
      expect(sched().handoffs).toBeGreaterThan(0)
      expect(sched().handedChars).toBe(20_000 + '\r\nthrough the scheduler\r\n'.length)
      expect(sched().inflightChars).toBe(0) // xterm parsed it all and acked it
      act(() => { cleanup() })
      await settle(200)
      expect(sched().panes).toBe(0)
    })

    it("NEGATIVE CONTROL: with localStorage 'termpolis.writeScheduler' = '0' the pane keeps its own throttle: the same output arrives, the scheduler never hears of the pane", async () => {
      window.localStorage.setItem('termpolis.writeScheduler', '0')
      await mount([['a', true]])
      await settle(500)
      await act(async () => { dataCbs[0]('a', 'x'.repeat(20_000) + '\r\nthrough the throttle\r\n') })
      await settle(200)
      expect(bufferLines(term())).toContain('through the throttle')
      expect(hasSchedulerHook()).toBe(false)
    })

    it("localStorage 'termpolis.outputChunks' = '0' (the whole 1.54.4 output path) takes the scheduler out as well", async () => {
      window.localStorage.setItem('termpolis.outputChunks', '0')
      await mount([['a', true]])
      await settle(500)
      await act(async () => { dataCbs[0]('a', 'x'.repeat(20_000) + '\r\nthrough the string buffer\r\n') })
      await settle(200)
      expect(bufferLines(term())).toContain('through the string buffer')
      expect(hasSchedulerHook()).toBe(false)
    })

    it('a pane that mounts again under the same id (a remount) takes over: one pane in the scheduler, the new xterm gets the output', async () => {
      await mount([['a', true]])
      await settle(300)
      act(() => { cleanup() })
      await settle(200)
      expect(sched().panes).toBe(0)
      await mount([['a', true]])
      await settle(500)
      expect(sched().panes).toBe(1)
      await act(async () => { dataCbs[dataCbs.length - 1]('a', 'x'.repeat(20_000) + '\r\nafter the remount\r\n') })
      await settle(200)
      expect(bufferLines(term(h.terms.length - 1))).toContain('after the remount')
    })
  })

  // ---------------------------------------------------------------------------------------------
  describe('every byte arrives, once, in order', () => {
    const makeLines = (prefix: string, n: number): string[] => Array.from({ length: n }, (_, i) => `${prefix}${String(i).padStart(5, '0')} ${'z'.repeat(30)}`)

    it('three panes flooded in interleaved, randomly split chunks (mid-escape included) end with their own lines, complete and in order', async () => {
      await mount([['a', true], ['b', true], ['c', false]])
      await settle(500)
      activeId = 'a'
      const want = { a: makeLines('A', 1500), b: makeLines('B', 1500), c: makeLines('C', 1500) }
      const streams: Record<string, string> = {}
      for (const id of ['a', 'b', 'c'] as const) streams[id] = want[id].map((l) => `\x1b[32m${l}\x1b[0m`).join('\r\n') + '\r\n' // colour on every line: a split lands inside a CSI
      const rand = prng(11)
      const at = { a: 0, b: 0, c: 0 }
      const ids = ['a', 'b', 'c'] as const
      let steps = 0
      while (ids.some((id) => at[id] < streams[id].length) && steps++ < 100_000) {
        const id = ids[Math.floor(rand() * 3)]
        if (at[id] >= streams[id].length) continue
        const n = 1 + Math.floor(rand() * (rand() < 0.2 ? 30_000 : 400))
        const chunk = streams[id].slice(at[id], at[id] + n)
        at[id] += chunk.length
        await act(async () => { dataCbs[ids.indexOf(id)](id, chunk) })
        if (rand() < 0.3) await settle(Math.floor(rand() * 40))
      }
      await settle(20_000)
      for (const id of ids) {
        const got = bufferLines(term(ids.indexOf(id))).filter((l) => l.startsWith(id.toUpperCase()))
        expect(got).toEqual(want[id])
      }
      expect(sched().queuedChars).toBe(0)
      expect(sched().inflightChars).toBe(0)
      expect(sched().refusals).toBe(0)
    })

    it('NEGATIVE CONTROL: the check can fail: a pane told to drop a chunk would not pass it', async () => {
      await mount([['a', true]])
      await settle(500)
      const want = makeLines('A', 50)
      await act(async () => { dataCbs[0]('a', want.slice(0, 20).join('\r\n') + '\r\n') })
      await act(async () => { dataCbs[0]('a', want.slice(25).join('\r\n') + '\r\n') }) // 5 lines never sent
      await settle(2000)
      expect(bufferLines(term()).filter((l) => l.startsWith('A'))).not.toEqual(want)
    })

    it('output held back by a selection comes out in order, through the scheduler, when the selection is gone', async () => {
      await mount([['a', true]])
      await settle(500)
      const t = term()
      await act(async () => { dataCbs[0]('a', 'before\r\n') })
      await settle(100)
      t.select(0, 0, 4) // a selection: the pane holds output instead of writing it
      expect(t.hasSelection()).toBe(true)
      const lines = makeLines('H', 200)
      await act(async () => { dataCbs[0]('a', lines.slice(0, 100).join('\r\n') + '\r\n') })
      await act(async () => { dataCbs[0]('a', lines.slice(100).join('\r\n') + '\r\n') })
      await settle(500)
      expect(bufferLines(t).filter((l) => l.startsWith('H'))).toEqual([]) // held
      act(() => { t.clearSelection() })
      await settle(2000)
      expect(bufferLines(t).filter((l) => l.startsWith('H'))).toEqual(lines)
      expect(bufferLines(t)[0]).toBe('before')
    })
  })

  // ---------------------------------------------------------------------------------------------
  describe('priority: the active terminal first, then the visible panes, then the hidden ones', () => {
    /** Push to c (hidden), then b (on screen), then a (active) last: the reverse of their priority. Watch the first pass. */
    async function firstPass(sizeOfA: number): Promise<Array<{ id: string; chars: number }>> {
      await mount([['b', true], ['a', true], ['c', false]])
      await settle(500)
      activeId = 'a'
      const log = recordWrites(['b', 'a', 'c'])
      await act(async () => {
        dataCbs[2]('c', 'x'.repeat(200_000))
        dataCbs[0]('b', 'x'.repeat(200_000))
        dataCbs[1]('a', 'x'.repeat(sizeOfA))
      })
      await settle(20) // one frame
      return log
    }

    it('serves a (active) first, then b (on screen), then c (hidden), though they were pushed to in the reverse order', async () => {
      const log = await firstPass(20_000)
      expect(log.slice(0, 3).map((w) => w.id)).toEqual(['a', 'b', 'c'])
      expect(log[1].chars).toBe(D.slice.visible)
      expect(log[2].chars).toBe(D.slice.hidden) // the pool had 45,536 left: more than a hidden pane's slice
    })

    it("NEGATIVE CONTROL: with the scheduler off the throttles take turns in the order they were armed: the active terminal is served last", async () => {
      window.localStorage.setItem('termpolis.writeScheduler', '0')
      const log = await firstPass(20_000)
      expect(log.slice(0, 3).map((w) => w.id)).toEqual(['c', 'b', 'a'])
    })

    it('an active terminal that floods leaves the others nothing in the pass: its own cap fills the pool', async () => {
      const log = await firstPass(500_000)
      expect(log.length).toBeGreaterThan(0)
      expect(new Set(log.map((w) => w.id))).toEqual(new Set(['a']))
      expect(sched().inflightChars).toBeLessThanOrEqual(D.inflight.focused)
    })

    it("NEGATIVE CONTROL: with the scheduler off the same flood gives b and c their 64 KB each, on top of the active terminal's", async () => {
      window.localStorage.setItem('termpolis.writeScheduler', '0')
      const log = await firstPass(500_000)
      expect(new Set(log.map((w) => w.id))).toEqual(new Set(['a', 'b', 'c']))
    })

    it('a hidden pane gets a hidden pane\'s cap in flight, not a visible pane\'s', async () => {
      await mount([['a', true], ['c', false]])
      await settle(500)
      activeId = 'a'
      await act(async () => { dataCbs[1]('c', 'x'.repeat(500_000)) })
      await settle(20)
      expect(sched().maxInflight.hidden).toBeGreaterThan(0)
      expect(sched().maxInflight.hidden).toBeLessThanOrEqual(D.inflight.hidden)
    })
  })

  // ---------------------------------------------------------------------------------------------
  describe('Clear (RZ-4)', () => {
    it("drops what is still queued for the pane, so the old output is not drawn onto the cleared screen; output after the Clear arrives", async () => {
      await mount([['a', true]])
      await settle(500)
      await act(async () => {
        dataCbs[0]('a', 'y'.repeat(3_000_000) + '\r\nBEFORE-CLEAR\r\n') // far more than one pass hands over
        window.dispatchEvent(new CustomEvent('termpolis:clear-terminal', { detail: 'a' }))
      })
      await settle(2000)
      expect(sched().discardedChars).toBeGreaterThan(0)
      expect(sched().queuedChars).toBe(0)
      expect(bufferLines(term()).join('\n')).not.toContain('BEFORE-CLEAR')
      await act(async () => { dataCbs[0]('a', 'AFTER-CLEAR\r\n') })
      await settle(200)
      expect(bufferLines(term())).toContain('AFTER-CLEAR')
    })

    it('NEGATIVE CONTROL: the same backlog with no Clear is drawn in full', async () => {
      await mount([['a', true]])
      await settle(500)
      await act(async () => { dataCbs[0]('a', 'y'.repeat(3_000_000) + '\r\nBEFORE-CLEAR\r\n') })
      await settle(2000)
      expect(sched().discardedChars).toBe(0)
      expect(bufferLines(term())).toContain('BEFORE-CLEAR')
    })
  })

  describe('typing', () => {
    it("a key typed into a pane is noted by the scheduler; the terminal's own reports are not keys", async () => {
      await mount([['a', true]])
      await settle(500)
      await act(async () => { dataCbs[0]('a', 'prompt$ ') })
      expect(hasSchedulerHook()).toBe(true)
      expect(sched().keys).toBe(0)
      act(() => { term().input('x', true) })
      expect(sched().keys).toBe(1)
      act(() => { term().input('\x1b[I', false) }) // a focus-in report
      act(() => { term().input('\x1b[?1;2c', false) }) // a device attributes reply
      expect(sched().keys).toBe(1)
    })

    it('while a key is going in, a flooded visible pane is handed small slices only, and the typed pane is served at once', async () => {
      await mount([['a', true], ['b', true]])
      await settle(500)
      activeId = 'a'
      const log = recordWrites(['a', 'b'])
      act(() => { term(0).input('k', true) })
      await act(async () => { dataCbs[1]('b', 'x'.repeat(300_000)) })
      await settle(16)
      const forB = log.filter((w) => w.id === 'b')
      expect(forB.length).toBeGreaterThan(0)
      for (const w of forB) expect(w.chars).toBeLessThanOrEqual(D.sliceTyping.visible)
    })

    it('NEGATIVE CONTROL: with nobody typing the same flood is handed in a visible pane\'s full slices', async () => {
      await mount([['a', true], ['b', true]])
      await settle(500)
      activeId = 'a'
      const log = recordWrites(['a', 'b'])
      await act(async () => { dataCbs[1]('b', 'x'.repeat(300_000)) })
      await settle(16)
      expect(Math.max(...log.filter((w) => w.id === 'b').map((w) => w.chars))).toBe(D.slice.visible)
    })
  })

  // ---------------------------------------------------------------------------------------------
  describe('a resize waits for the scheduler: drained(id)', () => {
    const OSC = 9999
    const frame = (id: number): string => `\x1b]${OSC};${id}\x07` + 'x'.repeat(9000) + '\r\n'

    async function scenario(): Promise<{ wrong: number; parsedWhenTold: number | null; told: number; newGrid: [number, number]; oldGrid: [number, number] }> {
      await mount([['a', true]])
      await settle(500)
      const t = term()
      const oldGrid = sizeOf(t)
      const parsedAt = new Map<number, [number, number]>()
      t.parser.registerOscHandler(OSC, (payload) => { parsedAt.set(Number(payload), [t.cols, t.rows]); return true })
      let parsedWhenTold: number | null = null
      mockResizeTerminal.mockClear()
      mockResizeTerminal.mockImplementation(() => { if (parsedWhenTold === null) parsedWhenTold = parsedAt.size })
      await act(async () => { for (let i = 0; i < 30; i++) dataCbs[0]('a', frame(i)) })
      layout.set(containerOf(t), { width: 800, height: 500 })
      fireObservers()
      await settle(95)
      await act(async () => { for (let i = 30; i < 60; i++) dataCbs[0]('a', frame(i)) })
      await settle(3500)
      const told = mockResizeTerminal.mock.calls.length
      const newGrid = sizeOf(t)
      await act(async () => { for (let i = 60; i < 65; i++) dataCbs[0]('a', frame(i)) })
      await settle(500)
      let wrong = 0
      for (let i = 0; i < 65; i++) {
        const want = i < 60 ? oldGrid : newGrid
        const got = parsedAt.get(i)
        if (!got || got[0] !== want[0] || got[1] !== want[1]) wrong++
      }
      return { wrong, parsedWhenTold, told, newGrid, oldGrid }
    }

    it('every frame is parsed at the geometry it was drawn for, and the pty is told once, after the 60 old frames were parsed', async () => {
      const r = await scenario()
      expect(r.newGrid).not.toEqual(r.oldGrid)
      expect(r.told).toBe(1)
      expect(r.parsedWhenTold).toBe(60)
      expect(r.wrong).toBe(0)
    })

    it('NEGATIVE CONTROL: with the resize switch off the same window narrows under the backlog', async () => {
      window.localStorage.setItem('termpolis.resizeOrder', '0')
      const r = await scenario()
      expect(r.wrong).toBeGreaterThan(0)
    })

    it('what the resize waits on is the scheduler: the pane is drained when everything pushed before the request has been handed to xterm', async () => {
      await mount([['a', true]])
      await settle(500)
      await act(async () => { for (let i = 0; i < 150; i++) dataCbs[0]('a', frame(i)) }) // 1.35 MB: at 64 KB a frame, about 340 ms to hand over
      expect(sched().queuedChars).toBeGreaterThan(1_000_000)
      layout.set(containerOf(term()), { width: 800, height: 500 })
      mockResizeTerminal.mockClear()
      fireObservers()
      await settle(110)
      expect(mockResizeTerminal).not.toHaveBeenCalled() // waiting in line behind the output
      await settle(3000)
      expect(mockResizeTerminal).toHaveBeenCalledTimes(1)
      expect(sched().queuedChars).toBe(0)
    })
  })

  // ---------------------------------------------------------------------------------------------
  describe('a live write that xterm refuses', () => {
    const REFUSAL = 'write data discarded, use flow control to avoid losing data'
    const lines = Array.from({ length: 600 }, (_, i) => `L${String(i).padStart(4, '0')} ${'z'.repeat(40)}`)
    const burst = lines.join('\r\n') + '\r\n'

    async function refuseOnce(): Promise<Terminal> {
      await mount([['a', true]])
      await settle(500)
      const t = term()
      const realWrite = t.write.bind(t)
      let refused = 0
      vi.spyOn(t, 'write').mockImplementation(((data: string, cb?: () => void) => {
        if (data.length > 8192 && refused < 1) { refused++; throw new Error(REFUSAL) }
        return realWrite(data, cb)
      }) as typeof t.write)
      return t
    }

    it('the chunk stays queued and is offered again: all 600 lines arrive, once each, in order; the first refusal is reported', async () => {
      const t = await refuseOnce()
      const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
      await act(async () => { dataCbs[0]('a', burst) })
      await settle(3000)
      expect(bufferLines(t).filter((l) => l.startsWith('L'))).toEqual(lines)
      expect(sched().refusals).toBe(1)
      expect(errors).toHaveBeenCalled()
    })
  })

  // ---------------------------------------------------------------------------------------------
  describe('a replay that lands while output is in the scheduler', () => {
    it('output that beat the reply goes straight to xterm and the replay is laid in behind a reset: the screen is the replay, then what the reply did not cover', async () => {
      let reply!: (v: unknown) => void
      mockReadTerminalBuffer.mockReturnValueOnce(new Promise((r) => { reply = r }))
      await mount([['a', true]])
      await settle(300)
      // main tags each chunk with where it ends in the stream: the reply covers the first (offset 29), not the second
      await act(async () => { dataCbs[0]('a', 'early one\r\n', 29) })
      await act(async () => { dataCbs[0]('a', 'early two\r\n', 40) })
      expect(sched().queuedChars).toBe(0) // nothing sits in the scheduler ahead of the replay
      await act(async () => { reply({ success: true, data: { output: 'replayed history\r\nearly one\r\n', cols: 80, rows: 24, nextOffset: 29, missed: 0, length: 29 } }) })
      await settle(500)
      await act(async () => { dataCbs[0]('a', 'live after\r\n') })
      await settle(500)
      const text = bufferLines(term()).filter((l) => l !== '')
      expect(text).toEqual(['replayed history', 'early one', 'early two', 'live after'])
    })
  })
})
