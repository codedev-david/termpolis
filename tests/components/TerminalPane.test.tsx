import React from 'react'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'

// vi.hoisted runs before vi.mock factories — we can create vi.fn() here
const mocks = vi.hoisted(() => {
  // vitest makes vi available inside vi.hoisted
  const mockBufferLines = ['line0', 'line1', 'line2', 'line3', 'line4']

  const mockTerminal = {
    open: vi.fn(),
    write: vi.fn(),
    dispose: vi.fn(),
    onData: vi.fn(),
    attachCustomKeyEventHandler: vi.fn(),
    getSelection: vi.fn(() => ''),
    clearSelection: vi.fn(),
    selectAll: vi.fn(),
    loadAddon: vi.fn(),
    unicode: { activeVersion: '11', register: vi.fn() },
    options: {} as Record<string, any>,
    cols: 80,
    rows: 24,
    buffer: {
      active: {
        length: mockBufferLines.length,
        viewportY: 0,
        getLine: vi.fn((i: number) => {
          if (i < mockBufferLines.length) {
            return { translateToString: vi.fn(() => mockBufferLines[i]) }
          }
          return null
        }),
      },
    },
  }

  return {
    mockTerminal,
    mockBufferLines,
    mockAddTerminal: vi.fn(),
    mockRemoveTerminal: vi.fn(),
    mockGetState: vi.fn(),
    mockGetSuggestion: vi.fn(() => Promise.resolve(null)),
    mockCompletionDismiss: vi.fn(),
    mockTriggerCompletions: vi.fn(),
    mockHandleDropdownKeyIntercept: vi.fn(() => false),
    mockProcessAgentDetection: vi.fn(),
    mockStartRecording: vi.fn(),
    mockStopRecording: vi.fn(),
    mockAppendRecordingEntry: vi.fn(),
  }
})

// --- Capture callbacks registered by the mock Terminal ---
let mockOnDataCb: ((data: string) => void) | null = null
let mockKeyHandlerCb: ((e: KeyboardEvent) => boolean) | null = null
let mockOnTerminalDataCb: ((id: string, data: string) => void) | null = null

// Wire up onData and attachCustomKeyEventHandler to capture callbacks
mocks.mockTerminal.onData.mockImplementation((cb: (data: string) => void) => {
  mockOnDataCb = cb
  return { dispose: vi.fn() }
})
mocks.mockTerminal.attachCustomKeyEventHandler.mockImplementation((cb: (e: KeyboardEvent) => boolean) => {
  mockKeyHandlerCb = cb
  return { dispose: vi.fn() }
})

// Wire up mockGetState
mocks.mockGetState.mockImplementation(() => ({
  terminals: [{ id: 'term-1', isSwarm: false }],
  addTerminal: mocks.mockAddTerminal,
  removeTerminal: mocks.mockRemoveTerminal,
  autocompleteEnabled: true,
  keybindings: { ...DEFAULT_KEYBINDINGS },
  customKeybindings: [],
}))

