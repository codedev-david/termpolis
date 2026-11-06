import React from 'react'
import { render, act, cleanup } from '@testing-library/react'
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { FitAddon } from '@xterm/addon-fit'
import type { Terminal } from '@xterm/xterm'

// How a pane resizes (1.54.5, plan package P3), against a REAL xterm and a REAL FitAddon.
//
// The four older pane test files replace `@xterm/addon-fit` with `fit = vi.fn()` and the Terminal with a
// fake, so nothing in them ever resizes anything: none of the ordering below could be seen. Here the
// Terminal is the real one (a subclass that only supplies what jsdom has no layout engine for: a cell
// size), the FitAddon is the real one (fed a container size through getComputedStyle), and the output
// throttle is the real one. What each test counts is what reaches xterm and the pty: fits, resizeTerminal
// calls, and for which geometry every frame was parsed.
//
// Each claim is paired with a NEGATIVE CONTROL in this file: the 1.54.4 behaviour is still there behind
// localStorage 'termpolis.resizeOrder' = '0', and the harness has to be able to see it.

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

beforeEach(() => {
  vi.useFakeTimers()
  // Frames as timers, so the real output throttle runs under the fake clock.
  vi.stubGlobal('requestAnimationFrame', (cb: () => void) => setTimeout(() => cb(), 16))
  vi.stubGlobal('cancelAnimationFrame', (id: ReturnType<typeof setTimeout>) => clearTimeout(id))
  h.terms.length = 0
  observers.length = 0
  dataCbs.length = 0
  defaultLayout = { width: 1000, height: 600 }
  mockResizeTerminal.mockReset()
  mockReadTerminalBuffer.mockReset()
  mockReadTerminalBuffer.mockResolvedValue({ success: true, data: { output: '' } })
  window.localStorage.clear()
  window.localStorage.setItem('termpolis.echoTrace', '0') // the echo trace is not what is under test
  mockGetState.mockImplementation(() => ({
    terminals: ['a', 'b', 'c', 'term-1'].map((id) => ({ id, isSwarm: false })),
    activeTerminalId: undefined,
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
})

describe('TerminalPane resize: real xterm, real FitAddon, real output throttle', () => {
  // ---------------------------------------------------------------------------------------------
  it('the harness itself: a real fit changes the real grid, and the pty is told what xterm has', async () => {
    await mount([['a', true]])
    await settle(500)
    const t = term()
    expect(sizeOf(t)).not.toEqual([80, 24]) // fitted to the 1000 x 600 container: a real grid change
    expect(t.cols).toBeGreaterThan(100)
    expectToldTheGrid('a', t)
  })

  it('the e2e size hook reports the grid xterm has, by id and for the active terminal, and null for none', async () => {
    const size = (id?: string): { cols: number; rows: number } | null =>
      (window as unknown as { __termpolis_terminal_size: (id?: string) => { cols: number; rows: number } | null }).__termpolis_terminal_size(id)
    await mount([['a', true], ['b', false]])
    await settle(500)
    expect(size('a')).toEqual({ cols: term(0).cols, rows: term(0).rows })
    expect(size('b')).toEqual({ cols: term(1).cols, rows: term(1).rows }) // fitted once at mount, hidden (RZ-2)
    expect(term(1).cols).toBeGreaterThan(100) // the real container, not the spawn size of 80 x 24
    expect(size('nope')).toBeNull()
    expect(size()).not.toBeNull() // no id: the terminal on screen (jsdom has no visibility API: the first live one)
    act(() => { cleanup() })
    await settle(200) // the panes are gone: nothing is live to answer for
    expect(size('a')).toBeNull()
    expect(size()).toBeNull()
  })

  // ---------------------------------------------------------------------------------------------
  describe('mount: the pty is not moved under an in-flight replay', () => {
    it('does not resize the pty before the replay reply lands, then fits once, after the replay was parsed at the pty size', async () => {
      let reply!: (v: unknown) => void
      mockReadTerminalBuffer.mockReturnValueOnce(new Promise((r) => { reply = r }))
      await mount([['a', true]])
      await settle(1500) // the first frame, the font effect and the visibility effect have all run by now
      // 1.54.4 sent the pty its new size here (font effect at mount, visibility effect), ahead of the reply
      expect(mockResizeTerminal).not.toHaveBeenCalled()

      const t = term()
      const log: string[] = []
      const realResize = t.resize.bind(t)
      vi.spyOn(t, 'resize').mockImplementation((c: number, r: number) => { log.push(`xterm ${c}x${r}`); realResize(c, r) })
      mockResizeTerminal.mockImplementation((_id: string, c: number, r: number) => { log.push(`pty ${c}x${r}`) })
      await act(async () => { reply({ success: true, data: { output: 'old\r\n', cols: 90, rows: 30, nextOffset: 5, missed: 0, length: 5 } }) })
      await settle(300)
      const [cols, rows] = sizeOf(t)
      expect([cols, rows]).not.toEqual([90, 30])
      // the replay was parsed at the pty's size (xterm 90x30), THEN the pane was fitted, THEN the pty was told
      expect(log).toEqual(['xterm 90x30', `xterm ${cols}x${rows}`, `pty ${cols}x${rows}`])
    })

    it('a reply that fails still lets the pane fit: the hold is never left up', async () => {
      mockReadTerminalBuffer.mockRejectedValueOnce(new Error('terminal not found'))
      await mount([['a', true]])
      await settle(300)
      expectToldTheGrid('a', term())
      expect(term().cols).toBeGreaterThan(100)
    })

    it('a reply that never comes cannot hold the fit for ever: the 2 s bound releases it', async () => {
      mockReadTerminalBuffer.mockReturnValueOnce(new Promise(() => undefined))
      await mount([['a', true]])
      await settle(1900)
      expect(mockResizeTerminal).not.toHaveBeenCalled()
      await settle(300)
      expectToldTheGrid('a', term())
    })

    it('NEGATIVE CONTROL: with the resize switch off, the pty is moved at mount, ahead of the reply (1.54.4)', async () => {
      window.localStorage.setItem('termpolis.resizeOrder', '0')
      mockReadTerminalBuffer.mockReturnValueOnce(new Promise(() => undefined))
      await mount([['a', true]])
      await settle(500)
      expect(sentFor('a').length).toBeGreaterThan(0)
    })
  })

  // ---------------------------------------------------------------------------------------------
  describe('only a visible pane fits when the window resizes', () => {
    it('3 mounted panes, 1 visible: all observers fire, one fit and one resizeTerminal, for the visible one', async () => {
      const fit = vi.spyOn(FitAddon.prototype, 'fit')
      await mount([['a', true], ['b', false], ['c', false]])
      await settle(500)
      fit.mockClear()
      mockResizeTerminal.mockClear()
      const hiddenBefore = [sizeOf(term(1)), sizeOf(term(2))]

      defaultLayout = { width: 800, height: 500 }
      fireObservers()
      await settle(300)
      expect(fit).toHaveBeenCalledTimes(1)
      expect(mockResizeTerminal).toHaveBeenCalledTimes(1)
      expect(mockResizeTerminal.mock.calls[0][0]).toBe('a')
      expect([sizeOf(term(1)), sizeOf(term(2))]).toEqual(hiddenBefore) // the hidden panes did not reflow
    })

    it('a pane hidden from mount is told its real size once (RZ-2), then nothing while hidden; shown, it fits to the container it has by then', async () => {
      await mount([['a', true], ['b', false]])
      await settle(500)
      const atMount = sizeOf(term(1))
      expect(sentFor('b')).toEqual([atMount]) // once, after the replay: its agent draws at the real width, not 80 x 24
      expect(atMount[0]).toBeGreaterThan(100)
      defaultLayout = { width: 800, height: 500 }
      fireObservers()
      await settle(300)
      expect(sentFor('b')).toEqual([atMount]) // hidden: no reflow, no pty resize, no conhost repaint, no agent redraw
      expect(sizeOf(term(1))).toEqual(atMount) // and its grid still agrees with its pty
      await remount([['a', true], ['b', true]])
      await settle(50)
      expect(sentFor('b')).toEqual([atMount, sizeOf(term(1))])
      expect(term(1).cols).toBeLessThan(100) // fitted to the 800 px container, not the 1000 px it had at mount
    })

    it('NEGATIVE CONTROL: with all 3 visible every pane fits (the harness counts), and so does every pane with the switch off', async () => {
      const fit = vi.spyOn(FitAddon.prototype, 'fit')
      await mount([['a', true], ['b', true], ['c', true]])
      await settle(500)
      fit.mockClear()
      mockResizeTerminal.mockClear()
      fireObservers()
      await settle(300)
      expect(fit).toHaveBeenCalledTimes(3)
      expect(mockResizeTerminal).toHaveBeenCalledTimes(3)
    })

    it('NEGATIVE CONTROL: with the resize switch off the hidden panes fit too (1.54.4: 3 fits and 3 resizeTerminal for 1 visible pane)', async () => {
      window.localStorage.setItem('termpolis.resizeOrder', '0')
      const fit = vi.spyOn(FitAddon.prototype, 'fit')
      await mount([['a', true], ['b', false], ['c', false]])
      await settle(500)
      fit.mockClear()
      mockResizeTerminal.mockClear()
      fireObservers()
      await settle(300)
      expect(fit).toHaveBeenCalledTimes(3)
      expect(mockResizeTerminal).toHaveBeenCalledTimes(3)
    })
  })

  // ---------------------------------------------------------------------------------------------
  describe('a collapsed container never reaches the pty', () => {
    it('FitAddon proposes 2 x 1 for a 0 x 0 container: nothing is resized, nothing is sent, the last good size stays', async () => {
      await mount([['a', true]])
      await settle(500)
      const t = term()
      const good = sizeOf(t)
      mockResizeTerminal.mockClear()
      layout.set(containerOf(t), { width: 0, height: 0 })
      fireObservers()
      await settle(300)
      expect(mockResizeTerminal).not.toHaveBeenCalled()
      expect(sizeOf(t)).toEqual(good)
    })

    it('NEGATIVE CONTROL: the same container, sized, is fitted and sent', async () => {
      await mount([['a', true]])
      await settle(500)
      const t = term()
      mockResizeTerminal.mockClear()
      layout.set(containerOf(t), { width: 600, height: 400 })
      fireObservers()
      await settle(300)
      expect(sentFor('a')).toEqual([sizeOf(t)])
      expect(t.cols).toBeLessThan(100)
    })

    it('NEGATIVE CONTROL: with the switch off the 2 x 1 is applied and sent, as in 1.54.4', async () => {
      window.localStorage.setItem('termpolis.resizeOrder', '0')
      await mount([['a', true]])
      await settle(500)
      const t = term()
      mockResizeTerminal.mockClear()
      layout.set(containerOf(t), { width: 0, height: 0 })
      fireObservers()
      await settle(300)
      expect(sizeOf(t)).toEqual([2, 1])
      expect(sentFor('a')).toEqual([[2, 1]])
    })
  })

  // ---------------------------------------------------------------------------------------------
  describe('fit() that throws', () => {
    it('the pty is still told the size xterm has, and the failure is reported, not thrown', async () => {
      await mount([['a', true]])
      await settle(500)
      const t = term()
      const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
      vi.spyOn(FitAddon.prototype, 'fit').mockImplementationOnce(() => { throw new Error('webgl context lost mid-fit') })
      mockResizeTerminal.mockClear()
      layout.set(containerOf(t), { width: 700, height: 450 })
      fireObservers()
      await settle(300)
      expect(sentFor('a')).toEqual([sizeOf(t)])
      expect(errors).toHaveBeenCalledWith('[pane fit]', expect.objectContaining({ message: 'webgl context lost mid-fit' }))
    })
  })

  // ---------------------------------------------------------------------------------------------
  describe('a selection defers the fit, for a second at most', () => {
    it('fits once, a second after the first request, with the selection still active', async () => {
      await mount([['a', true]])
      await settle(500)
      const t = term()
      t.select(0, 0, 5)
      expect(t.hasSelection()).toBe(true)
      mockResizeTerminal.mockClear()
      layout.set(containerOf(t), { width: 700, height: 450 })
      fireObservers()
      await settle(100) // the observer's debounce: the request is made now
      await settle(800) // 0.9 s in: still waiting
      expect(mockResizeTerminal).not.toHaveBeenCalled()
      await settle(400)
      expect(sentFor('a')).toEqual([sizeOf(t)])
      await settle(5000)
      expect(mockResizeTerminal).toHaveBeenCalledTimes(1)
    })

    it('NEGATIVE CONTROL: with the resize switch off a selection defers the fit for as long as it lasts (1.54.4 has no cap)', async () => {
      window.localStorage.setItem('termpolis.resizeOrder', '0')
      await mount([['a', true]])
      await settle(500)
      const t = term()
      t.select(0, 0, 5)
      mockResizeTerminal.mockClear()
      layout.set(containerOf(t), { width: 700, height: 450 })
      fireObservers()
      await settle(6000) // six times the new cap, and still waiting
      expect(mockResizeTerminal).not.toHaveBeenCalled()
      t.clearSelection()
      await settle(200)
      expect(sentFor('a')).toEqual([sizeOf(t)])
    })

    it('NEGATIVE CONTROL: a selection that ends sooner lets the fit through at the next retry', async () => {
      await mount([['a', true]])
      await settle(500)
      const t = term()
      t.select(0, 0, 5)
      mockResizeTerminal.mockClear()
      layout.set(containerOf(t), { width: 700, height: 450 })
      fireObservers()
      await settle(400)
      expect(mockResizeTerminal).not.toHaveBeenCalled()
      t.clearSelection()
      await settle(200)
      expect(sentFor('a')).toEqual([sizeOf(t)])
    })
  })

  // ---------------------------------------------------------------------------------------------
  describe('a same-size resize is still sent (conhost repaints the viewport on every resize)', () => {
    it('the container did not change: fit() changes nothing, and the pty is told anyway', async () => {
      const fit = vi.spyOn(FitAddon.prototype, 'fit')
      await mount([['a', true]])
      await settle(500)
      const t = term()
      const before = sizeOf(t)
      fit.mockClear()
      mockResizeTerminal.mockClear()
      fireObservers()
      await settle(300)
      expect(fit).toHaveBeenCalledTimes(1)
      expect(sizeOf(t)).toEqual(before)
      expect(sentFor('a')).toEqual([before])
    })
  })

  // ---------------------------------------------------------------------------------------------
  describe('in stream order, through the real throttle and the real parser', () => {
    const OSC = 9999
    const frame = (id: number): string => `\x1b]${OSC};${id}\x07` + 'x'.repeat(9000) + '\r\n' // over the 8 KB bypass: it queues

    /** 60 frames the child drew for the old size are queued when the window is narrowed; 5 more follow once the pty has been told. */
    async function scenario(): Promise<{ wrong: number; oldFrames: number; parsedWhenTold: number | null; told: number; newGrid: [number, number]; oldGrid: [number, number] }> {
      await mount([['a', true]])
      await settle(500)
      const t = term()
      const oldGrid = sizeOf(t)
      const parsedAt = new Map<number, [number, number]>()
      t.parser.registerOscHandler(OSC, (payload) => { parsedAt.set(Number(payload), [t.cols, t.rows]); return true })
      let parsedWhenTold: number | null = null
      mockResizeTerminal.mockClear()
      mockResizeTerminal.mockImplementation(() => { if (parsedWhenTold === null) parsedWhenTold = parsedAt.size })

      await act(async () => { for (let i = 0; i < 30; i++) dataCbs[0]('a', frame(i)) }) // 270 KB in the throttle
      layout.set(containerOf(t), { width: 800, height: 500 })
      fireObservers() // the request is made 100 ms from now
      await settle(95)
      await act(async () => { for (let i = 30; i < 60; i++) dataCbs[0]('a', frame(i)) }) // more, still drawn for the old size
      await settle(3500) // the request, the drain, the resize
      const told = mockResizeTerminal.mock.calls.length
      const newGrid = sizeOf(t)
      await act(async () => { for (let i = 60; i < 65; i++) dataCbs[0]('a', frame(i)) }) // what the pty draws for the new size
      await settle(500)

      let wrong = 0
      for (let i = 0; i < 65; i++) {
        const want = i < 60 ? oldGrid : newGrid
        const got = parsedAt.get(i)
        if (!got || got[0] !== want[0] || got[1] !== want[1]) wrong++
      }
      return { wrong, oldFrames: 60, parsedWhenTold, told, newGrid, oldGrid }
    }

    it('every frame is parsed at the geometry it was drawn for: 0 of 65 wrong, and the pty is told only after the 60 old frames were parsed', async () => {
      const r = await scenario()
      expect(r.newGrid).not.toEqual(r.oldGrid) // the window really was narrowed
      expect(r.told).toBe(1)
      expect(r.parsedWhenTold).toBe(r.oldFrames)
      expect(r.wrong).toBe(0)
    })

    it('NEGATIVE CONTROL: with the resize switch off the same window narrows under the backlog and frames are parsed at the wrong size (key s8)', async () => {
      window.localStorage.setItem('termpolis.resizeOrder', '0')
      const r = await scenario()
      expect(r.newGrid).not.toEqual(r.oldGrid)
      expect(r.wrong).toBeGreaterThan(0)
      expect(r.parsedWhenTold).toBeLessThan(r.oldFrames) // the pty was told while old frames were still queued
    })

    it('unmounting while the resize waits in line sends nothing to a pty that is going away', async () => {
      await mount([['a', true]])
      await settle(500)
      mockResizeTerminal.mockClear()
      // 150 frames is 1.35 MB: at 64 KB a frame the throttle needs about 340 ms, so the request, made
      // 100 ms from now, finds most of it still queued and has to wait.
      await act(async () => { for (let i = 0; i < 150; i++) dataCbs[0]('a', frame(i)) })
      layout.set(containerOf(term()), { width: 800, height: 500 })
      fireObservers()
      await settle(110) // the request is made and is waiting
      expect(mockResizeTerminal).not.toHaveBeenCalled()
      act(() => { cleanup() })
      await settle(5000)
      expect(mockResizeTerminal).not.toHaveBeenCalled()
    })
  })

  // ---------------------------------------------------------------------------------------------
  describe('a live write that xterm refuses (key s4: a throw after the buffer was emptied lost 40,000 of 40,000 chars)', () => {
    const REFUSAL = 'write data discarded, use flow control to avoid losing data'
    /** 600 labelled lines, about 28 KB: over the throttle's 8 KB bypass, so it queues and is flushed by a frame. */
    const lines = Array.from({ length: 600 }, (_, i) => `L${String(i).padStart(4, '0')} ${'z'.repeat(40)}`)
    const burst = lines.join('\r\n') + '\r\n'

    const bufferLines = (t: Terminal): string[] => {
      const b = t.buffer.active
      const out: string[] = []
      for (let y = 0; y < b.length; y++) out.push(b.getLine(y)?.translateToString(true) ?? '')
      return out
    }

    async function refuseOnce(): Promise<{ t: Terminal; refused: () => number }> {
      await mount([['a', true]])
      await settle(500)
      const t = term()
      const realWrite = t.write.bind(t)
      let refused = 0
      vi.spyOn(t, 'write').mockImplementation(((data: string, cb?: () => void) => {
        if (data.length > 8192 && refused < 1) { refused++; throw new Error(REFUSAL) }
        return realWrite(data, cb)
      }) as typeof t.write)
      return { t, refused: () => refused }
    }

    it('the chunk stays queued and is offered again: all 600 lines arrive, once each, in order', async () => {
      const { t, refused } = await refuseOnce()
      const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
      await act(async () => { dataCbs[0]('a', burst) })
      await settle(3000)
      expect(refused()).toBe(1)
      const seen = bufferLines(t).filter((l) => /^L\d{4} z{40}$/.test(l))
      expect(seen).toEqual(lines) // none lost, none repeated, in order
      expect(errors).toHaveBeenCalledTimes(1) // the refusal was reported once, not swallowed and not once per retry
      expect(errors.mock.calls[0][0]).toBe('[output throttle]')
    })

    it('NEGATIVE CONTROL: with the output switch off the same refusal loses the whole chunk and throws out of the timer (1.54.4)', async () => {
      window.localStorage.setItem('termpolis.outputChunks', '0')
      const { t, refused } = await refuseOnce()
      await act(async () => { dataCbs[0]('a', burst) })
      await expect(settle(3000)).rejects.toThrow(REFUSAL)
      await settle(3000) // nothing offers it again
      expect(refused()).toBe(1)
      expect(bufferLines(t).filter((l) => /^L\d{4} z{40}$/.test(l))).toEqual([]) // all 600 lines are gone
    })
  })

  // ---------------------------------------------------------------------------------------------
  it('a font change refits the visible pane and tells the pty, once', async () => {
    await mount([['a', true]])
    await settle(500)
    const t = term()
    const before = sizeOf(t)
    mockResizeTerminal.mockClear()
    await remount([['a', true]], 18)
    await settle(300)
    expect(sentFor('a')).toEqual([sizeOf(t)])
    expect(sizeOf(t)).toEqual(before) // the stubbed cell size does not follow the font: same grid, same-size resize, still sent
  })
})
