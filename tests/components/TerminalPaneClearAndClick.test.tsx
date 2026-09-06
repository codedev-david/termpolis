import React from 'react'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'

// v1.39.1 coverage for the two new TerminalPane gestures:
//
//   1. handleTerminalMouseUp — synthesizing a left CLICK back to the pty for a TUI
//      whose mouse tracking Termpolis deliberately swallowed.
//   2. handleClearTerminal — the real `clear` for an AI terminal, reachable three
//      ways (header button, Ctrl+Shift+X, the window-level `termpolis:clear-terminal`
//      event fired by App.tsx).
//
// The mock setup deliberately mirrors tests/components/TerminalPaneBranches.test.tsx —
// same fake xterm Terminal, same fake preload bridge — so the TerminalPane files stay
// comparable. Two additions this behaviour needs and the older files never did:
// `reset`/`scrollToBottom` on the fake terminal, and `clearTerminalBuffer` on the bridge.
//
// xterm never really paints under jsdom, so terminal text is never read off `.xterm`;
// everything here is asserted through the callbacks the fake hands back.

// vi.hoisted runs before the vi.mock factories below, so the fakes they hand out are
// the same objects these tests assert against.
const mocks = vi.hoisted(() => {
  const mockBufferLines = ['line0', 'line1', 'line2', 'line3', 'line4']

  const mockTerminal = {
    open: vi.fn(),
    focus: vi.fn(),
    write: vi.fn(),
    dispose: vi.fn(),
    onData: vi.fn(),
    attachCustomKeyEventHandler: vi.fn(),
    attachCustomWheelEventHandler: vi.fn(),
    getSelection: vi.fn(() => ''),
    hasSelection: vi.fn(() => false),
    onSelectionChange: vi.fn(() => ({ dispose: vi.fn() })),
    clearSelection: vi.fn(),
    selectAll: vi.fn(),
    select: vi.fn(),
    loadAddon: vi.fn(),
    // The two halves of the visible clear. Neither existed on the older TerminalPane
    // fakes because nothing before v1.39.1 called them.
    reset: vi.fn(),
    scrollToBottom: vi.fn(),
    parser: { registerCsiHandler: vi.fn() },
    unicode: { activeVersion: '11', register: vi.fn() },
    options: {} as Record<string, any>,
    cols: 80,
    rows: 24,
    buffer: {
      active: {
        type: 'normal',
        length: mockBufferLines.length,
        viewportY: 0,
        cursorX: 0,
        cursorY: 0,
        baseY: 0,
        getLine: vi.fn((i: number) => {
          if (i < mockBufferLines.length) return { translateToString: vi.fn(() => mockBufferLines[i]) }
          return null
        }),
      },
    },
  }

  return {
    mockTerminal,
    mockBufferLines,
    mockGetState: vi.fn(),
    mockAddTerminal: vi.fn(),
    mockRemoveTerminal: vi.fn(),
    mockFocusActiveTerminal: vi.fn(),
    mockSetShowSettings: vi.fn(),
    mockGetSuggestion: vi.fn(() => Promise.resolve(null as string | null)),
    mockCompletionDismiss: vi.fn(),
    mockTriggerCompletions: vi.fn(),
    mockHandleDropdownKeyIntercept: vi.fn(() => false),
    mockProcessAgentDetection: vi.fn(),
    mockStartRecording: vi.fn(),
    mockStopRecording: vi.fn(),
    mockAppendRecordingEntry: vi.fn(),
  }
})

// --- Callbacks the mock Terminal / preload hand back to us ---
let mockOnDataCb: ((data: string) => void) | null = null
let mockKeyHandlerCb: ((e: KeyboardEvent) => boolean) | null = null
let mockOnTerminalDataCb: ((id: string, data: string) => void) | null = null
// The header badge is `agentFromCommand(agentCommand) ?? detectedAgent`; driving the
// detection hook makes a terminal look like an AI terminal without launching one.
let detectedAgentValue: { name: string; icon: string; color: string } | null = null

// --- Mock xterm.js and addons ---
vi.mock('@xterm/xterm', () => ({
  Terminal: function () { return mocks.mockTerminal },
}))
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: function () { this.fit = vi.fn(); this.dispose = vi.fn() },
}))
vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: function () { this.dispose = vi.fn(); this.onContextLoss = vi.fn() },
}))
vi.mock('@xterm/addon-unicode11', () => ({
  Unicode11Addon: function () { this.dispose = vi.fn() },
}))
vi.mock('@xterm/addon-web-links', () => ({
  WebLinksAddon: function () { this.dispose = vi.fn() },
}))
vi.mock('@xterm/addon-search', () => ({
  SearchAddon: function () {
    this.dispose = vi.fn()
    this.findNext = vi.fn()
    this.findPrevious = vi.fn()
    this.clearDecorations = vi.fn()
    this.onDidChangeResults = () => ({ dispose: vi.fn() })
  },
}))
vi.mock('@xterm/xterm/css/xterm.css', () => ({}))

vi.mock('uuid', () => ({ v4: vi.fn(() => 'mock-uuid-1234') }))

vi.mock('../../src/renderer/src/themes/terminalThemes', () => ({
  getTheme: vi.fn(() => ({ background: '#1e1e1e', foreground: '#d4d4d4' })),
}))

vi.mock('../../src/renderer/src/store/terminalStore', () => {
  const fn = vi.fn((selector?: any) => {
    const state = mocks.mockGetState()
    return selector ? selector(state) : state
  })
  Object.assign(fn, { getState: mocks.mockGetState })
  return { useTerminalStore: fn }
})

vi.mock('../../src/renderer/src/completions/completionEngine', () => ({
  getCompletions: vi.fn(() => Promise.resolve([])),
}))
vi.mock('../../src/renderer/src/corrections/correctionEngine', () => ({
  getSuggestion: mocks.mockGetSuggestion,
}))

