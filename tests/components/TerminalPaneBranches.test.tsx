import React from 'react'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import type { SoMenu } from '../../src/renderer/src/lib/secondOpinion'

// Branch backfill for TerminalPane. Everything here targets a *defensive* path the
// happy-path suite never walks: xterm reporting an empty selection, a pane with no
// laid-out screen, the selection-snapshot throttle, and the renderer gate. The mock
// setup deliberately mirrors tests/components/TerminalPane.test.tsx so the two files
// stay comparable — xterm never really renders under jsdom, so the Terminal is a fake
// whose callbacks we capture and drive by hand.

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
    // Counts WebglAddon constructions so the hardware-GL gate is observable.
    mockWebglCtor: vi.fn(),
    // buildCopySnapshot() walks the buffer through the formatters; counting one of
    // them is how "did the snapshot get rebuilt?" becomes observable from outside.
    mockFormatCodeBlock: vi.fn((term: any) => '```text\n' + ((term?.getSelection?.() ?? '') as string) + '\n```'),
    mockBuildSecondOpinionMenu: vi.fn(),
    realBuildSecondOpinionMenu: null as unknown as (
      installed: Record<string, boolean> | null | undefined,
      claudeModels: Array<{ alias: string; label: string }>,
    ) => SoMenu,
    mockGetState: vi.fn(),
    mockAddTerminal: vi.fn(),
    mockRemoveTerminal: vi.fn(),
    mockFocusActiveTerminal: vi.fn(),
    mockSetShowSettings: vi.fn(),
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
let mockOnTerminalDataCb: ((id: string, data: string) => void) | null = null
let mockSelectionChangeCb: (() => void) | null = null
// The badge the pane shows is `agentFromCommand(agentCommand) ?? detectedAgent`; driving
// the hook lets a terminal look like Claude Code WITHOUT Termpolis having launched it.
let detectedAgentValue: { name: string; icon: string; color: string } | null = null

// --- Mock xterm.js and addons ---
vi.mock('@xterm/xterm', () => ({
  Terminal: function () { return mocks.mockTerminal },
}))
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: function () { this.fit = vi.fn(); this.dispose = vi.fn() },
}))
vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: function () { mocks.mockWebglCtor(); this.dispose = vi.fn(); this.onContextLoss = vi.fn() },
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

// Only the menu BUILDER is swappable — parseSecondOpinion stays real so the value the
// pane parses is parsed by production code.
vi.mock('../../src/renderer/src/lib/secondOpinion', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/renderer/src/lib/secondOpinion')>()
  mocks.realBuildSecondOpinionMenu = actual.buildSecondOpinionMenu
  return { ...actual, buildSecondOpinionMenu: mocks.mockBuildSecondOpinionMenu }
})

vi.mock('../../src/renderer/src/completions/completionEngine', () => ({
  getCompletions: vi.fn(() => Promise.resolve([])),
}))
vi.mock('../../src/renderer/src/corrections/correctionEngine', () => ({
  getSuggestion: vi.fn(() => Promise.resolve(null)),
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
    formatAsCodeBlockFromTerm: mocks.mockFormatCodeBlock,
    formatAsCodeBlockHtmlFromTerm: vi.fn((term: any) => '<pre><code>' + sel(term) + '</code></pre>'),
    formatAsPlainTextFromTerm: vi.fn((term: any) => sel(term)),
    formatAsMessageHtmlFromTerm: vi.fn((term: any) => '<span style="font-family:monospace">' + sel(term) + '</span>'),
    formatAsMessagePlainTextFromTerm: vi.fn((term: any) => sel(term)),
    writeCodeBlockToClipboard: vi.fn(() => Promise.resolve()),
    writeCodeBlockToClipboardFromTerm: vi.fn(() => Promise.resolve()),
  }
})

// Identity throttle: term.write() lands synchronously, so "was output flushed?" is a
// direct assertion instead of a timer race.
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
  CommandFixBanner: () => <div data-testid="command-fix-banner" />,
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
const mockOnTerminalData = vi.fn((cb: (id: string, data: string) => void) => {
  mockOnTerminalDataCb = cb
  return vi.fn()
})
const mockClipboardWriteText = vi.fn(() => Promise.resolve({ success: true }))
const mockSecondOpinion = vi.fn(() => Promise.resolve({ success: true, data: { feedback: 'looks fine' } }))
const mockDetectAgents = vi.fn(async () => ({ success: true, data: { claude: true, codex: true, agy: true } }))

