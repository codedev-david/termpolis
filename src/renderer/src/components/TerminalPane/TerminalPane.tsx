import React, { useEffect, useLayoutEffect, useRef, useState, useCallback } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import { SearchAddon } from '@xterm/addon-search'
import { getTheme } from '../../themes/terminalThemes'
import { createOutputThrottle } from '../../lib/outputThrottle'
import { stripAnsi, generateFilename, formatAsCodeBlockFromTerm, formatAsCodeBlockHtmlFromTerm, formatAsPlainTextFromTerm } from '../../lib/exportTerminal'
import { computeMenuPosition, type MenuPosition } from '../../lib/contextMenuPosition'
import { buildTerminalOptions } from '../../lib/terminalOptions'
import { requestsMouseTracking, requestsSgrMouseEncoding, disablesMouseTracking, exitsAltScreen, wheelNotchLines, buildWheelSequence, type MouseEncoding } from '../../lib/mouseMode'
import { PinnedOutput, type PinnedItem } from '../PinnedOutput/PinnedOutput'
import { TerminalSearch, type TerminalSearchOptions } from '../TerminalSearch/TerminalSearch'
import { v4 as uuid } from 'uuid'
import { getSuggestion } from '../../corrections/correctionEngine'
import { CommandFixBanner } from '../CommandFix/CommandFixBanner'
import { TerminalStatusBar } from '../StatusBar/TerminalStatusBar'
import { parsePromptFromOutput } from '../../lib/promptParser'
import { DiffViewer } from '../DiffViewer/DiffViewer'
import { PastAISessions } from '../PastAISessions/PastAISessions'
import { VoiceGroqGate } from './VoiceGroqGate'
import { useTerminalStore } from '../../store/terminalStore'
import { setPendingSettingsTab } from '../../lib/settingsNav'
import { matchesKeybinding, matchLaunchAgentSlot, matchCustomKeybinding, isEditableTarget } from '../../lib/keybindings'
import { moveCaret, toLinearSelection, selectionKeyAction, type GridCtx, type GridPos, type SelectionAction } from '../../lib/terminalSelection'
import { useVoiceInput } from '../../hooks/useVoiceInput'
import { tapOrHoldKeydownAction, tapOrHoldKeyupAction, pushToTalkMainKey, computeDisplayLevel, RELIABLE_SPEECH_RMS } from '../../lib/voice/voicePipeline'
import { CLAUDE_MODEL_OPTIONS, modelSwitchCommand } from '../../lib/modelBroker'
import { DIFF_PATTERN, ERROR_PATTERN } from '../../lib/outputPatterns'
import { useAgentDetection } from '../../hooks/useAgentDetection'
import { agentFromCommand } from '../../lib/agentDetector'
import { useTranscriptWatcher } from '../../hooks/useTranscriptWatcher'
import { useAutoPrimer, useCompactionReprimer } from '../../hooks/useAutoPrimer'
import { useAutoCodeIndex } from '../../hooks/useAutoCodeIndex'
import { useSessionRecording } from '../../hooks/useSessionRecording'
import type { ShellType } from '../../types'
import '@xterm/xterm/css/xterm.css'

// True only when a real, hardware-accelerated WebGL2 context is available. Gates
// xterm's WebGL renderer: under software GL (headless CI, VMs, old/blocked
// drivers) the addon initializes but then throws ASYNCHRONOUSLY (undefined render
// dimensions / `_isDisposed` on teardown) — a crash that escapes the synchronous
// guard around loadAddon — so we never load it there and keep the robust DOM
// renderer. Returns false in non-DOM/jsdom environments too.
function hasHardwareWebgl(): boolean {
  try {
    if (typeof document === 'undefined') return false
    const probe = document.createElement('canvas')
    const gl = probe.getContext('webgl2') as WebGL2RenderingContext | null
    if (!gl) return false
    const dbg = gl.getExtension('WEBGL_debug_renderer_info')
    const renderer = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : ''
    // SwiftShader / llvmpipe / softpipe / ANGLE-software / Microsoft Basic Render
    // are the software rasterizers where the async crash happens.
    return !/swiftshader|llvmpipe|softpipe|software|basic render|microsoft basic/i.test(renderer)
  } catch {
    return false
  }
}

interface Props {
  terminalId: string
  terminalName: string
  shellType: ShellType
  cwd: string
  isVisible: boolean
  fontSize: number
  theme: string
  fontFamily: string
  onTerminalReady?: (term: any) => void
  onSplitRight?: () => void
  onSplitDown?: () => void
}

interface ContextMenuState {
  visible: boolean
  x: number
  y: number
}

type CopySnapshot = {
  selection: string
  codeBlockMd: string
  codeBlockHtml: string
  plainText: string
}

// Build the copy payloads from the terminal's CURRENT selection (null if none).
// Captured at the earliest instant of a right-click so the menu never depends on
// the live selection surviving — some environments clear xterm's selection the
// moment you right-click ("the selection disappears as soon as I right-click").
function buildCopySnapshot(term: Terminal | null): CopySnapshot | null {
  const selection = term?.getSelection() ?? ''
  if (!term || !selection) return null
  return {
    selection,
    codeBlockMd: formatAsCodeBlockFromTerm(term),
    codeBlockHtml: formatAsCodeBlockHtmlFromTerm(term),
    plainText: formatAsPlainTextFromTerm(term),
  }
}

// Highlight colors for the in-terminal find: a dim amber wash on every match and
// a bright amber box on the active one, plus overview-ruler ticks so off-screen
// matches are visible in the scrollbar gutter.
const SEARCH_DECORATIONS = {
  matchBackground: '#5a4a1e',
  matchBorder: '#8a6d1f',
  matchOverviewRuler: '#d9a441',
  activeMatchBackground: '#d9a441',
  activeMatchBorder: '#ffffff',
  activeMatchColorOverviewRuler: '#ffd479',
}

// Map the find bar's options to xterm SearchAddon's ISearchOptions.
function toXtermSearchOptions(o: TerminalSearchOptions, incremental: boolean) {
  return {
    caseSensitive: o.caseSensitive,
    wholeWord: o.wholeWord,
    regex: o.regex,
    incremental,
    decorations: SEARCH_DECORATIONS,
  }
}