vi.mock('../../src/renderer/src/lib/exportTerminal', () => {
  const sel = (term: any): string => (term?.getSelection?.() ?? '') as string
  return {
    stripAnsi: vi.fn((s: string) => s),
    generateFilename: vi.fn(() => 'terminal-export.txt'),
    formatAsCodeBlock: vi.fn((s: string) => '```text\n' + s + '\n```'),
    formatAsCodeBlockHtml: vi.fn((s: string) => '<pre><code>' + s + '</code></pre>'),
    formatAsPlainText: vi.fn((s: string) => s),
    extractSelectionWithLogicalNewlines: vi.fn((term: any) => sel(term)),
    formatAsCodeBlockFromTerm: vi.fn((term: any) => '```text\n' + sel(term) + '\n```'),
    formatAsCodeBlockHtmlFromTerm: vi.fn((term: any) => '<pre><code>' + sel(term) + '</code></pre>'),
    formatAsPlainTextFromTerm: vi.fn((term: any) => sel(term)),
    formatAsMessageHtmlFromTerm: vi.fn((term: any) => '<span style="font-family:monospace">' + sel(term) + '</span>'),
    formatAsMessagePlainTextFromTerm: vi.fn((term: any) => sel(term)),
    writeCodeBlockToClipboard: vi.fn(() => Promise.resolve()),
    writeCodeBlockToClipboardFromTerm: vi.fn(() => Promise.resolve()),
  }
})

// Identity throttle: term.write() lands synchronously, so "was the buffered output
// flushed?" is a direct assertion rather than a timer race.
vi.mock('../../src/renderer/src/lib/outputThrottle', () => ({
  createOutputThrottle: vi.fn((cb: (data: string) => void) => cb),
}))
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
    suggestions: [],
    selectedIndex: 0,
    dropdownPosition: { x: 0, y: 0 },
    dropdownVisible: false,
    dismissDropdown: mocks.mockCompletionDismiss,
    triggerCompletions: mocks.mockTriggerCompletions,
    acceptSuggestion: vi.fn(),
    handleDropdownKeyIntercept: mocks.mockHandleDropdownKeyIntercept,
    isDropdownVisibleRef: { current: false },
    suggestionsRef: { current: [] },
    autocompleteEnabledRef: { current: true },
  })),
}))
vi.mock('../../src/renderer/src/hooks/useAgentDetection', () => ({
  useAgentDetection: vi.fn(() => ({
    detectedAgent: detectedAgentValue,
    processAgentDetection: mocks.mockProcessAgentDetection,
    agentDetectedRef: { current: false },
  })),
}))
vi.mock('../../src/renderer/src/hooks/useSessionRecording', () => ({
  useSessionRecording: vi.fn(() => ({
    isRecording: false,
    startRecording: mocks.mockStartRecording,
    stopRecording: mocks.mockStopRecording,
    appendRecordingEntry: mocks.mockAppendRecordingEntry,
    isRecordingRef: { current: false },
  })),
}))
vi.mock('../../src/renderer/src/lib/voice/voiceEngines', () => ({
  createVoiceEngine: () => ({ transcribe: vi.fn(), warm: vi.fn(async () => {}), dispose: vi.fn() }),
}))

// --- Child components ---
vi.mock('../../src/renderer/src/components/CompletionDropdown/CompletionDropdown', () => ({
  CompletionDropdown: () => <div data-testid="completion-dropdown" />,
}))
vi.mock('../../src/renderer/src/components/CommandFix/CommandFixBanner', () => ({
  CommandFixBanner: ({ suggestion }: any) => <div data-testid="command-fix-banner">{suggestion}</div>,
}))
vi.mock('../../src/renderer/src/components/StatusBar/TerminalStatusBar', () => ({
  TerminalStatusBar: () => <div data-testid="terminal-status-bar" />,
}))
vi.mock('../../src/renderer/src/components/DiffViewer/DiffViewer', () => ({
  DiffViewer: () => <div data-testid="diff-viewer" />,
}))
vi.mock('../../src/renderer/src/components/PinnedOutput/PinnedOutput', () => ({
  PinnedOutput: ({ pins }: any) => (
    <div data-testid="pinned-output">
      {pins.map((p: any) => (<div key={p.id} data-testid={`pin-${p.id}`}>{p.text}</div>))}
    </div>
  ),
}))

// --- window.termpolis ---
const mockWriteToTerminal = vi.fn()
const mockReadTerminalBuffer = vi.fn(() => Promise.resolve({ success: true, data: { output: '' } }))
const mockClearTerminalBuffer = vi.fn(() => Promise.resolve({ success: true }))
const mockAppendHistory = vi.fn()
const mockOnTerminalData = vi.fn((cb: (id: string, data: string) => void) => {
  mockOnTerminalDataCb = cb
  return vi.fn()
})
const mockClipboardWriteText = vi.fn(() => Promise.resolve({ success: true }))
const mockDetectAgents = vi.fn(async () => ({ success: true, data: { claude: true, codex: true, agy: true } }))

