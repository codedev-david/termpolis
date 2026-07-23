/**
 * TerminalPane — error paths, fallbacks and disposal races.
 *
 * TerminalPane.test.tsx covers the happy paths. This file deliberately targets the
 * arms that only run when something GOES WRONG or a value is missing:
 *
 *   • the WebGL renderer probe (hardware vs software GL, a throwing addon)
 *   • every rejected clipboard/IPC promise (a `.catch` that never ran is an
 *     unhandled rejection in production)
 *   • the `disposed` guards — a stale callback from a torn-down terminal must not
 *     write state into the terminal that replaced it
 *   • keyboard copy-mode word motions over an absent buffer line
 *   • the voice hotkey permutations (already-listening, key auto-repeat, blank sendKey)
 *   • the v1.25.3 rule: a LAUNCH-PRIMED terminal is NEVER typed into on compaction
 *
 * Every test asserts on observable behaviour (a call with specific args, rendered
 * output, a state transition, or a call that must NOT happen).
 */
import React from 'react'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'

// ---------------------------------------------------------------------------
// Hoisted mock state. Callbacks are collected into ARRAYS (not a single "last"
// slot) so a stale callback registered by a torn-down terminal effect survives a
// re-render and can be fired on purpose — that is how the `disposed` guards are
// tested for real instead of with a vacuous "does not throw".
// ---------------------------------------------------------------------------
const H = vi.hoisted(() => {
  const bufferLines = ['echo hello world', 'line-1', 'line-2', 'line-3', 'line-4']
  const term = {
    open: vi.fn(),
    focus: vi.fn(),
    write: vi.fn(),
    dispose: vi.fn(),
    onData: vi.fn(),
    attachCustomKeyEventHandler: vi.fn(),
    attachCustomWheelEventHandler: vi.fn(),
    getSelection: vi.fn(() => '' as any),
    hasSelection: vi.fn(() => false),
    onSelectionChange: vi.fn(() => ({ dispose: vi.fn() })),
    clearSelection: vi.fn(),
    selectAll: vi.fn(),
    select: vi.fn(),
    loadAddon: vi.fn(),
    parser: { registerCsiHandler: vi.fn() },
    unicode: { activeVersion: '11', register: vi.fn() },
    options: {} as Record<string, any>,
    cols: 80,
    rows: 24,
    buffer: {
      active: {
        type: 'normal',
        length: bufferLines.length,
        viewportY: 0,
        cursorX: 0,
        cursorY: 0,
        baseY: 0,
        getLine: vi.fn((i: number) => null as any),
      },
    },
  }

  return {
    term,
    bufferLines,
    lastTerminalOptions: null as any,
    // captured callbacks — index 0 is the FIRST terminal effect, and stays valid
    // after that effect has been disposed.
    dataCbs: [] as ((d: string) => void)[],
    keyCbs: [] as ((e: KeyboardEvent) => boolean)[],
    wheelCbs: [] as ((e: WheelEvent) => boolean)[],
    ptyCbs: [] as ((id: string, d: string) => void)[],
    roCbs: [] as (() => void)[],
    searchResultCbs: [] as ((r: { resultIndex: number; resultCount: number }) => void)[],
    rafCbs: [] as (() => void)[],
    deferRaf: { on: false },
    fitAddons: [] as any[],
    webglAddons: [] as any[],
    webglThrows: { on: false },
    findNext: vi.fn(),
    findPrevious: vi.fn(),
    clearDecorations: vi.fn(),
    // store
    state: { current: null as any },
    updateTerminal: vi.fn(),
    setShowSettings: vi.fn(),
    setMemoryNotice: vi.fn(),
    focusActiveTerminal: vi.fn(),
    // hooks
    agent: { current: null as any },
    voice: { current: null as any },
    recording: { current: null as any },
    processAgentDetection: vi.fn(),
    startRecording: vi.fn(),
    stopRecording: vi.fn(),
    appendRecordingEntry: vi.fn(),
    voiceToggle: vi.fn(),
    voiceStart: vi.fn(),
    voiceStop: vi.fn(),
    voiceConfirmRun: vi.fn(),
    voiceCancelConfirm: vi.fn(),
    voiceClearError: vi.fn(),
    // libs
    getSuggestion: vi.fn(),
    parsePrompt: vi.fn(),
  }
})

// --- xterm + addons --------------------------------------------------------
vi.mock('@xterm/xterm', () => ({
  Terminal: function (options: unknown) {
    H.lastTerminalOptions = options
    return H.term
  },
}))
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: function (this: any) {
    this.fit = vi.fn()
    this.dispose = vi.fn()
    H.fitAddons.push(this)
  },
}))
vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: function (this: any) {
    if (H.webglThrows.on) throw new Error('WebGL context creation failed')
    this.dispose = vi.fn()
    this.contextLossCb = null
    this.onContextLoss = vi.fn((cb: () => void) => {
      this.contextLossCb = cb
    })
    H.webglAddons.push(this)
  },
}))
vi.mock('@xterm/addon-unicode11', () => ({
  Unicode11Addon: function (this: any) {
    this.dispose = vi.fn()
  },
}))
vi.mock('@xterm/addon-web-links', () => ({
  WebLinksAddon: function (this: any) {
    this.dispose = vi.fn()
  },
}))
vi.mock('@xterm/addon-search', () => ({
  SearchAddon: function (this: any) {
    this.dispose = vi.fn()
    this.findNext = H.findNext
    this.findPrevious = H.findPrevious
    this.clearDecorations = H.clearDecorations
    this.onDidChangeResults = (cb: (r: { resultIndex: number; resultCount: number }) => void) => {
      H.searchResultCbs.push(cb)
      return { dispose: vi.fn() }
    }
  },
}))
vi.mock('@xterm/xterm/css/xterm.css', () => ({}))

vi.mock('uuid', () => ({ v4: vi.fn(() => 'pin-uuid-1') }))

vi.mock('../../src/renderer/src/themes/terminalThemes', () => ({
  getTheme: vi.fn(() => ({ background: '#1e1e1e', foreground: '#d4d4d4' })),
}))

// --- store -----------------------------------------------------------------
vi.mock('../../src/renderer/src/store/terminalStore', () => {
  const fn: any = vi.fn((selector?: any) => (selector ? selector(H.state.current) : H.state.current))
  fn.getState = () => H.state.current
  return { useTerminalStore: fn }
})

// --- libs ------------------------------------------------------------------
vi.mock('../../src/renderer/src/corrections/correctionEngine', () => ({
  getSuggestion: H.getSuggestion,
}))
vi.mock('../../src/renderer/src/lib/promptParser', () => ({
  parsePromptFromOutput: H.parsePrompt,
}))
vi.mock('../../src/renderer/src/lib/outputThrottle', () => ({
  createOutputThrottle: vi.fn((cb: (d: string) => void) => cb),
}))
vi.mock('../../src/renderer/src/lib/exportTerminal', () => {
  const sel = (t: any): string => (t?.getSelection?.() ?? '') as string
  return {
    stripAnsi: vi.fn((s: string) => s),
    generateFilename: vi.fn(() => 'terminal-export.txt'),
    formatAsCodeBlockFromTerm: vi.fn((t: any) => '```text\n' + sel(t) + '\n```'),
    formatAsCodeBlockHtmlFromTerm: vi.fn((t: any) => '<pre><code>' + sel(t) + '</code></pre>'),
    formatAsPlainTextFromTerm: vi.fn((t: any) => 'PLAIN:' + sel(t)),
    formatAsMessageHtmlFromTerm: vi.fn((t: any) => '<span>' + sel(t) + '</span>'),
    formatAsMessagePlainTextFromTerm: vi.fn((t: any) => 'MSG:' + sel(t)),
  }
})

// --- hooks -----------------------------------------------------------------
// useAutoPrimer (and its useCompactionReprimer / useSessionReflection siblings) is
// left REAL — the compaction-reprime suite below exercises the component's wiring
// into it end to end.
vi.mock('../../src/renderer/src/hooks/useAgentDetection', () => ({
  useAgentDetection: () => H.agent.current,
}))
vi.mock('../../src/renderer/src/hooks/useSessionRecording', () => ({
  useSessionRecording: () => H.recording.current,
}))
vi.mock('../../src/renderer/src/hooks/useVoiceInput', () => ({
  useVoiceInput: () => H.voice.current,
}))
vi.mock('../../src/renderer/src/hooks/useTranscriptWatcher', () => ({
  useTranscriptWatcher: vi.fn(),
}))
vi.mock('../../src/renderer/src/hooks/useAutoCodeIndex', () => ({
  useAutoCodeIndex: vi.fn(),
}))