beforeAll(() => {
  ;(window as any).termpolis = {
    writeToTerminal: mockWriteToTerminal,
    readTerminalBuffer: mockReadTerminalBuffer,
    onTerminalData: mockOnTerminalData,
    appendHistory: vi.fn(),
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
    secondOpinion: mockSecondOpinion,
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
// Alt+Shift+left-click — the click-to-anchor chord.
const ANCHOR_CHORD = { button: 0, altKey: true, shiftKey: true, ctrlKey: false, metaKey: false }

const paneOf = (container: HTMLElement): HTMLElement => container.querySelector('.flex-1.relative') as HTMLElement

// Mount and let the pane's async agent detection settle inside act(), so no state
// update lands after the assertions.
const renderPane = async (): Promise<ReturnType<typeof render>> => {
  let result!: ReturnType<typeof render>
  await act(async () => { result = render(<TerminalPane {...defaultProps} />) })
  return result
}

// A fake xterm screen with real geometry: 800px / 80 cols = 10px per col, 480px / 24 rows = 20px per row.
const mountScreen = (container: HTMLElement, rect?: Partial<DOMRect>): HTMLElement => {
  const screenEl = document.createElement('div')
  screenEl.className = 'xterm-screen'
  if (rect) {
    screenEl.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 800, height: 480, right: 800, bottom: 480, x: 0, y: 0, toJSON: () => ({}), ...rect }) as DOMRect
  }
  paneOf(container).appendChild(screenEl)
  return screenEl
}

describe('TerminalPane — defensive branches', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockOnTerminalDataCb = null
    mockSelectionChangeCb = null
    detectedAgentValue = null

    mocks.mockTerminal.onData.mockImplementation(() => ({ dispose: vi.fn() }))
    mocks.mockTerminal.attachCustomKeyEventHandler.mockImplementation(() => ({ dispose: vi.fn() }))
    mocks.mockTerminal.onSelectionChange.mockImplementation((cb: () => void) => {
      mockSelectionChangeCb = cb
      return { dispose: vi.fn() }
    })
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
    mocks.mockBuildSecondOpinionMenu.mockImplementation(mocks.realBuildSecondOpinionMenu)
    mockOnTerminalData.mockImplementation((cb: (id: string, data: string) => void) => {
      mockOnTerminalDataCb = cb
      return vi.fn()
    })
    mockReadTerminalBuffer.mockResolvedValue({ success: true, data: { output: '' } })
    mockSecondOpinion.mockResolvedValue({ success: true, data: { feedback: 'looks fine' } })
    mockDetectAgents.mockResolvedValue({ success: true, data: { claude: true, codex: true, agy: true } })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    mocks.mockTerminal.buffer.active.length = mocks.mockBufferLines.length
    mocks.mockTerminal.buffer.active.viewportY = 0
  })

  // =====================================================
  // posFromMouse — the two ways a click can't be mapped to a buffer cell.
  // Both must no-op: anchoring at a made-up cell would select the wrong text.
  // =====================================================
  describe('click-to-anchor with no usable screen geometry', () => {
    it('ignores an anchor click before xterm has painted its screen', async () => {
      // No .xterm-screen in the DOM: the pane mounted but xterm has not rendered yet
      // (the real addon creates that element). posFromMouse has nothing to measure.
      const { container } = await renderPane()
      expect(paneOf(container).querySelector('.xterm-screen')).toBeNull()

      fireEvent.mouseDown(paneOf(container), { ...ANCHOR_CHORD, clientX: 25, clientY: 45 })

      expect(screen.queryByTestId('click-anchor-badge')).not.toBeInTheDocument()
      expect(mocks.mockTerminal.clearSelection).not.toHaveBeenCalled()
      expect(mocks.mockTerminal.select).not.toHaveBeenCalled()

      // Positive control: the very same event anchors once the screen exists, so the
      // no-op above is the missing screen and not a mis-built chord.
      mountScreen(container, {})
      fireEvent.mouseDown(paneOf(container), { ...ANCHOR_CHORD, clientX: 25, clientY: 45 })
      expect(screen.getByTestId('click-anchor-badge')).toBeInTheDocument()
    })

    it('ignores an anchor click in a pane with no laid-out size', async () => {
      // A screen element that measures 0x0 — a hidden pane / pre-layout tab. Dividing the
      // click offset by a zero cell size would produce Infinity, so this must bail first.
      const { container } = await renderPane()
      const screenEl = mountScreen(container) // jsdom's default rect is all zeros

      fireEvent.mouseDown(screenEl, { ...ANCHOR_CHORD, clientX: 25, clientY: 45 })

      expect(screen.queryByTestId('click-anchor-badge')).not.toBeInTheDocument()
      expect(mocks.mockTerminal.select).not.toHaveBeenCalled()

      // Positive control: give the same element a real rect and the same click anchors.
      screenEl.getBoundingClientRect = () =>
        ({ left: 0, top: 0, width: 800, height: 480, right: 800, bottom: 480, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect
      fireEvent.mouseDown(screenEl, { ...ANCHOR_CHORD, clientX: 25, clientY: 45 })
      expect(screen.getByTestId('click-anchor-badge')).toBeInTheDocument()
    })
  })

  // =====================================================
  // Anchor pair completed, but xterm hands back nothing.
  // =====================================================
  it('does not clobber the clipboard when the anchored range yields no text', async () => {
    mocks.mockTerminal.buffer.active.length = 1000
    const { container } = await renderPane()
    const screenEl = mountScreen(container, {})

    fireEvent.mouseDown(screenEl, { ...ANCHOR_CHORD, clientX: 25, clientY: 45 })
    expect(screen.getByTestId('click-anchor-badge')).toBeInTheDocument()

    // The second click selects the range, but a repaint moved those rows out from under
    // the model, so getSelection() comes back empty. Writing that would silently wipe
    // whatever the user already had on the clipboard.
    mocks.mockTerminal.getSelection.mockReturnValue('')
    fireEvent.mouseDown(screenEl, { ...ANCHOR_CHORD, clientX: 55, clientY: 125 })

    expect(mocks.mockTerminal.select).toHaveBeenCalled()
    expect(mockClipboardWriteText).not.toHaveBeenCalled()
    // The anchor is still consumed — the pair is finished either way.
    expect(screen.queryByTestId('click-anchor-badge')).not.toBeInTheDocument()
  })

  // =====================================================
  // The selection-snapshot throttle (SELECTION_SNAP_THROTTLE_MS = 100).
  // onSelectionChange fires on every mousemove of a drag; each snapshot is five
  // buffer walks, so all but the first per 100ms must be skipped.
  // =====================================================
  it('rebuilds the selection snapshot at most once per 100ms of a drag', async () => {
    await renderPane()
    mocks.mockTerminal.hasSelection.mockReturnValue(true)
    mocks.mockTerminal.getSelection.mockReturnValue('picked')
    const now = vi.spyOn(Date, 'now').mockReturnValue(50_000)

    mockSelectionChangeCb!()
    expect(mocks.mockFormatCodeBlock).toHaveBeenCalledTimes(1)

    // Same millisecond — a drag emits dozens of these; they must not each walk the buffer.
    mockSelectionChangeCb!()
    mockSelectionChangeCb!()
    expect(mocks.mockFormatCodeBlock).toHaveBeenCalledTimes(1)

    // Past the window, the next sample refines the banked snapshot again.
    now.mockReturnValue(50_100)
    mockSelectionChangeCb!()
    expect(mocks.mockFormatCodeBlock).toHaveBeenCalledTimes(2)
  })

  // =====================================================
  // Output pausing during a drag.
  // =====================================================
  it('keeps output paused when xterm reports an empty selection mid-drag', async () => {
    const { container } = await renderPane()

    // A left press starts a potential drag-select: output freezes from this instant,
    // before the selection is even non-empty.
    fireEvent.mouseDown(paneOf(container), { button: 0, clientX: 10, clientY: 10 })
    mocks.mockTerminal.write.mockClear()

    mockOnTerminalDataCb!('term-1', 'output during the drag')
    expect(mocks.mockTerminal.write).not.toHaveBeenCalled()

    // xterm says "nothing is selected" partway through the drag (the drag has not
    // produced a range yet). The press is still down, so the pause must hold — flushing
    // here would repaint the rows the user is dragging across.
    mocks.mockTerminal.hasSelection.mockReturnValue(false)
    mockSelectionChangeCb!()
    expect(mocks.mockTerminal.write).not.toHaveBeenCalled()

    // Releasing ends the drag and releases the buffered output in one go.
    fireEvent.mouseUp(document)
    expect(mocks.mockTerminal.write).toHaveBeenCalledWith('output during the drag')
  })

  // =====================================================
  // Banking the drag-end selection (the "right-click Copy is greyed out" fix).
  // =====================================================
  it('banks the drag-end selection so a later right-click can still pin it', async () => {
    const { container } = await renderPane()

    // Drag ends with a live selection — the last instant xterm's buffer still matches
    // what the user highlighted.
    mocks.mockTerminal.hasSelection.mockReturnValue(true)
    mocks.mockTerminal.getSelection.mockReturnValue('the line the user dragged over')
    fireEvent.mouseUp(document)

    // Agent output repaints and xterm's own selection is gone by the time the user
    // reaches the menu. The banked snapshot is the only thing left.
    mocks.mockTerminal.hasSelection.mockReturnValue(false)
    mocks.mockTerminal.getSelection.mockReturnValue('')
    fireEvent.contextMenu(paneOf(container), { clientX: 20, clientY: 20 })

    const pin = screen.getByRole('button', { name: /Pin Selection/ })
    expect(pin).not.toBeDisabled()
    fireEvent.click(pin)

    expect(screen.getByTestId('pin-mock-uuid-1234')).toHaveTextContent('the line the user dragged over')
  })

  // =====================================================
  // Second Opinion label fallback.
  // =====================================================
  it('names the raw agent when a Second Opinion pick carries no model', async () => {
    detectedAgentValue = { ...CLAUDE_BADGE }
    mockReadTerminalBuffer.mockResolvedValue({ success: true, data: { output: 'PROPOSED SOLUTION: bubble sort' } })
    mockSecondOpinion.mockResolvedValue({ success: false, error: 'agent not reachable' } as never)
    // `claude:` is what parseSecondOpinion (real, not mocked here) turns into a bare
    // { agent: 'claude' } with no model — the one shape that has no pretty label of its
    // own. The message must fall back to the agent id instead of printing "Claude undefined".
    mocks.mockBuildSecondOpinionMenu.mockReturnValue({
      flat: [{ value: 'claude:', label: 'Claude (CLI default model)' }],
      claude: null,
      hasAny: true,
    } satisfies SoMenu)

    await renderPane()
    const picker = await screen.findByTestId('second-opinion-picker')
    fireEvent.change(picker, { target: { value: 'claude:' } })

    await waitFor(() => expect(mockWriteToTerminal).toHaveBeenCalled())
    expect(mockWriteToTerminal.mock.calls[0][1]).toContain('[Second Opinion from claude failed: agent not reachable]')
  })

  // =====================================================
  // Model picker returning to its placeholder.
  // =====================================================
  it('types nothing into the agent when the model picker goes back to the placeholder', async () => {
    // Claude detected from OUTPUT, not launched by Termpolis: no authoritative session,
    // so picking a model types /model into the running agent instead of relaunching it.
    detectedAgentValue = { ...CLAUDE_BADGE }
    await renderPane()
    const picker = await screen.findByTestId('model-picker')

    fireEvent.change(picker, { target: { value: 'haiku' } })
    expect(mockWriteToTerminal).toHaveBeenCalledWith('term-1', '/model haiku\r')

    mockWriteToTerminal.mockClear()
    // Back to "Model…". That is not an alias, so modelSwitchCommand() returns '' and
    // nothing may be typed — a bare '\r' would submit whatever the agent's prompt held.
    fireEvent.change(picker, { target: { value: '' } })

    expect(mockWriteToTerminal).not.toHaveBeenCalled()
  })

  // =====================================================
  // The WebGL renderer gate. Under software GL the addon initialises and then throws
  // ASYNCHRONOUSLY, so the probe — not a try/catch — is what keeps the app alive.
  // =====================================================
  describe('hardware WebGL gate', () => {
    const stubGl = (renderer: string | null): void => {
      const gl = {
        getExtension: (name: string) => (renderer === null || name !== 'WEBGL_debug_renderer_info' ? null : { UNMASKED_RENDERER_WEBGL: 0x9246 }),
        getParameter: () => renderer,
      }
      vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(gl as never)
    }

    it('loads the WebGL renderer on a real GPU', async () => {
      stubGl('ANGLE (NVIDIA GeForce RTX 4090 Direct3D11 vs_5_0 ps_5_0)')
      await renderPane()
      expect(mocks.mockWebglCtor).toHaveBeenCalledTimes(1)
    })

    it('stays on the DOM renderer under a software rasterizer', async () => {
      stubGl('Google SwiftShader')
      await renderPane()
      expect(mocks.mockWebglCtor).not.toHaveBeenCalled()
    })

    it('assumes real hardware when the driver hides its renderer string', async () => {
      // WEBGL_debug_renderer_info is blocked (privacy-hardened builds): there is no
      // string to match against, and the pre-WebGL DOM-only fallback is not the answer
      // for every such machine — treat an unknown renderer as hardware.
      stubGl(null)
      await renderPane()
      expect(mocks.mockWebglCtor).toHaveBeenCalledTimes(1)
    })

    it('stays on the DOM renderer when there is no GL context at all', async () => {
      vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
      await renderPane()
      expect(mocks.mockWebglCtor).not.toHaveBeenCalled()
    })
  })
})
