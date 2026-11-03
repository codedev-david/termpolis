import React from 'react'
import { render, act, cleanup } from '@testing-library/react'
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import type { Terminal } from '@xterm/xterm'

// What a pane does with its terminal's output when it is NOT the one on screen, how it hears that output, and how much
// work a chunk costs (1.54.5, plan package P9), against a REAL xterm, the REAL preload router (over a fake ipc), the
// REAL write scheduler and the REAL WebGL budget.
//
// Counters, not wall-clock: ipcRenderer.on registrations alive, listener runs and pane callbacks per message, the
// order of the subscribe announcement and the replay request, side-effect passes per second per terminal, what the
// hidden pane's xterm still parsed, how often the WebGL budget acquired and released a context.
//
// Every claim has a NEGATIVE CONTROL in this file: a kill switch (hiddenPanes, dataRouting, paneEffects) gives the
// 1.54.4 behaviour back, and the same scenario shows what the change is.

// ---- shared state for the mock factories -------------------------------------------------------
const h = vi.hoisted(() => ({
  terms: [] as Array<Terminal>, // every real Terminal a pane created, in creation order
  cell: { width: 9, height: 17 },
  detect: null as null | ((...a: unknown[]) => void), // processAgentDetection, shared by every pane
  webgl: { enabled: false, created: 0, disposed: 0 },
  log: [] as string[], // the order of announcements and replay requests
}))

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

