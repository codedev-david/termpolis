import React, { useEffect, useLayoutEffect, useRef, useState, useCallback } from 'react'
import { Terminal } from 'xterm'
import { FitAddon } from '@xterm/addon-fit'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { getTheme } from '../../themes/terminalThemes'
import { createOutputThrottle } from '../../lib/outputThrottle'
import { stripAnsi, generateFilename, formatAsCodeBlockFromTerm, formatAsCodeBlockHtmlFromTerm, formatAsPlainTextFromTerm } from '../../lib/exportTerminal'
import { computeMenuPosition, type MenuPosition } from '../../lib/contextMenuPosition'
import { PinnedOutput, type PinnedItem } from '../PinnedOutput/PinnedOutput'
import { v4 as uuid } from 'uuid'
import { getCompletions } from '../../completions/completionEngine'
import { getSuggestion } from '../../corrections/correctionEngine'
import { CompletionDropdown } from '../CompletionDropdown/CompletionDropdown'
import { CommandFixBanner } from '../CommandFix/CommandFixBanner'
import { TerminalStatusBar } from '../StatusBar/TerminalStatusBar'
import { parsePromptFromOutput } from '../../lib/promptParser'
import { DiffViewer } from '../DiffViewer/DiffViewer'
import { PastAISessions } from '../PastAISessions/PastAISessions'
import { useTerminalStore } from '../../store/terminalStore'
import { matchesKeybinding, matchLaunchAgentSlot, matchCustomKeybinding, isEditableTarget } from '../../lib/keybindings'
import { moveCaret, toLinearSelection, selectionKeyAction, type GridCtx, type GridPos, type SelectionAction } from '../../lib/terminalSelection'
import { useVoiceInput } from '../../hooks/useVoiceInput'
import { pushToTalkIntent, pushToTalkMainKey, computeDisplayLevel, RELIABLE_SPEECH_RMS } from '../../lib/voice/voicePipeline'
import { DIFF_PATTERN, ERROR_PATTERN } from '../../lib/outputPatterns'
import { useCompletionDropdown } from '../../hooks/useCompletionDropdown'
import { useAgentDetection } from '../../hooks/useAgentDetection'
import { useTranscriptWatcher } from '../../hooks/useTranscriptWatcher'
import { useAutoPrimer, useCompactionReprimer } from '../../hooks/useAutoPrimer'
import { useSessionRecording } from '../../hooks/useSessionRecording'
import type { ShellType } from '../../types'
import 'xterm/css/xterm.css'

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