export function TerminalPane({ terminalId, terminalName, shellType, cwd, isVisible, fontSize, theme, fontFamily, onTerminalReady, onSplitRight, onSplitDown }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const searchAddonRef = useRef<SearchAddon | null>(null)
  const inputBufferRef = useRef('')
  const [contextMenu, setContextMenu] = useState<ContextMenuState>({ visible: false, x: 0, y: 0 })
  const menuRef = useRef<HTMLDivElement>(null)
  const [menuPos, setMenuPos] = useState<MenuPosition | null>(null)
  const [pastSessionsOpen, setPastSessionsOpen] = useState(false)
  const [groqGateOpen, setGroqGateOpen] = useState(false)
  // In-terminal find bar (Ctrl+Shift+F). `searchResults` is fed from the
  // SearchAddon's onDidChangeResults so the bar can show "3/17".
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchResults, setSearchResults] = useState<{ index: number; count: number }>({ index: -1, count: 0 })
  const handleSearchIncremental = useCallback((term: string, o: TerminalSearchOptions) => {
    try { searchAddonRef.current?.findNext(term, toXtermSearchOptions(o, true)) } catch { /* addon not ready */ }
  }, [])
  const handleSearchNext = useCallback((term: string, o: TerminalSearchOptions) => {
    try { searchAddonRef.current?.findNext(term, toXtermSearchOptions(o, false)) } catch { /* addon not ready */ }
  }, [])
  const handleSearchPrev = useCallback((term: string, o: TerminalSearchOptions) => {
    try { searchAddonRef.current?.findPrevious(term, toXtermSearchOptions(o, false)) } catch { /* addon not ready */ }
  }, [])
  const handleSearchClose = useCallback(() => {
    setSearchOpen(false)
    setSearchResults({ index: -1, count: 0 })
    try { searchAddonRef.current?.clearDecorations() } catch { /* nothing to clear */ }
    try { termRef.current?.focus() } catch { /* terminal disposed */ }
  }, [])
  // Keyboard copy mode — select text/words with no mouse (Ctrl+Shift+Space).
  const selectionModeRef = useRef(false)
  const anchorRef = useRef<GridPos>({ x: 0, y: 0 })
  const caretRef = useRef<GridPos>({ x: 0, y: 0 })
  const [selectionMode, setSelectionMode] = useState(false)

  // Command fix banner state
  const [fixSuggestion, setFixSuggestion] = useState<string | null>(null)
  const fixSuggestionRef = useRef<string | null>(null)
  const outputBufferRef = useRef('')
  const [parsedCwd, setParsedCwd] = useState<string | null>(null)
  const [parsedBranch, setParsedBranch] = useState<string | null>(null)
  const lastCommandRef = useRef('')
  // Snapshot of the selection + every derived copy payload, captured at
  // right-click time (handleContextMenu). The menu reads from this instead of
  // calling term.getSelection() lazily on click — xterm only guarantees the
  // selection through the right-click itself, and a focus change or re-render
  // while the menu is open can clear it, which silently no-op'd every copy.
  const copySnapshotRef = useRef<CopySnapshot | null>(null)
  // Snapshot taken at the right-button mousedown (capture phase) — the earliest
  // instant of a right-click, before anything (re-render, focus change, native
  // selection handling) can clear xterm's selection. handleContextMenu prefers
  // the live selection but falls back to this when the selection is already gone.
  const mouseDownSnapRef = useRef<{ snap: CopySnapshot | null; t: number } | null>(null)

  // Whether TUI apps may capture the mouse. Held in a ref so the parser handler
  // (registered once per terminal) always reads the live value — toggling the setting
  // takes effect on the next mouse-mode request without recreating the terminal.
  const allowAppMouseControl = useTerminalStore(s => s.allowAppMouseControl)
  const allowAppMouseControlRef = useRef(allowAppMouseControl)
  allowAppMouseControlRef.current = allowAppMouseControl
  // Remembers that a TUI app asked for the mouse (we swallowed it for selection)
  // and which encoding it wants, so the wheel handler can forward scroll back to it.
  const appWantedMouseRef = useRef(false)
  // Default the synthesized wheel encoding to SGR (1006). Every modern full-screen
  // mouse app — Claude Code, vim, tmux, lazygit, htop — selects SGR; legacy X10
  // wheel reports are effectively extinct. Defaulting to SGR (instead of X10) means
  // scroll-forwarding works even if we never positively observe the app's `?1006h`
  // (e.g. it was sent in an order/timing we don't capture). We still upgrade to SGR
  // explicitly when we DO see it, and — crucially — never clobber it back to X10.
  const mouseEncodingRef = useRef<MouseEncoding>('sgr')

  // Pinned output state
  const [pinnedItems, setPinnedItems] = useState<PinnedItem[]>([])

  // Diff viewer state
  const [diffDetected, setDiffDetected] = useState(false)
  const [showDiffViewer, setShowDiffViewer] = useState(false)
  const diffDetectedRef = useRef(false)

  // Throttle ref for prompt parsing
  const lastPromptParseRef = useRef(0)

  // Keep fixSuggestionRef in sync
  fixSuggestionRef.current = fixSuggestion

  // --- Custom hooks ---
  const agent = useAgentDetection()
  // The status-bar badge uses the LAUNCHED agent identity (the authoritative
  // `agentCommand` Termpolis records), NOT output keyword scraping — which
  // mislabels e.g. a Claude session that merely discusses "OpenAI" as "Codex".
  // Falls back to output detection for an agent started by hand in a plain shell.
  const agentCommand = useTerminalStore((s) => s.terminals.find((t) => t.id === terminalId)?.agentCommand)
  const badgeAgent = agentFromCommand(agentCommand) ?? agent.detectedAgent
  useTranscriptWatcher(terminalId, cwd, agent.detectedAgent)
  // Seed a launched agent with recalled context (opt-out in Settings).
  useAutoPrimer(terminalId, agent.detectedAgent, cwd)
  // Re-seed it after Claude compacts its conversation, restoring the detail it
  // summarized away from the durable memory brain (opt-out in Settings).
  const onCompactionOutput = useCompactionReprimer(terminalId, agent.detectedAgent, parsedCwd || cwd)
  // Auto-index this terminal's repo code into the shared memory brain when its
  // cwd resolves to a Git repo — once per repo per session (opt-out in Settings).
  useAutoCodeIndex(parsedCwd || cwd)
  const recording = useSessionRecording(terminalName, shellType)
  // Voice dictation (push-to-talk). Agent terminals take it as a prompt; plain
  // shells get a confirm-before-run bar. Opt-in via Settings → Voice.
  const voice = useVoiceInput(terminalId, !!agent.detectedAgent)
  // Reactive so the on-pane mic button appears/disappears as voice is toggled in Settings.
  const voiceEnabled = useTerminalStore((s) => s.voiceSettings?.enabled ?? false)
  const setShowSettings = useTerminalStore((s) => s.setShowSettings)
  // Local hot-swap model for this terminal's Claude agent (sends /model on change).
  const [liveModel, setLiveModel] = useState('')
  const voiceToggleRef = useRef<() => void>(() => {})
  const voiceStartRef = useRef<() => void>(() => {})
  const voiceStopRef = useRef<() => void>(() => {})
  // Hotkey START path, gated on a live Groq key check (parity with the button).
  const voiceStartGatedRef = useRef<() => void>(() => {})
  const voiceListeningRef = useRef(false)
  // A physical activation-key press is currently down (tap-or-hold mode), plus the
  // performance.now() it began at — together they tell a quick TAP (toggles
  // hands-free) from a HOLD (push-to-talk: sends on release).
  const pttPressActiveRef = useRef(false)
  const pttPressStartRef = useRef(0)
  voiceToggleRef.current = voice.toggle
  voiceStartRef.current = voice.start
  voiceStopRef.current = voice.stop
  voiceListeningRef.current = voice.listening

  // Voice dictation is Groq-cloud-only (local Whisper was removed in v1.13.0), so
  // starting a capture with no Groq key connected can only fail. BOTH entry points
  // — the on-pane Voice button AND the push-to-talk hotkey — must check for a
  // connected key first and, when it's missing, show the same setup gate that
  // routes to Settings → Voice instead of starting a doomed (silent) capture.
  // Returns true when capture may proceed. Stopping never needs the check.
  const ensureGroqOrGate = useCallback(async (): Promise<boolean> => {
    try {
      const status = await window.termpolis?.groqGetKeyStatus?.()
      if (status?.success && status.data?.connected) return true
    } catch {
      // An errored status check is treated as "not connected" — show the gate.
    }
    setGroqGateOpen(true)
    return false
  }, [])
  // Hotkey START (keydown) is gated too. The xterm key handler is synchronous, so
  // we fire-and-forget the async check: either capture starts or the gate opens.
  voiceStartGatedRef.current = () => {
    void (async () => { if (await ensureGroqOrGate()) voiceStartRef.current() })()
  }

  const handleVoiceButtonClick = useCallback(async () => {
    if (voiceListeningRef.current) { voice.toggle(); return }
    if (await ensureGroqOrGate()) voice.toggle()
  }, [voice, ensureGroqOrGate])

  const handleExport = useCallback((mode: 'full' | 'visible') => {
    const term = termRef.current
    if (!term) return

    let text: string
    if (mode === 'full') {
      const buf = term.buffer.active
      const lines: string[] = []
      for (let i = 0; i < buf.length; i++) {
        const line = buf.getLine(i)
        if (line) lines.push(line.translateToString(true))
      }
      text = stripAnsi(lines.join('\n'))
    } else {
      const buf = term.buffer.active
      const startRow = buf.viewportY
      const lines: string[] = []
      for (let i = startRow; i < startRow + term.rows; i++) {
        const line = buf.getLine(i)
        if (line) lines.push(line.translateToString(true))
      }
      text = stripAnsi(lines.join('\n'))
    }

    const defaultFilename = generateFilename(terminalName)
    window.termpolis.exportTerminal({ content: text, defaultFilename })
    setContextMenu({ visible: false, x: 0, y: 0 })
  }, [terminalName])

  const handleStartRecording = useCallback(() => {
    recording.startRecording()
    setContextMenu({ visible: false, x: 0, y: 0 })
  }, [recording])

  const handleStopRecording = useCallback(() => {
    recording.stopRecording()
    setContextMenu({ visible: false, x: 0, y: 0 })
  }, [recording])

  const handlePinSelection = useCallback(() => {
    const selection = copySnapshotRef.current?.selection
    if (selection) {
      const pin: PinnedItem = {
        id: uuid(),
        text: selection,
        timestamp: Date.now(),
        terminalName,
      }
      setPinnedItems(prev => [...prev, pin])
    }
    setContextMenu({ visible: false, x: 0, y: 0 })
  }, [terminalName])

  const handleUnpin = useCallback((id: string) => {
    setPinnedItems(prev => prev.filter(p => p.id !== id))
  }, [])

  // Capture the selection at the EARLIEST instant of a right-click — the
  // mousedown, capture phase — before xterm or a React re-render can clear it.
  const handleMouseDownCapture = useCallback((e: React.MouseEvent) => {
    if (e.button !== 2) return
    mouseDownSnapRef.current = { snap: buildCopySnapshot(termRef.current), t: Date.now() }
  }, [])

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    // Decide which selection the menu's Copy actions will use. Prefer the live
    // selection (keyboard-invoked menu, or the selection survived the click);
    // fall back to the right-mousedown snapshot when the selection was already
    // cleared by the time the menu opens ("right-click deselects, won't copy").
    // Reading the selection lazily at menu-item-click time is what failed.
    const live = buildCopySnapshot(termRef.current)
    const md = mouseDownSnapRef.current
    const fresh = md && Date.now() - md.t < 1000 ? md.snap : null
    copySnapshotRef.current = live ?? fresh ?? null
    mouseDownSnapRef.current = null
    // Right-click always opens the context menu (Windows/Linux convention).
    // The Copy-as-Code-Block / Paste / Plain Text options are the whole point
    // of having the menu — hiding it behind a Shift+right-click modifier (the
    // old mintty-style fast-copy behavior) made the Teams/Slack workflow
    // invisible to users who weren't power users. Ctrl+C / Ctrl+V still
    // provide the keyboard fast path; Ctrl+Shift+M still copies as code block.
    setContextMenu({ visible: true, x: e.clientX, y: e.clientY })
  }, [])

  useEffect(() => {
    if (!contextMenu.visible) return

    const handleClick = () => setContextMenu({ visible: false, x: 0, y: 0 })
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setContextMenu({ visible: false, x: 0, y: 0 })
    }

    document.addEventListener('click', handleClick)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('click', handleClick)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [contextMenu.visible])

  // Once the menu has rendered, measure it and flip it up/left so it never
  // spills past the viewport — the common case is right-clicking the bottom
  // input line, where a downward menu would clip Paste and everything below.
  // Runs before paint (useLayoutEffect), so the corrected spot is what shows.
  useLayoutEffect(() => {
    if (!contextMenu.visible) {
      setMenuPos(null)
      return
    }
    const el = menuRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    setMenuPos(computeMenuPosition(contextMenu.x, contextMenu.y, r.width, r.height, window.innerWidth, window.innerHeight))
  }, [contextMenu.visible, contextMenu.x, contextMenu.y])

  useEffect(() => {
    if (!containerRef.current) return
    let disposed = false

    // 1. Create Terminal instance
    // Swarm agent terminals use reduced scrollback to save memory
    const termInfo = useTerminalStore.getState().terminals.find(t => t.id === terminalId)
    const scrollback = termInfo?.isSwarm ? 3000 : 10000

    const term = new Terminal(buildTerminalOptions({
      theme: getTheme(theme),
      fontFamily,
      fontSize,
      scrollback,
      // On Windows, hand xterm the ConPTY backend + OS build (resolved in main)
      // so its line-reflow + scrollback heuristics match the pty. Without this a
      // heavy-redraw TUI like Claude Code's Ink UI progressively desyncs and its
      // output overlaps the prompt box. null off Windows (native reflow is fine).
      windowsPty: window.termpolis?.platformInfo?.windowsPty ?? null,
    }))

    // Keep the mouse free for text selection unless the user opted into app mouse
    // control: swallow mouse-tracking DECSET (CSI ? 1000-1003 h) so a click-drag
    // selects text — making right-click Copy work — instead of being captured by the
    // TUI app (Claude Code, vim, lazygit). Other private modes pass through untouched.
    // We still REMEMBER that the app wanted the mouse + its encoding so the wheel
    // handler below can forward scroll to it — otherwise swallowing tracking leaves
    // the wheel dead on the alternate screen (which has no scrollback to fall back on).
    term.parser.registerCsiHandler({ prefix: '?', final: 'h' }, (params) => {
      if (requestsSgrMouseEncoding(params)) mouseEncodingRef.current = 'sgr'
      if (allowAppMouseControlRef.current) return false
      // Swallow ANY mouse-tracking enable — including one bundled with its encoding,
      // e.g. `CSI ? 1002 ; 1006 h` — so xterm never captures the mouse and a click-drag
      // keeps selecting text. Remember that the app wanted the mouse so the wheel
      // handler below can forward scroll to it.
      if (requestsMouseTracking(params)) {
        appWantedMouseRef.current = true
        return true
      }
      return false
    })
    // Clear the wheel-forwarding FLAG when the app disables mouse tracking OR leaves the
    // alternate screen (its session is ending). The alt-screen reset matters when a
    // mouse app exits WITHOUT a tracking-disable (crash / no DECRST): otherwise the
    // stale flag would make the next non-mouse pager (less, man, git) on the alt screen
    // receive synthesized wheel reports as garbage instead of scrolling. We deliberately
    // do NOT reset the ENCODING here: apps routinely toggle tracking granularity mid-
    // session (e.g. select SGR with `?1006h`, then `?1000l`/`?1002h` to switch trackers),
    // and clobbering the captured SGR back to X10 made us emit legacy X10 wheel reports
    // to an SGR-mode app — which it can't parse, so scroll silently died while selection
    // kept working. The encoding stays at its SGR default. Never swallow these — return
    // false so xterm still processes them.
    term.parser.registerCsiHandler({ prefix: '?', final: 'l' }, (params) => {
      if (disablesMouseTracking(params) || exitsAltScreen(params)) {
        appWantedMouseRef.current = false
      }
      return false
    })
    // Wheel forwarding. When we swallowed the app's mouse tracking AND it owns the
    // screen (alternate buffer = no scrollback), synthesize wheel reports to the pty
    // so the app scrolls its own content (e.g. Claude Code's transcript). On the
    // normal buffer we return true and let xterm scroll its scrollback as before.
    // Returning false cancels xterm's own wheel handling for the forwarded case.
    term.attachCustomWheelEventHandler((ev: WheelEvent) => {
      if (allowAppMouseControlRef.current) return true   // app already gets the mouse natively
      if (!appWantedMouseRef.current) return true        // plain shell → xterm scrolls scrollback
      if (ev.deltaY === 0) return true                   // ignore horizontal wheels
      if (term.buffer.active.type !== 'alternate') return true // normal buffer has scrollback
      const screenEl = containerRef.current?.querySelector('.xterm-screen') as HTMLElement | null
      const rect = screenEl?.getBoundingClientRect()
      const cellH = rect && term.rows > 0 ? rect.height / term.rows : 0
      const cellW = rect && term.cols > 0 ? rect.width / term.cols : 0
      const col = rect && cellW > 0 ? Math.floor((ev.clientX - rect.left) / cellW) + 1 : 1
      const row = rect && cellH > 0 ? Math.floor((ev.clientY - rect.top) / cellH) + 1 : 1
      const seq = buildWheelSequence({
        direction: ev.deltaY < 0 ? 'up' : 'down',
        lines: wheelNotchLines(ev.deltaY, ev.deltaMode, cellH, term.rows),
        encoding: mouseEncodingRef.current,
        col: Math.min(term.cols, Math.max(1, col)),
        row: Math.min(term.rows, Math.max(1, row)),
      })
      if (seq) window.termpolis.writeToTerminal(terminalId, seq)
      try { ev.preventDefault() } catch { /* passive listener — ignore */ }
      return false
    })

    // 2. Load FitAddon
    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)

    // 3. Open terminal (attach to DOM) — must come before WebGL
    term.open(containerRef.current)

    // 4. Renderer. xterm's default DOM renderer is the slowest and is the source
    // of typing/paint latency. The GPU WebGL renderer is far faster — BUT under a
    // SOFTWARE GL stack (headless CI, VMs, old/blocked drivers) it initializes and
    // then throws ASYNCHRONOUSLY inside the addon (undefined render dimensions /
    // `_isDisposed` on teardown), and that throw escapes the synchronous try/catch
    // around loadAddon. That async crash is exactly what broke the e2e smoke
    // ("toggle split view") in the earlier renderer-ladder attempts. So we probe
    // for a real HARDWARE WebGL2 context up front and only load WebGL then;
    // otherwise we stay on the DOM renderer (what shipped fine before). A runtime
    // context loss still disposes the addon → DOM fallback.
    if (hasHardwareWebgl()) {
      try {
        const webglAddon = new WebglAddon()
        webglAddon.onContextLoss(() => { try { webglAddon.dispose() } catch { /* already disposed */ } })
        term.loadAddon(webglAddon)
      } catch { /* WebGL load failed late — DOM renderer stays */ }
    }

    // 5. Load Unicode11 addon
    try {
      const unicode11 = new Unicode11Addon()
      term.loadAddon(unicode11)
      term.unicode.activeVersion = '11'
    } catch {
      // Unicode11 addon failed — continue with default Unicode handling
    }

    // 6. Load Web Links addon (clickable URLs)
    try {
      const webLinksAddon = new WebLinksAddon()
      term.loadAddon(webLinksAddon)
    } catch {}

    // 6b. Load Search addon — powers the in-terminal find bar (Ctrl+Shift+F). It
    // searches the whole buffer INCLUDING scrollback and scrolls the viewport to
    // each match. onDidChangeResults drives the bar's "n/total" readout.
    try {
      const searchAddon = new SearchAddon()
      term.loadAddon(searchAddon)
      searchAddonRef.current = searchAddon
      searchAddon.onDidChangeResults((res: { resultIndex: number; resultCount: number }) => {
        if (!disposed) setSearchResults({ index: res.resultIndex, count: res.resultCount })
      })
    } catch { /* search addon unavailable — the find bar will simply no-op */ }

    // 7. Fit (deferred to avoid layout thrashing when multiple terminals mount at once)
    requestAnimationFrame(() => {
      if (!disposed) fitAddon.fit()
    })

    termRef.current = term
    fitRef.current = fitAddon

    onTerminalReady?.(term)

    // Replay buffered output so view switches don't lose scrollback
    window.termpolis.readTerminalBuffer(terminalId).then(res => {
      if (disposed || !res.success || !res.data) return
      if (res.data.output) term.write(res.data.output)
    }).catch(() => { /* terminal may have been killed before replay */ })

    // Copy/paste shortcuts are read from the store keybindings at event time, so
    // rebinding them in Settings takes effect immediately:
    //   copy / copyAsCodeBlock / paste  → rebindable
    // The two plain-terminal conveniences below stay hardcoded because they are
    // terminal semantics rather than configurable rows:
    //   Ctrl+C        → smart: copy selection if any, else passthrough (SIGINT)
    //   Ctrl+V        → paste
    //   Shift+Enter   → backslash/Esc + Enter (line continuation / multi-line)
    // --- Keyboard copy mode helpers (select text/words with no mouse) ---
    const gridCtx = (): GridCtx => ({
      cols: term.cols,
      lineCount: term.buffer.active.length,
      getLineText: (y) => term.buffer.active.getLine(y)?.translateToString(true) ?? '',
    })
    const renderSelection = () => {
      const { column, row, length } = toLinearSelection(anchorRef.current, caretRef.current, term.cols)
      term.select(column, row, Math.max(1, length))
    }
    const enterSelectionMode = () => {
      const b = term.buffer.active
      const pos = { x: b.cursorX, y: b.baseY + b.cursorY }
      anchorRef.current = pos
      caretRef.current = pos
      selectionModeRef.current = true
      setSelectionMode(true)
      renderSelection()
    }
    const exitSelectionMode = () => {
      selectionModeRef.current = false
      setSelectionMode(false)
      term.clearSelection()
    }
    const applySelectionAction = (action: SelectionAction) => {
      if (!action) return
      switch (action.kind) {
        case 'exit':
          exitSelectionMode()
          break
        case 'copy': {
          const sel = term.getSelection()
          if (sel) window.termpolis.clipboardWriteText(sel).catch(() => {})
          exitSelectionMode()
          break
        }
        case 'selectAll':
          anchorRef.current = { x: 0, y: 0 }
          caretRef.current = { x: Math.max(0, term.cols - 1), y: Math.max(0, term.buffer.active.length - 1) }
          term.selectAll()
          break
        case 'move': {
          const next = moveCaret(caretRef.current, action.motion, gridCtx())
          anchorRef.current = next
          caretRef.current = next
          renderSelection()
          break
        }
        case 'extend':
          caretRef.current = moveCaret(caretRef.current, action.motion, gridCtx())
          renderSelection()
          break
      }
    }

    term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
      // Open the in-terminal find bar (default Ctrl+Shift+F). Keydown only — steal
      // the combo from the shell and let the find bar's own input take focus.
      if (e.type === 'keydown' && matchesKeybinding(e, useTerminalStore.getState().keybindings.terminalSearch)) {
        e.preventDefault()
        setSearchOpen(true)
        return false
      }

      // Voice activation runs first and (in tap-or-hold mode) handles keyup too, so
      // it must sit ahead of the keydown-only guard below. Inert until enabled.
      const vs = useTerminalStore.getState().voiceSettings
      if (vs?.enabled) {
        const mode = vs.pushToTalkMode
        // ── Activation combo (default Ctrl+Shift+L) keydown ───────────────────
        if (e.type === 'keydown' && matchesKeybinding(e, vs.pushToTalkKey)) {
          e.preventDefault()
          if (mode === 'toggle') {
            // Pure toggle: tap to start, tap again to stop (no hold-to-talk).
            // Starting is Groq-gated; stopping never needs the check.
            if (voiceListeningRef.current) voiceStopRef.current()
            else voiceStartGatedRef.current()
          } else if (mode === 'tapSpace') {
            // Tap the combo to START; the send key ends it (handled below). No
            // keyup latch — releasing the combo keys must NOT stop dictation here.
            if (!voiceListeningRef.current) voiceStartGatedRef.current()
          } else {
            // tapOrHold (default; also where legacy 'hold' lands): a TAP toggles
            // hands-free, a HOLD is push-to-talk. keydown begins a press (or stops
            // an already-live session); the keyup below decides tap vs hold.
            const action = tapOrHoldKeydownAction({
              listening: voiceListeningRef.current,
              pressActive: pttPressActiveRef.current,
              repeat: e.repeat,
            })
            if (action === 'start') {
              pttPressActiveRef.current = true
              pttPressStartRef.current = performance.now()
              voiceStartGatedRef.current()
            } else if (action === 'stop') {
              pttPressActiveRef.current = false
              voiceStopRef.current()
            }
          }
          return false
        }
        // ── tapOrHold release: a long press (HOLD) sends; a quick press (TAP)
        //    leaves dictation listening hands-free. Modifiers may already be up,
        //    so match on the combo's main key only.
        if (mode !== 'toggle' && mode !== 'tapSpace' && e.type === 'keyup' && pttPressActiveRef.current
            && e.key.toLowerCase() === pushToTalkMainKey(vs.pushToTalkKey)) {
          e.preventDefault()
          const heldMs = performance.now() - pttPressStartRef.current
          pttPressActiveRef.current = false
          if (tapOrHoldKeyupAction({ pressActive: true, heldMs }) === 'stop') voiceStopRef.current()
          return false
        }
        // ── tapSpace: while listening, the send key (default Space, rebindable)
        //    ends dictation and is swallowed so it never reaches the shell/agent.
        if (mode === 'tapSpace' && e.type === 'keydown' && voiceListeningRef.current
            && matchesKeybinding(e, vs.sendKey || 'Space')) {
          e.preventDefault()
          voiceStopRef.current()
          return false
        }
      }

      if (e.type !== 'keydown') return true
      const kb = useTerminalStore.getState().keybindings

      // Keyboard copy mode intercepts first. While active it swallows EVERY key
      // (nothing leaks to the shell); Ctrl+Shift+Space enters it when idle.
      const selAction = selectionKeyAction(e, selectionModeRef.current)
      if (selectionModeRef.current) {
        e.preventDefault()
        applySelectionAction(selAction)
        return false
      }
      if (selAction?.kind === 'enter') {
        e.preventDefault()
        enterSelectionMode()
        return false
      }

      // When our handler returns false, xterm.js bails out of _keyDown WITHOUT
      // calling preventDefault — so the browser routes the keystroke to xterm's
      // hidden textarea, which then fires xterm's `input` listener and sends a
      // second copy to the PTY. For Shift+Enter that meant the PTY saw
      // "\\\r" + "\r" — line continuation immediately cancelled by a bare \r.
      // Calling preventDefault here BEFORE returning false is what stops the
      // textarea from seeing the keystroke at all. Same fix applies to every
      // shortcut below that returns false.

      // Shift+Enter → newline-without-submit. Two flavors:
      //   AI agents (Claude/Codex/Gemini/Qwen) read Esc+Enter (\x1b\r) as the
      //     multi-line sequence — sends a literal LF inside the input box
      //     without firing the submit keybind.
      //   Plain shells (bash/zsh/fish on git-bash, mintty, etc.) treat
      //     backslash-Enter as line continuation, prompting `> ` for more.
      if (e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && e.key === 'Enter') {
        e.preventDefault()
        const seq = agent.agentDetectedRef.current ? '\x1b\r' : '\\\r'
        window.termpolis.writeToTerminal(terminalId, seq)
        return false
      }

      // Copy as code block (HTML + markdown plain-text)
      if (matchesKeybinding(e, kb.copyAsCodeBlock)) {
        e.preventDefault()
        if (term.getSelection()) window.termpolis.clipboardWriteRich(formatAsCodeBlockFromTerm(term), formatAsCodeBlockHtmlFromTerm(term)).catch(() => {})
        return false
      }
      // Copy (explicit force-copy form)
      if (matchesKeybinding(e, kb.copy)) {
        e.preventDefault()
        const selection = term.getSelection()
        if (selection) window.termpolis.clipboardWriteText(selection).catch(() => {})
        return false
      }
      // Paste (explicit form)
      if (matchesKeybinding(e, kb.paste)) {
        e.preventDefault()
        window.termpolis.clipboardReadText().then(res => {
          const text = res?.success ? res.data : ''
          if (text) window.termpolis.writeToTerminal(terminalId, text)
        }).catch(() => {})
        return false
      }
      // App-level shortcuts must be caught HERE when a terminal is focused —
      // otherwise xterm turns Ctrl+<digit>/Ctrl+Alt+<key> into stray control
      // bytes (Ctrl+3 → ESC, Ctrl+4 → FS) sent to the shell. We preventDefault +
      // return false so xterm emits nothing; App's window handler skips events
      // we've already defaultPrevented. The launch needs App's deps, so signal
      // it via a window event; a macro just types into this focused terminal.
      const launchSlot = matchLaunchAgentSlot(e, kb)
      if (launchSlot !== null) {
        e.preventDefault()
        window.dispatchEvent(new CustomEvent('termpolis:launch-agent-slot', { detail: launchSlot }))
        return false
      }
      const macro = matchCustomKeybinding(e, useTerminalStore.getState().customKeybindings)
      if (macro) {
        e.preventDefault()
        window.termpolis.writeToTerminal(terminalId, macro.text + (macro.runOnSend ? '\r' : ''))
        return false
      }

      // Ctrl+C (no Shift) — smart copy: if selection, copy + clear; else
      // let it through so it reaches the shell as SIGINT.
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.key === 'C' || e.key === 'c')) {
        const selection = term.getSelection()
        if (selection) {
          e.preventDefault()
          window.termpolis.clipboardWriteText(selection).catch(() => {})
          term.clearSelection()
          return false
        }
        return true
      }
      // Ctrl+V (no Shift) — paste
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.key === 'V' || e.key === 'v')) {
        e.preventDefault()
        window.termpolis.clipboardReadText().then(res => {
          const text = res?.success ? res.data : ''
          if (text) window.termpolis.writeToTerminal(terminalId, text)
        }).catch(() => {})
        return false
      }
      return true // let terminal handle all other keys
    })

    term.onData((data) => {
      // Pass data to PTY
      window.termpolis.writeToTerminal(terminalId, data)

      // Record input if recording
      recording.appendRecordingEntry('input', data)

      // Track the current command line so we can record it to history on Enter and
      // dismiss the command-fix banner when the user starts a new command.
      if (data === '\r') {
        const cmd = inputBufferRef.current.trim()
        if (cmd) {
          window.termpolis.appendHistory(terminalId, terminalName, cmd)
          lastCommandRef.current = cmd
        }
        inputBufferRef.current = ''
        outputBufferRef.current = ''
        diffDetectedRef.current = false
        setDiffDetected(false)
      } else if (data === '\u007f') {
        inputBufferRef.current = inputBufferRef.current.slice(0, -1)
      } else if (!data.startsWith('\x1b')) {
        inputBufferRef.current += data
        // Dismiss fix banner when user starts typing a new command
        if (fixSuggestionRef.current) setFixSuggestion(null)
      }
    })

    const throttledWrite = createOutputThrottle((data) => term.write(data))

    const unsub = window.termpolis.onTerminalData((id, data) => {
      if (id !== terminalId) return
      throttledWrite(data)

      // Record output if recording
      recording.appendRecordingEntry('output', data)

      // Buffer recent output (keep last 4KB to avoid memory bloat)
      outputBufferRef.current += data
      if (outputBufferRef.current.length > 4096) {
        outputBufferRef.current = outputBufferRef.current.slice(-4096)
      }

      // Detect diff output (using compiled pattern)
      const hasDiff = DIFF_PATTERN.test(outputBufferRef.current)
      if (hasDiff !== diffDetectedRef.current) {
        diffDetectedRef.current = hasDiff
        if (!disposed) setDiffDetected(hasDiff)
      }

      // Strip ANSI for processing
      const stripped = outputBufferRef.current.replace(/\x1b\[[\?]?[0-9;]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')

      // Parse prompt for cwd and git branch — throttled to once per 500ms.
      // Skipped while an AI agent owns the terminal: agent TUI output and
      // injected context are full of path/branch-shaped text that is NOT a
      // live shell prompt, and parsing it corrupts the status bar cwd/branch
      // and the store cwd the Git Panel follows.
      const now = Date.now()
      if (!agent.agentDetectedRef.current && now - lastPromptParseRef.current > 500) {
        lastPromptParseRef.current = now
        const promptInfo = parsePromptFromOutput(stripped, shellType)
        if (promptInfo.cwd && !disposed) {
          setParsedCwd(promptInfo.cwd)
          // Write live cwd back to the store so Git Panel and other components can use it
          useTerminalStore.getState().updateTerminal(terminalId, { cwd: promptInfo.cwd })
        }
        if (promptInfo.gitBranch !== undefined && !disposed) setParsedBranch(promptInfo.gitBranch)
      }

      // Agent detection + cost tracking + conversation parsing
      agent.processAgentDetection(stripped, data.length, terminalId, terminalName)

      // Re-prime memory after the agent compacts its conversation (settles, then
      // re-injects recalled context). Stable callback; internally gated + debounced.
      onCompactionOutput(stripped)

      // Watch for OSC 633 exit code marker (if shell integration is enabled)
      const oscMatch = data.match(/\x1b\]633;E;(\d+)\x07/)
      if (oscMatch) {
        const exitCode = parseInt(oscMatch[1], 10)
        if (exitCode !== 0 && lastCommandRef.current) {
          const cmd = lastCommandRef.current
          const output = outputBufferRef.current
          getSuggestion(cmd, output).then(suggestion => {
            if (disposed) return
            if (suggestion) setFixSuggestion(suggestion)
          }).catch(() => {})
        }
      }

      // Pattern-matching fallback: detect common error patterns in output
      // (using compiled combined pattern)
      if (lastCommandRef.current && !fixSuggestionRef.current) {
        if (ERROR_PATTERN.test(data)) {
          const cmd = lastCommandRef.current
          const output = outputBufferRef.current
          getSuggestion(cmd, output).then(suggestion => {
            if (disposed) return
            if (suggestion) setFixSuggestion(suggestion)
          }).catch(() => {})
        }
      }
    })

    let resizeTimer: ReturnType<typeof setTimeout> | null = null
    const ro = new ResizeObserver(() => {
      if (resizeTimer) clearTimeout(resizeTimer)
      resizeTimer = setTimeout(() => {
        if (disposed) return
        fitAddon.fit()
        window.termpolis.resizeTerminal(terminalId, term.cols, term.rows)
      }, 100)
    })
    ro.observe(containerRef.current)

    return () => {
      disposed = true
      unsub()
      if (resizeTimer) clearTimeout(resizeTimer)
      ro.disconnect()
      term.dispose()
    }
  }, [terminalId])

  // Dynamically update theme, font, and fontSize
  useEffect(() => {
    if (!termRef.current) return
    termRef.current.options.fontSize = fontSize
    termRef.current.options.fontFamily = fontFamily
    termRef.current.options.theme = getTheme(theme)
    fitRef.current?.fit()
    window.termpolis.resizeTerminal(terminalId, termRef.current.cols, termRef.current.rows)
  }, [fontSize, theme, fontFamily])

  useEffect(() => {
    if (isVisible && fitRef.current && termRef.current) {
      setTimeout(() => {
        if (!fitRef.current || !termRef.current) return
        if (typeof window === 'undefined' || !window.termpolis?.resizeTerminal) return
        fitRef.current.fit()
        window.termpolis.resizeTerminal(terminalId, termRef.current.cols, termRef.current.rows)
      }, 0)
    }
  }, [isVisible, terminalId])

  // Put the cursor on the active terminal's command line so it's ready for input
  // the instant you switch to it (Alt+1..9) or launch an agent (Ctrl+1..4 →
  // addTerminal marks the new terminal active) — no manual click. Without this,
  // switching swaps the visible pane but keystrokes have nowhere to land until
  // the user clicks into xterm. Gate on isVisible so an off-screen grid pane or a
  // hidden tab never grabs the caret, and skip when an editable field (command
  // palette, settings input, modal) owns focus so we never yank it mid-type.
  const isActiveTerminal = useTerminalStore(s => s.activeTerminalId === terminalId)
  // Bumps on every switch (Alt+<n>, click, Ctrl+Tab) and every explicit
  // focusActiveTerminal() — e.g. right after voice dictation stops. Watching it
  // here re-runs this effect so the caret returns to the input line even when the
  // active terminal didn't change (re-selecting the same one, or voice ending).
  const focusNonce = useTerminalStore(s => s.focusNonce)
  useEffect(() => {
    if (!isActiveTerminal || !isVisible) return
    const term = termRef.current
    if (!term) return
    // Don't yank the caret out of a NON-terminal editable field (command palette,
    // settings input, a modal). xterm captures input via a hidden <textarea>
    // inside .xterm, so a focused *terminal* is exempt — switching terminals
    // (Alt+1..9) must be able to move focus from the old terminal to this one.
    const active = document.activeElement as HTMLElement | null
    if (isEditableTarget(active) && !active?.closest('.xterm')) return
    try { term.focus() } catch { /* terminal disposed before the effect ran */ }
  }, [isActiveTerminal, isVisible, terminalId, focusNonce])

  return (
    <div
      className="absolute inset-0 flex flex-col"
      style={{ visibility: isVisible ? 'visible' : 'hidden' }}
    >
      <div
        ref={containerRef}
        className="flex-1 relative min-h-0 overflow-hidden"
        style={{ padding: 4 }}
        onMouseDownCapture={handleMouseDownCapture}
        onContextMenu={handleContextMenu}
        onDragOver={(e) => { e.preventDefault(); e.stopPropagation() }}
        onDrop={(e) => {
          e.preventDefault()
          e.stopPropagation()
          const files = Array.from(e.dataTransfer.files)
          if (files.length > 0) {
            // Paste file paths into terminal, quoted and space-separated
            const paths = files.map(f => `"${(f as File & { path?: string }).path ?? ''}"`).join(' ')
            window.termpolis.writeToTerminal(terminalId, paths)
          }
        }}
      >
        <PinnedOutput pins={pinnedItems} onUnpin={handleUnpin} />
        {searchOpen && (
          <div className="absolute top-1.5 right-2 z-40">
            <TerminalSearch
              onSearch={handleSearchIncremental}
              onNext={handleSearchNext}
              onPrevious={handleSearchPrev}
              onClose={handleSearchClose}
              resultIndex={searchResults.index}
              resultCount={searchResults.count}
            />
          </div>
        )}
        {selectionMode && (
          <div
            data-testid="selection-mode-badge"
            className="absolute top-1.5 left-2 z-30 flex items-center gap-1.5 text-[10px] font-medium text-[#1e1e1e] bg-[#22D3EE] rounded px-2 py-1 pointer-events-none shadow"
          >
            <i className="fa-solid fa-i-cursor text-[9px]"></i>
            SELECT — arrows move · Shift+arrows extend · Ctrl=word · a=all · Enter/y=copy · Esc=exit
          </div>
        )}
        {voice.listening && (
          <button
            type="button"
            data-testid="voice-listening-badge"
            onClick={(e) => { e.stopPropagation(); voice.stop() }}
            title="Click to stop dictation"
            className="absolute top-1.5 left-2 z-30 flex items-center gap-2 text-[10px] font-medium text-white bg-[#c0392b] hover:bg-[#e74c3c] rounded px-2 py-1 shadow cursor-pointer"
          >
            <i className="fa-solid fa-microphone text-[9px] animate-pulse"></i>
            Listening…
            {/* Live mic level — lets the user SEE the mic is actually picking them
                up; the tick marks where audio becomes reliably transcribable. */}
            <span
              data-testid="voice-level-meter"
              className="relative inline-block h-1.5 w-20 rounded-full bg-[#ffffff2e] overflow-hidden align-middle"
              title="Live mic level — keep your voice above the tick"
            >
              <span
                data-testid="voice-level-fill"
                className="absolute left-0 top-0 h-full rounded-full transition-[width] duration-75"
                style={{
                  width: `${Math.round(voice.level * 100)}%`,
                  backgroundColor: voice.level >= computeDisplayLevel(RELIABLE_SPEECH_RMS) ? '#7ee787' : '#f0b86e',
                }}
              />
              <span className="absolute top-0 h-full w-px bg-white/70" style={{ left: `${computeDisplayLevel(RELIABLE_SPEECH_RMS) * 100}%` }} />
            </span>
            <span className="opacity-80 font-normal">— click to stop</span>
          </button>
        )}
        {voice.confirm && (
          <div
            data-testid="voice-confirm-bar"
            className="absolute bottom-2 left-2 right-2 z-40 flex items-center gap-2 text-xs bg-[#2d2d2d] border border-[#3c5f8a] rounded px-3 py-2 shadow-lg"
          >
            <i className="fa-solid fa-microphone-lines text-[#82aaff]"></i>
            <code className="flex-1 truncate text-[#e0e0e0]">{voice.confirm.text}</code>
            <span className="text-[10px] text-[#999]">dictated command — review before running</span>
            <button onClick={() => voice.confirmRun(true)} className="px-2 py-0.5 rounded bg-[#0e639c] hover:bg-[#1177bb] text-white">Run</button>
            <button onClick={() => voice.confirmRun(false)} className="px-2 py-0.5 rounded bg-[#3c3c3c] hover:bg-[#4a4a4a] text-[#e0e0e0]">Insert</button>
            <button onClick={voice.cancelConfirm} aria-label="Dismiss" className="px-1.5 py-0.5 rounded text-[#999] hover:text-white">✕</button>
          </div>
        )}
        {voice.status === 'error' && voice.errorMsg && (
          <div
            data-testid="voice-error-bar"
            className="absolute bottom-2 left-2 right-2 z-40 flex items-center gap-2 text-xs bg-[#3a2222] border border-[#a33] rounded px-3 py-2 shadow-lg"
          >
            <i className="fa-solid fa-microphone-slash text-[#ff8a8a]"></i>
            <span className="flex-1 text-[#f0c0c0]">Voice: {voice.errorMsg}</span>
            <button onClick={voice.clearError} aria-label="Dismiss" className="px-1.5 py-0.5 rounded text-[#caa] hover:text-white">✕</button>
          </div>
        )}
        <div className="absolute top-1.5 right-2 z-30 flex items-center gap-1.5">
          {voiceEnabled && (
            <button
              type="button"
              data-testid="voice-toggle-btn"
              onClick={(e) => { e.stopPropagation(); void handleVoiceButtonClick() }}
              disabled={voice.status === 'transcribing'}
              aria-pressed={voice.listening}
              title={
                voice.listening
                  ? 'Stop voice dictation'
                  : voice.status === 'transcribing'
                    ? 'Transcribing…'
                    : 'Start voice dictation (or hold the push-to-talk hotkey)'
              }
              className={`flex items-center gap-1.5 text-[10px] font-medium border rounded px-2 py-1 transition-colors disabled:opacity-60 ${
                voice.listening
                  ? 'text-white bg-[#c0392b] hover:bg-[#e74c3c] border-[#e74c3c]'
                  : 'text-[#e0e0e0] bg-[#2d2d2d]/90 hover:bg-[#0e639c] border-[#3c3c3c] hover:border-[#1177bb]'
              }`}
            >
              <i className={`fa-solid ${voice.listening ? 'fa-stop' : voice.status === 'transcribing' ? 'fa-spinner fa-spin' : 'fa-microphone'} text-[9px]`}></i>
              {voice.listening ? 'Stop' : voice.status === 'transcribing' ? 'Transcribing…' : 'Voice'}
            </button>
          )}
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setPastSessionsOpen(true) }}
            className="flex items-center gap-1.5 text-[10px] font-medium text-[#e0e0e0] bg-[#2d2d2d]/90 hover:bg-[#0e639c] border border-[#3c3c3c] hover:border-[#1177bb] rounded px-2 py-1 transition-colors"
            title="Browse past Claude AI sessions across every project on this machine. Click to resume any session in a new terminal at its original folder."
            data-testid="past-ai-sessions-btn"
          >
            <i className="fa-solid fa-clock-rotate-left text-[9px]"></i>
            Past AI Sessions
          </button>
          {agentFromCommand(agentCommand)?.name === 'Claude Code' && (
            <select
              data-testid="model-picker"
              value={liveModel}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => {
                e.stopPropagation()
                const alias = e.target.value
                setLiveModel(alias)
                const cmd = modelSwitchCommand(alias)
                if (cmd) window.termpolis.writeToTerminal(terminalId, cmd + '\r')
              }}
              title="Switch this Claude agent's model on the fly (takes effect next message). Cheaper models save tokens."
              className="text-[10px] font-medium text-[#e0e0e0] bg-[#2d2d2d]/90 hover:bg-[#0e639c] border border-[#3c3c3c] hover:border-[#1177bb] rounded px-1.5 py-1 transition-colors outline-none"
            >
              <option value="">Model…</option>
              {CLAUDE_MODEL_OPTIONS.map((m) => (
                <option key={m.alias} value={m.alias}>{m.label}{m.savingsPct > 0 ? ` · ${m.savingsPct}% cheaper` : ''}</option>
              ))}
            </select>
          )}
        </div>
        <PastAISessions open={pastSessionsOpen} onClose={() => setPastSessionsOpen(false)} />
        {groqGateOpen && (
          <VoiceGroqGate
            onClose={() => setGroqGateOpen(false)}
            onOpenSettings={() => {
              setGroqGateOpen(false)
              setPendingSettingsTab('voice')
              setShowSettings(true)
            }}
          />
        )}
        {contextMenu.visible && (
          <div
            ref={menuRef}
            data-testid="terminal-context-menu"
            className="fixed z-50 bg-[#2d2d2d] border border-[#454545] rounded shadow-lg py-1 min-w-[200px]"
            style={{
              left: menuPos ? menuPos.left : contextMenu.x,
              top: menuPos ? menuPos.top : contextMenu.y,
              // Hide for the single pre-measure commit so it never flashes at
              // the un-flipped spot, then reveal at the corrected position.
              visibility: menuPos ? 'visible' : 'hidden',
            }}
          >
            <button
              className="w-full text-left px-3 py-1.5 text-xs text-[#d4d4d4] hover:bg-[#094771] cursor-pointer"
              onClick={() => {
                const snap = copySnapshotRef.current
                if (snap) window.termpolis.clipboardWriteText(snap.selection).catch(() => {})
                setContextMenu({ visible: false, x: 0, y: 0 })
              }}
            >
              Copy<span className="float-right text-[#999]">Ctrl+Shift+C</span>
            </button>
            <button
              className="w-full text-left px-3 py-1.5 text-xs text-[#d4d4d4] hover:bg-[#094771] cursor-pointer"
              onClick={() => {
                const snap = copySnapshotRef.current
                if (snap) {
                  window.termpolis.clipboardWriteRich(snap.codeBlockMd, snap.codeBlockHtml).catch(() => {})
                }
                setContextMenu({ visible: false, x: 0, y: 0 })
              }}
              title="Strip ANSI, recover logical newlines from the buffer, write both rich-text (HTML) and markdown forms. Pastes as a real code box in Slack, Teams, Outlook, GitHub, Discord."
            >
              Copy as Code Block<span className="float-right text-[#999]">Ctrl+Shift+M</span>
            </button>
            <button
              className="w-full text-left px-3 py-1.5 text-xs text-[#d4d4d4] hover:bg-[#094771] cursor-pointer"
              onClick={() => {
                const snap = copySnapshotRef.current
                if (snap) {
                  window.termpolis.clipboardWriteText(snap.plainText).catch(() => {})
                }
                setContextMenu({ visible: false, x: 0, y: 0 })
              }}
              title="Strip ANSI colors and recover logical newlines from the buffer. No markdown fence."
            >
              Copy as Plain Text
            </button>
            <button
              className="w-full text-left px-3 py-1.5 text-xs text-[#d4d4d4] hover:bg-[#094771] cursor-pointer"
              onClick={() => {
                const snap = copySnapshotRef.current
                if (snap) {
                  const cmd = lastCommandRef.current
                  const body = snap.codeBlockMd
                  const withCmd = cmd ? '`$ ' + cmd + '`\n' + body : body
                  window.termpolis.clipboardWriteText(withCmd).catch(() => {})
                }
                setContextMenu({ visible: false, x: 0, y: 0 })
              }}
              title="Prepend the last command that produced this output."
            >
              Copy with Command
            </button>
            <button
              className="w-full text-left px-3 py-1.5 text-xs text-[#d4d4d4] hover:bg-[#094771] cursor-pointer"
              onClick={async () => {
                const xtermEl = containerRef.current?.querySelector('.xterm') as HTMLElement | null
                if (xtermEl) {
                  try {
                    const canvas = xtermEl.querySelector('canvas') as HTMLCanvasElement | null
                    if (canvas) {
                      const dataUrl = canvas.toDataURL('image/png')
                      if (dataUrl) await window.termpolis.clipboardWriteImage(dataUrl)
                    }
                  } catch {}
                }
                setContextMenu({ visible: false, x: 0, y: 0 })
              }}
              title="Copy a PNG of the visible terminal area to the clipboard."
            >
              Copy as Image
            </button>
            <button
              className="w-full text-left px-3 py-1.5 text-xs text-[#d4d4d4] hover:bg-[#094771] cursor-pointer"
              onClick={() => {
                window.termpolis.clipboardReadText().then(res => {
                  const text = res?.success ? res.data : ''
                  if (text) window.termpolis.writeToTerminal(terminalId, text)
                }).catch(() => {})
                setContextMenu({ visible: false, x: 0, y: 0 })
              }}
            >
              Paste<span className="float-right text-[#999]">Ctrl+Shift+V</span>
            </button>
            <button
              className="w-full text-left px-3 py-1.5 text-xs text-[#d4d4d4] hover:bg-[#094771] cursor-pointer"
              onClick={() => {
                termRef.current?.selectAll()
                setContextMenu({ visible: false, x: 0, y: 0 })
              }}
            >
              Select All
            </button>
            <button
              className="w-full text-left px-3 py-1.5 text-xs text-[#d4d4d4] hover:bg-[#094771] cursor-pointer"
              onClick={() => {
                setContextMenu({ visible: false, x: 0, y: 0 })
                setSearchOpen(true)
              }}
              title="Search this terminal's output, including scrollback, and jump to matches."
            >
              Find...<span className="float-right text-[#999]">Ctrl+Shift+F</span>
            </button>
            <div className="border-t border-[#454545] my-1"></div>
            <button
              className="w-full text-left px-3 py-1.5 text-xs text-[#d4d4d4] hover:bg-[#094771] cursor-pointer"
              onClick={() => handleExport('full')}
            >
              Export Full Scrollback...
            </button>
            <button
              className="w-full text-left px-3 py-1.5 text-xs text-[#d4d4d4] hover:bg-[#094771] cursor-pointer"
              onClick={() => handleExport('visible')}
            >
              Export Visible Output...
            </button>
            <div className="border-t border-[#454545] my-1"></div>
            {!recording.isRecording ? (
              <button
                className="w-full text-left px-3 py-1.5 text-xs text-[#d4d4d4] hover:bg-[#094771] cursor-pointer"
                onClick={handleStartRecording}
              >
                <i className="fa-solid fa-circle text-red-500 text-[8px] mr-1.5"></i>
                Start Recording
              </button>
            ) : (
              <button
                className="w-full text-left px-3 py-1.5 text-xs text-[#d4d4d4] hover:bg-[#094771] cursor-pointer"
                onClick={handleStopRecording}
              >
                <i className="fa-solid fa-stop text-red-500 text-[8px] mr-1.5"></i>
                Stop Recording &amp; Save
              </button>
            )}
            <button
              className={`w-full text-left px-3 py-1.5 text-xs hover:bg-[#094771] cursor-pointer ${copySnapshotRef.current ? 'text-[#d4d4d4]' : 'text-[#999] pointer-events-none'}`}
              onClick={handlePinSelection}
              disabled={!copySnapshotRef.current}
            >
              <i className="fa-solid fa-thumbtack text-[10px] mr-1.5"></i>
              Pin Selection
            </button>
            <button
              className="w-full text-left px-3 py-1.5 text-xs text-[#d4d4d4] hover:bg-[#094771] cursor-pointer"
              onClick={() => {
                setShowDiffViewer(true)
                setContextMenu({ visible: false, x: 0, y: 0 })
              }}
            >
              <i className="fa-solid fa-code-compare text-[10px] mr-1.5"></i>
              View as Diff
            </button>
            {(onSplitRight || onSplitDown) && (
              <>
                <div className="border-t border-[#454545] my-1"></div>
                {onSplitRight && (
                  <button
                    className="w-full text-left px-3 py-1.5 text-xs text-[#d4d4d4] hover:bg-[#094771] cursor-pointer"
                    onClick={() => {
                      onSplitRight()
                      setContextMenu({ visible: false, x: 0, y: 0 })
                    }}
                  >
                    Split Right<span className="float-right text-[#999]">Ctrl+Shift+R</span>
                  </button>
                )}
                {onSplitDown && (
                  <button
                    className="w-full text-left px-3 py-1.5 text-xs text-[#d4d4d4] hover:bg-[#094771] cursor-pointer"
                    onClick={() => {
                      onSplitDown()
                      setContextMenu({ visible: false, x: 0, y: 0 })
                    }}
                  >
                    Split Down<span className="float-right text-[#999]">Ctrl+Shift+D</span>
                  </button>
                )}
              </>
            )}
          </div>
        )}
        {fixSuggestion && (
          <CommandFixBanner
            suggestion={fixSuggestion}
            onAccept={() => {
              window.termpolis.writeToTerminal(terminalId, fixSuggestion + '\r')
              setFixSuggestion(null)
            }}
            onDismiss={() => setFixSuggestion(null)}
          />
        )}
        {diffDetected && (
          <button
            className="absolute top-2 right-2 z-40 px-2.5 py-1 text-[11px] bg-[#1e3a5f] hover:bg-[#264f78] text-[#82aaff] rounded border border-[#3c5f8a] cursor-pointer shadow-lg"
            onClick={() => setShowDiffViewer(true)}
          >
            <i className="fa-solid fa-code-compare mr-1"></i>
            View Diff
          </button>
        )}
      </div>
      <TerminalStatusBar
        terminalId={terminalId}
        shellType={shellType}
        cwd={parsedCwd || cwd}
        parsedBranch={parsedBranch}
        agent={badgeAgent}
        isRecording={recording.isRecording}
      />
      {showDiffViewer && (
        <DiffViewer
          rawDiff={outputBufferRef.current}
          onClose={() => setShowDiffViewer(false)}
        />
      )}
    </div>
  )
}