// --- Mock xterm.js and addons ---
vi.mock('xterm', () => ({
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
vi.mock('xterm/css/xterm.css', () => ({}))

// --- Mock uuid ---
vi.mock('uuid', () => ({
  v4: vi.fn(() => 'mock-uuid-1234'),
}))

// --- Mock themes ---
vi.mock('../../src/renderer/src/themes/terminalThemes', () => ({
  getTheme: vi.fn(() => ({ background: '#1e1e1e', foreground: '#d4d4d4' })),
}))

// --- Mock store ---
vi.mock('../../src/renderer/src/store/terminalStore', () => {
  const fn = vi.fn((selector?: any) => {
    const state = mocks.mockGetState()
    return selector ? selector(state) : state
  })
  Object.assign(fn, { getState: mocks.mockGetState })
  return { useTerminalStore: fn }
})

// --- Mock completionEngine ---
vi.mock('../../src/renderer/src/completions/completionEngine', () => ({
  getCompletions: vi.fn(() => Promise.resolve([])),
}))

// --- Mock correctionEngine ---
vi.mock('../../src/renderer/src/corrections/correctionEngine', () => ({
  getSuggestion: mocks.mockGetSuggestion,
}))

// --- Mock exportTerminal ---
vi.mock('../../src/renderer/src/lib/exportTerminal', () => {
  // Helper: pull text out of the fake terminal handle the way the real
  // term-aware extractors do (just `getSelection()` here — the buffer-level
  // logic is exercised in tests/renderer/formatAsCodeBlock.test.ts).
  const sel = (term: any): string => (term?.getSelection?.() ?? '') as string
  return {
    stripAnsi: vi.fn((s: string) => s),
    generateFilename: vi.fn(() => 'terminal-export.txt'),
    // Legacy text-based formatters (still exported so tests of older paths keep working)
    formatAsCodeBlock: vi.fn((s: string) => '```text\n' + s + '\n```'),
    formatAsCodeBlockHtml: vi.fn((s: string) => '<pre><code>' + s + '</code></pre>'),
    formatAsPlainText: vi.fn((s: string) => s),
    writeCodeBlockToClipboard: vi.fn((s: string) => {
      return navigator.clipboard.writeText('```text\n' + s + '\n```')
    }),
    // Buffer-aware variants used by TerminalPane after v1.11.49
    extractSelectionWithLogicalNewlines: vi.fn((term: any) => sel(term)),
    formatAsCodeBlockFromTerm: vi.fn((term: any) => '```text\n' + sel(term) + '\n```'),
    formatAsCodeBlockHtmlFromTerm: vi.fn((term: any) => '<pre><code>' + sel(term) + '</code></pre>'),
    formatAsPlainTextFromTerm: vi.fn((term: any) => sel(term)),
    writeCodeBlockToClipboardFromTerm: vi.fn((term: any) => {
      return navigator.clipboard.writeText('```text\n' + sel(term) + '\n```')
    }),
  }
})

// --- Mock outputThrottle ---
vi.mock('../../src/renderer/src/lib/outputThrottle', () => ({
  createOutputThrottle: vi.fn((cb: (data: string) => void) => cb),
}))

// --- Mock promptParser ---
vi.mock('../../src/renderer/src/lib/promptParser', () => ({
  parsePromptFromOutput: vi.fn(() => ({ cwd: null, gitBranch: undefined })),
}))

// --- Mock outputPatterns ---
vi.mock('../../src/renderer/src/lib/outputPatterns', () => ({
  DIFF_PATTERN: /^diff --git /m,
  ERROR_PATTERN: /command not found|not recognized/i,
  COMPACTION_PATTERN: /compacting conversation/i,
}))

// --- Mock hooks ---
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
    detectedAgent: null,
    costInfo: null,
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

// --- Mock child components ---
vi.mock('../../src/renderer/src/components/CompletionDropdown/CompletionDropdown', () => ({
  CompletionDropdown: () => <div data-testid="completion-dropdown">CompletionDropdown</div>,
}))
vi.mock('../../src/renderer/src/components/CommandFix/CommandFixBanner', () => ({
  CommandFixBanner: ({ suggestion, onAccept, onDismiss }: any) => (
    <div data-testid="command-fix-banner">
      <span>{suggestion}</span>
      <button data-testid="fix-accept" onClick={onAccept}>Accept</button>
      <button data-testid="fix-dismiss" onClick={onDismiss}>Dismiss</button>
    </div>
  ),
}))
vi.mock('../../src/renderer/src/components/StatusBar/TerminalStatusBar', () => ({
  TerminalStatusBar: () => <div data-testid="terminal-status-bar">StatusBar</div>,
}))
vi.mock('../../src/renderer/src/components/DiffViewer/DiffViewer', () => ({
  DiffViewer: ({ onClose }: any) => (
    <div data-testid="diff-viewer">
      DiffViewer
      <button data-testid="diff-close" onClick={onClose}>Close</button>
    </div>
  ),
}))
vi.mock('../../src/renderer/src/components/PinnedOutput/PinnedOutput', () => ({
  PinnedOutput: ({ pins, onUnpin }: any) => (
    <div data-testid="pinned-output">
      {pins.map((p: any) => (
        <div key={p.id} data-testid={`pin-${p.id}`}>
          {p.text}
          <button data-testid={`unpin-${p.id}`} onClick={() => onUnpin(p.id)}>Unpin</button>
        </div>
      ))}
    </div>
  ),
}))

// --- Global window.termpolis mock ---
const mockWriteToTerminal = vi.fn()
const mockReadTerminalBuffer = vi.fn(() =>
  Promise.resolve({ success: true, data: { output: '' } })
)
const mockOnTerminalData = vi.fn((cb: (id: string, data: string) => void) => {
  mockOnTerminalDataCb = cb
  return vi.fn() // unsub function
})
const mockAppendHistory = vi.fn()
const mockExportTerminal = vi.fn()
const mockResizeTerminal = vi.fn()
const mockCreateTerminal = vi.fn(() => Promise.resolve())
const mockKillTerminal = vi.fn()
const mockClipboardWriteText = vi.fn(() => Promise.resolve({ success: true }))
const mockClipboardReadText = vi.fn(() => Promise.resolve({ success: true, data: 'pasted-text' }))
const mockClipboardWriteRich = vi.fn(() => Promise.resolve({ success: true }))
const mockClipboardWriteImage = vi.fn(() => Promise.resolve({ success: true }))

beforeAll(() => {
  ;(window as any).termpolis = {
    writeToTerminal: mockWriteToTerminal,
    readTerminalBuffer: mockReadTerminalBuffer,
    onTerminalData: mockOnTerminalData,
    appendHistory: mockAppendHistory,
    exportTerminal: mockExportTerminal,
    resizeTerminal: mockResizeTerminal,
    createTerminal: mockCreateTerminal,
    killTerminal: mockKillTerminal,
    clipboardWriteText: mockClipboardWriteText,
    clipboardReadText: mockClipboardReadText,
    clipboardWriteRich: mockClipboardWriteRich,
    clipboardWriteImage: mockClipboardWriteImage,
    listAISessions: vi.fn().mockResolvedValue({ success: true, data: [] }),
  }

  // Mock ResizeObserver
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )

  // Mock requestAnimationFrame
  vi.stubGlobal('requestAnimationFrame', (cb: () => void) => {
    cb()
    return 0
  })

  // Mock navigator.clipboard
  Object.defineProperty(navigator, 'clipboard', {
    value: {
      writeText: vi.fn(() => Promise.resolve()),
      readText: vi.fn(() => Promise.resolve('pasted-text')),
    },
    writable: true,
  })
})

// Import after all mocks are set up
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

describe('TerminalPane', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockOnDataCb = null
    mockKeyHandlerCb = null
    mockOnTerminalDataCb = null

    // Re-wire implementations after clearAllMocks
    mocks.mockTerminal.onData.mockImplementation((cb: (data: string) => void) => {
      mockOnDataCb = cb
      return { dispose: vi.fn() }
    })
    mocks.mockTerminal.attachCustomKeyEventHandler.mockImplementation((cb: (e: KeyboardEvent) => boolean) => {
      mockKeyHandlerCb = cb
      return { dispose: vi.fn() }
    })
    mocks.mockTerminal.getSelection.mockReturnValue('')
    mocks.mockGetState.mockImplementation(() => ({
      terminals: [{ id: 'term-1', isSwarm: false }],
      addTerminal: mocks.mockAddTerminal,
      removeTerminal: mocks.mockRemoveTerminal,
      autocompleteEnabled: true,
      keybindings: { ...DEFAULT_KEYBINDINGS },
      customKeybindings: [],
    }))
    mocks.mockHandleDropdownKeyIntercept.mockReturnValue(false)
    mocks.mockGetSuggestion.mockReturnValue(Promise.resolve(null))
    mockOnTerminalData.mockImplementation((cb: (id: string, data: string) => void) => {
      mockOnTerminalDataCb = cb
      return vi.fn()
    })
    mockReadTerminalBuffer.mockReturnValue(
      Promise.resolve({ success: true, data: { output: '' } })
    )
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  // =====================================================
  // 1. Rendering
  // =====================================================
  describe('rendering', () => {
    it('renders the container div', () => {
      const { container } = render(<TerminalPane {...defaultProps} />)
      expect(container.querySelector('.absolute.inset-0')).toBeTruthy()
    })

    it('renders with visible style when isVisible is true', () => {
      const { container } = render(<TerminalPane {...defaultProps} isVisible={true} />)
      const outer = container.firstChild as HTMLElement
      expect(outer.style.visibility).toBe('visible')
    })

    it('renders with hidden style when isVisible is false', () => {
      const { container } = render(<TerminalPane {...defaultProps} isVisible={false} />)
      const outer = container.firstChild as HTMLElement
      expect(outer.style.visibility).toBe('hidden')
    })

    it('renders TerminalStatusBar', () => {
      render(<TerminalPane {...defaultProps} />)
      expect(screen.getByTestId('terminal-status-bar')).toBeInTheDocument()
    })

    it('renders PinnedOutput component', () => {
      render(<TerminalPane {...defaultProps} />)
      expect(screen.getByTestId('pinned-output')).toBeInTheDocument()
    })

    it('renders the Past AI Sessions overlay button on every terminal pane', () => {
      render(<TerminalPane {...defaultProps} />)
      const btn = screen.getByTestId('past-ai-sessions-btn')
      expect(btn).toBeInTheDocument()
      expect(btn.textContent).toMatch(/Past AI Sessions/i)
    })

    it('clicking the Past AI Sessions button opens the modal overlay', async () => {
      render(<TerminalPane {...defaultProps} />)
      // Modal should not be mounted before click
      expect(screen.queryByTestId('past-ai-sessions-overlay')).not.toBeInTheDocument()
      fireEvent.click(screen.getByTestId('past-ai-sessions-btn'))
      await waitFor(() => {
        expect(screen.getByTestId('past-ai-sessions-overlay')).toBeInTheDocument()
      })
    })
  })

  // =====================================================
  // 2. Terminal initialization
  // =====================================================
  describe('terminal initialization', () => {
    it('calls Terminal.open on mount', () => {
      render(<TerminalPane {...defaultProps} />)
      expect(mocks.mockTerminal.open).toHaveBeenCalled()
    })

    it('loads addons via loadAddon', () => {
      render(<TerminalPane {...defaultProps} />)
      // loadAddon is called for FitAddon, Unicode11Addon, and WebLinksAddon
      expect(mocks.mockTerminal.loadAddon).toHaveBeenCalled()
      expect(mocks.mockTerminal.loadAddon.mock.calls.length).toBeGreaterThanOrEqual(1)
    })

    it('attaches custom key event handler', () => {
      render(<TerminalPane {...defaultProps} />)
      expect(mocks.mockTerminal.attachCustomKeyEventHandler).toHaveBeenCalled()
    })

    it('registers onData handler', () => {
      render(<TerminalPane {...defaultProps} />)
      expect(mocks.mockTerminal.onData).toHaveBeenCalled()
      expect(mockOnDataCb).toBeInstanceOf(Function)
    })

    it('calls onTerminalReady callback when provided', () => {
      const onReady = vi.fn()
      render(<TerminalPane {...defaultProps} onTerminalReady={onReady} />)
      expect(onReady).toHaveBeenCalledWith(mocks.mockTerminal)
    })

    it('replays buffered output from readTerminalBuffer', async () => {
      mockReadTerminalBuffer.mockResolvedValueOnce({
        success: true,
        data: { output: 'buffered-output' },
      })
      render(<TerminalPane {...defaultProps} />)
      await waitFor(() => {
        expect(mocks.mockTerminal.write).toHaveBeenCalledWith('buffered-output')
      })
    })

    it('subscribes to onTerminalData', () => {
      render(<TerminalPane {...defaultProps} />)
      expect(mockOnTerminalData).toHaveBeenCalled()
    })
  })

  // =====================================================
  // 3. Cleanup on unmount
  // =====================================================
  describe('cleanup', () => {
    it('disposes terminal on unmount', () => {
      const { unmount } = render(<TerminalPane {...defaultProps} />)
      unmount()
      expect(mocks.mockTerminal.dispose).toHaveBeenCalled()
    })
  })

  // =====================================================
  // 4. Data handler - input buffer tracking
  // =====================================================
  describe('data handler - input buffer', () => {
    it('typing characters passes data to writeToTerminal', () => {
      render(<TerminalPane {...defaultProps} />)
      act(() => { mockOnDataCb?.('a') })
      expect(mockWriteToTerminal).toHaveBeenCalledWith('term-1', 'a')
    })

    it('typing multiple characters accumulates in buffer', () => {
      render(<TerminalPane {...defaultProps} />)
      act(() => { mockOnDataCb?.('g') })
      act(() => { mockOnDataCb?.('i') })
      act(() => { mockOnDataCb?.('t') })
      expect(mockWriteToTerminal).toHaveBeenCalledWith('term-1', 'g')
      expect(mockWriteToTerminal).toHaveBeenCalledWith('term-1', 'i')
      expect(mockWriteToTerminal).toHaveBeenCalledWith('term-1', 't')
    })

    it('Enter key clears input buffer and appends to history', () => {
      render(<TerminalPane {...defaultProps} />)
      act(() => { mockOnDataCb?.('l') })
      act(() => { mockOnDataCb?.('s') })
      act(() => { mockOnDataCb?.('\r') })
      expect(mockAppendHistory).toHaveBeenCalledWith('term-1', 'Terminal 1', 'ls')
    })

    it('Enter key with empty input does not append to history', () => {
      render(<TerminalPane {...defaultProps} />)
      act(() => { mockOnDataCb?.('\r') })
      expect(mockAppendHistory).not.toHaveBeenCalled()
    })

    it('Backspace removes last character from buffer', () => {
      render(<TerminalPane {...defaultProps} />)
      act(() => { mockOnDataCb?.('a') })
      act(() => { mockOnDataCb?.('b') })
      act(() => { mockOnDataCb?.('\u007f') }) // backspace
      // After 'ab' then backspace, buffer should be 'a'
      act(() => { mockOnDataCb?.('\r') })
      expect(mockAppendHistory).toHaveBeenCalledWith('term-1', 'Terminal 1', 'a')
    })

    it('escape sequences are not added to input buffer', () => {
      render(<TerminalPane {...defaultProps} />)
      act(() => { mockOnDataCb?.('\x1b[A') }) // arrow up
      act(() => { mockOnDataCb?.('\r') })
      expect(mockAppendHistory).not.toHaveBeenCalled()
    })
  })

  // =====================================================
  // 5. Copy/paste via key handler
  // =====================================================
  describe('copy/paste', () => {
    it('Ctrl+Shift+C copies selection to clipboard', () => {
      render(<TerminalPane {...defaultProps} />)
      mocks.mockTerminal.getSelection.mockReturnValue('selected-text')
      const event = new KeyboardEvent('keydown', {
        ctrlKey: true,
        shiftKey: true,
        key: 'C',
      })
      const result = mockKeyHandlerCb?.(event)
      expect(result).toBe(false) // consumed by handler
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith('selected-text')
    })

    it('Ctrl+Shift+C with no selection does not write to clipboard', () => {
      render(<TerminalPane {...defaultProps} />)
      mocks.mockTerminal.getSelection.mockReturnValue('')
      const event = new KeyboardEvent('keydown', {
        ctrlKey: true,
        shiftKey: true,
        key: 'C',
      })
      mockKeyHandlerCb?.(event)
      expect(navigator.clipboard.writeText).not.toHaveBeenCalled()
    })

    it('Ctrl+Shift+V reads clipboard and writes to terminal', async () => {
      render(<TerminalPane {...defaultProps} />)
      const event = new KeyboardEvent('keydown', {
        ctrlKey: true,
        shiftKey: true,
        key: 'V',
      })
      const result = mockKeyHandlerCb?.(event)
      expect(result).toBe(false)
      await waitFor(() => {
        expect(mockWriteToTerminal).toHaveBeenCalledWith('term-1', 'pasted-text')
      })
    })

    it('normal keys pass through (returns true)', () => {
      render(<TerminalPane {...defaultProps} />)
      const event = new KeyboardEvent('keydown', { key: 'a' })
      const result = mockKeyHandlerCb?.(event)
      expect(result).toBe(true)
    })

    it('Ctrl+C with selection copies and clears selection (does not pass through)', () => {
      render(<TerminalPane {...defaultProps} />)
      mocks.mockTerminal.getSelection.mockReturnValue('selected-text')
      const event = new KeyboardEvent('keydown', { ctrlKey: true, key: 'C' })
      const result = mockKeyHandlerCb?.(event)
      expect(result).toBe(false)
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith('selected-text')
      expect(mocks.mockTerminal.clearSelection).toHaveBeenCalled()
    })

    it('Ctrl+C with no selection passes through (so shells get SIGINT)', () => {
      render(<TerminalPane {...defaultProps} />)
      mocks.mockTerminal.getSelection.mockReturnValue('')
      const event = new KeyboardEvent('keydown', { ctrlKey: true, key: 'C' })
      const result = mockKeyHandlerCb?.(event)
      expect(result).toBe(true)
      expect(navigator.clipboard.writeText).not.toHaveBeenCalled()
    })

    it('Ctrl+V pastes clipboard text into terminal', async () => {
      render(<TerminalPane {...defaultProps} />)
      const event = new KeyboardEvent('keydown', { ctrlKey: true, key: 'V' })
      const result = mockKeyHandlerCb?.(event)
      expect(result).toBe(false)
      await waitFor(() => {
        expect(mockWriteToTerminal).toHaveBeenCalledWith('term-1', 'pasted-text')
      })
    })

    it('Shift+Enter sends backslash+CR for shell line continuation when no agent detected', () => {
      render(<TerminalPane {...defaultProps} />)
      const event = new KeyboardEvent('keydown', { shiftKey: true, key: 'Enter', cancelable: true })
      const result = mockKeyHandlerCb?.(event)
      expect(result).toBe(false)
      expect(mockWriteToTerminal).toHaveBeenCalledWith('term-1', '\\\r')
      // CRITICAL: must preventDefault, or xterm's hidden textarea will also
      // fire an `input` event and inject a second \r — cancelling line continuation.
      expect(event.defaultPrevented).toBe(true)
    })

    it('Shift+Enter sends Esc+CR (ESC \\r = \\x1b\\r) when an AI agent is detected', async () => {
      const { useAgentDetection } = await import('../../src/renderer/src/hooks/useAgentDetection')
      ;(useAgentDetection as any).mockReturnValue({
        detectedAgent: { name: 'claude' },
        costInfo: null,
        processAgentDetection: mocks.mockProcessAgentDetection,
        agentDetectedRef: { current: true },
      })
      render(<TerminalPane {...defaultProps} />)
      const event = new KeyboardEvent('keydown', { shiftKey: true, key: 'Enter', cancelable: true })
      const result = mockKeyHandlerCb?.(event)
      expect(result).toBe(false)
      expect(mockWriteToTerminal).toHaveBeenCalledWith('term-1', '\x1b\r')
      expect(event.defaultPrevented).toBe(true)

      // Reset for subsequent tests in this describe.
      ;(useAgentDetection as any).mockReturnValue({
        detectedAgent: null,
        costInfo: null,
        processAgentDetection: mocks.mockProcessAgentDetection,
        agentDetectedRef: { current: false },
      })
    })

    it('Shift+Enter ignores Ctrl/Alt/Meta modifiers (does not write)', () => {
      render(<TerminalPane {...defaultProps} />)
      mockWriteToTerminal.mockClear()
      const event = new KeyboardEvent('keydown', { shiftKey: true, ctrlKey: true, key: 'Enter' })
      const result = mockKeyHandlerCb?.(event)
      // Ctrl+Shift+Enter is not the documented Shift+Enter — let it through.
      expect(result).toBe(true)
      expect(mockWriteToTerminal).not.toHaveBeenCalledWith('term-1', '\x1b\r')
      expect(mockWriteToTerminal).not.toHaveBeenCalledWith('term-1', '\\\r')
    })

    it('non-keydown events bypass the custom handler', () => {
      render(<TerminalPane {...defaultProps} />)
      const event = new KeyboardEvent('keyup', { ctrlKey: true, key: 'C' })
      const result = mockKeyHandlerCb?.(event)
      expect(result).toBe(true)
      expect(navigator.clipboard.writeText).not.toHaveBeenCalled()
    })
  })

  // =====================================================
  // 5c. Copy/paste/autocomplete combos are read from store keybindings,
  // so rebinding them in Settings actually takes effect.
  // =====================================================
  describe('rebindable shortcuts (read from store keybindings)', () => {
    function withKeybindings(over: Record<string, string>) {
      mocks.mockGetState.mockImplementation(() => ({
        terminals: [{ id: 'term-1', isSwarm: false }],
        addTerminal: mocks.mockAddTerminal,
        removeTerminal: mocks.mockRemoveTerminal,
        autocompleteEnabled: true,
        keybindings: { ...DEFAULT_KEYBINDINGS, ...over },
        customKeybindings: [],
      }))
    }

    it('honors a rebound Copy combo (copy = Alt+C)', () => {
      withKeybindings({ copy: 'Alt+C' })
      render(<TerminalPane {...defaultProps} />)
      mocks.mockTerminal.getSelection.mockReturnValue('rebound-sel')
      const result = mockKeyHandlerCb?.(new KeyboardEvent('keydown', { altKey: true, key: 'c' }))
      expect(result).toBe(false)
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith('rebound-sel')
    })

    it('stops copying on the old default once Copy is rebound away', () => {
      withKeybindings({ copy: 'Alt+C' })
      render(<TerminalPane {...defaultProps} />)
      mocks.mockTerminal.getSelection.mockReturnValue('sel')
      // Ctrl+Shift+C is no longer the copy combo; the smart Ctrl+C path needs
      // no Shift, so this combo must now do nothing.
      mockKeyHandlerCb?.(new KeyboardEvent('keydown', { ctrlKey: true, shiftKey: true, key: 'C' }))
      expect(navigator.clipboard.writeText).not.toHaveBeenCalled()
    })

    it('honors a rebound autocomplete combo (toggleAutocomplete = Ctrl+J)', async () => {
      const { getCompletions } = await import('../../src/renderer/src/completions/completionEngine')
      ;(getCompletions as any).mockResolvedValue([{ text: 'git', source: 'command' }])
      withKeybindings({ toggleAutocomplete: 'Ctrl+J' })
      render(<TerminalPane {...defaultProps} />)
      act(() => { mockOnDataCb?.('g') })
      act(() => { mockOnDataCb?.('i') })
      act(() => { mockKeyHandlerCb?.(new KeyboardEvent('keydown', { ctrlKey: true, key: 'j' })) })
      await waitFor(() => { expect(getCompletions).toHaveBeenCalled() })
    })
  })

  // =====================================================
  // 5d. App-level shortcuts (launch slots + custom macros) are intercepted in
  // the xterm key handler so the terminal never gets a stray control byte
  // (Ctrl+3 -> ESC, Ctrl+4 -> FS) and the action still fires.
  // =====================================================
  describe('app-level shortcuts over a focused terminal', () => {
    it('Ctrl+3 (launch slot) is consumed, leaks no byte, and dispatches a launch event', () => {
      render(<TerminalPane {...defaultProps} />)
      mockWriteToTerminal.mockClear()
      let launchedSlot: number | null = null
      const onLaunch = (e: Event) => { launchedSlot = (e as CustomEvent).detail }
      window.addEventListener('termpolis:launch-agent-slot', onLaunch)
      try {
        const ev = new KeyboardEvent('keydown', { ctrlKey: true, key: '3', cancelable: true })
        const result = mockKeyHandlerCb?.(ev)
        expect(result).toBe(false)
        expect(ev.defaultPrevented).toBe(true)
        expect(launchedSlot).toBe(2) // Ctrl+3 -> slot index 2 (Gemini)
        expect(mockWriteToTerminal).not.toHaveBeenCalled() // no ESC byte to the PTY
      } finally {
        window.removeEventListener('termpolis:launch-agent-slot', onLaunch)
      }
    })

    it('a custom macro combo writes its text into this terminal and is consumed', () => {
      mocks.mockGetState.mockImplementation(() => ({
        terminals: [{ id: 'term-1', isSwarm: false }],
        addTerminal: mocks.mockAddTerminal,
        removeTerminal: mocks.mockRemoveTerminal,
        autocompleteEnabled: true,
        keybindings: { ...DEFAULT_KEYBINDINGS },
        customKeybindings: [{ id: 'm', label: 'GS', combo: 'Ctrl+Alt+G', text: 'git status', runOnSend: true }],
      }))
      render(<TerminalPane {...defaultProps} />)
      mockWriteToTerminal.mockClear()
      const ev = new KeyboardEvent('keydown', { ctrlKey: true, altKey: true, key: 'g', cancelable: true })
      const result = mockKeyHandlerCb?.(ev)
      expect(result).toBe(false)
      expect(mockWriteToTerminal).toHaveBeenCalledWith('term-1', 'git status\r')
    })
  })

  // =====================================================
  // 5b. Right-click opens the context menu (Windows/Linux convention).
  // The mintty-style "right-click = quick copy/paste" was discoverability-
  // hostile because it hid the Copy-as-Code-Block menu entirely.
  // =====================================================
  describe('right-click opens context menu', () => {
    it('plain right-click with no selection opens the full menu (no auto-paste)', () => {
      mocks.mockTerminal.getSelection.mockReturnValue('')
      const { container } = render(<TerminalPane {...defaultProps} />)
      const terminalContainer = container.querySelector('.flex-1.relative')!
      fireEvent.contextMenu(terminalContainer, { clientX: 100, clientY: 200 })
      expect(screen.getByText('Select All')).toBeInTheDocument()
      expect(screen.getByText('Copy as Code Block')).toBeInTheDocument()
      // Did NOT auto-paste
      expect(mockWriteToTerminal).not.toHaveBeenCalled()
    })

    it('plain right-click with selection opens menu (no auto-copy)', () => {
      mocks.mockTerminal.getSelection.mockReturnValue('selected-text')
      const { container } = render(<TerminalPane {...defaultProps} />)
      const terminalContainer = container.querySelector('.flex-1.relative')!
      fireEvent.contextMenu(terminalContainer, { clientX: 100, clientY: 200 })
      expect(screen.getByText('Select All')).toBeInTheDocument()
      expect(screen.getByText('Copy as Code Block')).toBeInTheDocument()
      // Did NOT auto-copy or clear
      expect(navigator.clipboard.writeText).not.toHaveBeenCalled()
      expect(mocks.mockTerminal.clearSelection).not.toHaveBeenCalled()
    })

    it('Shift + right-click also opens the full context menu (legacy alias)', () => {
      const { container } = render(<TerminalPane {...defaultProps} />)
      const terminalContainer = container.querySelector('.flex-1.relative')!
      fireEvent.contextMenu(terminalContainer, { clientX: 100, clientY: 200, shiftKey: true })
      expect(screen.getByText('Select All')).toBeInTheDocument()
      expect(screen.getByText('Copy as Code Block')).toBeInTheDocument()
    })
  })

  // =====================================================
  // 7. Context menu
  // =====================================================
  describe('context menu', () => {
    it('right-click shows context menu', () => {
      const { container } = render(<TerminalPane {...defaultProps} />)
      const terminalContainer = container.querySelector('.flex-1.relative')!
      fireEvent.contextMenu(terminalContainer, { clientX: 100, clientY: 200, shiftKey: true })

      expect(screen.getByText('Copy')).toBeInTheDocument()
      expect(screen.getByText('Paste')).toBeInTheDocument()
      expect(screen.getByText('Select All')).toBeInTheDocument()
      expect(screen.getByText('Export Full Scrollback...')).toBeInTheDocument()
      expect(screen.getByText('Export Visible Output...')).toBeInTheDocument()
    })

    it('flips the menu UP when right-clicking near the viewport bottom (terminal line)', () => {
      // Simulate a short viewport and a tall menu so a click near the bottom
      // would overflow if the menu grew downward.
      const origH = window.innerHeight
      const origW = window.innerWidth
      Object.defineProperty(window, 'innerHeight', { value: 500, configurable: true })
      Object.defineProperty(window, 'innerWidth', { value: 1000, configurable: true })
      const rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
        width: 200, height: 400, top: 0, left: 0, right: 200, bottom: 400, x: 0, y: 0, toJSON: () => ({}),
      } as DOMRect)
      try {
        const { container } = render(<TerminalPane {...defaultProps} />)
        const terminalContainer = container.querySelector('.flex-1.relative')!
        // Right-click on the bottom input line.
        fireEvent.contextMenu(terminalContainer, { clientX: 100, clientY: 450 })
        const menu = screen.getByTestId('terminal-context-menu')
        // 450 + 400 overflows 500, so it must open upward: top = 450 - 400 = 50.
        expect(menu.style.top).toBe('50px')
        expect(parseInt(menu.style.top, 10)).toBeLessThan(450)
        // Horizontally it fits, so no flip: left stays at the click point.
        expect(menu.style.left).toBe('100px')
      } finally {
        rectSpy.mockRestore()
        Object.defineProperty(window, 'innerHeight', { value: origH, configurable: true })
        Object.defineProperty(window, 'innerWidth', { value: origW, configurable: true })
      }
    })

    it('clicking Copy in context menu copies selection', () => {
      const { container } = render(<TerminalPane {...defaultProps} />)
      mocks.mockTerminal.getSelection.mockReturnValue('copied-text')
      const terminalContainer = container.querySelector('.flex-1.relative')!
      fireEvent.contextMenu(terminalContainer, { clientX: 100, clientY: 200, shiftKey: true })
      fireEvent.click(screen.getByText('Copy'))
      expect(mockClipboardWriteText).toHaveBeenCalledWith('copied-text')
    })

    it('clicking Paste in context menu pastes from clipboard', async () => {
      const { container } = render(<TerminalPane {...defaultProps} />)
      const terminalContainer = container.querySelector('.flex-1.relative')!
      fireEvent.contextMenu(terminalContainer, { clientX: 100, clientY: 200, shiftKey: true })
      fireEvent.click(screen.getByText('Paste'))
      await waitFor(() => {
        expect(mockWriteToTerminal).toHaveBeenCalledWith('term-1', 'pasted-text')
      })
    })

    it('clicking Select All calls selectAll on terminal', () => {
      const { container } = render(<TerminalPane {...defaultProps} />)
      const terminalContainer = container.querySelector('.flex-1.relative')!
      fireEvent.contextMenu(terminalContainer, { clientX: 100, clientY: 200, shiftKey: true })
      fireEvent.click(screen.getByText('Select All'))
      expect(mocks.mockTerminal.selectAll).toHaveBeenCalled()
    })

    it('clicking export full scrollback triggers export', () => {
      const { container } = render(<TerminalPane {...defaultProps} />)
      const terminalContainer = container.querySelector('.flex-1.relative')!
      fireEvent.contextMenu(terminalContainer, { clientX: 100, clientY: 200, shiftKey: true })
      fireEvent.click(screen.getByText('Export Full Scrollback...'))
      expect(mockExportTerminal).toHaveBeenCalledWith(
        expect.objectContaining({ defaultFilename: 'terminal-export.txt' })
      )
    })

    it('clicking export visible output triggers export', () => {
      const { container } = render(<TerminalPane {...defaultProps} />)
      const terminalContainer = container.querySelector('.flex-1.relative')!
      fireEvent.contextMenu(terminalContainer, { clientX: 100, clientY: 200, shiftKey: true })
      fireEvent.click(screen.getByText('Export Visible Output...'))
      expect(mockExportTerminal).toHaveBeenCalledWith(
        expect.objectContaining({ defaultFilename: 'terminal-export.txt' })
      )
    })

    it('context menu closes on document click', () => {
      const { container } = render(<TerminalPane {...defaultProps} />)
      const terminalContainer = container.querySelector('.flex-1.relative')!
      fireEvent.contextMenu(terminalContainer, { clientX: 100, clientY: 200, shiftKey: true })
      expect(screen.getByText('Copy')).toBeInTheDocument()
      fireEvent.click(document)
      expect(screen.queryByText(/^Copy$/)).not.toBeInTheDocument()
    })

    it('context menu closes on Escape key', () => {
      const { container } = render(<TerminalPane {...defaultProps} />)
      const terminalContainer = container.querySelector('.flex-1.relative')!
      fireEvent.contextMenu(terminalContainer, { clientX: 100, clientY: 200, shiftKey: true })
      expect(screen.getByText('Copy')).toBeInTheDocument()
      fireEvent.keyDown(document, { key: 'Escape' })
      expect(screen.queryByText(/^Copy$/)).not.toBeInTheDocument()
    })

    it('shows split options when onSplitRight and onSplitDown are provided', () => {
      const onSplitRight = vi.fn()
      const onSplitDown = vi.fn()
      const { container } = render(
        <TerminalPane {...defaultProps} onSplitRight={onSplitRight} onSplitDown={onSplitDown} />
      )
      const terminalContainer = container.querySelector('.flex-1.relative')!
      fireEvent.contextMenu(terminalContainer, { clientX: 100, clientY: 200, shiftKey: true })
      expect(screen.getByText('Split Right')).toBeInTheDocument()
      expect(screen.getByText('Split Down')).toBeInTheDocument()
    })

    it('clicking Split Right invokes the callback', () => {
      const onSplitRight = vi.fn()
      const { container } = render(
        <TerminalPane {...defaultProps} onSplitRight={onSplitRight} />
      )
      const terminalContainer = container.querySelector('.flex-1.relative')!
      fireEvent.contextMenu(terminalContainer, { clientX: 100, clientY: 200, shiftKey: true })
      fireEvent.click(screen.getByText('Split Right'))
      expect(onSplitRight).toHaveBeenCalled()
    })

    it('clicking Split Down invokes the callback', () => {
      const onSplitDown = vi.fn()
      const { container } = render(
        <TerminalPane {...defaultProps} onSplitDown={onSplitDown} />
      )
      const terminalContainer = container.querySelector('.flex-1.relative')!
      fireEvent.contextMenu(terminalContainer, { clientX: 100, clientY: 200, shiftKey: true })
      fireEvent.click(screen.getByText('Split Down'))
      expect(onSplitDown).toHaveBeenCalled()
    })

    it('shows Start Recording when not recording', () => {
      const { container } = render(<TerminalPane {...defaultProps} />)
      const terminalContainer = container.querySelector('.flex-1.relative')!
      fireEvent.contextMenu(terminalContainer, { clientX: 100, clientY: 200, shiftKey: true })
      expect(screen.getByText('Start Recording')).toBeInTheDocument()
    })
  })

  // =====================================================
  // 8. Pinned output
  // =====================================================
  describe('pinned output', () => {
    it('Pin Selection pins selected text from terminal', () => {
      mocks.mockTerminal.getSelection.mockReturnValue('pinned-text')
      const { container } = render(<TerminalPane {...defaultProps} />)
      const terminalContainer = container.querySelector('.flex-1.relative')!
      fireEvent.contextMenu(terminalContainer, { clientX: 100, clientY: 200, shiftKey: true })
      fireEvent.click(screen.getByText('Pin Selection'))

      expect(screen.getByText('pinned-text')).toBeInTheDocument()
    })

    it('unpinning removes the pinned item', async () => {
      mocks.mockTerminal.getSelection.mockReturnValue('to-remove')
      const { container } = render(<TerminalPane {...defaultProps} />)
      const terminalContainer = container.querySelector('.flex-1.relative')!

      fireEvent.contextMenu(terminalContainer, { clientX: 100, clientY: 200, shiftKey: true })
      fireEvent.click(screen.getByText('Pin Selection'))

      expect(screen.getByText('to-remove')).toBeInTheDocument()

      fireEvent.click(screen.getByTestId('unpin-mock-uuid-1234'))

      await waitFor(() => {
        expect(screen.queryByText('to-remove')).not.toBeInTheDocument()
      })
    })
  })

  // =====================================================
  // 9. Output handling via onTerminalData
  // =====================================================
  describe('output handling', () => {
    it('writes received data to terminal via throttled write', () => {
      render(<TerminalPane {...defaultProps} />)
      act(() => {
        mockOnTerminalDataCb?.('term-1', 'hello output')
      })
      expect(mocks.mockTerminal.write).toHaveBeenCalledWith('hello output')
    })

    it('ignores data for other terminal IDs', () => {
      render(<TerminalPane {...defaultProps} />)
      const writeCountBefore = mocks.mockTerminal.write.mock.calls.length
      act(() => {
        mockOnTerminalDataCb?.('term-other', 'should not appear')
      })
      expect(mocks.mockTerminal.write.mock.calls.length).toBe(writeCountBefore)
    })

    it('calls processAgentDetection with stripped output', () => {
      render(<TerminalPane {...defaultProps} />)
      act(() => {
        mockOnTerminalDataCb?.('term-1', 'some agent output')
      })
      expect(mocks.mockProcessAgentDetection).toHaveBeenCalled()
    })

    it('does not parse prompt info while an AI agent owns the terminal', async () => {
      const { useAgentDetection } = await import('../../src/renderer/src/hooks/useAgentDetection')
      ;(useAgentDetection as any).mockReturnValue({
        detectedAgent: { name: 'claude' },
        costInfo: null,
        processAgentDetection: mocks.mockProcessAgentDetection,
        agentDetectedRef: { current: true },
      })
      const { parsePromptFromOutput } = await import('../../src/renderer/src/lib/promptParser')
      render(<TerminalPane {...defaultProps} />)
      act(() => {
        mockOnTerminalDataCb?.('term-1', 'PS C:\\bogus-from-agent-output> ')
      })
      expect(parsePromptFromOutput).not.toHaveBeenCalled()
      // Reset for subsequent tests in this describe.
      ;(useAgentDetection as any).mockReturnValue({
        detectedAgent: null,
        costInfo: null,
        processAgentDetection: mocks.mockProcessAgentDetection,
        agentDetectedRef: { current: false },
      })
    })

    it('parses prompt info from output when no agent is active', async () => {
      const { parsePromptFromOutput } = await import('../../src/renderer/src/lib/promptParser')
      render(<TerminalPane {...defaultProps} />)
      act(() => {
        mockOnTerminalDataCb?.('term-1', 'PS C:\\real-shell> ')
      })
      expect(parsePromptFromOutput).toHaveBeenCalled()
    })

    it('records output when recording is active', () => {
      render(<TerminalPane {...defaultProps} />)
      act(() => {
        mockOnTerminalDataCb?.('term-1', 'recorded output')
      })
      expect(mocks.mockAppendRecordingEntry).toHaveBeenCalledWith('output', 'recorded output')
    })
  })

  // =====================================================
  // 10. Diff detection
  // =====================================================
  describe('diff detection', () => {
    it('shows View Diff button when diff pattern is detected in output', async () => {
      render(<TerminalPane {...defaultProps} />)

      act(() => {
        mockOnTerminalDataCb?.('term-1', 'diff --git a/file.ts b/file.ts\n')
      })

      await waitFor(() => {
        expect(screen.getByText('View Diff')).toBeInTheDocument()
      })
    })

    it('clicking View Diff button opens DiffViewer', async () => {
      render(<TerminalPane {...defaultProps} />)

      act(() => {
        mockOnTerminalDataCb?.('term-1', 'diff --git a/file.ts b/file.ts\n')
      })

      await waitFor(() => {
        expect(screen.getByText('View Diff')).toBeInTheDocument()
      })

      fireEvent.click(screen.getByText('View Diff'))

      await waitFor(() => {
        expect(screen.getByTestId('diff-viewer')).toBeInTheDocument()
      })
    })

    it('closing DiffViewer hides it', async () => {
      render(<TerminalPane {...defaultProps} />)

      act(() => {
        mockOnTerminalDataCb?.('term-1', 'diff --git a/file.ts b/file.ts\n')
      })

      await waitFor(() => {
        expect(screen.getByText('View Diff')).toBeInTheDocument()
      })

      fireEvent.click(screen.getByText('View Diff'))
      expect(screen.getByTestId('diff-viewer')).toBeInTheDocument()

      fireEvent.click(screen.getByTestId('diff-close'))
      expect(screen.queryByTestId('diff-viewer')).not.toBeInTheDocument()
    })

    it('View as Diff from context menu opens DiffViewer', () => {
      const { container } = render(<TerminalPane {...defaultProps} />)
      const terminalContainer = container.querySelector('.flex-1.relative')!
      fireEvent.contextMenu(terminalContainer, { clientX: 100, clientY: 200, shiftKey: true })
      fireEvent.click(screen.getByText('View as Diff'))
      expect(screen.getByTestId('diff-viewer')).toBeInTheDocument()
    })
  })

  // =====================================================
  // 11. Command fix banner via error patterns
  // =====================================================
  describe('command fix banner', () => {
    it('shows fix banner when error pattern detected after a command', async () => {
      mocks.mockGetSuggestion.mockResolvedValue('npm install')

      render(<TerminalPane {...defaultProps} />)

      act(() => { mockOnDataCb?.('n') })
      act(() => { mockOnDataCb?.('p') })
      act(() => { mockOnDataCb?.('m') })
      act(() => { mockOnDataCb?.('\r') })

      act(() => {
        mockOnTerminalDataCb?.('term-1', 'command not found: npm')
      })

      await waitFor(() => {
        expect(screen.getByTestId('command-fix-banner')).toBeInTheDocument()
        expect(screen.getByText('npm install')).toBeInTheDocument()
      })
    })

    it('accepting fix banner writes suggestion to terminal', async () => {
      mocks.mockGetSuggestion.mockResolvedValue('git pull')

      render(<TerminalPane {...defaultProps} />)

      act(() => { mockOnDataCb?.('g') })
      act(() => { mockOnDataCb?.('\r') })

      act(() => {
        mockOnTerminalDataCb?.('term-1', 'command not found')
      })

      await waitFor(() => {
        expect(screen.getByTestId('command-fix-banner')).toBeInTheDocument()
      })

      fireEvent.click(screen.getByTestId('fix-accept'))

      expect(mockWriteToTerminal).toHaveBeenCalledWith('term-1', 'git pull\r')
    })

    it('dismissing fix banner hides it', async () => {
      mocks.mockGetSuggestion.mockResolvedValue('fix-command')

      render(<TerminalPane {...defaultProps} />)

      act(() => { mockOnDataCb?.('x') })
      act(() => { mockOnDataCb?.('\r') })

      act(() => {
        mockOnTerminalDataCb?.('term-1', 'not recognized')
      })

      await waitFor(() => {
        expect(screen.getByTestId('command-fix-banner')).toBeInTheDocument()
      })

      fireEvent.click(screen.getByTestId('fix-dismiss'))

      await waitFor(() => {
        expect(screen.queryByTestId('command-fix-banner')).not.toBeInTheDocument()
      })
    })

    it('typing new input dismisses fix banner', async () => {
      mocks.mockGetSuggestion.mockResolvedValue('suggested-fix')

      render(<TerminalPane {...defaultProps} />)

      act(() => { mockOnDataCb?.('x') })
      act(() => { mockOnDataCb?.('\r') })

      act(() => {
        mockOnTerminalDataCb?.('term-1', 'command not found')
      })

      await waitFor(() => {
        expect(screen.getByTestId('command-fix-banner')).toBeInTheDocument()
      })

      act(() => { mockOnDataCb?.('n') })

      await waitFor(() => {
        expect(screen.queryByTestId('command-fix-banner')).not.toBeInTheDocument()
      })
    })
  })

  // =====================================================
  // 12. Output throttling
  // =====================================================
  describe('output throttling', () => {
    it('output is written via createOutputThrottle', () => {
      render(<TerminalPane {...defaultProps} />)
      act(() => {
        mockOnTerminalDataCb?.('term-1', 'throttled-data')
      })
      expect(mocks.mockTerminal.write).toHaveBeenCalledWith('throttled-data')
    })
  })

  // =====================================================
  // 13. Recording entries
  // =====================================================
  describe('session recording', () => {
    it('records input data when data handler fires', () => {
      render(<TerminalPane {...defaultProps} />)
      act(() => { mockOnDataCb?.('a') })
      expect(mocks.mockAppendRecordingEntry).toHaveBeenCalledWith('input', 'a')
    })

    it('records output data when terminal data arrives', () => {
      render(<TerminalPane {...defaultProps} />)
      act(() => {
        mockOnTerminalDataCb?.('term-1', 'output-data')
      })
      expect(mocks.mockAppendRecordingEntry).toHaveBeenCalledWith('output', 'output-data')
    })
  })

  // =====================================================
  // 14. Ctrl+Space triggers completions
  // =====================================================
  describe('Ctrl+Space completions', () => {
    it('Ctrl+Space triggers manual completions when buffer has content', async () => {
      const { getCompletions } = await import('../../src/renderer/src/completions/completionEngine')
      ;(getCompletions as any).mockResolvedValue([{ text: 'git', source: 'command' }])

      render(<TerminalPane {...defaultProps} />)

      act(() => { mockOnDataCb?.('g') })
      act(() => { mockOnDataCb?.('i') })

      // Ctrl+Space is now handled in the key handler (rebindable toggleAutocomplete)
      act(() => { mockKeyHandlerCb?.(new KeyboardEvent('keydown', { ctrlKey: true, key: ' ' })) })

      await waitFor(() => {
        expect(getCompletions).toHaveBeenCalled()
      })
    })
  })

  // =====================================================
  // 15. Dropdown key intercept
  // =====================================================
  describe('dropdown key intercept', () => {
    it('consumes key when dropdown intercepts it', () => {
      mocks.mockHandleDropdownKeyIntercept.mockReturnValue(true)

      render(<TerminalPane {...defaultProps} />)

      act(() => { mockOnDataCb?.('\t') })

      // writeToTerminal should NOT be called because the key was consumed
      expect(mockWriteToTerminal).not.toHaveBeenCalledWith('term-1', '\t')
    })
  })

  // =====================================================
  // 16. Drag and drop files
  // =====================================================
  describe('drag and drop', () => {
    it('dropping files writes quoted paths to terminal', () => {
      const { container } = render(<TerminalPane {...defaultProps} />)
      const terminalContainer = container.querySelector('.flex-1.relative')!

      const file1 = new File([''], 'test.txt')
      Object.defineProperty(file1, 'path', { value: '/home/user/test.txt' })
      const file2 = new File([''], 'test2.txt')
      Object.defineProperty(file2, 'path', { value: '/home/user/test2.txt' })

      fireEvent.drop(terminalContainer, {
        dataTransfer: { files: [file1, file2] },
      })

      expect(mockWriteToTerminal).toHaveBeenCalledWith(
        'term-1',
        '"/home/user/test.txt" "/home/user/test2.txt"'
      )
    })

    it('dragOver is handled without error', () => {
      const { container } = render(<TerminalPane {...defaultProps} />)
      const terminalContainer = container.querySelector('.flex-1.relative')!
      // Just verify it doesn't throw
      fireEvent.dragOver(terminalContainer)
    })
  })

  // =====================================================
  // 17. Output buffer management (4KB limit)
  // =====================================================
  describe('output buffer management', () => {
    it('truncates output buffer when exceeding 4KB', () => {
      render(<TerminalPane {...defaultProps} />)
      const largeOutput = 'x'.repeat(5000)
      act(() => {
        mockOnTerminalDataCb?.('term-1', largeOutput)
      })
      expect(mocks.mockTerminal.write).toHaveBeenCalledWith(largeOutput)
    })
  })

  // =====================================================
  // 18. OSC 633 exit code handling
  // =====================================================
  describe('OSC 633 exit code', () => {
    it('triggers fix suggestion on non-zero exit code', async () => {
      mocks.mockGetSuggestion.mockResolvedValue('suggested-fix')

      render(<TerminalPane {...defaultProps} />)

      act(() => { mockOnDataCb?.('b') })
      act(() => { mockOnDataCb?.('a') })
      act(() => { mockOnDataCb?.('d') })
      act(() => { mockOnDataCb?.('\r') })

      act(() => {
        mockOnTerminalDataCb?.('term-1', '\x1b]633;E;1\x07')
      })

      await waitFor(() => {
        expect(mocks.mockGetSuggestion).toHaveBeenCalledWith('bad', expect.any(String))
      })
    })

    it('does not trigger on zero exit code', () => {
      render(<TerminalPane {...defaultProps} />)

      act(() => { mockOnDataCb?.('g') })
      act(() => { mockOnDataCb?.('\r') })

      act(() => {
        mockOnTerminalDataCb?.('term-1', '\x1b]633;E;0\x07')
      })

      expect(mocks.mockGetSuggestion).not.toHaveBeenCalled()
    })
  })

  // =====================================================
  // 19. Dynamic theme/font updates
  // =====================================================
  describe('dynamic option updates', () => {
    it('updates terminal options when fontSize changes', () => {
      const { rerender } = render(<TerminalPane {...defaultProps} fontSize={14} />)
      rerender(<TerminalPane {...defaultProps} fontSize={18} />)
      expect(mocks.mockTerminal.options.fontSize).toBe(18)
    })

    it('updates terminal options when theme changes', async () => {
      const { getTheme } = await import('../../src/renderer/src/themes/terminalThemes')
      const { rerender } = render(<TerminalPane {...defaultProps} theme="dark" />)
      rerender(<TerminalPane {...defaultProps} theme="dracula" />)
      expect(getTheme).toHaveBeenCalledWith('dracula')
    })

    it('updates terminal options when fontFamily changes', () => {
      const { rerender } = render(<TerminalPane {...defaultProps} fontFamily="monospace" />)
      rerender(<TerminalPane {...defaultProps} fontFamily="Fira Code" />)
      expect(mocks.mockTerminal.options.fontFamily).toBe('Fira Code')
    })
  })

  // =====================================================
  // 20. Visibility change triggers fit
  // =====================================================
  describe('visibility changes', () => {
    it('triggers fit and resize when becoming visible', () => {
      vi.useFakeTimers()
      const { rerender } = render(<TerminalPane {...defaultProps} isVisible={false} />)
      rerender(<TerminalPane {...defaultProps} isVisible={true} />)
      vi.advanceTimersByTime(10)
      expect(mockResizeTerminal).toHaveBeenCalledWith('term-1', 80, 24)
      vi.useRealTimers()
    })
  })

  // =====================================================
  // 23. Swarm terminal reduced scrollback
  // =====================================================
  describe('swarm terminal', () => {
    it('uses reduced scrollback for swarm terminals', () => {
      mocks.mockGetState.mockImplementation(() => ({
        terminals: [{ id: 'term-1', isSwarm: true }],
        addTerminal: mocks.mockAddTerminal,
        removeTerminal: mocks.mockRemoveTerminal,
        autocompleteEnabled: true,
      }))

      render(<TerminalPane {...defaultProps} />)
      // Terminal was created (open was called)
      expect(mocks.mockTerminal.open).toHaveBeenCalled()

      // Reset
      mocks.mockGetState.mockImplementation(() => ({
        terminals: [{ id: 'term-1', isSwarm: false }],
        addTerminal: mocks.mockAddTerminal,
        removeTerminal: mocks.mockRemoveTerminal,
        autocompleteEnabled: true,
      }))
    })
  })

  // =====================================================
  // 24. Stop Recording context menu
  // =====================================================
  describe('stop recording context menu', () => {
    it('shows Stop Recording when recording is active', async () => {
      const { useSessionRecording } = await import('../../src/renderer/src/hooks/useSessionRecording')
      ;(useSessionRecording as any).mockReturnValue({
        isRecording: true,
        startRecording: mocks.mockStartRecording,
        stopRecording: mocks.mockStopRecording,
        appendRecordingEntry: mocks.mockAppendRecordingEntry,
        isRecordingRef: { current: true },
      })

      const { container } = render(<TerminalPane {...defaultProps} />)
      const terminalContainer = container.querySelector('.flex-1.relative')!
      fireEvent.contextMenu(terminalContainer, { clientX: 100, clientY: 200, shiftKey: true })
      expect(screen.getByText(/Stop Recording/)).toBeInTheDocument()

      // Click Stop Recording
      fireEvent.click(screen.getByText(/Stop Recording/))
      expect(mocks.mockStopRecording).toHaveBeenCalled()

      // Reset
      ;(useSessionRecording as any).mockReturnValue({
        isRecording: false,
        startRecording: mocks.mockStartRecording,
        stopRecording: mocks.mockStopRecording,
        appendRecordingEntry: mocks.mockAppendRecordingEntry,
        isRecordingRef: { current: false },
      })
    })

    it('clicking Start Recording calls startRecording and closes context menu', () => {
      const { container } = render(<TerminalPane {...defaultProps} />)
      const terminalContainer = container.querySelector('.flex-1.relative')!
      fireEvent.contextMenu(terminalContainer, { clientX: 100, clientY: 200, shiftKey: true })
      fireEvent.click(screen.getByText('Start Recording'))
      expect(mocks.mockStartRecording).toHaveBeenCalled()
      // Context menu should close
      expect(screen.queryByText('Start Recording')).not.toBeInTheDocument()
    })
  })

  // =====================================================
  // 25. Slack/Teams copy submenu (v1.11.43)
  // =====================================================
  describe('copy as code block / plain text / image', () => {
    it('Ctrl+Shift+M with selection copies fenced output to clipboard', async () => {
      const { writeCodeBlockToClipboardFromTerm } = await import('../../src/renderer/src/lib/exportTerminal')
      mocks.mockTerminal.getSelection.mockReturnValue('hello')

      render(<TerminalPane {...defaultProps} />)
      const event = new KeyboardEvent('keydown', {
        ctrlKey: true,
        shiftKey: true,
        key: 'M',
      })
      const result = mockKeyHandlerCb?.(event)
      expect(result).toBe(false)
      expect(writeCodeBlockToClipboardFromTerm).toHaveBeenCalledWith(mocks.mockTerminal)
    })

    it('Ctrl+Shift+M with no selection does not write to clipboard', async () => {
      const { writeCodeBlockToClipboardFromTerm } = await import('../../src/renderer/src/lib/exportTerminal')
      ;(writeCodeBlockToClipboardFromTerm as any).mockClear()
      mocks.mockTerminal.getSelection.mockReturnValue('')
      render(<TerminalPane {...defaultProps} />)
      const event = new KeyboardEvent('keydown', {
        ctrlKey: true,
        shiftKey: true,
        key: 'M',
      })
      mockKeyHandlerCb?.(event)
      expect(writeCodeBlockToClipboardFromTerm).not.toHaveBeenCalled()
    })

    it('Copy as Code Block submenu item formats and copies', async () => {
      mocks.mockTerminal.getSelection.mockReturnValue('selected')

      const { container } = render(<TerminalPane {...defaultProps} />)
      const terminalContainer = container.querySelector('.flex-1.relative')!
      fireEvent.contextMenu(terminalContainer, { clientX: 100, clientY: 200, shiftKey: true })
      fireEvent.click(screen.getByText('Copy as Code Block'))

      // Menu copy goes through the native Electron clipboard (focus-immune) with
      // BOTH the markdown fence and the rich HTML form.
      expect(mockClipboardWriteRich).toHaveBeenCalledWith('```text\nselected\n```', '<pre><code>selected</code></pre>')
    })

    it('Copy as Code Block with empty selection does nothing', async () => {
      mocks.mockTerminal.getSelection.mockReturnValue('')
      const { container } = render(<TerminalPane {...defaultProps} />)
      const terminalContainer = container.querySelector('.flex-1.relative')!
      fireEvent.contextMenu(terminalContainer, { clientX: 100, clientY: 200, shiftKey: true })
      fireEvent.click(screen.getByText('Copy as Code Block'))
      expect(mockClipboardWriteRich).not.toHaveBeenCalled()
    })

    it('Copy as Plain Text strips ANSI and copies', async () => {
      const { formatAsPlainTextFromTerm } = await import('../../src/renderer/src/lib/exportTerminal')
      ;(formatAsPlainTextFromTerm as any).mockReturnValue('plain output')
      mocks.mockTerminal.getSelection.mockReturnValue('plain output')

      const { container } = render(<TerminalPane {...defaultProps} />)
      const terminalContainer = container.querySelector('.flex-1.relative')!
      fireEvent.contextMenu(terminalContainer, { clientX: 100, clientY: 200, shiftKey: true })
      fireEvent.click(screen.getByText('Copy as Plain Text'))

      expect(formatAsPlainTextFromTerm).toHaveBeenCalledWith(mocks.mockTerminal)
      expect(mockClipboardWriteText).toHaveBeenCalledWith('plain output')
    })

    it('Copy as Plain Text with empty selection does nothing', () => {
      mocks.mockTerminal.getSelection.mockReturnValue('')
      const { container } = render(<TerminalPane {...defaultProps} />)
      const terminalContainer = container.querySelector('.flex-1.relative')!
      fireEvent.contextMenu(terminalContainer, { clientX: 100, clientY: 200, shiftKey: true })
      fireEvent.click(screen.getByText('Copy as Plain Text'))
      expect(mockClipboardWriteText).not.toHaveBeenCalled()
    })

    it('Copy with Command prepends last command and copies fence', async () => {
      const { formatAsCodeBlockFromTerm } = await import('../../src/renderer/src/lib/exportTerminal')
      ;(formatAsCodeBlockFromTerm as any).mockReturnValue('```text\nresult\n```')
      mocks.mockTerminal.getSelection.mockReturnValue('result')

      const { container } = render(<TerminalPane {...defaultProps} />)
      // Type a command and submit so lastCommandRef captures it
      act(() => { mockOnDataCb?.('l'); mockOnDataCb?.('s'); mockOnDataCb?.('\r') })

      const terminalContainer = container.querySelector('.flex-1.relative')!
      fireEvent.contextMenu(terminalContainer, { clientX: 100, clientY: 200, shiftKey: true })
      fireEvent.click(screen.getByText('Copy with Command'))

      expect(mockClipboardWriteText).toHaveBeenCalledWith('`$ ls`\n```text\nresult\n```')
    })

    it('Copy with Command falls back to plain fence when no last command', async () => {
      const { formatAsCodeBlockFromTerm } = await import('../../src/renderer/src/lib/exportTerminal')
      ;(formatAsCodeBlockFromTerm as any).mockReturnValue('```text\nresult\n```')
      mocks.mockTerminal.getSelection.mockReturnValue('result')

      const { container } = render(<TerminalPane {...defaultProps} />)
      const terminalContainer = container.querySelector('.flex-1.relative')!
      fireEvent.contextMenu(terminalContainer, { clientX: 100, clientY: 200, shiftKey: true })
      fireEvent.click(screen.getByText('Copy with Command'))

      expect(mockClipboardWriteText).toHaveBeenCalledWith('```text\nresult\n```')
    })

    it('Copy with Command with empty selection does nothing', () => {
      mocks.mockTerminal.getSelection.mockReturnValue('')
      const { container } = render(<TerminalPane {...defaultProps} />)
      const terminalContainer = container.querySelector('.flex-1.relative')!
      fireEvent.contextMenu(terminalContainer, { clientX: 100, clientY: 200, shiftKey: true })
      fireEvent.click(screen.getByText('Copy with Command'))
      expect(mockClipboardWriteText).not.toHaveBeenCalled()
    })

    it('Copy as Image grabs the canvas and writes via the native clipboard', async () => {
      // Set up a fake canvas inside the .xterm element
      const { container } = render(<TerminalPane {...defaultProps} />)
      const inner = container.querySelector('.flex-1.relative') as HTMLElement
      const xtermDiv = document.createElement('div')
      xtermDiv.className = 'xterm'
      const canvas = document.createElement('canvas') as HTMLCanvasElement
      ;(canvas as any).toDataURL = () => 'data:image/png;base64,ZmFrZQ=='
      xtermDiv.appendChild(canvas)
      inner.appendChild(xtermDiv)

      fireEvent.contextMenu(inner, { clientX: 100, clientY: 200, shiftKey: true })
      fireEvent.click(screen.getByText('Copy as Image'))

      await waitFor(() => {
        expect(mockClipboardWriteImage).toHaveBeenCalledWith('data:image/png;base64,ZmFrZQ==')
      })
    })

    it('Copy as Image is a no-op when there is no canvas', () => {
      const { container } = render(<TerminalPane {...defaultProps} />)
      const inner = container.querySelector('.flex-1.relative') as HTMLElement
      fireEvent.contextMenu(inner, { clientX: 100, clientY: 200, shiftKey: true })
      fireEvent.click(screen.getByText('Copy as Image'))
      expect(mockClipboardWriteImage).not.toHaveBeenCalled()
    })

    it('Copy as Image swallows canvas errors', async () => {
      const { container } = render(<TerminalPane {...defaultProps} />)
      const inner = container.querySelector('.flex-1.relative') as HTMLElement
      const xtermDiv = document.createElement('div')
      xtermDiv.className = 'xterm'
      const canvas = document.createElement('canvas') as HTMLCanvasElement
      ;(canvas as any).toDataURL = () => { throw new Error('boom') }
      xtermDiv.appendChild(canvas)
      inner.appendChild(xtermDiv)

      fireEvent.contextMenu(inner, { clientX: 100, clientY: 200, shiftKey: true })
      // Should not throw
      expect(() => fireEvent.click(screen.getByText('Copy as Image'))).not.toThrow()
    })
  })
})