beforeAll(() => {
  ;(window as any).termpolis = {
    writeToTerminal: mockWriteToTerminal,
    readTerminalBuffer: mockReadTerminalBuffer,
    clearTerminalBuffer: mockClearTerminalBuffer,
    onTerminalData: mockOnTerminalData,
    appendHistory: mockAppendHistory,
    exportTerminal: vi.fn(),
    resizeTerminal: vi.fn(),
    createTerminal: vi.fn(() => Promise.resolve()),
    killTerminal: vi.fn(),
    clipboardWriteText: mockClipboardWriteText,
    clipboardReadText: vi.fn(() => Promise.resolve({ success: true, data: 'pasted-text' })),
    clipboardWriteRich: vi.fn(() => Promise.resolve({ success: true })),
    listAISessions: vi.fn().mockResolvedValue({ success: true, data: [] }),
    groqGetKeyStatus: vi.fn(async () => ({ success: true, data: { connected: true, hint: 'gsk_test' } })),
    detectAgents: mockDetectAgents,
    secondOpinion: vi.fn(() => Promise.resolve({ success: true, data: { feedback: 'ok' } })),
    platformInfo: { platform: 'win32', windowsPty: { backend: 'conpty', buildNumber: 22631 } },
  }

  vi.stubGlobal('ResizeObserver', class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  })
  vi.stubGlobal('requestAnimationFrame', (cb: () => void) => { cb(); return 0 })
})

// Import after every mock is registered.
import { TerminalPane } from '../../src/renderer/src/components/TerminalPane/TerminalPane'
import { DEFAULT_KEYBINDINGS } from '../../src/renderer/src/lib/keybindings'

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

const CLAUDE_BADGE = { name: 'Claude Code', icon: 'fa-solid fa-robot', color: '#D97706' }

// A plain, unmodified left button — the only chord that arms a click forward.
const PLAIN_LEFT = { button: 0, altKey: false, shiftKey: false, ctrlKey: false, metaKey: false }

const paneOf = (container: HTMLElement): HTMLElement => container.querySelector('.flex-1.relative') as HTMLElement

// Mount and let the pane's async agent detection settle inside act(), so no state
// update lands after the assertions.
const renderPane = async (
  props: Partial<typeof defaultProps> = {},
): Promise<ReturnType<typeof render>> => {
  let result!: ReturnType<typeof render>
  await act(async () => { result = render(<TerminalPane {...defaultProps} {...props} />) })
  return result
}

// A fake xterm screen with real geometry: 800px / 80 cols = 10px per col,
// 480px / 24 rows = 20px per row. So clientX 85 -> col 9, clientY 50 -> row 3.
const mountScreen = (container: HTMLElement, rect?: Partial<DOMRect>): HTMLElement => {
  const screenEl = document.createElement('div')
  screenEl.className = 'xterm-screen'
  screenEl.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 800, height: 480, right: 800, bottom: 480, x: 0, y: 0, toJSON: () => ({}), ...rect }) as DOMRect
  paneOf(container).appendChild(screenEl)
  return screenEl
}

// Replay the DECSET a TUI sends to grab the mouse. TerminalPane swallows it (so drag
// still selects text) but remembers that the app wanted the mouse — which is exactly
// the flag the click forward is gated on.
const appRequestsMouseTracking = (params: number[] = [1002]): void => {
  const calls = mocks.mockTerminal.parser.registerCsiHandler.mock.calls as any[]
  const h = [...calls].reverse().find((c) => c[0]?.final === 'h')?.[1] as (p: (number | number[])[]) => boolean
  h(params)
}

// The exact press+release pair a left click at (col, row) becomes in SGR encoding.
const sgrClick = (col: number, row: number): string => `\x1b[<0;${col};${row}M\x1b[<0;${col};${row}m`

// Ctrl+Shift+X, shaped the way matchesKeybinding reads it.
const clearKeyEvent = (over: Partial<KeyboardEvent> = {}): KeyboardEvent =>
  ({
    type: 'keydown',
    key: 'X',
    ctrlKey: true,
    shiftKey: true,
    altKey: false,
    metaKey: false,
    preventDefault: vi.fn(),
    ...over,
  }) as unknown as KeyboardEvent