export function TerminalPane({ terminalId, terminalName, shellType, cwd, isVisible, fontSize, theme, fontFamily, onTerminalReady, onSplitRight, onSplitDown }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const inputBufferRef = useRef('')
  const [contextMenu, setContextMenu] = useState<ContextMenuState>({ visible: false, x: 0, y: 0 })
  const menuRef = useRef<HTMLDivElement>(null)
  const [menuPos, setMenuPos] = useState<MenuPosition | null>(null)
  const [pastSessionsOpen, setPastSessionsOpen] = useState(false)
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
  const completion = useCompletionDropdown(terminalId, containerRef, inputBufferRef)
  const agent = useAgentDetection()
  useTranscriptWatcher(terminalId, cwd, agent.detectedAgent)
  // Seed a launched agent with recalled context (opt-out in Settings).
  useAutoPrimer(terminalId, agent.detectedAgent, cwd)
  // Re-seed it after Claude compacts its conversation, restoring the detail it
  // summarized away from the durable memory brain (opt-out in Settings).
  const onCompactionOutput = useCompactionReprimer(terminalId, agent.detectedAgent, parsedCwd || cwd)
  const recording = useSessionRecording(terminalName, shellType)
  // Voice dictation (push-to-talk). Agent terminals take it as a prompt; plain
  // shells get a confirm-before-run bar. Opt-in via Settings → Voice.
  const voice = useVoiceInput(terminalId, !!agent.detectedAgent)
  // Reactive so the on-pane mic button appears/disappears as voice is toggled in Settings.
  const voiceEnabled = useTerminalStore((s) => s.voiceSettings?.enabled ?? false)
  const voiceToggleRef = useRef<() => void>(() => {})
  const voiceStartRef = useRef<() => void>(() => {})
  const voiceStopRef = useRef<() => void>(() => {})
  const voiceListeningRef = useRef(false)
  const pttHoldActiveRef = useRef(false)
  voiceToggleRef.current = voice.toggle
  voiceStartRef.current = voice.start
  voiceStopRef.current = voice.stop
  voiceListeningRef.current = voice.listening

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
    const selection = termRef.current?.getSelection()
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

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
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

    const term = new Terminal({
      theme: getTheme(theme),
      fontFamily,
      fontSize,
      cursorBlink: false,
      cursorStyle: 'block',
      cursorInactiveStyle: 'outline',
      scrollback,
    })

    // 2. Load FitAddon
    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)

    // 3. Open terminal (attach to DOM) — must come before WebGL
    term.open(containerRef.current)

    // 4. Load WebGL addon (requires DOM attachment)
    // Disabled for now — canvas renderer is stable; WebGL can cause blank screens
    // on some systems. Re-enable when xterm.js WebGL addon is more robust.
    // try {
    //   const webglAddon = new WebglAddon()
    //   webglAddon.onContextLoss(() => webglAddon.dispose())
    //   term.loadAddon(webglAddon)
    // } catch {}

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

    // Copy/paste/autocomplete shortcuts are read from the store keybindings at
    // event time, so rebinding them in Settings takes effect immediately:
    //   copy / copyAsCodeBlock / paste / toggleAutocomplete  → rebindable
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
      // Voice push-to-talk runs first and (in hold mode) handles keyup too, so it
      // must sit ahead of the keydown-only guard below. Inert until enabled.
      const vs = useTerminalStore.getState().voiceSettings
      if (vs?.enabled) {
        if (e.type === 'keydown' && matchesKeybinding(e, vs.pushToTalkKey)) {
          e.preventDefault()
          const intent = pushToTalkIntent('keydown', vs.pushToTalkMode)
          if (intent === 'toggle') voiceToggleRef.current()
          else if (intent === 'start' && !voiceListeningRef.current) {
            voiceStartRef.current()
            pttHoldActiveRef.current = true
          }
          return false
        }
        // Hold mode: stop on release of the trigger's main key (modifiers may already be up).
        if (e.type === 'keyup' && pttHoldActiveRef.current && e.key.toLowerCase() === pushToTalkMainKey(vs.pushToTalkKey)) {
          e.preventDefault()
          pttHoldActiveRef.current = false
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
      // Trigger autocomplete on the current input buffer (was Ctrl+Space → \x00
      // via onData; now driven by the rebindable toggleAutocomplete binding).
      if (matchesKeybinding(e, kb.toggleAutocomplete)) {
        e.preventDefault()
        const input = inputBufferRef.current
        if (input.length > 0) {
          getCompletions(input).then(results => {
            if (disposed) return
            if (results.length > 0) completion.triggerCompletions(input)
          }).catch(() => {})
        }
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
      // When dropdown is visible, intercept certain keys
      if (completion.handleDropdownKeyIntercept(data)) {
        return // Key was consumed by dropdown
      }

      // Pass data to PTY
      window.termpolis.writeToTerminal(terminalId, data)

      // Record input if recording
      recording.appendRecordingEntry('input', data)

      // Update input buffer
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
        // Dismiss dropdown on Enter
        completion.dismissDropdown()
      } else if (data === '\u007f') {
        inputBufferRef.current = inputBufferRef.current.slice(0, -1)
        // Re-filter completions after backspace
        if (completion.autocompleteEnabledRef.current && inputBufferRef.current.length >= 2) {
          completion.triggerCompletions(inputBufferRef.current)
        } else {
          completion.dismissDropdown()
        }
      } else if (!data.startsWith('\x1b')) {
        inputBufferRef.current += data
        // Dismiss fix banner when user starts typing a new command
        if (fixSuggestionRef.current) setFixSuggestion(null)
        // Trigger completions if autocomplete is enabled and input has 2+ chars
        if (completion.autocompleteEnabledRef.current && inputBufferRef.current.length >= 2) {
          completion.triggerCompletions(inputBufferRef.current)
        }
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
              onClick={(e) => { e.stopPropagation(); voice.toggle() }}
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
        </div>
        <PastAISessions open={pastSessionsOpen} onClose={() => setPastSessionsOpen(false)} />
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
                const selection = termRef.current?.getSelection()
                if (selection) window.termpolis.clipboardWriteText(selection).catch(() => {})
                setContextMenu({ visible: false, x: 0, y: 0 })
              }}
            >
              Copy<span className="float-right text-[#999]">Ctrl+Shift+C</span>
            </button>
            <button
              className="w-full text-left px-3 py-1.5 text-xs text-[#d4d4d4] hover:bg-[#094771] cursor-pointer"
              onClick={() => {
                const term = termRef.current
                if (term && term.getSelection()) {
                  window.termpolis.clipboardWriteRich(formatAsCodeBlockFromTerm(term), formatAsCodeBlockHtmlFromTerm(term)).catch(() => {})
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
                const term = termRef.current
                if (term && term.getSelection()) {
                  window.termpolis.clipboardWriteText(formatAsPlainTextFromTerm(term)).catch(() => {})
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
                const term = termRef.current
                if (term && term.getSelection()) {
                  const cmd = lastCommandRef.current
                  const body = formatAsCodeBlockFromTerm(term)
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
              className={`w-full text-left px-3 py-1.5 text-xs hover:bg-[#094771] cursor-pointer ${termRef.current?.getSelection() ? 'text-[#d4d4d4]' : 'text-[#999] pointer-events-none'}`}
              onClick={handlePinSelection}
              disabled={!termRef.current?.getSelection()}
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
        {completion.dropdownVisible && (
          <CompletionDropdown
            suggestions={completion.suggestions}
            selectedIndex={completion.selectedIndex}
            position={completion.dropdownPosition}
            onAccept={completion.acceptSuggestion}
            onDismiss={completion.dismissDropdown}
          />
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
        agent={agent.detectedAgent}
        costInfo={agent.costInfo}
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