// --- child components ------------------------------------------------------
vi.mock('../../src/renderer/src/components/CommandFix/CommandFixBanner', () => ({
  CommandFixBanner: ({ suggestion, onAccept, onDismiss }: any) => (
    <div data-testid="command-fix-banner">
      <span data-testid="fix-text">{suggestion}</span>
      <button data-testid="fix-accept" onClick={onAccept}>Accept</button>
      <button data-testid="fix-dismiss" onClick={onDismiss}>Dismiss</button>
    </div>
  ),
}))
vi.mock('../../src/renderer/src/components/StatusBar/TerminalStatusBar', () => ({
  TerminalStatusBar: ({ cwd, parsedBranch, agent, isRecording }: any) => (
    <div data-testid="terminal-status-bar">
      <span data-testid="sb-cwd">{cwd}</span>
      <span data-testid="sb-branch">{parsedBranch ?? ''}</span>
      <span data-testid="sb-agent">{agent?.name ?? ''}</span>
      <span data-testid="sb-rec">{isRecording ? 'rec' : ''}</span>
    </div>
  ),
}))
vi.mock('../../src/renderer/src/components/DiffViewer/DiffViewer', () => ({
  DiffViewer: ({ onClose }: any) => (
    <div data-testid="diff-viewer">
      <button data-testid="diff-close" onClick={onClose}>Close</button>
    </div>
  ),
}))
vi.mock('../../src/renderer/src/components/PinnedOutput/PinnedOutput', () => ({
  PinnedOutput: ({ pins }: any) => (
    <div data-testid="pinned-output">{pins.map((p: any) => <span key={p.id}>{p.text}</span>)}</div>
  ),
}))
vi.mock('../../src/renderer/src/components/PastAISessions/PastAISessions', () => ({
  PastAISessions: ({ open, onClose }: any) =>
    open ? (
      <div data-testid="past-ai-sessions-overlay">
        <button data-testid="past-ai-close" onClick={onClose}>Close</button>
      </div>
    ) : null,
}))

// --- window bridges --------------------------------------------------------
const mockWriteToTerminal = vi.fn()
const mockReadTerminalBuffer = vi.fn()
const mockOnTerminalData = vi.fn()
const mockAppendHistory = vi.fn()
const mockExportTerminal = vi.fn()
const mockResizeTerminal = vi.fn()
const mockClipboardWriteText = vi.fn()
const mockClipboardReadText = vi.fn()
const mockClipboardWriteRich = vi.fn()
const mockDetectAgents = vi.fn()
const mockSecondOpinion = vi.fn()
const mockGroqGetKeyStatus = vi.fn()
const mockMemoryBuildPrimer = vi.fn()
const mockMemoryReflectSession = vi.fn()
const mockInputPending = vi.fn()

beforeAll(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(cb: () => void) { H.roCbs.push(cb) }
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
  // rAF runs synchronously by default (matching the rest of the suite); the
  // disposal test flips `deferRaf` so it can fire the callback after teardown.
  vi.stubGlobal('requestAnimationFrame', (cb: () => void) => {
    if (H.deferRaf.on) { H.rafCbs.push(cb); return H.rafCbs.length }
    cb()
    return 0
  })
})

// Imported after the mocks are registered.
import { TerminalPane } from '../../src/renderer/src/components/TerminalPane/TerminalPane'
import { DEFAULT_KEYBINDINGS } from '../../src/renderer/src/lib/keybindings'
import { computeDisplayLevel, RELIABLE_SPEECH_RMS } from '../../src/renderer/src/lib/voice/voicePipeline'
import { CLAUDE_MODEL_OPTIONS } from '../../src/renderer/src/lib/modelBroker'

const CLAUDE = { name: 'Claude Code', icon: 'fa-solid fa-robot', color: '#D97706' }

const defaultProps = {
  terminalId: 'term-1',
  terminalName: 'Terminal 1',
  shellType: 'bash' as const,
  cwd: '/home/user',
  isVisible: true,
  fontSize: 14,
  theme: 'dark',
  fontFamily: 'monospace',
}

// --- per-test wiring -------------------------------------------------------
function setStore(over: Record<string, any> = {}): void {
  H.state.current = {
    terminals: [{ id: 'term-1', isSwarm: false }],
    activeTerminalId: null,
    focusNonce: 0,
    allowAppMouseControl: false,
    autocompleteEnabled: true,
    keybindings: { ...DEFAULT_KEYBINDINGS },
    customKeybindings: [],
    voiceSettings: {
      enabled: false,
      consentAccepted: true,
      groqModel: 'whisper-large-v3-turbo',
      pushToTalkKey: 'Ctrl+Shift+L',
      pushToTalkMode: 'tapOrHold',
      sendKey: 'Space',
      autoSubmitInAgent: false,
      correctionEnabled: true,
      confirmBeforeRunInShell: true,
    },
    updateTerminal: H.updateTerminal,
    setShowSettings: H.setShowSettings,
    setMemoryNotice: H.setMemoryNotice,
    focusActiveTerminal: H.focusActiveTerminal,
    addTerminal: vi.fn(),
    removeTerminal: vi.fn(),
    ...over,
  }
}

function setVoice(over: Record<string, any> = {}): void {
  H.voice.current = {
    status: 'idle',
    listening: false,
    level: 0,
    lastCapture: null,
    confirm: null,
    errorMsg: null,
    toggle: H.voiceToggle,
    start: H.voiceStart,
    stop: H.voiceStop,
    confirmRun: H.voiceConfirmRun,
    cancelConfirm: H.voiceCancelConfirm,
    clearError: H.voiceClearError,
    dispose: vi.fn(),
    ...over,
  }
}

function setAgent(detectedAgent: any = null): void {
  H.agent.current = {
    detectedAgent,
    processAgentDetection: H.processAgentDetection,
    agentDetectedRef: { current: !!detectedAgent },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  H.dataCbs.length = 0
  H.keyCbs.length = 0
  H.wheelCbs.length = 0
  H.ptyCbs.length = 0
  H.roCbs.length = 0
  H.searchResultCbs.length = 0
  H.rafCbs.length = 0
  H.fitAddons.length = 0
  H.webglAddons.length = 0
  H.deferRaf.on = false
  H.webglThrows.on = false
  H.lastTerminalOptions = null

  // xterm handle
  H.term.onData.mockImplementation((cb: (d: string) => void) => { H.dataCbs.push(cb); return { dispose: vi.fn() } })
  H.term.attachCustomKeyEventHandler.mockImplementation((cb: (e: KeyboardEvent) => boolean) => { H.keyCbs.push(cb) })
  H.term.attachCustomWheelEventHandler.mockImplementation((cb: (e: WheelEvent) => boolean) => { H.wheelCbs.push(cb) })
  H.term.onSelectionChange.mockImplementation(() => ({ dispose: vi.fn() }))
  H.term.getSelection.mockReturnValue('')
  H.term.hasSelection.mockReturnValue(false)
  H.term.buffer.active.type = 'normal'
  H.term.buffer.active.length = H.bufferLines.length
  H.term.buffer.active.viewportY = 0
  H.term.buffer.active.cursorX = 0
  H.term.buffer.active.cursorY = 0
  H.term.buffer.active.baseY = 0
  H.term.buffer.active.getLine.mockImplementation((i: number) =>
    i < H.bufferLines.length ? { translateToString: vi.fn(() => H.bufferLines[i]) } : null,
  )

  // libs / hooks
  H.getSuggestion.mockResolvedValue(null)
  H.parsePrompt.mockReturnValue({ cwd: null, gitBranch: undefined })
  setStore()
  setVoice()
  setAgent(null)
  H.recording.current = {
    isRecording: false,
    startRecording: H.startRecording,
    stopRecording: H.stopRecording,
    appendRecordingEntry: H.appendRecordingEntry,
    isRecordingRef: { current: false },
  }

  // bridges
  mockReadTerminalBuffer.mockResolvedValue({ success: true, data: { output: '' } })
  mockOnTerminalData.mockImplementation((cb: (id: string, d: string) => void) => { H.ptyCbs.push(cb); return vi.fn() })
  mockClipboardWriteText.mockResolvedValue({ success: true })
  mockClipboardWriteRich.mockResolvedValue({ success: true })
  mockClipboardReadText.mockResolvedValue({ success: true, data: 'pasted-text' })
  mockDetectAgents.mockResolvedValue({ success: true, data: {} })
  mockSecondOpinion.mockResolvedValue({ success: true, data: { feedback: 'ok' } })
  mockGroqGetKeyStatus.mockResolvedValue({ success: true, data: { connected: true } })
  mockMemoryBuildPrimer.mockResolvedValue({ success: true, data: '- [a] a remembered fix\n' })
  mockMemoryReflectSession.mockResolvedValue({ success: true })
  mockInputPending.mockResolvedValue({ success: true, data: false })

  ;(window as any).termpolis = {
    writeToTerminal: mockWriteToTerminal,
    readTerminalBuffer: mockReadTerminalBuffer,
    onTerminalData: mockOnTerminalData,
    appendHistory: mockAppendHistory,
    exportTerminal: mockExportTerminal,
    resizeTerminal: mockResizeTerminal,
    clipboardWriteText: mockClipboardWriteText,
    clipboardReadText: mockClipboardReadText,
    clipboardWriteRich: mockClipboardWriteRich,
    detectAgents: mockDetectAgents,
    secondOpinion: mockSecondOpinion,
    groqGetKeyStatus: mockGroqGetKeyStatus,
    memoryBuildPrimer: mockMemoryBuildPrimer,
    memoryReflectSession: mockMemoryReflectSession,
    platformInfo: { platform: 'win32', windowsPty: { backend: 'conpty', buildNumber: 22631 } },
  }
  ;(window as any).aiSecurity = { inputPending: mockInputPending }

  // The LAUNCH primer types into agent terminals 1.5s after mount; switch it off so
  // "nothing was written" assertions below are about the code under test, not it.
  localStorage.setItem('termpolis.memory.autoPrimerOnLaunch', '0')
})