describe('TerminalPane — click forwarding and clear (v1.39.1)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockOnDataCb = null
    mockKeyHandlerCb = null
    mockOnTerminalDataCb = null
    detectedAgentValue = null

    mocks.mockTerminal.onData.mockImplementation((cb: (data: string) => void) => {
      mockOnDataCb = cb
      return { dispose: vi.fn() }
    })
    mocks.mockTerminal.attachCustomKeyEventHandler.mockImplementation((cb: (e: KeyboardEvent) => boolean) => {
      mockKeyHandlerCb = cb
      return { dispose: vi.fn() }
    })
    mocks.mockTerminal.onSelectionChange.mockImplementation(() => ({ dispose: vi.fn() }))
    mocks.mockTerminal.getSelection.mockReturnValue('')
    mocks.mockTerminal.hasSelection.mockReturnValue(false)
    mocks.mockGetState.mockImplementation(() => ({
      terminals: [{ id: 'term-1', isSwarm: false }],
      addTerminal: mocks.mockAddTerminal,
      removeTerminal: mocks.mockRemoveTerminal,
      focusActiveTerminal: mocks.mockFocusActiveTerminal,
      setShowSettings: mocks.mockSetShowSettings,
      focusNonce: 0,
      autocompleteEnabled: true,
      allowAppMouseControl: false,
      voiceSettings: { enabled: false },
      keybindings: { ...DEFAULT_KEYBINDINGS },
      customKeybindings: [],
    }))
    mocks.mockGetSuggestion.mockResolvedValue(null)
    mockOnTerminalData.mockImplementation((cb: (id: string, data: string) => void) => {
      mockOnTerminalDataCb = cb
      return vi.fn()
    })
    mockReadTerminalBuffer.mockResolvedValue({ success: true, data: { output: '' } })
    mockClearTerminalBuffer.mockResolvedValue({ success: true })
    mockClipboardWriteText.mockResolvedValue({ success: true })
    mockDetectAgents.mockResolvedValue({ success: true, data: { claude: true, codex: true, agy: true } })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    mocks.mockTerminal.buffer.active.type = 'normal'
  })

  // =====================================================
  // 1. handleTerminalMouseUp — forwarding a swallowed left click to the pty.
  //
  // Termpolis swallows a TUI's mouse-tracking DECSET so a drag keeps selecting text,
  // which also swallows the app's clicks — Claude Code's diff panel ✕ became
  // unreachable, with no keyboard equivalent. This synthesizes the click back.
  // =====================================================
  describe('forwarding a click to a mouse-tracking app', () => {
    it('sends an SGR press+release pair for a plain stationary left click', async () => {
      const { container } = await renderPane()
      const screenEl = mountScreen(container)
      appRequestsMouseTracking()
      mockWriteToTerminal.mockClear()

      fireEvent.mouseDown(screenEl, { ...PLAIN_LEFT, clientX: 85, clientY: 50 })
      fireEvent.mouseUp(screenEl, { ...PLAIN_LEFT, clientX: 85, clientY: 50 })

      // BOTH reports go out together: a TUI that acts on release (several do) would
      // otherwise see the button held down forever.
      expect(mockWriteToTerminal).toHaveBeenCalledWith('term-1', sgrClick(9, 3))
    })

    it('reports the cell under the pointer, not the pixel', async () => {
      // The pty speaks in cells; getting this wrong points the app's click at the
      // wrong widget, which is worse than not forwarding at all.
      const { container } = await renderPane()
      const screenEl = mountScreen(container)
      appRequestsMouseTracking()
      mockWriteToTerminal.mockClear()

      fireEvent.mouseDown(screenEl, { ...PLAIN_LEFT, clientX: 5, clientY: 5 })
      fireEvent.mouseUp(screenEl, { ...PLAIN_LEFT, clientX: 5, clientY: 5 })
      expect(mockWriteToTerminal).toHaveBeenLastCalledWith('term-1', sgrClick(1, 1))

      fireEvent.mouseDown(screenEl, { ...PLAIN_LEFT, clientX: 795, clientY: 475 })
      fireEvent.mouseUp(screenEl, { ...PLAIN_LEFT, clientX: 795, clientY: 475 })
      expect(mockWriteToTerminal).toHaveBeenLastCalledWith('term-1', sgrClick(80, 24))
    })

    it('answers cell 1,1 for a pane that has not been laid out yet', async () => {
      // A 0x0 screen rect (hidden pane / pre-layout tab). Dividing by a zero cell size
      // would put Infinity in the escape sequence; cellFromPoint clamps to 1,1 instead.
      const { container } = await renderPane()
      const screenEl = mountScreen(container, { width: 0, height: 0, right: 0, bottom: 0 })
      appRequestsMouseTracking()
      mockWriteToTerminal.mockClear()

      fireEvent.mouseDown(screenEl, { ...PLAIN_LEFT, clientX: 85, clientY: 50 })
      fireEvent.mouseUp(screenEl, { ...PLAIN_LEFT, clientX: 85, clientY: 50 })

      expect(mockWriteToTerminal).toHaveBeenCalledWith('term-1', sgrClick(1, 1))
    })

    it('stays silent in a plain shell where nothing asked for the mouse', async () => {
      // No mouse-tracking DECSET was ever seen, so nothing swallowed a click and
      // there is nothing to give back. Injecting escape bytes into bash would echo
      // them onto the command line.
      const { container } = await renderPane()
      const screenEl = mountScreen(container)
      mockWriteToTerminal.mockClear()

      fireEvent.mouseDown(screenEl, { ...PLAIN_LEFT, clientX: 85, clientY: 50 })
      fireEvent.mouseUp(screenEl, { ...PLAIN_LEFT, clientX: 85, clientY: 50 })

      expect(mockWriteToTerminal).not.toHaveBeenCalled()
    })

    it('stops forwarding once the app disables mouse tracking', async () => {
      // The app exited or switched off tracking. Its successor on this pty never asked
      // for clicks, so the flag must go stale-safe rather than latch on forever.
      const { container } = await renderPane()
      const screenEl = mountScreen(container)
      appRequestsMouseTracking()

      const calls = mocks.mockTerminal.parser.registerCsiHandler.mock.calls as any[]
      const l = [...calls].reverse().find((c) => c[0]?.final === 'l')?.[1] as (p: (number | number[])[]) => boolean
      l([1002])
      mockWriteToTerminal.mockClear()

      fireEvent.mouseDown(screenEl, { ...PLAIN_LEFT, clientX: 85, clientY: 50 })
      fireEvent.mouseUp(screenEl, { ...PLAIN_LEFT, clientX: 85, clientY: 50 })

      expect(mockWriteToTerminal).not.toHaveBeenCalled()
    })

    it('defers to xterm when the user opted into native app mouse control', async () => {
      // With the opt-in on, the DECSET is never swallowed — xterm delivers the click
      // itself. Forwarding here too would give the app the same click twice.
      const { container, rerender } = await renderPane()
      const screenEl = mountScreen(container)
      appRequestsMouseTracking() // arm the flag while the opt-in is still off

      mocks.mockGetState.mockImplementation(() => ({
        terminals: [{ id: 'term-1', isSwarm: false }],
        addTerminal: mocks.mockAddTerminal,
        removeTerminal: mocks.mockRemoveTerminal,
        focusActiveTerminal: mocks.mockFocusActiveTerminal,
        setShowSettings: mocks.mockSetShowSettings,
        focusNonce: 0,
        autocompleteEnabled: true,
        allowAppMouseControl: true,
        voiceSettings: { enabled: false },
        keybindings: { ...DEFAULT_KEYBINDINGS },
        customKeybindings: [],
      }))
      // TerminalPane is React.memo'd, so a re-render with byte-identical props is
      // skipped and the ref would never pick the new store value up. Vary a cosmetic
      // prop to force the render that copies allowAppMouseControl into its ref.
      await act(async () => {
        rerender(<TerminalPane {...defaultProps} terminalName="Terminal 1 " />)
      })
      mockWriteToTerminal.mockClear()

      fireEvent.mouseDown(screenEl, { ...PLAIN_LEFT, clientX: 85, clientY: 50 })
      fireEvent.mouseUp(screenEl, { ...PLAIN_LEFT, clientX: 85, clientY: 50 })

      expect(mockWriteToTerminal).not.toHaveBeenCalled()
    })

    it('leaves every modified click purely local', async () => {
      // Shift overrides app mouse capture, Ctrl opens links, Alt+Shift is the copy
      // anchor. A modified press records no click start, so none of them can be
      // turned into a button report for the app.
      const { container } = await renderPane()
      const screenEl = mountScreen(container)
      appRequestsMouseTracking()

      for (const mod of [{ shiftKey: true }, { ctrlKey: true }, { altKey: true }, { metaKey: true }]) {
        mockWriteToTerminal.mockClear()
        fireEvent.mouseDown(screenEl, { ...PLAIN_LEFT, ...mod, clientX: 85, clientY: 50 })
        fireEvent.mouseUp(screenEl, { ...PLAIN_LEFT, ...mod, clientX: 85, clientY: 50 })
        expect(mockWriteToTerminal).not.toHaveBeenCalled()
      }

      // Positive control: the same press with no modifier does forward, so the four
      // silences above are the modifier check and not a broken fixture.
      fireEvent.mouseDown(screenEl, { ...PLAIN_LEFT, clientX: 85, clientY: 50 })
      fireEvent.mouseUp(screenEl, { ...PLAIN_LEFT, clientX: 85, clientY: 50 })
      expect(mockWriteToTerminal).toHaveBeenCalledWith('term-1', sgrClick(9, 3))
    })

    it('ignores a release of a button other than the left one', async () => {
      // Right-click belongs to the context menu; middle-click is paste on X11.
      // Neither is a left click and neither may be reported as one.
      const { container } = await renderPane()
      const screenEl = mountScreen(container)
      appRequestsMouseTracking()
      mockWriteToTerminal.mockClear()

      fireEvent.mouseDown(screenEl, { ...PLAIN_LEFT, clientX: 85, clientY: 50 })
      fireEvent.mouseUp(screenEl, { ...PLAIN_LEFT, button: 2, clientX: 85, clientY: 50 })

      expect(mockWriteToTerminal).not.toHaveBeenCalled()
    })

    it('ignores a release that no press in this pane armed', async () => {
      // A mouseup with no recorded start: the press landed elsewhere and the drag
      // ended over the terminal, or a synthetic event arrived on its own.
      const { container } = await renderPane()
      const screenEl = mountScreen(container)
      appRequestsMouseTracking()
      mockWriteToTerminal.mockClear()

      fireEvent.mouseUp(screenEl, { ...PLAIN_LEFT, clientX: 85, clientY: 50 })

      expect(mockWriteToTerminal).not.toHaveBeenCalled()
    })

    it('forwards a click exactly once — the armed press is consumed', async () => {
      // The click start is cleared at the top of the handler, before any guard can
      // return early. A repeated mouseup (React StrictMode double-invoke, a stray
      // synthetic event) must not double-click the app's UI.
      const { container } = await renderPane()
      const screenEl = mountScreen(container)
      appRequestsMouseTracking()
      mockWriteToTerminal.mockClear()

      fireEvent.mouseDown(screenEl, { ...PLAIN_LEFT, clientX: 85, clientY: 50 })
      fireEvent.mouseUp(screenEl, { ...PLAIN_LEFT, clientX: 85, clientY: 50 })
      fireEvent.mouseUp(screenEl, { ...PLAIN_LEFT, clientX: 85, clientY: 50 })

      expect(mockWriteToTerminal).toHaveBeenCalledTimes(1)
    })

    it('treats a press that travelled as a drag, not a click', async () => {
      // This is the gesture that used to select text and still must: forwarding it
      // would hand the app a click at the release cell and eat the selection.
      const { container } = await renderPane()
      const screenEl = mountScreen(container)
      appRequestsMouseTracking()
      mockWriteToTerminal.mockClear()

      fireEvent.mouseDown(screenEl, { ...PLAIN_LEFT, clientX: 85, clientY: 50 })
      fireEvent.mouseUp(screenEl, { ...PLAIN_LEFT, clientX: 200, clientY: 50 })

      expect(mockWriteToTerminal).not.toHaveBeenCalled()
    })

    it('tolerates the sub-pixel wobble of a real finger or mouse', async () => {
      // Nobody releases on the exact pixel they pressed. A few px of travel is still
      // a click (CLICK_MAX_MOVE_PX), and the cell reported is the RELEASE cell.
      const { container } = await renderPane()
      const screenEl = mountScreen(container)
      appRequestsMouseTracking()
      mockWriteToTerminal.mockClear()

      fireEvent.mouseDown(screenEl, { ...PLAIN_LEFT, clientX: 85, clientY: 50 })
      fireEvent.mouseUp(screenEl, { ...PLAIN_LEFT, clientX: 88, clientY: 53 })

      expect(mockWriteToTerminal).toHaveBeenCalledWith('term-1', sgrClick(9, 3))
    })

    it('treats a long press-and-hold as a drag, not a click', async () => {
      // Held past CLICK_MAX_DURATION_MS the user was doing something else — a slow
      // drag-select, or they pressed and thought better of it.
      const { container } = await renderPane()
      const screenEl = mountScreen(container)
      appRequestsMouseTracking()
      mockWriteToTerminal.mockClear()

      const now = vi.spyOn(Date, 'now').mockReturnValue(10_000)
      fireEvent.mouseDown(screenEl, { ...PLAIN_LEFT, clientX: 85, clientY: 50 })
      now.mockReturnValue(10_800)
      fireEvent.mouseUp(screenEl, { ...PLAIN_LEFT, clientX: 85, clientY: 50 })

      expect(mockWriteToTerminal).not.toHaveBeenCalled()
    })

    it('lets a live selection veto the forward outright', async () => {
      // If text is highlighted, this release ended a selection — it was not a button
      // press at the app. Forwarding would make the app act AND wipe the highlight.
      const { container } = await renderPane()
      const screenEl = mountScreen(container)
      appRequestsMouseTracking()
      mocks.mockTerminal.hasSelection.mockReturnValue(true)
      mockWriteToTerminal.mockClear()

      fireEvent.mouseDown(screenEl, { ...PLAIN_LEFT, clientX: 85, clientY: 50 })
      fireEvent.mouseUp(screenEl, { ...PLAIN_LEFT, clientX: 85, clientY: 50 })

      expect(mockWriteToTerminal).not.toHaveBeenCalled()
    })

    it('stays silent before xterm has painted a screen to measure', async () => {
      // The pane is mounted but the renderer has not produced `.xterm-screen` yet, so
      // there is no geometry — a report built from a guessed cell is worse than none.
      const { container } = await renderPane()
      appRequestsMouseTracking()
      expect(paneOf(container).querySelector('.xterm-screen')).toBeNull()
      mockWriteToTerminal.mockClear()

      fireEvent.mouseDown(paneOf(container), { ...PLAIN_LEFT, clientX: 85, clientY: 50 })
      fireEvent.mouseUp(paneOf(container), { ...PLAIN_LEFT, clientX: 85, clientY: 50 })
      expect(mockWriteToTerminal).not.toHaveBeenCalled()

      // Positive control: the identical gesture forwards once the screen exists.
      mountScreen(container)
      fireEvent.mouseDown(paneOf(container), { ...PLAIN_LEFT, clientX: 85, clientY: 50 })
      fireEvent.mouseUp(paneOf(container), { ...PLAIN_LEFT, clientX: 85, clientY: 50 })
      expect(mockWriteToTerminal).toHaveBeenCalledWith('term-1', sgrClick(9, 3))
    })
  })

  // =====================================================
  // 2. The header Clear button — offered on AI terminals only.
  // =====================================================
  describe('the Clear button', () => {
    it('is hidden on a plain shell terminal', async () => {
      // A shell already has `clear`; the button would be redundant chrome over bash.
      await renderPane()

      expect(screen.queryByTestId('clear-terminal-btn')).not.toBeInTheDocument()
    })

    it('appears once the pane is running an AI agent', async () => {
      // An agent owns the screen and repaints over `clear`, so the button is the only
      // discoverable way to wipe the pane.
      detectedAgentValue = CLAUDE_BADGE
      await renderPane()

      expect(screen.getByTestId('clear-terminal-btn')).toBeInTheDocument()
    })

    it('clears the pty-side buffer BEFORE resetting xterm', async () => {
      // Order is load-bearing. TerminalPane replays readTerminalBuffer() into a fresh
      // xterm on every mount, so clearing only the renderer is undone by the next tab
      // switch. Clearing the source first also means nothing arriving mid-clear is
      // left stranded on screen.
      detectedAgentValue = CLAUDE_BADGE
      await renderPane()

      await act(async () => { fireEvent.click(screen.getByTestId('clear-terminal-btn')) })

      expect(mockClearTerminalBuffer).toHaveBeenCalledWith('term-1')
      expect(mocks.mockTerminal.reset).toHaveBeenCalledTimes(1)
      expect(mocks.mockTerminal.scrollToBottom).toHaveBeenCalledTimes(1)
      expect(mockClearTerminalBuffer.mock.invocationCallOrder[0])
        .toBeLessThan(mocks.mockTerminal.reset.mock.invocationCallOrder[0])
    })

    it('never sends the clear to the pty', async () => {
      // Deliberate asymmetry: Termpolis may throw away its own scrollback, but it has
      // no business rewriting the agent's history behind its back. The agent still
      // remembers the conversation; only what was DRAWN is forgotten.
      detectedAgentValue = CLAUDE_BADGE
      await renderPane()
      mockWriteToTerminal.mockClear()

      await act(async () => { fireEvent.click(screen.getByTestId('clear-terminal-btn')) })

      expect(mockWriteToTerminal).not.toHaveBeenCalled()
    })

    it('still clears the screen when the main process refuses the buffer clear', async () => {
      // A failed IPC leaves replay able to restore the old text on the next mount —
      // worse than nothing, but not worth refusing the visible half of the action over.
      detectedAgentValue = CLAUDE_BADGE
      mockClearTerminalBuffer.mockRejectedValue(new Error('main process is gone'))
      await renderPane()

      await act(async () => { fireEvent.click(screen.getByTestId('clear-terminal-btn')) })

      expect(mocks.mockTerminal.reset).toHaveBeenCalledTimes(1)
      expect(mocks.mockTerminal.scrollToBottom).toHaveBeenCalledTimes(1)
    })
  })

  // =====================================================
  // 3. What handleClearTerminal has to forget alongside the text.
  //
  // Everything below is derived from output that just went away. Leaving any of it
  // set is how you get a diff badge on an empty terminal, or a context menu that
  // will happily paste text the user can no longer see.
  // =====================================================
  describe('resetting the state derived from the cleared text', () => {
    const clearViaButton = async (): Promise<void> => {
      await act(async () => { fireEvent.click(screen.getByTestId('clear-terminal-btn')) })
    }

    it('takes down the diff badge and closes an open diff viewer', async () => {
      detectedAgentValue = CLAUDE_BADGE
      await renderPane()

      act(() => { mockOnTerminalDataCb?.('term-1', 'diff --git a/a.ts b/a.ts\n') })
      fireEvent.click(screen.getByRole('button', { name: /View Diff/ }))
      expect(screen.getByTestId('diff-viewer')).toBeInTheDocument()

      await clearViaButton()

      expect(screen.queryByTestId('diff-viewer')).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /View Diff/ })).not.toBeInTheDocument()
    })

    it('does not let the badge come back from output that was already cleared', async () => {
      // Diff detection re-tests the WHOLE accumulated output buffer on every chunk.
      // If the buffer survived the clear, the next unrelated byte of output would
      // re-match the old diff and pop the badge back up on an empty screen.
      detectedAgentValue = CLAUDE_BADGE
      await renderPane()

      act(() => { mockOnTerminalDataCb?.('term-1', 'diff --git a/a.ts b/a.ts\n') })
      expect(screen.getByRole('button', { name: /View Diff/ })).toBeInTheDocument()

      await clearViaButton()
      act(() => { mockOnTerminalDataCb?.('term-1', 'just a prompt\n') })

      expect(screen.queryByRole('button', { name: /View Diff/ })).not.toBeInTheDocument()
    })

    it('dismisses the command-fix banner', async () => {
      // The banner offers a fix for a command whose failure is no longer on screen.
      detectedAgentValue = CLAUDE_BADGE
      mocks.mockGetSuggestion.mockResolvedValue('npm install')
      await renderPane()

      act(() => { mockOnDataCb?.('npm') })
      act(() => { mockOnDataCb?.('\r') })
      await act(async () => { mockOnTerminalDataCb?.('term-1', 'command not found: npm') })
      expect(screen.getByTestId('command-fix-banner')).toBeInTheDocument()

      await clearViaButton()

      expect(screen.queryByTestId('command-fix-banner')).not.toBeInTheDocument()
    })

    it('forgets the half-typed command line', async () => {
      // The user's in-progress input was wiped off the screen with everything else.
      // Keeping it would make the next Enter submit a line nobody can see, and record
      // it to history as though they had typed it.
      detectedAgentValue = CLAUDE_BADGE
      await renderPane()

      act(() => { mockOnDataCb?.('npm i') })
      await clearViaButton()
      act(() => { mockOnDataCb?.('\r') })

      expect(mockAppendHistory).not.toHaveBeenCalled()

      // Positive control: typing after the clear still records normally, so the
      // silence above is the reset and not a dead onData callback.
      act(() => { mockOnDataCb?.('ls') })
      act(() => { mockOnDataCb?.('\r') })
      expect(mockAppendHistory).toHaveBeenCalledWith('term-1', 'Terminal 1', 'ls')
    })

    it('drops output that was parked behind a live selection', async () => {
      // Output freezes while the user drags. Flushing that backlog into the freshly
      // reset screen would repaint the very text they asked to be rid of.
      detectedAgentValue = CLAUDE_BADGE
      const { container } = await renderPane()

      fireEvent.mouseDown(paneOf(container), { ...PLAIN_LEFT, clientX: 10, clientY: 10 })
      mocks.mockTerminal.write.mockClear()
      act(() => { mockOnTerminalDataCb?.('term-1', 'output parked during the drag') })
      expect(mocks.mockTerminal.write).not.toHaveBeenCalled()

      await clearViaButton()
      fireEvent.mouseUp(document)

      expect(mocks.mockTerminal.write).not.toHaveBeenCalled()
    })

    it('forgets the banked drag-end selection so the context menu cannot re-paste it', async () => {
      // The banked snapshot outlives xterm's own selection by design (agent repaints
      // clear it). After a clear that text is gone from the pane, so the menu must
      // stop offering it.
      detectedAgentValue = CLAUDE_BADGE
      const { container } = await renderPane()

      mocks.mockTerminal.hasSelection.mockReturnValue(true)
      mocks.mockTerminal.getSelection.mockReturnValue('the line the user dragged over')
      fireEvent.mouseUp(document) // drag ends: the snapshot is banked here
      mocks.mockTerminal.hasSelection.mockReturnValue(false)
      mocks.mockTerminal.getSelection.mockReturnValue('')

      // Positive control first: without a clear, the menu still offers the banked text.
      fireEvent.contextMenu(paneOf(container), { clientX: 20, clientY: 20 })
      expect(screen.getByRole('button', { name: /Pin Selection/ })).not.toBeDisabled()
      fireEvent.click(document.body) // dismiss the menu

      await clearViaButton()
      fireEvent.contextMenu(paneOf(container), { clientX: 20, clientY: 20 })

      expect(screen.getByRole('button', { name: /Pin Selection/ })).toBeDisabled()
    })

    it('forgets the right-mousedown selection snapshot', async () => {
      // The press-time snapshot exists so "right-click deselects, then Copy is greyed
      // out" cannot happen. It is only valid for the text that was on screen when the
      // press landed, so a clear in between has to invalidate it.
      detectedAgentValue = CLAUDE_BADGE
      const { container } = await renderPane()

      mocks.mockTerminal.getSelection.mockReturnValue('picked before the right-click')
      fireEvent.mouseDown(paneOf(container), { button: 2, clientX: 20, clientY: 20 })
      mocks.mockTerminal.getSelection.mockReturnValue('') // the press cleared the selection

      await clearViaButton()
      fireEvent.contextMenu(paneOf(container), { clientX: 20, clientY: 20 })

      expect(screen.getByRole('button', { name: /Pin Selection/ })).toBeDisabled()
    })
  })

  // =====================================================
  // 4. The window-level `termpolis:clear-terminal` event (App.tsx fires it when no
  //    terminal has focus). Every pane hears it; only the named one may act.
  // =====================================================
  describe('the termpolis:clear-terminal window event', () => {
    const dispatchClear = async (detail: string): Promise<void> => {
      await act(async () => {
        window.dispatchEvent(new CustomEvent('termpolis:clear-terminal', { detail }))
      })
    }

    it('clears the pane named in the event detail', async () => {
      await renderPane()

      await dispatchClear('term-1')

      expect(mockClearTerminalBuffer).toHaveBeenCalledWith('term-1')
      expect(mocks.mockTerminal.reset).toHaveBeenCalledTimes(1)
    })

    it('leaves every other pane alone', async () => {
      // The event is broadcast to the whole window, so a pane that is not the target
      // must ignore it — otherwise one hotkey would wipe every open terminal.
      await renderPane()

      await dispatchClear('term-2')

      expect(mockClearTerminalBuffer).not.toHaveBeenCalled()
      expect(mocks.mockTerminal.reset).not.toHaveBeenCalled()
    })

    it('stops listening once the pane unmounts', async () => {
      // A leaked listener would keep clearing a pty for a tab the user already closed.
      const { unmount } = await renderPane()
      unmount()

      await dispatchClear('term-1')

      expect(mockClearTerminalBuffer).not.toHaveBeenCalled()
    })
  })

  // =====================================================
  // 5. Ctrl+Shift+X inside attachCustomKeyEventHandler.
  //
  // Handled in the pane rather than passed to the shell: the point is to wipe what
  // Termpolis is holding, and a stray control byte in an agent's prompt is exactly
  // what nobody asked for.
  // =====================================================
  describe('the Ctrl+Shift+X hotkey', () => {
    it('clears the pane and swallows the keystroke', async () => {
      await renderPane()
      const e = clearKeyEvent()

      let handled!: boolean
      await act(async () => { handled = mockKeyHandlerCb!(e) })

      expect(handled).toBe(false) // false = xterm must not also send this to the pty
      expect(e.preventDefault).toHaveBeenCalled()
      expect(mockClearTerminalBuffer).toHaveBeenCalledWith('term-1')
      expect(mocks.mockTerminal.reset).toHaveBeenCalledTimes(1)
    })

    it('works on a plain shell terminal that has no Clear button', async () => {
      // The button is AI-only; the hotkey is the path a shell user has.
      await renderPane()
      expect(screen.queryByTestId('clear-terminal-btn')).not.toBeInTheDocument()

      await act(async () => { mockKeyHandlerCb!(clearKeyEvent()) })

      expect(mockClearTerminalBuffer).toHaveBeenCalledWith('term-1')
    })

    it('fires on keydown only', async () => {
      // Acting on the keyup too would clear twice per press.
      await renderPane()

      await act(async () => { mockKeyHandlerCb!(clearKeyEvent({ type: 'keyup' })) })

      expect(mockClearTerminalBuffer).not.toHaveBeenCalled()
    })

    it('leaves Ctrl+X alone', async () => {
      // Without Shift this is cut / the readline "start of an emacs chord" — stealing
      // it would break editing in every shell.
      await renderPane()
      const e = clearKeyEvent({ key: 'x', shiftKey: false })

      await act(async () => { mockKeyHandlerCb!(e) })

      expect(mockClearTerminalBuffer).not.toHaveBeenCalled()
      expect(e.preventDefault).not.toHaveBeenCalled()
    })

    it('follows a rebound clearTerminal keybinding', async () => {
      // The combo is user-configurable, so the handler must read it from the store on
      // every keystroke rather than hard-code Ctrl+Shift+X.
      mocks.mockGetState.mockImplementation(() => ({
        terminals: [{ id: 'term-1', isSwarm: false }],
        addTerminal: mocks.mockAddTerminal,
        removeTerminal: mocks.mockRemoveTerminal,
        focusActiveTerminal: mocks.mockFocusActiveTerminal,
        setShowSettings: mocks.mockSetShowSettings,
        focusNonce: 0,
        autocompleteEnabled: true,
        allowAppMouseControl: false,
        voiceSettings: { enabled: false },
        keybindings: { ...DEFAULT_KEYBINDINGS, clearTerminal: 'Ctrl+Alt+K' },
        customKeybindings: [],
      }))
      await renderPane()

      // The old default no longer clears...
      await act(async () => { mockKeyHandlerCb!(clearKeyEvent()) })
      expect(mockClearTerminalBuffer).not.toHaveBeenCalled()

      // ...and the new binding does.
      await act(async () => {
        mockKeyHandlerCb!(clearKeyEvent({ key: 'k', shiftKey: false, altKey: true }))
      })
      expect(mockClearTerminalBuffer).toHaveBeenCalledWith('term-1')
    })
  })

  // =====================================================
  // 6. The other half of handleMouseDownCapture, which the click-forward guards share.
  //    Its Alt+Shift anchor copy is exercised elsewhere, but never with a clipboard
  //    that says no — and that rejection handler is the last uncovered arm of the
  //    mousedown path this suite touches.
  // =====================================================
  describe('the Alt+Shift anchor copy when the clipboard refuses', () => {
    it('swallows a clipboard failure instead of unhandled-rejecting', async () => {
      // Electron's clipboard can reject (another process holding it, a locked
      // session). The selection is already made and visible; an unhandled rejection
      // would surface as a renderer error over a gesture that visibly worked.
      const { container } = await renderPane()
      const screenEl = mountScreen(container)
      mocks.mockTerminal.getSelection.mockReturnValue('between the two anchors')
      mockClipboardWriteText.mockRejectedValue(new Error('clipboard is busy'))

      fireEvent.mouseDown(screenEl, { button: 0, altKey: true, shiftKey: true, ctrlKey: false, metaKey: false, clientX: 25, clientY: 45 })
      await act(async () => {
        fireEvent.mouseDown(screenEl, { button: 0, altKey: true, shiftKey: true, ctrlKey: false, metaKey: false, clientX: 55, clientY: 125 })
      })

      expect(mocks.mockTerminal.select).toHaveBeenCalled()
      expect(mockClipboardWriteText).toHaveBeenCalledWith('between the two anchors')
    })
  })
})
