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
  compaction: null as null | ((text: string) => void), // what a pane hands the compaction watcher
  session: null as null | ((text: string) => void), // ... and the session-reflection watcher
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
// The auto-primer, the compaction re-primer and the session reflector are what a pane feeds its output to; here they are
// counters (what text did each get?), not the real memory-brain consumers.
vi.mock('../../src/renderer/src/hooks/useAutoPrimer', () => ({
  useAutoPrimer: vi.fn(),
  useCompactionReprimer: () => (text: string) => h.compaction?.(text),
  useSessionReflection: () => (text: string) => h.session?.(text),
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
import { appendOutput, readOutputFrom, type OutputBuffers } from '../../src/main/terminalOutputBuffer'
import { createTerminalDataRouting, registerTerminalDataRouting } from '../../src/main/terminalDataRouting'
import { prng } from '../renderer/helpers/schedulerHarness'
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
let compactionCalls: string[] = []
let sessionCalls: string[] = []

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
  compactionCalls = []
  sessionCalls = []
  h.detect = (...a) => { detectCalls.push(a) }
  h.compaction = (text) => { compactionCalls.push(text) }
  h.session = (text) => { sessionCalls.push(text) }
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
  h.compaction = null
  h.session = null
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

  it('a pass longer than the 4 KB window: the conversation parser still reads the window, and what looks for a MARKER (an agent banner, the compaction notice) reads the whole pass', async () => {
    await mount(tabs(1, 0))
    await settle(500)
    detectCalls = []
    compactionCalls = []
    sessionCalls = []
    await burst('t0', 'A'.repeat(10_000) + 'Compacting conversation', 'B'.repeat(8_000))
    expect(detectCalls).toHaveLength(2) // the lead chunk, then ONE pass for the two chunks of the burst
    const pass = detectCalls[1]
    expect(pass[4]).toBe(2) // two chunks, one pass
    // What the conversation parser reads is the window, exactly as in 1.54.4: the last 4 KB, which has scrolled the marker out.
    expect(String(pass[0]).length).toBeLessThanOrEqual(4096)
    expect(String(pass[0])).not.toContain('Compacting conversation')
    // What looks for a marker reads the whole pass (8,023 chars from its end), as it read every chunk of it before.
    expect(String(pass[5])).toContain('Compacting conversation')
    expect(String(pass[5]).length).toBeGreaterThan(18_000)
    expect(compactionCalls.some((t) => t.includes('Compacting conversation'))).toBe(true)
    // The session watcher only needs to hear that there was output; it gets the window.
    expect(sessionCalls).toHaveLength(2)
    expect(sessionCalls.every((t) => t.length <= 4096)).toBe(true)
  })

  it('NEGATIVE CONTROL: per chunk (the kill switch) the window is all there is, and nothing reads more: the marker is seen only while it is still in the last 4 KB', async () => {
    window.localStorage.setItem(SWITCH_PANE_EFFECTS, '0')
    await mount(tabs(1, 0))
    await settle(500)
    detectCalls = []
    compactionCalls = []
    await burst('t0', 'A'.repeat(10_000) + 'Compacting conversation', 'B'.repeat(8_000))
    expect(detectCalls).toHaveLength(3) // a pass per chunk
    expect(String(detectCalls[1][0])).toContain('Compacting conversation') // right after its own chunk it is at the end of the window
    expect(String(detectCalls[2][0])).not.toContain('Compacting conversation') // 8,000 B's later it has scrolled out
    for (const c of detectCalls) expect(c[5]).toBe(c[0]) // no wide text: detection reads the window, as in 1.54.4
    expect(compactionCalls).toHaveLength(3)
    expect(compactionCalls[1]).toContain('Compacting conversation')
    expect(compactionCalls[2]).not.toContain('Compacting conversation')
  })

  it('an error pattern anywhere in a pass makes ONE suggestion lookup (the base: one per chunk that carried it); a pass is capped at 64 KB, and what the cap dropped is not looked at', async () => {
    const { getSuggestion } = await import('../../src/renderer/src/corrections/correctionEngine')
    const lookups = vi.mocked(getSuggestion)
    await mount(tabs(1, 0))
    await settle(500)
    await runCommand(0, 'frobnicate')
    lookups.mockClear()
    await burst('t0', 'zsh: command not found: one\r\n' + 'x'.repeat(3_000), 'zsh: command not found: two\r\n' + 'y'.repeat(3_000))
    expect(lookups).toHaveBeenCalledTimes(1) // two chunks carried it, one pass looked once
    expect(lookups.mock.calls[0][0]).toBe('frobnicate')
    // A pattern at the front of a pass longer than the 4 KB window is still seen: the base tested every chunk's own text.
    lookups.mockClear()
    await burst('t0', 'command not found: front\r\n' + 'x'.repeat(5_000), 'y'.repeat(100))
    expect(lookups).toHaveBeenCalledTimes(1)
    // A pass keeps its newest 64 KB: the pattern in the 24 chars at the very front of an 80 KB pass was dropped by the cap.
    lookups.mockClear()
    await burst('t0', 'command not found: old\r\n' + 'x'.repeat(40_000), 'y'.repeat(40_000))
    expect(lookups).toHaveBeenCalledTimes(0)
    expect(paneStats('t0').droppedChars).toBeGreaterThan(14_000)
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

  it('Enter: the pending pass is looked at under the command that PRODUCED the output, not the one just typed', async () => {
    const { getSuggestion } = await import('../../src/renderer/src/corrections/correctionEngine')
    const lookups = vi.mocked(getSuggestion)
    await mount(tabs(1, 0))
    await settle(500)
    await runCommand(0, 'first-command')
    await settle(400) // the window of anything before this has elapsed: the next chunk runs at once
    lookups.mockClear()
    // `first-command` fails: one chunk runs at once (leading edge), the error line lands inside the window and waits for its pass.
    await act(async () => { ipc.emit('terminal:data', 't0', 'starting\r\n', 10) })
    await act(async () => { ipc.emit('terminal:data', 't0', 'zsh: command not found: first-command\r\n', 50) })
    expect(lookups).toHaveBeenCalledTimes(0)
    // The next command is typed and entered inside the same window.
    await runCommand(0, 'second-command')
    expect(lookups).toHaveBeenCalledTimes(1) // the pending pass ran at Enter ...
    expect(lookups.mock.calls[0][0]).toBe('first-command') // ... for the command whose output it was
    await settle(2000)
    expect(lookups).toHaveBeenCalledTimes(1) // and nothing is left to run under the new one
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

describe("TerminalPane: output produced around a pane's mount reaches it once and in order (the real routing, the real replay, a wire with latency)", () => {
  /**
   * One terminal in a fake main process: the REAL output buffer, the REAL router and announcement handlers, the REAL preload
   * router on the renderer side, and a wire with latency in each direction. Messages keep their order on each direction, like a
   * Mojo pipe, so a subscribe sent before a replay request is read before it.
   */
  function fakeMain(latencyUp: number, latencyDown: number, subscribeExtraDelay = 0) {
    const buffers: OutputBuffers = new Map()
    const routing = createTerminalDataRouting()
    const handlers = new Map<string, (e: unknown, msg: unknown) => void>()
    registerTerminalDataRouting({ on: (c, hnd) => { handlers.set(c, hnd as (e: unknown, msg: unknown) => void) } }, routing)
    const up = (fn: () => void, extra = 0): void => { setTimeout(fn, latencyUp + extra) }
    const down = (fn: () => void): void => { setTimeout(fn, latencyDown) }
    const mainWindow = { webContents: { id: 1, send: (channel: string, ...args: unknown[]) => { down(() => { ipc.emit(channel, ...args) }) } } }
    // Another pane is mounted somewhere: routing is armed, so a terminal nobody announced gets only its grace.
    routing.note(1, { id: 'another-terminal', epoch: 1 }, true)
    // The renderer's announcements travel up the wire in order with the replay request (the control delays only the subscribe).
    const send = ipc.send
    ipc.send = (channel, ...args) => {
      send(channel, ...args)
      up(() => { handlers.get(channel)?.({ sender: { id: 1 } }, args[0]) }, channel === 'terminal:subscribe' ? subscribeExtraDelay : 0)
    }
    mockReadTerminalBuffer.mockImplementation((id: string) => new Promise((resolve) => {
      up(() => {
        // Served when it ARRIVES, from the buffer as it is then; the reply travels down.
        const slice = readOutputFrom(buffers, id, 0)
        down(() => { resolve({ success: true, data: { ...slice, length: slice.output.length } }) })
      })
    }))
    let n = 0
    return {
      /** The terminal prints a line: buffered first, then sent if something listens (the order the real pump uses). */
      print(id: string): string {
        const line = `line-${String(n++).padStart(4, '0')}`
        const data = line + '\r\n'
        const end = appendOutput(buffers, id, data)
        routing.send(mainWindow, id, data, end)
        return line
      },
      routing,
    }
  }

  /** One random interleaving: 70 lines printed with nobody listening, 40 more at random moments, the pane mounting at a random one. */
  async function scenario(seed: number, subscribeExtraDelay = 0): Promise<{ printed: string[]; seen: string[]; missing: string[]; duplicated: string[] }> {
    // A fresh renderer side for every interleaving.
    ipc = fakeIpc()
    router = createTerminalDataRouter(ipc, 1)
    h.terms.length = 0
    h.log.length = 0
    resetWriteScheduler()
    const rand = prng(seed)
    const main = fakeMain(1 + Math.floor(rand() * 30), 1 + Math.floor(rand() * 30), subscribeExtraDelay)
    const printed: string[] = []
    for (let i = 0; i < 70; i++) printed.push(main.print('t0')) // the grace (64 chunks) is spent; the rest is only in main's buffer
    const times = Array.from({ length: 40 }, () => Math.floor(rand() * 300)).sort((a, b) => a - b)
    const mountAt = 20 + Math.floor(rand() * 200)
    const events: Array<{ t: number; run: () => Promise<void> | void }> = [
      ...times.map((t) => ({ t, run: () => { printed.push(main.print('t0')) } })),
      { t: mountAt, run: () => mount(tabs(1, 0)) },
    ].sort((a, b) => a.t - b.t) // stable: a print and the mount at the same moment keep their order
    let now = 0
    for (const ev of events) {
      if (ev.t > now) { await settle(ev.t - now); now = ev.t }
      await ev.run()
    }
    await settle(3000)
    const seen = bufferLines(term(0)).map((l) => l.trim()).filter((l) => l.startsWith('line-'))
    const counts = new Map<string, number>()
    for (const l of seen) counts.set(l, (counts.get(l) ?? 0) + 1)
    const missing = printed.filter((p) => !counts.has(p))
    const duplicated = [...counts].filter(([, c]) => c > 1).map(([l]) => l)
    act(() => { cleanup() })
    view = null
    await settle(300)
    return { printed, seen, missing, duplicated }
  }

  it('12 random interleavings of prints, the subscribe, the replay request and its reply: every line arrives exactly once, in order', async () => {
    const seeds = Array.from({ length: 12 }, (_, i) => 100 + i)
    for (const seed of seeds) {
      const r = await scenario(seed)
      expect(r.missing, `seed ${seed}: lines lost`).toEqual([])
      expect(r.duplicated, `seed ${seed}: lines drawn twice`).toEqual([])
      expect(r.seen, `seed ${seed}: order`).toEqual(r.printed)
    }
  }, 600_000)

  it('NEGATIVE CONTROL: if the subscribe reached main AFTER the replay was served (the wrong order), lines printed in between are lost', async () => {
    let lostSomewhere = 0
    for (const seed of [100, 101, 102, 103, 104, 105]) {
      const r = await scenario(seed, 400)
      lostSomewhere += r.missing.length
    }
    expect(lostSomewhere).toBeGreaterThan(0)
  }, 600_000)
})