afterEach(() => {
  vi.useRealTimers()
  localStorage.clear()
})

// --- helpers ---------------------------------------------------------------
const keyDown = (init: KeyboardEventInit): boolean | undefined => {
  let r: boolean | undefined
  act(() => { r = H.keyCbs[H.keyCbs.length - 1]?.(new KeyboardEvent('keydown', { cancelable: true, ...init })) })
  return r
}
const keyUp = (init: KeyboardEventInit): boolean | undefined => {
  let r: boolean | undefined
  act(() => { r = H.keyCbs[H.keyCbs.length - 1]?.(new KeyboardEvent('keyup', { cancelable: true, ...init })) })
  return r
}
const typeIntoPty = (d: string): void => { act(() => { H.dataCbs[H.dataCbs.length - 1]?.(d) }) }
const emitPty = (d: string, id = 'term-1', idx = -1): void => {
  const cb = idx < 0 ? H.ptyCbs[H.ptyCbs.length - 1] : H.ptyCbs[idx]
  act(() => { cb?.(id, d) })
}
// Fake ONLY the timer APIs the component uses. vi.useFakeTimers() would also replace
// requestAnimationFrame, clobbering the rAF stub the disposal tests drive by hand.
const useTimers = (): void => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
}
const pane = (c: HTMLElement): HTMLElement => c.querySelector('.flex-1.relative') as HTMLElement
const openMenu = (c: HTMLElement): void => {
  fireEvent.contextMenu(pane(c), { clientX: 100, clientY: 200 })
}
const csi = (final: 'h' | 'l'): ((p: (number | number[])[]) => boolean) => {
  const calls = H.term.parser.registerCsiHandler.mock.calls as any[]
  return [...calls].reverse().find((c) => c[0]?.final === final)?.[1]
}
const wheelEv = (over: Partial<WheelEvent> = {}): WheelEvent =>
  ({ deltaY: -100, deltaMode: 0, clientX: 0, clientY: 0, preventDefault: vi.fn(), ...over }) as unknown as WheelEvent

// Fake WebGL2 context for the hardware-GL probe.
function stubWebgl(opts: { renderer?: string | null; noDebugExt?: boolean; throws?: boolean } = {}) {
  return vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(((type: string) => {
    if (opts.throws) throw new Error('getContext blew up')
    if (type !== 'webgl2') return null
    return {
      getExtension: () => (opts.noDebugExt ? null : { UNMASKED_RENDERER_WEBGL: 37446 }),
      getParameter: () => opts.renderer,
    }
  }) as any)
}

