import React from 'react'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import type { SoMenu } from '../../src/renderer/src/lib/secondOpinion'

// The echo trace's wiring inside TerminalPane (1.54.5, plan package P0). src/renderer/src/lib/echoTrace.ts
// has its own unit tests; this file pins that the pane calls it where it must and changes nothing else:
// every typed key goes through the trace's write, the throttle's xterm write goes through its tap, output
// is counted on arrival, a refit reads the queue first, and unmount detaches. The trace is replaced by a
// recording fake here, so every assertion is about the pane. The xterm and preload mocks mirror
// tests/components/TerminalPaneBranches.test.tsx: xterm never really renders under jsdom, so the
// Terminal is a fake whose callbacks we capture and drive by hand.

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
    parser: { registerCsiHandler: vi.fn(), registerOscHandler: vi.fn() },
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
    // The echo trace, as a recording fake: what TerminalPane asks of it is what these tests assert.
    mockEchoAttach: vi.fn(),
    mockEchoPane: {
      write: vi.fn(),
      tap: vi.fn((fn: (data: string) => void) => fn),
      received: vi.fn(),
      resize: vi.fn(),
      detach: vi.fn(),
    },
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
let resizeObserverCb: (() => void) | null = null
const frames: Array<() => void> = []
let mockSelectionChangeCb: (() => void) | null = null
// The badge the pane shows is `agentFromCommand(agentCommand) ?? detectedAgent`; driving
// the hook lets a terminal look like Claude Code WITHOUT Termpolis having launched it.
let detectedAgentValue: { name: string; icon: string; color: string } | null = null

// --- The echo trace ---
vi.mock('../../src/renderer/src/lib/echoTrace', () => ({
  echoTraceAttach: (...args: unknown[]) => { mocks.mockEchoAttach(...args); return mocks.mockEchoPane },
}))

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

// The REAL output throttle (the other TerminalPane files swap in an identity one): the throttle probe
// reads its pending(), and its ordering is part of what is pinned here.
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
    constructor(cb: () => void) { resizeObserverCb = cb }
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  })
  // Frames are queued, not run: a burst then stays in the output throttle until a test flushes it.
  vi.stubGlobal('requestAnimationFrame', (cb: () => void) => { frames.push(cb); return frames.length })
  vi.stubGlobal('cancelAnimationFrame', () => undefined)
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


const onDataCb = (): ((data: string) => void) => mocks.mockTerminal.onData.mock.calls[mocks.mockTerminal.onData.mock.calls.length - 1][0]

describe('TerminalPane: echo trace wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockOnTerminalDataCb = null
    mockSelectionChangeCb = null
    detectedAgentValue = null
    resizeObserverCb = null
    frames.length = 0
    mocks.mockEchoPane.tap.mockImplementation((fn: (data: string) => void) => fn)

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

  it('attaches one pane per mount, for this terminal and its xterm, with both queue probes', async () => {
    await renderPane()
    expect(mocks.mockEchoAttach).toHaveBeenCalledTimes(1)
    const [id, term, probes] = mocks.mockEchoAttach.mock.calls[0]
    expect(id).toBe('term-1')
    expect(term).toBe(mocks.mockTerminal)
    expect(probes.throttle()).toBe(0)
    expect(probes.held()).toBe(0)
  })

  it('sends every typed key through the trace, and not straight to the preload', async () => {
    await renderPane()
    onDataCb()('a')
    onDataCb()('\r')
    expect(mocks.mockEchoPane.write.mock.calls).toEqual([['a'], ['\r']])
    expect(mockWriteToTerminal).not.toHaveBeenCalled() // the trace's write is the one that forwards
  })

  it('hands the throttle a tap around its xterm write, and a chunk still reaches xterm through it', async () => {
    await renderPane()
    expect(mocks.mockEchoPane.tap).toHaveBeenCalledTimes(1)
    expect(typeof mocks.mockEchoPane.tap.mock.calls[0][0]).toBe('function')
    await act(async () => { mockOnTerminalDataCb!('term-1', 'hello') })
    expect(mocks.mockTerminal.write).toHaveBeenCalledWith('hello')
  })

  it('counts the chars of output for this pane as they arrive, and ignores another terminal', async () => {
    await renderPane()
    await act(async () => { mockOnTerminalDataCb!('term-1', 'hello') })
    expect(mocks.mockEchoPane.received).toHaveBeenCalledTimes(1)
    expect(mocks.mockEchoPane.received).toHaveBeenCalledWith(5)
    await act(async () => { mockOnTerminalDataCb!('some-other-terminal', 'zzzzzzzz') })
    expect(mocks.mockEchoPane.received).toHaveBeenCalledTimes(1) // NEGATIVE CONTROL: not this pane's output
  })

  it('reports the chars still sitting in the output throttle through the throttle probe', async () => {
    await renderPane()
    const probes = mocks.mockEchoAttach.mock.calls[0][2]
    await act(async () => { mockOnTerminalDataCb!('term-1', 'x'.repeat(10_000)) }) // past the small-write bypass: it queues
    expect(probes.throttle()).toBe(10_000)
    expect(mocks.mockTerminal.write).not.toHaveBeenCalledWith('x'.repeat(10_000)) // still waiting for its frame
    await act(async () => { frames.splice(0).forEach((f) => f()) })
    expect(probes.throttle()).toBe(0)
    expect(mocks.mockTerminal.write).toHaveBeenCalledWith('x'.repeat(10_000))
  })

  it('reports the output a held selection is sitting on through the held probe', async () => {
    await renderPane()
    const probes = mocks.mockEchoAttach.mock.calls[0][2]
    mocks.mockTerminal.hasSelection.mockReturnValue(true) // a selection is active: writes are held back
    await act(async () => { mockOnTerminalDataCb!('term-1', 'abcdef') })
    expect(probes.held()).toBe(6)
    expect(mocks.mockTerminal.write).not.toHaveBeenCalledWith('abcdef')
  })

  it('reads the queue as a refit starts', async () => {
    vi.useFakeTimers()
    try {
      await renderPane()
      resizeObserverCb!()
      vi.advanceTimersByTime(100) // the refit is debounced 100 ms
      expect(mocks.mockEchoPane.resize).toHaveBeenCalledTimes(1)
    } finally { vi.useRealTimers() }
  })

  it('NEGATIVE CONTROL: a refit deferred by an active selection reads nothing, and the one after it does', async () => {
    vi.useFakeTimers()
    try {
      await renderPane()
      mocks.mockTerminal.hasSelection.mockReturnValue(true)
      resizeObserverCb!()
      vi.advanceTimersByTime(100)
      expect(mocks.mockEchoPane.resize).not.toHaveBeenCalled() // deferred: no reflow happened
      mocks.mockTerminal.hasSelection.mockReturnValue(false)
      vi.advanceTimersByTime(150)
      expect(mocks.mockEchoPane.resize).toHaveBeenCalledTimes(1)
    } finally { vi.useRealTimers() }
  })

  it('detaches the pane on unmount, once', async () => {
    const view = await renderPane()
    expect(mocks.mockEchoPane.detach).not.toHaveBeenCalled()
    view.unmount()
    expect(mocks.mockEchoPane.detach).toHaveBeenCalledTimes(1)
  })
})