// A GPU renderer the budget can hand out and take back, counted.
vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: function (this: Record<string, unknown>) {
    h.webgl.created++
    this.activate = vi.fn()
    this.dispose = vi.fn(() => { h.webgl.disposed++ })
    this.onContextLoss = vi.fn()
  },
}))
vi.mock('../../src/renderer/src/lib/webglSupport', () => ({ hasHardwareWebgl: () => h.webgl.enabled }))
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
// ONE shared processAgentDetection: the counter of side-effect passes (every call is one pass, or one chunk with the switch off).
vi.mock('../../src/renderer/src/hooks/useAgentDetection', () => ({
  useAgentDetection: vi.fn(() => ({
    detectedAgent: null,
    processAgentDetection: (...a: unknown[]) => h.detect?.(...a),
    agentDetectedRef: { current: false },
  })),
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

// ---- window.termpolis: the REAL preload router over a fake ipc ------------------------------------------
import { createTerminalDataRouter, type RouterIpc } from '../../src/preload/terminalDataRouter'

interface FakeIpc extends RouterIpc {
  alive: (channel: string) => number
  emit: (channel: string, ...args: unknown[]) => number
  sent: Array<{ channel: string; args: unknown[] }>
}
function fakeIpc(): FakeIpc {
  const listeners = new Map<string, Array<(e: unknown, ...a: unknown[]) => void>>()
  const sent: FakeIpc['sent'] = []
  return {
    sent,
    on(channel, listener) {
      const list = listeners.get(channel) ?? []
      list.push(listener as (e: unknown, ...a: unknown[]) => void)
      listeners.set(channel, list)
    },
    removeListener(channel, listener) {
      const list = listeners.get(channel) ?? []
      const i = list.indexOf(listener as (e: unknown, ...a: unknown[]) => void)
      if (i >= 0) list.splice(i, 1)
    },
    send(channel, ...args) {
      sent.push({ channel, args })
      const m = args[0] as { id?: string } | undefined
      h.log.push(`${channel}:${m?.id ?? 'all'}`)
    },
    alive: (channel) => (listeners.get(channel) ?? []).length,
    emit(channel, ...args) {
      const list = (listeners.get(channel) ?? []).slice()
      for (const l of list) l({}, ...args)
      return list.length
    },
  }
}

let ipc: FakeIpc
let router: ReturnType<typeof createTerminalDataRouter>
/** Pane callbacks run (what the base counted as handler runs: every pane's filter), per message. */
let paneRuns = 0

const mockResizeTerminal = vi.fn()
const mockReadTerminalBuffer = vi.fn()
const observers: Array<{ cb: () => void; el: Element }> = []

/** What getComputedStyle reports for each pane's container (FitAddon reads width and height from it). */
const layout = new WeakMap<Element, { width: number; height: number }>()
let defaultLayout = { width: 1000, height: 600 }
const realGetComputedStyle = window.getComputedStyle.bind(window)
const realMatchMedia = (window as { matchMedia?: unknown }).matchMedia

beforeAll(() => {
  ;(window as unknown as { termpolis: unknown }).termpolis = {
    writeToTerminal: vi.fn(),
    readTerminalBuffer: (...a: unknown[]) => { h.log.push(`replay:${String(a[0])}`); return mockReadTerminalBuffer(...a) },
    onTerminalData: (cb: (id: string, data: string, end?: number) => void) => router.onAll((id, data, end) => { paneRuns++; cb(id, data, end) }),
    onTerminalDataFor: (id: string, cb: (id: string, data: string, end?: number) => void) => router.onFor(id, (tid, data, end) => { paneRuns++; cb(tid, data, end) }),
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
import { resetWriteScheduler } from '../../src/renderer/src/lib/writeScheduler'
import { resetWebglBudget } from '../../src/renderer/src/lib/webglBudget'
import { SWITCH_HIDDEN_PANES, SWITCH_DATA_ROUTING, SWITCH_PANE_EFFECTS } from '../../src/renderer/src/lib/paneSwitches'

const BASE = { terminalName: 'Terminal', shellType: 'bash' as const, cwd: '/home/user', fontSize: 14, theme: 'dark', fontFamily: 'monospace' }
const paneEl = (id: string, visible: boolean): React.ReactElement => (
  <TerminalPane key={id} {...BASE} terminalId={id} isVisible={visible} />
)

let view: ReturnType<typeof render> | null = null
const mount = async (panes: Array<[string, boolean]>): Promise<void> => {
  await act(async () => { view = render(<>{panes.map(([id, visible]) => paneEl(id, visible))}</>) })
}
const show = async (panes: Array<[string, boolean]>): Promise<void> => {
  await act(async () => { view!.rerender(<>{panes.map(([id, visible]) => paneEl(id, visible))}</>) })
}
const settle = async (ms: number): Promise<void> => {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
}
const term = (i = 0): Terminal => h.terms[i]
/** The pane's root element: the one `paneRootStyle` styles. */
const rootOf = (t: Terminal): HTMLElement => t.element!.parentElement!.parentElement as HTMLElement
const bufferLines = (t: Terminal): string[] => {
  const b = t.buffer.active
  const out: string[] = []
  for (let y = 0; y < b.length; y++) out.push(b.getLine(y)?.translateToString(true) ?? '')
  return out
}

let activeId: string | undefined
let detectCalls: unknown[][] = []

beforeEach(() => {
  vi.useFakeTimers()
  // Frames as timers, so the real scheduler runs under the fake clock (performance.now is faked as well).
  vi.stubGlobal('requestAnimationFrame', (cb: () => void) => setTimeout(() => cb(), 16))
  vi.stubGlobal('cancelAnimationFrame', (id: ReturnType<typeof setTimeout>) => clearTimeout(id))
  resetWriteScheduler()
  resetWebglBudget()
  ipc = fakeIpc()
  router = createTerminalDataRouter(ipc, 1)
  paneRuns = 0
  detectCalls = []
  h.detect = (...a) => { detectCalls.push(a) }
  h.terms.length = 0
  h.log.length = 0
  h.webgl.enabled = false
  h.webgl.created = 0
  h.webgl.disposed = 0
  observers.length = 0
  activeId = undefined
  defaultLayout = { width: 1000, height: 600 }
  mockResizeTerminal.mockReset()
  mockReadTerminalBuffer.mockReset()
  mockReadTerminalBuffer.mockResolvedValue({ success: true, data: { output: '' } })
  window.localStorage.clear()
  window.localStorage.setItem('termpolis.echoTrace', '0') // the echo trace is not what is under test
  mockGetState.mockImplementation(() => ({
    terminals: Array.from({ length: 12 }, (_, i) => ({ id: `t${i}`, isSwarm: false })),
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
  resetWriteScheduler()
  resetWebglBudget()
  h.detect = null
})

/** One pane's side-effect counters, as an e2e spec reads them. */
const paneStats = (id: string): Record<string, number> =>
  (window as unknown as { __termpolis_pane_effects: () => Record<string, Record<string, number>> }).__termpolis_pane_effects()[id]

const ids = (n: number): string[] => Array.from({ length: n }, (_, i) => `t${i}`)
/** n panes, the first one on screen. */
const tabs = (n: number, on = 0): Array<[string, boolean]> => ids(n).map((id, i) => [id, i === on])

describe('TerminalPane: the style of an inactive pane', () => {
  it('a hidden pane skips its rendering and keeps its box; the pane on screen is plain visible', async () => {
    await mount(tabs(3))
    const [a, b] = [rootOf(term(0)), rootOf(term(1))]
    expect(a.style.visibility).toBe('visible')
    expect((a.style as unknown as { contentVisibility?: string }).contentVisibility ?? '').toBe('')
    expect(b.style.visibility).toBe('hidden')
    expect((b.style as unknown as { contentVisibility?: string }).contentVisibility).toBe('hidden')
    // The box is kept: nothing that takes the pane out of layout.
    for (const el of [a, b]) {
      expect(el.style.display).toBe('')
      expect(el.style.position).toBe('')
      expect(el.className).toContain('absolute inset-0')
    }
  })

  it('it follows the pane: shown, the style is plain visible; hidden again, it skips rendering again', async () => {
    await mount(tabs(2, 0))
    await show(tabs(2, 1))
    expect(rootOf(term(1)).style.visibility).toBe('visible')
    expect((rootOf(term(1)).style as unknown as { contentVisibility?: string }).contentVisibility ?? '').toBe('')
    expect((rootOf(term(0)).style as unknown as { contentVisibility?: string }).contentVisibility).toBe('hidden')
  })

  it("NEGATIVE CONTROL: with 'termpolis.hiddenPanes' = '0' an inactive pane has visibility: hidden only, as in 1.54.4", async () => {
    window.localStorage.setItem(SWITCH_HIDDEN_PANES, '0')
    await mount(tabs(2))
    const b = rootOf(term(1))
    expect(b.style.visibility).toBe('hidden')
    expect((b.style as unknown as { contentVisibility?: string }).contentVisibility ?? '').toBe('')
  })
})

describe('TerminalPane: how a pane hears its terminal', () => {
  it('10 panes: ONE ipcRenderer listener, and 1 message = 1 pane callback, 1 xterm write', async () => {
    await mount(tabs(10))
    await settle(500)
    expect(ipc.alive('terminal:data')).toBe(1)
    const writes = h.terms.map((t) => vi.spyOn(t, 'write'))
    paneRuns = 0
    await act(async () => { ipc.emit('terminal:data', 't3', 'hello t3\r\n', 10) })
    await settle(100)
    expect(paneRuns).toBe(1)
    expect(writes.map((w) => w.mock.calls.length)).toEqual([0, 0, 0, 1, 0, 0, 0, 0, 0, 0])
    expect(bufferLines(term(3))).toContain('hello t3')
  })

  it("NEGATIVE CONTROL: with 'termpolis.dataRouting' = '0' the same 10 panes keep ten listeners, and 1 message is 10 pane callbacks (9 of them for nothing)", async () => {
    window.localStorage.setItem(SWITCH_DATA_ROUTING, '0')
    await mount(tabs(10))
    await settle(500)
    expect(ipc.alive('terminal:data')).toBe(10)
    paneRuns = 0
    await act(async () => { ipc.emit('terminal:data', 't3', 'hello t3\r\n', 10) })
    await settle(100)
    expect(paneRuns).toBe(10)
    expect(bufferLines(term(3))).toContain('hello t3') // still delivered to its own pane only
    expect(bufferLines(term(4))).not.toContain('hello t3')
  })

  it('every pane announces its terminal BEFORE it asks for its replay (so output in between is in the replay or live, never in neither)', async () => {
    await mount(tabs(4))
    for (const id of ids(4)) {
      const sub = h.log.indexOf(`terminal:subscribe:${id}`)
      const replay = h.log.indexOf(`replay:${id}`)
      expect(sub, `subscribe of ${id}`).toBeGreaterThanOrEqual(0)
      expect(replay, `replay of ${id}`).toBeGreaterThanOrEqual(0)
      expect(sub).toBeLessThan(replay)
    }
    // The check itself sees a wrong order: a log with the replay first fails it.
    const wrong = ['replay:x', 'terminal:subscribe:x']
    expect(wrong.indexOf('terminal:subscribe:x') < wrong.indexOf('replay:x')).toBe(false)
  })

  it('an unmounted pane is unsubscribed, and the shared listener goes with the last pane', async () => {
    await mount(tabs(2))
    expect(ipc.alive('terminal:data')).toBe(1)
    act(() => { view!.rerender(<>{[paneEl('t0', true)]}</>) })
    await settle(200)
    expect(ipc.sent.some((s) => s.channel === 'terminal:unsubscribe' && (s.args[0] as { id: string }).id === 't1')).toBe(true)
    expect(ipc.alive('terminal:data')).toBe(1)
    act(() => { cleanup() })
    await settle(200)
    expect(ipc.alive('terminal:data')).toBe(0)
    expect(router.stats()).toMatchObject({ ids: 0, panes: 0 })
  })

  it('output that arrives while the replay is still on its way is kept once: the chunk in the reply is not drawn twice', async () => {
    let reply: (v: unknown) => void = () => undefined
    mockReadTerminalBuffer.mockReturnValue(new Promise((r) => { reply = r }))
    await mount(tabs(1))
    await settle(100)
    // 'AAA' (offsets 0..3) is in the reply AND arrives live first; 'BBB' (3..6) is live only.
    await act(async () => { ipc.emit('terminal:data', 't0', 'AAA', 3); ipc.emit('terminal:data', 't0', 'BBB', 6) })
    await act(async () => { reply({ success: true, data: { output: 'AAA', nextOffset: 3 } }) })
    await settle(200)
    const text = bufferLines(term(0)).join('')
    expect(text).toContain('AAABBB')
    expect(text.match(/AAA/g)).toHaveLength(1)
  })
})

describe('TerminalPane: side-effect passes per second', () => {
  /** Offer `perSecond` messages a second to terminal `id` for `seconds`. */
  const offer = async (id: string, perSecond: number, seconds: number): Promise<number> => {
    const step = 1000 / perSecond
    let sent = 0
    for (let i = 0; i < Math.round(perSecond * seconds); i++) {
      await act(async () => { ipc.emit('terminal:data', id, `chunk ${i}\r\n`, (i + 1) * 10); await vi.advanceTimersByTimeAsync(step) })
      sent++
    }
    return sent
  }

  it('125 messages a second to the pane on screen: at most 4 passes a second (the base: a pass per message)', async () => {
    await mount(tabs(2, 0))
    await settle(500)
    detectCalls = []
    const seconds = 6
    const offered = await offer('t0', 125, seconds)
    expect(offered).toBe(750)
    expect(detectCalls.length).toBeLessThanOrEqual(4 * seconds + 1)
    expect(detectCalls.length).toBeGreaterThanOrEqual(4 * seconds - 2)
    // Each pass says how many chunks it stands for, and together they are every chunk offered (a trailing pass may wait).
    await settle(300)
    const stood = detectCalls.reduce((n, c) => n + (c[4] as number), 0)
    expect(stood).toBe(offered)
  })

  it("NEGATIVE CONTROL: with 'termpolis.paneEffects' = '0' it is a pass per message, as in 1.54.4", async () => {
    window.localStorage.setItem(SWITCH_PANE_EFFECTS, '0')
    await mount(tabs(2, 0))
    await settle(500)
    detectCalls = []
    const offered = await offer('t0', 125, 2)
    expect(offered).toBe(250)
    expect(detectCalls).toHaveLength(250)
    expect(detectCalls.every((c) => c[4] === 1)).toBe(true)
  })

  it('a pane that is not on screen still runs them, slowly (1 a second): a background agent\'s compaction and reflection are still seen', async () => {
    await mount(tabs(2, 0))
    await settle(500)
    detectCalls = []
    const seconds = 6
    await offer('t1', 125, seconds)
    expect(detectCalls.length).toBeGreaterThanOrEqual(seconds - 1)
    expect(detectCalls.length).toBeLessThanOrEqual(seconds + 1)
  })

  /** Type a command and press Enter, so the pane has a last command (the fix suggestions need one). */
  const runCommand = async (i: number, cmd: string): Promise<void> => {
    await act(async () => { term(i).input(cmd, true) })
    await act(async () => { term(i).input('\r', true) })
    await settle(10)
  }
  /** A burst of three chunks inside one pass window: the first runs at once, the other two are one pass of their own. */
  const burst = async (id: string, a: string, b: string): Promise<void> => {
    await act(async () => { ipc.emit('terminal:data', id, 'lead\r\n', 6) })
    await act(async () => { ipc.emit('terminal:data', id, a, 6 + a.length) })
    await act(async () => { ipc.emit('terminal:data', id, b, 6 + a.length + b.length) })
    await settle(400)
  }

  it("a pass over more than the 4 KB window reads what arrived (up to 16 KB): a marker in the first half of a burst is not scrolled out of sight", async () => {
    await mount(tabs(1, 0))
    await settle(500)
    detectCalls = []
    await burst('t0', 'A'.repeat(10_000) + 'MARKER', 'B'.repeat(8_000))
    const passes = detectCalls.map((c) => String(c[0]))
    expect(passes).toHaveLength(2) // the lead chunk, then ONE pass for the two chunks of the burst
    expect(passes[1]).toContain('MARKER') // 8,006 chars from the end: inside the 16 KB a pass reads, outside the 4 KB window
    expect(passes[1].length).toBeLessThanOrEqual(16_384)
    expect(detectCalls[1][4]).toBe(2) // two chunks, one pass
  })

  it('NEGATIVE CONTROL: per chunk (the kill switch) the window is all there is: the marker is seen only while it is still in the last 4 KB', async () => {
    window.localStorage.setItem(SWITCH_PANE_EFFECTS, '0')
    await mount(tabs(1, 0))
    await settle(500)
    detectCalls = []
    await burst('t0', 'A'.repeat(10_000) + 'MARKER', 'B'.repeat(8_000))
    const seen = detectCalls.map((c) => String(c[0]))
    expect(seen).toHaveLength(3) // a pass per chunk
    expect(seen[1]).toContain('MARKER') // right after its own chunk the marker is at the end of the window
    expect(seen[2]).not.toContain('MARKER') // 8,000 B's later it has scrolled out of the 4 KB window
    expect(seen[2].length).toBeLessThanOrEqual(4096)
  })

  it('an error pattern anywhere in a pass makes ONE suggestion lookup (the base: one per chunk that carried it), a pass bigger than 16 KB looks at its tail', async () => {
    const { getSuggestion } = await import('../../src/renderer/src/corrections/correctionEngine')
    const lookups = vi.mocked(getSuggestion)
    await mount(tabs(1, 0))
    await settle(500)
    await runCommand(0, 'frobnicate')
    lookups.mockClear()
    await burst('t0', 'zsh: command not found: one\r\n' + 'x'.repeat(3_000), 'zsh: command not found: two\r\n' + 'y'.repeat(3_000))
    expect(lookups).toHaveBeenCalledTimes(1) // two chunks carried it, one pass looked once
    expect(lookups.mock.calls[0][0]).toBe('frobnicate')
    // Too far back (more than 16 KB from the end of the pass) is not looked at: the pass scans its tail, like the window did.
    lookups.mockClear()
    await burst('t0', 'command not found: old\r\n' + 'x'.repeat(20_000), 'y'.repeat(100))
    expect(lookups).toHaveBeenCalledTimes(0)
  })

  it('NEGATIVE CONTROL: per chunk (the kill switch) the same burst makes a lookup for EACH chunk that carried the pattern', async () => {
    window.localStorage.setItem(SWITCH_PANE_EFFECTS, '0')
    const { getSuggestion } = await import('../../src/renderer/src/corrections/correctionEngine')
    const lookups = vi.mocked(getSuggestion)
    await mount(tabs(1, 0))
    await settle(500)
    await runCommand(0, 'frobnicate')
    lookups.mockClear()
    await burst('t0', 'zsh: command not found: one\r\n' + 'x'.repeat(3_000), 'zsh: command not found: two\r\n' + 'y'.repeat(3_000))
    expect(lookups).toHaveBeenCalledTimes(2)
  })

  it('an OSC 633 failure marker anywhere in a pass starts a lookup for the last command; an exit 0 marker, or no last command, does not', async () => {
    const { getSuggestion } = await import('../../src/renderer/src/corrections/correctionEngine')
    const lookups = vi.mocked(getSuggestion)
    await mount(tabs(1, 0))
    await settle(500)
    // No command was typed yet: a failure marker has nothing to look up.
    lookups.mockClear()
    await burst('t0', '\x1b]633;E;1\x07', 'more')
    expect(lookups).toHaveBeenCalledTimes(0)
    await runCommand(0, 'badcmd')
    // A success marker first, a failure after it, in two different chunks of one pass: the failure counts.
    lookups.mockClear()
    await burst('t0', '\x1b]633;E;0\x07', '\x1b]633;E;2\x07')
    expect(lookups).toHaveBeenCalledTimes(1)
    expect(lookups.mock.calls[0][0]).toBe('badcmd')
    // Only successes: nothing to fix.
    lookups.mockClear()
    await burst('t0', '\x1b]633;E;0\x07', '\x1b]633;E;0\x07')
    expect(lookups).toHaveBeenCalledTimes(0)
  })

  it('Enter after output still in the pass window: the pass runs BEFORE the window is cleared, so the Enter reset is not undone by stale output', async () => {
    await mount(tabs(1, 0))
    await settle(500)
    detectCalls = []
    // `git diff` output lands, then the user presses Enter inside the 250 ms window (an empty Enter right after the output).
    await act(async () => { ipc.emit('terminal:data', 't0', 'diff --git a/x b/x\r\n', 20) })
    await act(async () => { ipc.emit('terminal:data', 't0', '+one line\r\n', 31) })
    expect(detectCalls).toHaveLength(1) // the first chunk ran at once (leading edge); the second is pending
    // Enter, as the keyboard sends it.
    await act(async () => { term(0).input('\r', true) })
    expect(detectCalls).toHaveLength(2) // the pending pass ran first ...
    expect(String(detectCalls[1][0])).toContain('+one line') // ... over what was pending
    await settle(2000)
    expect(detectCalls).toHaveLength(2) // ... and nothing stale is left to run after the reset
  })

  it('Clear terminal drops the output still waiting for its pass, with the screen: nothing stale runs afterwards', async () => {
    await mount(tabs(1, 0))
    await settle(500)
    detectCalls = []
    await act(async () => { ipc.emit('terminal:data', 't0', 'lead\r\n', 6) })
    await act(async () => { ipc.emit('terminal:data', 't0', 'diff --git a/x b/x\r\n', 25) })
    expect(detectCalls).toHaveLength(1) // the second chunk waits for its pass
    await act(async () => { window.dispatchEvent(new CustomEvent('termpolis:clear-terminal', { detail: 't0' })) })
    await settle(2000)
    expect(detectCalls).toHaveLength(1) // it went away with the screen: no pass over it afterwards
    expect(paneStats('t0')).toMatchObject({ pendingChars: 0, pendingMessages: 0 })
  })

  it("NEGATIVE CONTROL: with the pass kill switch every chunk ran at its own arrival, so nothing is pending at Enter", async () => {
    window.localStorage.setItem(SWITCH_PANE_EFFECTS, '0')
    await mount(tabs(1, 0))
    await settle(500)
    detectCalls = []
    await act(async () => { ipc.emit('terminal:data', 't0', 'diff --git a/x b/x\r\n', 20) })
    await act(async () => { ipc.emit('terminal:data', 't0', '+one line\r\n', 31) })
    expect(detectCalls).toHaveLength(2)
    await act(async () => { term(0).input('\r', true) })
    await settle(2000)
    expect(detectCalls).toHaveLength(2) // Enter adds no pass: there was nothing pending
  })

  it('shown again, the pending pass runs at once: the pane is current the moment it is looked at', async () => {
    await mount(tabs(2, 0))
    await settle(500)
    await offer('t1', 125, 1) // hidden: its pass window is a second
    await act(async () => { ipc.emit('terminal:data', 't1', 'last bit\r\n', 99999) })
    const before = detectCalls.length
    await show(tabs(2, 1))
    expect(detectCalls.length).toBeGreaterThan(before) // the pass ran in the very commit that showed the pane
    await settle(300)
    expect(bufferLines(term(1)).join('\n')).toContain('last bit')
  })

  it('every mounted pane\'s counters are readable as window.__termpolis_pane_effects(), by terminal id, and leave with the pane', async () => {
    const hook = (): Record<string, { messages: number; passes: number }> =>
      (window as unknown as { __termpolis_pane_effects: () => Record<string, { messages: number; passes: number }> }).__termpolis_pane_effects()
    await mount(tabs(3))
    await settle(300)
    await act(async () => { ipc.emit('terminal:data', 't1', 'x\r\n', 3) })
    const snap = hook()
    expect(Object.keys(snap).sort()).toEqual(['t0', 't1', 't2'])
    expect(snap.t1).toMatchObject({ messages: 1, passes: 1 })
    expect(snap.t0.messages).toBe(0)
    act(() => { cleanup() })
    await settle(100)
    expect(Object.keys(hook())).toEqual([])
  })

  it('NEGATIVE CONTROL: with the pass kill switch there are no counters (nothing batches, so nothing to count)', async () => {
    window.localStorage.setItem(SWITCH_PANE_EFFECTS, '0')
    await mount(tabs(2))
    await settle(300)
    const hook = (window as unknown as { __termpolis_pane_effects: () => Record<string, unknown> }).__termpolis_pane_effects
    expect(Object.keys(hook())).toEqual([])
  })

  it('a hidden pane\'s xterm still parses everything: modes (alt screen) and the whole stream, in order', async () => {
    await mount(tabs(2, 0))
    await settle(500)
    await act(async () => { ipc.emit('terminal:data', 't1', '\x1b[?1049h', 9) })
    await settle(100)
    expect(term(1).buffer.active.type).toBe('alternate') // parsed while hidden
    await act(async () => { ipc.emit('terminal:data', 't1', '\x1b[?1049l', 18) })
    await offer('t1', 125, 2)
    await settle(1500)
    expect(term(1).buffer.active.type).toBe('normal')
    const text = bufferLines(term(1)).join('\n')
    expect(text).toContain('chunk 0')
    expect(text).toContain('chunk 249')
  })
})

describe('TerminalPane: hiding does not thrash the WebGL budget', () => {
  /** Walk the active tab over `n` panes for `turns` switches; returns [contexts created, contexts released]. */
  const walk = async (n: number, turns: number): Promise<[number, number]> => {
    h.webgl.enabled = true
    await mount(tabs(n, 0))
    await settle(100)
    for (let i = 1; i <= turns; i++) await show(tabs(n, i % n))
    await settle(100)
    return [h.webgl.created, h.webgl.disposed]
  }
  /** Tear the panes down and let their deferred dispose run, so the next walk starts from nothing. */
  const reset = async (): Promise<void> => {
    act(() => { cleanup() })
    view = null
    await settle(300)
    resetWebglBudget()
    h.webgl.created = 0
    h.webgl.disposed = 0
  }

  it('12 tab switches over 4 panes: each pane takes one context and none is ever given back (the budget holds 8)', async () => {
    const [created, disposed] = await walk(4, 12)
    expect(created).toBe(4)
    expect(disposed).toBe(0)
  }, 120_000)

  it('NEGATIVE CONTROL: the same walk with the kill switch makes exactly the same acquires and releases (hiding changes nothing about the budget)', async () => {
    const withHiding = await walk(4, 12)
    await reset()
    window.localStorage.setItem(SWITCH_HIDDEN_PANES, '0')
    const without = await walk(4, 12)
    expect(without).toEqual(withHiding)
    expect(withHiding).toEqual([4, 0])
  }, 120_000)

  it("more panes than the budget: the churn is the budget's own LRU, and identical with and without hiding", async () => {
    const withHiding = await walk(10, 20)
    await reset()
    window.localStorage.setItem(SWITCH_HIDDEN_PANES, '0')
    const without = await walk(10, 20)
    expect(without).toEqual(withHiding)
    expect(withHiding[0]).toBeGreaterThanOrEqual(10) // 10 panes each took a context at least once
  }, 180_000)
})