describe('TerminalPane — error paths, fallbacks and disposal races', () => {
  // =========================================================================
  // 1. Renderer selection (hasHardwareWebgl)
  // =========================================================================
  describe('WebGL renderer probe', () => {
    it('loads the WebGL renderer on a real hardware GL context', () => {
      const spy = stubWebgl({ renderer: 'ANGLE (NVIDIA GeForce RTX 4090 Direct3D11)' })
      try {
        render(<TerminalPane {...defaultProps} />)
        expect(H.webglAddons).toHaveLength(1)
        expect(H.term.loadAddon).toHaveBeenCalledWith(H.webglAddons[0])
      } finally {
        spy.mockRestore()
      }
    })

    it('disposes the WebGL addon on context loss so xterm falls back to the DOM renderer', () => {
      const spy = stubWebgl({ renderer: 'AMD Radeon RX 7900' })
      try {
        render(<TerminalPane {...defaultProps} />)
        const addon = H.webglAddons[0]
        expect(addon.onContextLoss).toHaveBeenCalled()
        expect(addon.dispose).not.toHaveBeenCalled()

        act(() => { addon.contextLossCb() }) // GPU process died / driver reset

        expect(addon.dispose).toHaveBeenCalledTimes(1)
      } finally {
        spy.mockRestore()
      }
    })

    it('swallows a second context-loss notification (dispose already ran)', () => {
      const spy = stubWebgl({ renderer: 'Intel Iris Xe' })
      try {
        render(<TerminalPane {...defaultProps} />)
        const addon = H.webglAddons[0]
        addon.dispose.mockImplementation(() => { throw new Error('already disposed') })
        expect(() => addon.contextLossCb()).not.toThrow()
      } finally {
        spy.mockRestore()
      }
    })

    it.each([
      ['Google SwiftShader'],
      ['llvmpipe (LLVM 15.0.7, 256 bits)'],
      ['Microsoft Basic Render Driver'],
      ['ANGLE (Software Adapter)'],
    ])('stays on the DOM renderer under software GL (%s) — the async-crash guard', (renderer) => {
      const spy = stubWebgl({ renderer })
      try {
        render(<TerminalPane {...defaultProps} />)
        expect(H.webglAddons).toHaveLength(0)
        expect(H.term.open).toHaveBeenCalled() // terminal still comes up
      } finally {
        spy.mockRestore()
      }
    })

    it('treats a GL context with no WEBGL_debug_renderer_info as hardware and loads WebGL', () => {
      // No debug extension → renderer string is '' → it can't be matched as a known
      // software rasterizer, so we take the fast path rather than punishing every
      // browser that hides the renderer.
      const spy = stubWebgl({ noDebugExt: true })
      try {
        render(<TerminalPane {...defaultProps} />)
        expect(H.webglAddons).toHaveLength(1)
      } finally {
        spy.mockRestore()
      }
    })

    it('stays on the DOM renderer when the GL probe itself throws', () => {
      const spy = stubWebgl({ throws: true })
      try {
        expect(() => render(<TerminalPane {...defaultProps} />)).not.toThrow()
        expect(H.webglAddons).toHaveLength(0)
      } finally {
        spy.mockRestore()
      }
    })

    it('stays on the DOM renderer when the WebGL addon constructor throws', () => {
      const spy = stubWebgl({ renderer: 'NVIDIA GeForce RTX 3080' })
      H.webglThrows.on = true
      try {
        expect(() => render(<TerminalPane {...defaultProps} />)).not.toThrow()
        expect(H.webglAddons).toHaveLength(0)
        expect(H.term.open).toHaveBeenCalled()
      } finally {
        spy.mockRestore()
      }
    })

    it('does not load WebGL when the host has no WebGL2 at all (headless/jsdom)', () => {
      render(<TerminalPane {...defaultProps} />) // jsdom getContext → null
      expect(H.webglAddons).toHaveLength(0)
    })
  })

  // =========================================================================
  // 2. Selection snapshot — xterm handing back a non-string selection
  // =========================================================================
  describe('copy snapshot', () => {
    it('treats an undefined getSelection() as "no selection" (Pin disabled, Copy is a no-op)', () => {
      H.term.getSelection.mockReturnValue(undefined)
      const { container } = render(<TerminalPane {...defaultProps} />)
      openMenu(container)

      expect(screen.getByTestId('terminal-context-menu')).toBeInTheDocument()
      expect(screen.getByText('Pin Selection').closest('button')).toBeDisabled()

      fireEvent.click(screen.getByText('Copy'))
      expect(mockClipboardWriteText).not.toHaveBeenCalled()
    })

    it('banks the selection at xterm onSelectionChange, so right-click Copy survives a repaint that empties getSelection()', () => {
      // The reported bug: select text in a repainting TUI, right-click, and every Copy is greyed
      // out. By the right-click getSelection() is already '' (so `live` and the right-mousedown
      // `fresh` are both null), and the only proactive snapshot used to be the single document
      // mouseup sample — which the repaint/commit race can leave null. xterm's onSelectionChange
      // is the authoritative "a selection exists NOW" signal; banking there means the right-click
      // still has something to copy.
      const { container } = render(<TerminalPane {...defaultProps} />)
      const selCb = H.term.onSelectionChange.mock.calls.at(-1)?.[0] as (() => void) | undefined
      expect(typeof selCb).toBe('function')

      // xterm commits a selection and fires onSelectionChange (output is frozen during the drag).
      H.term.getSelection.mockReturnValue('picked-this-line')
      H.term.hasSelection.mockReturnValue(true)
      act(() => { selCb!() })

      // A repaint then scrolls the selected cells away: xterm clears the model, so getSelection()
      // is empty by the time the user right-clicks. This must NOT drop the already-banked snapshot.
      H.term.getSelection.mockReturnValue('')
      H.term.hasSelection.mockReturnValue(false)
      act(() => { selCb!() })

      // Right-click with no live/fresh selection: only the banked snapshot can keep Copy alive.
      openMenu(container)
      expect(screen.getByTestId('terminal-context-menu')).toBeInTheDocument()

      const copyBtn = screen.getByText('Copy').closest('button')!
      expect(copyBtn).toBeEnabled()

      fireEvent.click(copyBtn)
      expect(mockClipboardWriteText).toHaveBeenCalledWith('picked-this-line')
    })
  })

  // =========================================================================
  // 3. Context-menu dismissal
  // =========================================================================
  describe('context menu key handling', () => {
    it('leaves the menu open for a non-Escape key, and closes it on Escape', () => {
      const { container } = render(<TerminalPane {...defaultProps} />)
      openMenu(container)
      expect(screen.getByTestId('terminal-context-menu')).toBeInTheDocument()

      fireEvent.keyDown(document, { key: 'a' })
      expect(screen.getByTestId('terminal-context-menu')).toBeInTheDocument()

      fireEvent.keyDown(document, { key: 'Escape' })
      expect(screen.queryByTestId('terminal-context-menu')).not.toBeInTheDocument()
    })
  })

  // =========================================================================
  // 4. Mouse-mode DECRST that is neither a tracking-disable nor an alt-screen exit
  // =========================================================================
  describe('mouse-mode DECRST', () => {
    it('an unrelated DECRST (hide cursor, ?25l) passes through and keeps wheel-forwarding armed', () => {
      render(<TerminalPane {...defaultProps} />)
      csi('h')([1002]) // a TUI takes the mouse; we swallow it but remember
      expect(csi('l')([25])).toBe(false) // cursor-hide is xterm's business, not ours

      mockWriteToTerminal.mockClear()
      const handled = H.wheelCbs[0](wheelEv({ deltaY: -100 }))

      expect(handled).toBe(false) // still forwarding to the app…
      expect(mockWriteToTerminal.mock.calls[0][1]).toContain('\x1b[<64;') // …as an SGR wheel-up
    })
  })

  // =========================================================================
  // 5. Export — buffer lines that come back null
  // =========================================================================
  describe('export', () => {
    it('Export Full Scrollback skips null lines past the populated region of the buffer', () => {
      H.term.buffer.active.length = 8 // xterm claims 8 rows; only 5 are materialized
      const { container } = render(<TerminalPane {...defaultProps} />)
      openMenu(container)
      fireEvent.click(screen.getByText('Export Full Scrollback...'))

      expect(mockExportTerminal).toHaveBeenCalledWith({
        content: H.bufferLines.join('\n'),
        defaultFilename: 'terminal-export.txt',
      })
    })
  })

  // =========================================================================
  // 6. Keyboard copy mode — the motions the happy-path suite doesn't reach
  // =========================================================================
  describe('keyboard copy mode', () => {
    const enterCopyMode = (): void => { keyDown({ ctrlKey: true, shiftKey: true, key: ' ' }) }

    it('"a" selects the whole buffer and stays in copy mode', () => {
      render(<TerminalPane {...defaultProps} />)
      enterCopyMode()
      H.term.selectAll.mockClear()

      expect(keyDown({ key: 'a' })).toBe(false) // swallowed — never reaches the shell
      expect(H.term.selectAll).toHaveBeenCalledTimes(1)
      expect(screen.getByTestId('selection-mode-badge')).toBeInTheDocument()
    })

    it('a plain ArrowRight MOVES the caret (collapses the selection to one cell)', () => {
      render(<TerminalPane {...defaultProps} />)
      enterCopyMode()
      keyDown({ shiftKey: true, key: 'ArrowRight' }) // extend to 2 cells
      expect(H.term.select).toHaveBeenLastCalledWith(0, 0, 2)

      H.term.select.mockClear()
      keyDown({ key: 'ArrowRight' }) // no Shift → move, not extend

      // The anchor jumps to the caret, so the 2-cell selection collapses to 1 cell
      // at column 2 — proving a bare arrow moves rather than extending.
      expect(H.term.select).toHaveBeenCalledWith(2, 0, 1)
    })

    it('Ctrl+ArrowRight jumps to the next word boundary using the real line text', () => {
      render(<TerminalPane {...defaultProps} />)
      enterCopyMode()
      H.term.select.mockClear()

      keyDown({ ctrlKey: true, key: 'ArrowRight' })

      // line 0 is "echo hello world" → past "echo" + its space = column 5
      expect(H.term.select).toHaveBeenCalledWith(5, 0, 1)
    })

    it('a word motion over a line xterm cannot materialize falls back to empty text (no crash)', () => {
      H.term.buffer.active.getLine.mockReturnValue(null) // buffer trimmed under us
      render(<TerminalPane {...defaultProps} />)
      enterCopyMode()
      H.term.select.mockClear()

      expect(() => keyDown({ ctrlKey: true, key: 'ArrowRight' })).not.toThrow()
      expect(H.term.select).toHaveBeenCalledWith(0, 0, 1) // caret stays put
    })

    it('Enter with an empty selection exits copy mode without touching the clipboard', () => {
      H.term.getSelection.mockReturnValue('')
      render(<TerminalPane {...defaultProps} />)
      enterCopyMode()
      expect(screen.getByTestId('selection-mode-badge')).toBeInTheDocument()

      keyDown({ key: 'Enter' })

      expect(mockClipboardWriteText).not.toHaveBeenCalled()
      expect(H.term.clearSelection).toHaveBeenCalled()
      expect(screen.queryByTestId('selection-mode-badge')).not.toBeInTheDocument()
    })

    it('a rejected clipboard write still exits copy mode (and never escapes as an unhandled rejection)', async () => {
      H.term.getSelection.mockReturnValue('grabbed')
      mockClipboardWriteText.mockRejectedValue(new Error('clipboard is busy'))
      render(<TerminalPane {...defaultProps} />)
      enterCopyMode()

      keyDown({ key: 'Enter' })

      expect(mockClipboardWriteText).toHaveBeenCalledWith('grabbed')
      expect(screen.queryByTestId('selection-mode-badge')).not.toBeInTheDocument()
      await act(async () => { await Promise.resolve() })
    })
  })

  // =========================================================================
  // 7. Voice — button + hotkey permutations, meter, confirm bar, Groq gate
  // =========================================================================
  describe('voice', () => {
    const withVoiceOn = (settings: Record<string, unknown> = {}) => {
      setStore({
        voiceSettings: {
          enabled: true,
          consentAccepted: true,
          groqModel: 'whisper-large-v3-turbo',
          pushToTalkKey: 'Ctrl+Shift+L',
          pushToTalkMode: 'tapOrHold',
          sendKey: 'Space',
          autoSubmitInAgent: false,
          correctionEnabled: true,
          confirmBeforeRunInShell: true,
          ...settings,
        },
      })
    }

    it('clicking the Voice button while LISTENING stops immediately — no Groq round-trip', async () => {
      withVoiceOn()
      setVoice({ listening: true, status: 'listening' })
      render(<TerminalPane {...defaultProps} />)

      fireEvent.click(screen.getByTestId('voice-toggle-btn'))
      await act(async () => { await Promise.resolve() })

      expect(H.voiceToggle).toHaveBeenCalledTimes(1)
      expect(mockGroqGetKeyStatus).not.toHaveBeenCalled() // stopping never needs a key
    })

    it('toggle mode: the hotkey while listening STOPS and skips the Groq check', () => {
      withVoiceOn({ pushToTalkMode: 'toggle' })
      setVoice({ listening: true, status: 'listening' })
      render(<TerminalPane {...defaultProps} />)

      expect(keyDown({ ctrlKey: true, shiftKey: true, key: 'L' })).toBe(false)

      expect(H.voiceStop).toHaveBeenCalledTimes(1)
      expect(H.voiceStart).not.toHaveBeenCalled()
      expect(mockGroqGetKeyStatus).not.toHaveBeenCalled()
    })

    it('tapSpace mode: pressing the start combo again while listening does NOT restart capture', () => {
      withVoiceOn({ pushToTalkMode: 'tapSpace' })
      setVoice({ listening: true, status: 'listening' })
      render(<TerminalPane {...defaultProps} />)

      expect(keyDown({ ctrlKey: true, shiftKey: true, key: 'L' })).toBe(false) // still swallowed
      expect(H.voiceStart).not.toHaveBeenCalled()
      expect(H.voiceStop).not.toHaveBeenCalled()
    })

    it('tapOrHold: a key AUTO-REPEAT is inert (holding the combo does not restart or stop)', () => {
      withVoiceOn({ pushToTalkMode: 'tapOrHold' })
      setVoice({ listening: false })
      render(<TerminalPane {...defaultProps} />)

      expect(keyDown({ ctrlKey: true, shiftKey: true, key: 'L', repeat: true })).toBe(false)

      expect(H.voiceStart).not.toHaveBeenCalled()
      expect(H.voiceStop).not.toHaveBeenCalled()
    })

    it('tapSpace mode: a blank sendKey falls back to Space', () => {
      withVoiceOn({ pushToTalkMode: 'tapSpace', sendKey: '' })
      setVoice({ listening: true, status: 'listening' })
      render(<TerminalPane {...defaultProps} />)

      expect(keyDown({ key: ' ', code: 'Space' })).toBe(false) // swallowed, not sent to the shell
      expect(H.voiceStop).toHaveBeenCalledTimes(1)
    })

    it('the level meter turns green once the mic is above the reliably-transcribable tick', () => {
      const tick = computeDisplayLevel(RELIABLE_SPEECH_RMS)
      withVoiceOn()
      setVoice({ listening: true, status: 'listening', level: tick + 0.05 })
      const { unmount } = render(<TerminalPane {...defaultProps} />)

      expect(screen.getByTestId('voice-level-fill')).toHaveStyle({ backgroundColor: '#7ee787' })

      // Fresh mount rather than rerender-with-identical-props: TerminalPane is React.memo now, so a
      // parent rerender with unchanged props is (correctly) skipped. In production the voice HOOK's
      // own state change re-renders the pane internally; a remount reads the new mocked level the
      // same way, without depending on the memo boundary.
      unmount()
      setVoice({ listening: true, status: 'listening', level: tick - 0.05 }) // too quiet
      render(<TerminalPane {...defaultProps} />)

      expect(screen.getByTestId('voice-level-fill')).toHaveStyle({ backgroundColor: '#f0b86e' })
    })

    it('the shell confirm bar runs, inserts, or cancels the dictated command', () => {
      withVoiceOn()
      setVoice({ confirm: { text: 'rm -rf ./build' } })
      const { rerender } = render(<TerminalPane {...defaultProps} />)

      expect(screen.getByTestId('voice-confirm-bar')).toHaveTextContent('rm -rf ./build')

      fireEvent.click(screen.getByText('Run'))
      expect(H.voiceConfirmRun).toHaveBeenCalledWith(true) // submit

      fireEvent.click(screen.getByText('Insert'))
      expect(H.voiceConfirmRun).toHaveBeenCalledWith(false) // paste, don't run

      rerender(<TerminalPane {...defaultProps} />)
      fireEvent.click(screen.getByLabelText('Dismiss'))
      expect(H.voiceCancelConfirm).toHaveBeenCalledTimes(1)
    })

    it('dismissing the Groq setup gate closes it and does NOT open Settings', async () => {
      withVoiceOn()
      setVoice({ listening: false })
      mockGroqGetKeyStatus.mockResolvedValue({ success: true, data: { connected: false } })
      render(<TerminalPane {...defaultProps} />)

      fireEvent.click(screen.getByTestId('voice-toggle-btn'))
      await waitFor(() => expect(screen.getByTestId('voice-groq-gate')).toBeInTheDocument())
      expect(H.voiceToggle).not.toHaveBeenCalled() // capture never started

      fireEvent.click(screen.getByTestId('voice-groq-gate-dismiss'))

      expect(screen.queryByTestId('voice-groq-gate')).not.toBeInTheDocument()
      expect(H.setShowSettings).not.toHaveBeenCalled()
    })
  })

  // =========================================================================
  // 8. Overlay buttons
  // =========================================================================
  describe('overlay buttons', () => {
    const claudeStore = () => setStore({ terminals: [{ id: 'term-1', isSwarm: false, agentCommand: 'claude --resume' }] })

    it('closing the Past AI Sessions modal returns to the pane', async () => {
      claudeStore()
      render(<TerminalPane {...defaultProps} />)
      fireEvent.click(screen.getByTestId('past-ai-sessions-btn'))
      expect(screen.getByTestId('past-ai-sessions-overlay')).toBeInTheDocument()

      fireEvent.click(screen.getByTestId('past-ai-close'))

      expect(screen.queryByTestId('past-ai-sessions-overlay')).not.toBeInTheDocument()
    })

    it('clicking the model picker does not bubble out and close the open context menu', () => {
      claudeStore()
      const { container } = render(<TerminalPane {...defaultProps} />)
      openMenu(container)
      expect(screen.getByTestId('terminal-context-menu')).toBeInTheDocument()

      // The picker stops propagation so its click can't reach the document
      // click-to-dismiss listener (or steal focus back into xterm).
      fireEvent.click(screen.getByTestId('model-picker'))

      expect(screen.getByTestId('terminal-context-menu')).toBeInTheDocument()
    })
  })

  // =========================================================================
  // 9. Second Opinion — the failure and label arms
  // =========================================================================
  describe('Second Opinion', () => {
    const INSTALLED = { claude: true, codex: true, agy: true, 'qwen-code': true }

    async function renderWithAgents(installed: Record<string, boolean> = INSTALLED) {
      setStore({ terminals: [{ id: 'term-1', isSwarm: false, agentCommand: 'claude --resume' }] })
      mockDetectAgents.mockResolvedValue({ success: true, data: installed })
      const r = render(<TerminalPane {...defaultProps} />)
      await waitFor(() => expect(screen.getByTestId('second-opinion-picker')).toBeInTheDocument())
      mockWriteToTerminal.mockClear()
      mockReadTerminalBuffer.mockClear()
      return r
    }

    it('selecting the placeholder runs nothing at all', async () => {
      await renderWithAgents()
      fireEvent.change(screen.getByTestId('second-opinion-picker'), { target: { value: '' } })
      await act(async () => { await Promise.resolve() })

      expect(mockReadTerminalBuffer).not.toHaveBeenCalled()
      expect(mockSecondOpinion).not.toHaveBeenCalled()
      expect(mockWriteToTerminal).not.toHaveBeenCalled()
    })

    it('labels the pasted block with the reviewing agent (Qwen)', async () => {
      mockReadTerminalBuffer.mockResolvedValue({ success: true, data: { output: 'a failing test' } })
      mockSecondOpinion.mockResolvedValue({ success: true, data: { feedback: 'Check the mock.' } })
      await renderWithAgents()

      fireEvent.change(screen.getByTestId('second-opinion-picker'), { target: { value: 'qwen' } })
      await waitFor(() => expect(mockWriteToTerminal).toHaveBeenCalled())

      expect(mockSecondOpinion).toHaveBeenCalledWith({ agent: 'qwen', model: undefined, content: 'a failing test' })
      expect(mockWriteToTerminal.mock.calls[0][1]).toContain('=== Second Opinion (Qwen) ===')
      expect(mockWriteToTerminal.mock.calls[0][1]).toContain('Check the mock.')
    })

    it('says "nothing to review" and skips the agent when the buffer read FAILS', async () => {
      mockReadTerminalBuffer.mockResolvedValue({ success: false, error: 'terminal gone' })
      await renderWithAgents()

      fireEvent.change(screen.getByTestId('second-opinion-picker'), { target: { value: 'codex' } })
      await waitFor(() => expect(mockWriteToTerminal).toHaveBeenCalled())

      expect(mockSecondOpinion).not.toHaveBeenCalled()
      expect(mockWriteToTerminal.mock.calls[0][1]).toContain('[Second Opinion: nothing to review yet in this terminal]')
    })

    it('falls back to "no response" when the review fails with no error message', async () => {
      mockReadTerminalBuffer.mockResolvedValue({ success: true, data: { output: 'some output' } })
      mockSecondOpinion.mockResolvedValue({ success: false }) // no `error` field
      await renderWithAgents()

      fireEvent.change(screen.getByTestId('second-opinion-picker'), { target: { value: 'gemini' } })
      await waitFor(() => expect(mockWriteToTerminal).toHaveBeenCalled())

      expect(mockWriteToTerminal.mock.calls[0][1]).toContain('[Second Opinion from Gemini failed: no response]')
    })

    it('re-enables the picker after a review finishes', async () => {
      mockReadTerminalBuffer.mockResolvedValue({ success: true, data: { output: 'x' } })
      await renderWithAgents()
      const picker = screen.getByTestId('second-opinion-picker') as HTMLSelectElement

      fireEvent.change(picker, { target: { value: `claude:${CLAUDE_MODEL_OPTIONS[0].alias}` } })
      await waitFor(() => expect(mockWriteToTerminal).toHaveBeenCalled())

      expect(picker).not.toBeDisabled()
    })
  })

  // =========================================================================
  // 10. Clipboard failure paths — keyboard shortcuts
  // =========================================================================
  describe('clipboard shortcuts under failure', () => {
    it('a rejected rich-clipboard write on Ctrl+Shift+M is swallowed', async () => {
      H.term.getSelection.mockReturnValue('fenced')
      mockClipboardWriteRich.mockRejectedValue(new Error('OLE busy'))
      render(<TerminalPane {...defaultProps} />)

      expect(keyDown({ ctrlKey: true, shiftKey: true, key: 'M' })).toBe(false)

      expect(mockClipboardWriteRich).toHaveBeenCalledWith('```text\nfenced\n```', '<pre><code>fenced</code></pre>')
      await act(async () => { await Promise.resolve() })
    })

    it('a rejected clipboard write on Ctrl+Shift+C is swallowed', async () => {
      H.term.getSelection.mockReturnValue('plain')
      mockClipboardWriteText.mockRejectedValue(new Error('OLE busy'))
      render(<TerminalPane {...defaultProps} />)

      expect(keyDown({ ctrlKey: true, shiftKey: true, key: 'C' })).toBe(false)

      expect(mockClipboardWriteText).toHaveBeenCalledWith('plain')
      await act(async () => { await Promise.resolve() })
    })

    it('Ctrl+C still CLEARS the selection even when the clipboard write rejects', async () => {
      H.term.getSelection.mockReturnValue('sigint-or-copy')
      mockClipboardWriteText.mockRejectedValue(new Error('OLE busy'))
      render(<TerminalPane {...defaultProps} />)

      expect(keyDown({ ctrlKey: true, key: 'c' })).toBe(false) // consumed as a copy, not SIGINT

      expect(mockClipboardWriteText).toHaveBeenCalledWith('sigint-or-copy')
      expect(H.term.clearSelection).toHaveBeenCalled()
      await act(async () => { await Promise.resolve() })
    })

    it('a FAILED clipboard read on Ctrl+Shift+V writes nothing to the pty', async () => {
      mockClipboardReadText.mockResolvedValue({ success: false, error: 'empty' })
      render(<TerminalPane {...defaultProps} />)
      mockWriteToTerminal.mockClear()

      keyDown({ ctrlKey: true, shiftKey: true, key: 'V' })
      await act(async () => { await Promise.resolve() })

      expect(mockClipboardReadText).toHaveBeenCalled()
      expect(mockWriteToTerminal).not.toHaveBeenCalled()
    })

    it('a REJECTED clipboard read on Ctrl+Shift+V writes nothing to the pty', async () => {
      mockClipboardReadText.mockRejectedValue(new Error('no clipboard'))
      render(<TerminalPane {...defaultProps} />)
      mockWriteToTerminal.mockClear()

      keyDown({ ctrlKey: true, shiftKey: true, key: 'V' })
      await act(async () => { await Promise.resolve() })

      expect(mockWriteToTerminal).not.toHaveBeenCalled()
    })

    it('a FAILED clipboard read on Ctrl+V writes nothing to the pty', async () => {
      mockClipboardReadText.mockResolvedValue({ success: false })
      render(<TerminalPane {...defaultProps} />)
      mockWriteToTerminal.mockClear()

      keyDown({ ctrlKey: true, key: 'v' })
      await act(async () => { await Promise.resolve() })

      expect(mockWriteToTerminal).not.toHaveBeenCalled()
    })

    it('a REJECTED clipboard read on Ctrl+V writes nothing to the pty', async () => {
      mockClipboardReadText.mockRejectedValue(new Error('no clipboard'))
      render(<TerminalPane {...defaultProps} />)
      mockWriteToTerminal.mockClear()

      keyDown({ ctrlKey: true, key: 'v' })
      await act(async () => { await Promise.resolve() })

      expect(mockWriteToTerminal).not.toHaveBeenCalled()
    })
  })

  // =========================================================================
  // 11. Custom macro without run-on-send
  // =========================================================================
  describe('custom macros', () => {
    it('a macro with runOnSend=false types the text but does NOT press Enter', () => {
      setStore({ customKeybindings: [{ id: 'm1', combo: 'Ctrl+Alt+G', text: 'git status', runOnSend: false }] })
      render(<TerminalPane {...defaultProps} />)
      mockWriteToTerminal.mockClear()

      expect(keyDown({ ctrlKey: true, altKey: true, key: 'g' })).toBe(false)

      expect(mockWriteToTerminal).toHaveBeenCalledWith('term-1', 'git status')
    })
  })

  // =========================================================================
  // 12. Prompt parsing → status bar + store cwd (the Git Panel's source of truth)
  // =========================================================================
  describe('prompt parsing', () => {
    it('a parsed prompt publishes cwd + branch to the status bar and back into the store', () => {
      H.parsePrompt.mockReturnValue({ cwd: 'C:/repo/app', gitBranch: 'feature/x' })
      render(<TerminalPane {...defaultProps} />)

      emitPty('user@host MINGW64 /c/repo/app (feature/x)\n$ ')

      expect(H.updateTerminal).toHaveBeenCalledWith('term-1', { cwd: 'C:/repo/app' })
      expect(screen.getByTestId('sb-cwd')).toHaveTextContent('C:/repo/app')
      expect(screen.getByTestId('sb-branch')).toHaveTextContent('feature/x')
    })

    it('a prompt outside a repo clears the branch but still publishes the cwd', () => {
      H.parsePrompt.mockReturnValue({ cwd: '/tmp', gitBranch: null })
      render(<TerminalPane {...defaultProps} />)

      emitPty('$ ')

      expect(H.updateTerminal).toHaveBeenCalledWith('term-1', { cwd: '/tmp' })
      expect(screen.getByTestId('sb-branch')).toHaveTextContent('')
    })

    // The perf guard (v1.27.0): a live shell re-emits the same prompt ~twice a second, and each
    // updateTerminal replaces the whole terminals array → a store-wide re-render. When the cwd hasn't
    // changed, the write must be skipped entirely.
    it('does NOT write to the store when the parsed cwd equals the current one', () => {
      setStore({ terminals: [{ id: 'term-1', isSwarm: false, cwd: '/home/dev/proj' }] })
      H.parsePrompt.mockReturnValue({ cwd: '/home/dev/proj', gitBranch: 'main' })
      render(<TerminalPane {...defaultProps} />)

      emitPty('dev@host /home/dev/proj (main)\n$ ')

      // The status bar still shows it (local state), but no store write for an unchanged cwd.
      expect(screen.getByTestId('sb-cwd')).toHaveTextContent('/home/dev/proj')
      expect(H.updateTerminal).not.toHaveBeenCalledWith('term-1', { cwd: '/home/dev/proj' })
    })
  })

  // =========================================================================
  // 13. Command-fix suggestions that come back empty or fail
  // =========================================================================
  describe('command fix suggestions', () => {
    const runFailingCommand = (): void => {
      typeIntoPty('s'); typeIntoPty('l'); typeIntoPty('\r')
    }

    it('no banner when the OSC 633 failure yields no suggestion', async () => {
      H.getSuggestion.mockResolvedValue(null)
      render(<TerminalPane {...defaultProps} />)
      runFailingCommand()

      emitPty('\x1b]633;E;127\x07')
      await act(async () => { await Promise.resolve() })

      expect(H.getSuggestion).toHaveBeenCalledWith('sl', expect.any(String))
      expect(screen.queryByTestId('command-fix-banner')).not.toBeInTheDocument()
    })

    it('no banner (and no unhandled rejection) when the OSC 633 suggestion lookup THROWS', async () => {
      H.getSuggestion.mockRejectedValue(new Error('corrections index missing'))
      render(<TerminalPane {...defaultProps} />)
      runFailingCommand()

      emitPty('\x1b]633;E;1\x07')
      await act(async () => { await Promise.resolve() })

      expect(screen.queryByTestId('command-fix-banner')).not.toBeInTheDocument()
    })

    it('no banner when the error-pattern lookup yields no suggestion', async () => {
      H.getSuggestion.mockResolvedValue(null)
      render(<TerminalPane {...defaultProps} />)
      runFailingCommand()

      emitPty('bash: sl: command not found\n')
      await act(async () => { await Promise.resolve() })

      expect(H.getSuggestion).toHaveBeenCalled()
      expect(screen.queryByTestId('command-fix-banner')).not.toBeInTheDocument()
    })

    it('no banner (and no unhandled rejection) when the error-pattern lookup THROWS', async () => {
      H.getSuggestion.mockRejectedValue(new Error('boom'))
      render(<TerminalPane {...defaultProps} />)
      runFailingCommand()

      emitPty('bash: sl: command not found\n')
      await act(async () => { await Promise.resolve() })

      expect(screen.queryByTestId('command-fix-banner')).not.toBeInTheDocument()
    })
  })

  // =========================================================================
  // 14. Scrollback replay that never arrives
  // =========================================================================
  describe('scrollback replay', () => {
    it('a terminal killed before the replay lands does not crash the pane', async () => {
      mockReadTerminalBuffer.mockRejectedValue(new Error('terminal not found'))
      render(<TerminalPane {...defaultProps} />)
      await act(async () => { await Promise.resolve() })

      expect(H.term.write).not.toHaveBeenCalled()
      expect(screen.getByTestId('terminal-status-bar')).toBeInTheDocument()
    })
  })

  // =========================================================================
  // 15. Disposal races — a callback from a torn-down terminal must never write
  //     state into the terminal that replaced it.
  // =========================================================================
  describe('disposal races', () => {
    it('the deferred initial fit() is skipped when the pane unmounts before the frame runs', () => {
      H.deferRaf.on = true
      useTimers()
      const { unmount } = render(<TerminalPane {...defaultProps} />)
      expect(H.rafCbs).toHaveLength(1)
      act(() => { vi.advanceTimersByTime(50) }) // drain the become-visible fit while mounted

      unmount()
      H.fitAddons[0].fit.mockClear()

      act(() => { H.rafCbs[0]() }) // the frame lands after teardown

      expect(H.fitAddons[0].fit).not.toHaveBeenCalled() // fitting a disposed xterm throws
    })

    it('a ResizeObserver notification that lands after unmount never resizes the dead pty', () => {
      useTimers()
      const { unmount } = render(<TerminalPane {...defaultProps} />)
      const ro = H.roCbs[0]
      act(() => { vi.advanceTimersByTime(50) }) // drain the become-visible fit while mounted

      unmount()
      mockResizeTerminal.mockClear()
      H.fitAddons[0].fit.mockClear()

      act(() => { ro() })                        // observer fires post-teardown…
      act(() => { vi.advanceTimersByTime(200) }) // …and its 100ms debounce elapses

      expect(H.fitAddons[0].fit).not.toHaveBeenCalled()
      expect(mockResizeTerminal).not.toHaveBeenCalled()
    })

    it('search results from a REPLACED terminal do not hijack the new terminal\'s match count', () => {
      const { rerender } = render(<TerminalPane {...defaultProps} />)
      keyDown({ ctrlKey: true, shiftKey: true, key: 'F' }) // open the find bar
      fireEvent.change(screen.getByTestId('terminal-search-input'), { target: { value: 'needle' } })
      act(() => { H.searchResultCbs[0]({ resultIndex: 2, resultCount: 7 }) })
      expect(screen.getByTestId('terminal-search-count')).toHaveTextContent('3/7')

      rerender(<TerminalPane {...defaultProps} terminalId="term-2" />) // pane adopts a new terminal
      expect(H.searchResultCbs).toHaveLength(2)

      act(() => { H.searchResultCbs[0]({ resultIndex: 8, resultCount: 20 }) }) // stale addon fires

      expect(screen.getByTestId('terminal-search-count')).toHaveTextContent('3/7')
    })

    it('diff output from a REPLACED terminal does not raise the View Diff button', () => {
      const { rerender } = render(<TerminalPane {...defaultProps} />)
      rerender(<TerminalPane {...defaultProps} terminalId="term-2" />)
      expect(H.ptyCbs).toHaveLength(2)
      H.term.write.mockClear()

      emitPty('diff --git a/a.ts b/a.ts\n--- a/a.ts\n', 'term-1', 0) // stale subscription fires

      expect(H.term.write).toHaveBeenCalled() // we did run the disposed handler…
      expect(screen.queryByText('View Diff')).not.toBeInTheDocument() // …but it set no state
    })

    it('a fix suggestion resolved after the terminal is replaced never shows on the new one', async () => {
      let resolveSuggestion: (s: string | null) => void = () => {}
      H.getSuggestion.mockReturnValue(new Promise((r) => { resolveSuggestion = r }))
      const { rerender } = render(<TerminalPane {...defaultProps} />)
      typeIntoPty('s'); typeIntoPty('l'); typeIntoPty('\r')
      emitPty('\x1b]633;E;127\x07') // OSC exit-code marker → suggestion lookup starts
      expect(H.getSuggestion).toHaveBeenCalledTimes(1)

      rerender(<TerminalPane {...defaultProps} terminalId="term-2" />) // user switches the pty

      await act(async () => { resolveSuggestion('ls'); await Promise.resolve() })

      expect(screen.queryByTestId('command-fix-banner')).not.toBeInTheDocument()
    })

    it('an error-pattern suggestion resolved after the terminal is replaced never shows on the new one', async () => {
      let resolveSuggestion: (s: string | null) => void = () => {}
      H.getSuggestion.mockReturnValue(new Promise((r) => { resolveSuggestion = r }))
      const { rerender } = render(<TerminalPane {...defaultProps} />)
      typeIntoPty('s'); typeIntoPty('l'); typeIntoPty('\r')
      emitPty('bash: sl: command not found\n')
      expect(H.getSuggestion).toHaveBeenCalledTimes(1)

      rerender(<TerminalPane {...defaultProps} terminalId="term-2" />)

      await act(async () => { resolveSuggestion('ls'); await Promise.resolve() })

      expect(screen.queryByTestId('command-fix-banner')).not.toBeInTheDocument()
    })
  })

  // =========================================================================
  // 16. Becoming visible with the pty bridge gone
  // =========================================================================
  describe('visibility', () => {
    it('does not fit (or resize) when the pty bridge has gone away by the time the frame runs', () => {
      useTimers()
      const { rerender } = render(<TerminalPane {...defaultProps} isVisible={false} />)
      H.fitAddons[0].fit.mockClear()
      const saved = (window as any).termpolis.resizeTerminal
      delete (window as any).termpolis.resizeTerminal
      try {
        rerender(<TerminalPane {...defaultProps} isVisible={true} />)
        act(() => { vi.advanceTimersByTime(1) })

        // The guard returns BEFORE fit(), so a torn-down window can't reflow a
        // terminal whose backing pty is already gone.
        expect(H.fitAddons[0].fit).not.toHaveBeenCalled()
      } finally {
        ;(window as any).termpolis.resizeTerminal = saved
      }
    })
  })

  // =========================================================================
  // 17. Drag & drop
  // =========================================================================
  describe('drag and drop', () => {
    it('a drop with no files writes nothing', () => {
      const { container } = render(<TerminalPane {...defaultProps} />)
      mockWriteToTerminal.mockClear()

      fireEvent.drop(pane(container), { dataTransfer: { files: [] } })

      expect(mockWriteToTerminal).not.toHaveBeenCalled()
    })

    it('a dropped File with no Electron `path` yields an empty quoted arg, never "undefined"', () => {
      const { container } = render(<TerminalPane {...defaultProps} />)
      mockWriteToTerminal.mockClear()
      const f = new File(['x'], 'notes.txt', { type: 'text/plain' }) // browser File — no .path

      fireEvent.drop(pane(container), { dataTransfer: { files: [f] } })

      expect(mockWriteToTerminal).toHaveBeenCalledWith('term-1', '""')
    })
  })

  // =========================================================================
  // 18. Context menu under a failing clipboard
  // =========================================================================
  describe('context menu under a failing clipboard', () => {
    it.each([
      ['Copy', () => mockClipboardWriteText, ['grabbed']],
      ['Copy for Teams/Slack', () => mockClipboardWriteRich, ['MSG:grabbed', '<span>grabbed</span>']],
      ['Copy as Code Block', () => mockClipboardWriteRich, ['```text\ngrabbed\n```', '<pre><code>grabbed</code></pre>']],
      ['Copy as Plain Text', () => mockClipboardWriteText, ['PLAIN:grabbed']],
      ['Copy with Command', () => mockClipboardWriteText, ['```text\ngrabbed\n```']],
    ])('%s swallows a rejected clipboard IPC and still closes the menu', async (label, api, args) => {
      H.term.getSelection.mockReturnValue('grabbed')
      mockClipboardWriteText.mockRejectedValue(new Error('clipboard locked'))
      mockClipboardWriteRich.mockRejectedValue(new Error('clipboard locked'))
      const { container } = render(<TerminalPane {...defaultProps} />)
      openMenu(container)

      fireEvent.click(screen.getByText(label as string))

      // The right payload still went out, the rejection stayed contained (one that
      // escapes fails the run as an unhandled rejection), and the menu dismissed.
      expect((api as () => any)()).toHaveBeenCalledWith(...(args as string[]))
      expect(screen.queryByTestId('terminal-context-menu')).not.toBeInTheDocument()
      await act(async () => { await Promise.resolve() })
    })

    it('menu Paste writes nothing when the clipboard read FAILS', async () => {
      mockClipboardReadText.mockResolvedValue({ success: false })
      const { container } = render(<TerminalPane {...defaultProps} />)
      mockWriteToTerminal.mockClear()
      openMenu(container)

      fireEvent.click(screen.getByText('Paste'))
      await act(async () => { await Promise.resolve() })

      expect(mockClipboardReadText).toHaveBeenCalled()
      expect(mockWriteToTerminal).not.toHaveBeenCalled()
      expect(screen.queryByTestId('terminal-context-menu')).not.toBeInTheDocument()
    })

    it('menu Paste writes nothing when the clipboard read REJECTS', async () => {
      mockClipboardReadText.mockRejectedValue(new Error('no clipboard'))
      const { container } = render(<TerminalPane {...defaultProps} />)
      mockWriteToTerminal.mockClear()
      openMenu(container)

      fireEvent.click(screen.getByText('Paste'))
      await act(async () => { await Promise.resolve() })

      expect(mockWriteToTerminal).not.toHaveBeenCalled()
    })
  })

  // =========================================================================
  // 19. Compaction re-primer — the COMPONENT's wiring into useCompactionReprimer.
  //     v1.25.3: a LAUNCH-PRIMED terminal (Claude, seeded via
  //     --append-system-prompt-file) re-primes itself from its system prompt and
  //     must NEVER be typed into. Anything we paste lands at the cursor, on top of
  //     whatever the user is drafting.
  // =========================================================================
  describe('compaction re-primer wiring', () => {
    function claudeAgentPane(launchPrimed: boolean) {
      setAgent(CLAUDE)
      setStore({
        terminals: [{ id: 'term-1', isSwarm: false, agentCommand: 'claude --resume', launchPrimed }],
      })
    }

    const settle = async (ms: number): Promise<void> => {
      await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
      await act(async () => {
        for (let i = 0; i < 8; i++) await Promise.resolve()
      })
    }

    it('never writes into a LAUNCH-PRIMED terminal after a compaction (v1.25.3)', async () => {
      useTimers()
      claudeAgentPane(true)
      render(<TerminalPane {...defaultProps} />)

      emitPty('Compacting conversation… (esc to interrupt · 42s)\n')
      await settle(10_000) // well past the 3s quiet window

      // Claude's system prompt survives compaction and re-calls memory_primer itself.
      expect(mockWriteToTerminal).not.toHaveBeenCalled()
      expect(mockMemoryBuildPrimer).not.toHaveBeenCalled()
    })

    it('re-primes a hand-started agent (no launch seed) once the compaction settles', async () => {
      useTimers()
      claudeAgentPane(false)
      render(<TerminalPane {...defaultProps} />)

      emitPty('Compacting conversation… (esc to interrupt)\n')
      await settle(10_000)

      expect(mockMemoryBuildPrimer).toHaveBeenCalledTimes(1)
      expect(mockWriteToTerminal).toHaveBeenCalledTimes(1)
      const [id, seq] = mockWriteToTerminal.mock.calls[0]
      expect(id).toBe('term-1')
      expect(seq).toContain('memory_primer')          // routed to the MCP tool…
      expect(seq.startsWith('\x1b[200~')).toBe(true)  // …as ONE bracketed paste
      expect(seq.endsWith('\x1b[201~')).toBe(true)
      expect(seq).not.toContain('\r')                 // never auto-submitted
    })

    it('does not re-prime over an un-submitted draft in the input line', async () => {
      useTimers()
      claudeAgentPane(false)
      mockInputPending.mockResolvedValue({ success: true, data: true }) // user is mid-sentence
      render(<TerminalPane {...defaultProps} />)

      emitPty('Compacting conversation…\n')
      await settle(10_000)

      expect(mockWriteToTerminal).not.toHaveBeenCalled() // a paste would corrupt the draft
    })

    it('ordinary output never arms the re-primer', async () => {
      useTimers()
      claudeAgentPane(false)
      render(<TerminalPane {...defaultProps} />)

      emitPty('Running tests… 42 passed\n')
      await settle(10_000)

      expect(mockWriteToTerminal).not.toHaveBeenCalled()
      expect(mockMemoryBuildPrimer).not.toHaveBeenCalled()
    })

    it('a compaction in a PLAIN shell (no agent) is ignored', async () => {
      useTimers()
      setAgent(null) // no agent detected → the reprimer's hasAgent gate is closed
      setStore({ terminals: [{ id: 'term-1', isSwarm: false }] })
      render(<TerminalPane {...defaultProps} />)

      emitPty('grep -n "compacting conversation" log.txt\n')
      await settle(10_000)

      expect(mockWriteToTerminal).not.toHaveBeenCalled()
    })
  })
})
