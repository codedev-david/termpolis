import React, { useEffect, useRef, useState, useCallback } from 'react'
import { Terminal } from 'xterm'
import { FitAddon } from '@xterm/addon-fit'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { getTheme } from '../../themes/terminalThemes'
import { createOutputThrottle } from '../../lib/outputThrottle'
import { stripAnsi, generateFilename, formatAsCodeBlockFromTerm, formatAsPlainTextFromTerm, writeCodeBlockToClipboardFromTerm } from '../../lib/exportTerminal'
import { PinnedOutput, type PinnedItem } from '../PinnedOutput/PinnedOutput'
import { v4 as uuid } from 'uuid'
import { getCompletions } from '../../completions/completionEngine'
import { getSuggestion } from '../../corrections/correctionEngine'
import { CompletionDropdown } from '../CompletionDropdown/CompletionDropdown'
import { CommandFixBanner } from '../CommandFix/CommandFixBanner'
import { TerminalStatusBar } from '../StatusBar/TerminalStatusBar'
import { parsePromptFromOutput } from '../../lib/promptParser'
import { DiffViewer } from '../DiffViewer/DiffViewer'
import { AgentHandoffBanner } from '../AgentHandoff/AgentHandoffBanner'
import { AgentHandoffModal } from '../AgentHandoff/AgentHandoffModal'
import { PastAISessions } from '../PastAISessions/PastAISessions'
import { useTerminalStore } from '../../store/terminalStore'
import { isNaturalLanguage, getSuggestions } from '../../lib/aiSuggestions'
import { DIFF_PATTERN, ERROR_PATTERN } from '../../lib/outputPatterns'
import { useCompletionDropdown } from '../../hooks/useCompletionDropdown'
import { useAgentDetection } from '../../hooks/useAgentDetection'
import { useTranscriptWatcher } from '../../hooks/useTranscriptWatcher'
import { useSessionRecording } from '../../hooks/useSessionRecording'
import { useContextLimit } from '../../hooks/useContextLimit'
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
  const [pastSessionsOpen, setPastSessionsOpen] = useState(false)

  // AI command suggestion state
  const [aiSuggestions, setAiSuggestions] = useState<{ command: string; description: string }[]>([])
  const [selectedSuggestionIndex, setSelectedSuggestionIndex] = useState(0)

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
  const recording = useSessionRecording(terminalName, shellType)
  const contextLimit = useContextLimit(
    cwd,
    parsedCwd,
    agent.detectedAgent?.name ?? null,
    outputBufferRef,
  )

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

    // Copy/paste support:
    //   Ctrl+C        → smart: copy selection if any, else passthrough (SIGINT)
    //   Ctrl+V        → paste
    //   Ctrl+Shift+C  → always copy (legacy, for power users)
    //   Ctrl+Shift+V  → always paste (legacy)
    //   Ctrl+Shift+M  → copy as Slack/Teams-friendly code block (HTML+plain)
    //   Shift+Enter   → backslash + Enter (bash line continuation; many AI CLIs
    //                   treat \<Enter> as multi-line continuation as well)
    term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
      if (e.type !== 'keydown') return true

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

      // Ctrl+Shift+M — copy as code block (HTML + markdown plain-text)
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'M') {
        e.preventDefault()
        if (term.getSelection()) writeCodeBlockToClipboardFromTerm(term).catch(() => {})
        return false
      }
      // Ctrl+Shift+C — always copy (legacy explicit form)
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'C' || e.key === 'c')) {
        e.preventDefault()
        const selection = term.getSelection()
        if (selection) navigator.clipboard.writeText(selection).catch(() => {})
        return false
      }
      // Ctrl+Shift+V — always paste (legacy explicit form)
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'V' || e.key === 'v')) {
        e.preventDefault()
        navigator.clipboard.readText().then(text => {
          if (text) window.termpolis.writeToTerminal(terminalId, text)
        }).catch(() => {})
        return false
      }
      // Ctrl+C (no Shift) — smart copy: if selection, copy + clear; else
      // let it through so it reaches the shell as SIGINT.
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.key === 'C' || e.key === 'c')) {
        const selection = term.getSelection()
        if (selection) {
          e.preventDefault()
          navigator.clipboard.writeText(selection).catch(() => {})
          term.clearSelection()
          return false
        }
        return true
      }
      // Ctrl+V (no Shift) — paste
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.key === 'V' || e.key === 'v')) {
        e.preventDefault()
        navigator.clipboard.readText().then(text => {
          if (text) window.termpolis.writeToTerminal(terminalId, text)
        }).catch(() => {})
        return false
      }
      return true // let terminal handle all other keys
    })

    term.onData((data) => {
      // Tab: accept AI suggestion if visible
      if (data === '\t' && aiSuggestions.length > 0) {
        const selected = aiSuggestions[selectedSuggestionIndex]
        if (selected) {
          // Clear current input from terminal (send backspaces), then type the command
          const currentLen = inputBufferRef.current.length
          const backspaces = '\u007f'.repeat(currentLen)
          window.termpolis.writeToTerminal(terminalId, backspaces)
          window.termpolis.writeToTerminal(terminalId, selected.command)
          inputBufferRef.current = selected.command
          setAiSuggestions([])
        }
        return
      }

      // Up/Down: navigate AI suggestions if visible
      if (aiSuggestions.length > 0 && (data === '\x1b[A' || data === '\x1b[B')) {
        setSelectedSuggestionIndex(prev => {
          if (data === '\x1b[A') return Math.max(0, prev - 1)
          return Math.min(aiSuggestions.length - 1, prev + 1)
        })
        return
      }

      // Escape: dismiss AI suggestions
      if (data === '\x1b' && aiSuggestions.length > 0) {
        setAiSuggestions([])
        return
      }

      // Ctrl+Space: manually trigger completions
      if (data === '\x00') {
        const input = inputBufferRef.current
        if (input.length > 0) {
          getCompletions(input).then(results => {
            if (disposed) return
            if (results.length > 0) {
              completion.triggerCompletions(input)
            }
          }).catch(() => {})
        }
        return
      }

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
        // Dismiss dropdown and AI suggestions on Enter
        completion.dismissDropdown()
        if (!disposed) setAiSuggestions([])
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
        // AI command suggestions for natural language input
        const currentInput = inputBufferRef.current
        if (isNaturalLanguage(currentInput)) {
          const suggestions = getSuggestions(currentInput)
          if (!disposed) { setAiSuggestions(suggestions); setSelectedSuggestionIndex(0) }
        } else if (!disposed) {
          setAiSuggestions([])
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

      // Parse prompt for cwd and git branch — throttled to once per 500ms
      const now = Date.now()
      if (now - lastPromptParseRef.current > 500) {
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

      // Context limit detection (only when agent is active)
      if (agent.agentDetectedRef.current) {
        contextLimit.processContextLimit(stripped)
      }

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

  // Agent handoff: confirm and create new terminal
  const handleHandoffConfirm = useCallback((agentCommand: string, prompt: string, keepOldTerminal: boolean) => {
    contextLimit.setShowHandoffModal(false)
    contextLimit.dismissContextLimit()

    // Create a new terminal for the new agent
    const store = useTerminalStore.getState()
    const newId = uuid()
    const agentLabel = agentCommand.charAt(0).toUpperCase() + agentCommand.slice(1)
    const newTerminal = {
      id: newId,
      name: `${agentLabel} (handoff)`,
      color: '#D97706',
      shellType: shellType,
      cwd: parsedCwd || cwd,
      fontSize,
      theme,
      fontFamily,
    }

    // Add the terminal to the store
    store.addTerminal(newTerminal)

    // Create the PTY
    window.termpolis.createTerminal(newId, shellType, parsedCwd || cwd).then(() => {
      // Wait for shell to initialize, then launch the agent and paste the handoff prompt
      setTimeout(() => {
        if (typeof window === 'undefined' || !window.termpolis?.writeToTerminal) return
        // Start the agent
        window.termpolis.writeToTerminal(newId, agentCommand + '\r')
        // Wait for agent to initialize, then paste the handoff prompt
        setTimeout(() => {
          if (typeof window === 'undefined' || !window.termpolis?.writeToTerminal) return
          window.termpolis.writeToTerminal(newId, prompt + '\r')
        }, 2000)
      }, 1000)
    })

    // Optionally close the old terminal
    if (!keepOldTerminal) {
      window.termpolis.killTerminal(terminalId)
      store.removeTerminal(terminalId)
    }
  }, [terminalId, shellType, parsedCwd, cwd, fontSize, theme, fontFamily, contextLimit])

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
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); setPastSessionsOpen(true) }}
          className="absolute top-1.5 right-2 z-30 flex items-center gap-1.5 text-[10px] font-medium text-[#e0e0e0] bg-[#2d2d2d]/90 hover:bg-[#0e639c] border border-[#3c3c3c] hover:border-[#1177bb] rounded px-2 py-1 transition-colors"
          title="Browse past Claude AI sessions across every project on this machine. Click to resume any session in a new terminal at its original folder."
          data-testid="past-ai-sessions-btn"
        >
          <i className="fa-solid fa-clock-rotate-left text-[9px]"></i>
          Past AI Sessions
        </button>
        <PastAISessions open={pastSessionsOpen} onClose={() => setPastSessionsOpen(false)} />
        {contextMenu.visible && (
          <div
            className="fixed z-50 bg-[#2d2d2d] border border-[#454545] rounded shadow-lg py-1 min-w-[200px]"
            style={{ left: contextMenu.x, top: contextMenu.y }}
          >
            <button
              className="w-full text-left px-3 py-1.5 text-xs text-[#d4d4d4] hover:bg-[#094771] cursor-pointer"
              onClick={() => {
                const selection = termRef.current?.getSelection()
                if (selection) navigator.clipboard.writeText(selection)
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
                  writeCodeBlockToClipboardFromTerm(term).catch(() => {})
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
                  navigator.clipboard.writeText(formatAsPlainTextFromTerm(term))
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
                  navigator.clipboard.writeText(withCmd).catch(() => {})
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
                      const blob: Blob | null = await new Promise(res => canvas.toBlob(b => res(b), 'image/png'))
                      if (blob && navigator.clipboard && (window as any).ClipboardItem) {
                        await navigator.clipboard.write([new (window as any).ClipboardItem({ 'image/png': blob })])
                      }
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
                navigator.clipboard.readText().then(text => {
                  if (text) window.termpolis.writeToTerminal(terminalId, text)
                })
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
        {aiSuggestions.length > 0 && (
          <div className="absolute bottom-10 left-4 right-4 z-30 bg-[#252526] border border-[#3c3c3c] rounded-lg shadow-xl overflow-hidden">
            <div className="px-3 py-1.5 text-[10px] text-[#22D3EE] border-b border-[#3c3c3c] flex items-center gap-1.5">
              <i className="fa-solid fa-wand-magic-sparkles"></i>
              <span className="font-semibold">AI Suggestion</span>
            </div>
            {aiSuggestions.map((s, i) => (
              <div
                key={s.command}
                className={`flex items-center gap-3 px-3 py-2 text-xs cursor-pointer ${
                  i === selectedSuggestionIndex ? 'bg-[#04395e] text-white' : 'text-[#d4d4d4] hover:bg-[#2a2d2e]'
                }`}
                onClick={() => {
                  const currentLen = inputBufferRef.current.length
                  const backspaces = '\u007f'.repeat(currentLen)
                  window.termpolis.writeToTerminal(terminalId, backspaces)
                  window.termpolis.writeToTerminal(terminalId, s.command)
                  inputBufferRef.current = s.command
                  setAiSuggestions([])
                }}
              >
                <code className="font-mono text-[#22D3EE]">{s.command}</code>
                <span className="text-[#888] ml-auto">{s.description}</span>
              </div>
            ))}
            <div className="px-3 py-1 text-[10px] text-[#888] border-t border-[#3c3c3c]">
              Tab accept · ↑↓ navigate · Esc dismiss
            </div>
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
        {contextLimit.contextLimitReached && agent.detectedAgent && !contextLimit.showHandoffModal && (
          <AgentHandoffBanner
            previousAgent={agent.detectedAgent.name}
            onSwitchTo={contextLimit.handleHandoffSwitchTo}
            onDismiss={contextLimit.dismissContextLimit}
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
      {contextLimit.showHandoffModal && contextLimit.handoffContext && (
        <AgentHandoffModal
          context={contextLimit.handoffContext}
          onConfirm={handleHandoffConfirm}
          onCancel={() => contextLimit.setShowHandoffModal(false)}
        />
      )}
    </div>
  )
}
