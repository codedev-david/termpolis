import React, { useEffect, useRef, useState, useCallback } from 'react'
import { Terminal } from 'xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { getTheme } from '../../themes/terminalThemes'
import { createOutputThrottle } from '../../lib/outputThrottle'
import { stripAnsi, generateFilename } from '../../lib/exportTerminal'
import { createSessionRecorder, appendEntry, formatRecording, generateRecordingFilename, type SessionRecording } from '../../lib/sessionRecorder'
import { PinnedOutput, type PinnedItem } from '../PinnedOutput/PinnedOutput'
import { v4 as uuid } from 'uuid'
import { getCompletions, type CompletionResult } from '../../completions/completionEngine'
import { getSuggestion } from '../../corrections/correctionEngine'
import { CompletionDropdown } from '../CompletionDropdown/CompletionDropdown'
import { CommandFixBanner } from '../CommandFix/CommandFixBanner'
import { TerminalStatusBar } from '../StatusBar/TerminalStatusBar'
import { parsePromptFromOutput } from '../../lib/promptParser'
import { detectAgent, type AgentInfo } from '../../lib/agentDetector'
import { parseCostFromOutput, type CostInfo } from '../../lib/costTracker'
import { parseConversation } from '../../lib/conversationParser'
import { DiffViewer } from '../DiffViewer/DiffViewer'
import { useTerminalStore } from '../../store/terminalStore'
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

  // Completion state
  const [suggestions, setSuggestions] = useState<CompletionResult[]>([])
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [dropdownPosition, setDropdownPosition] = useState({ x: 0, y: 0 })
  const [dropdownVisible, setDropdownVisible] = useState(false)

  // Command fix banner state
  const [fixSuggestion, setFixSuggestion] = useState<string | null>(null)
  const fixSuggestionRef = useRef<string | null>(null)
  const outputBufferRef = useRef('')
  const [parsedCwd, setParsedCwd] = useState<string | null>(null)
  const [parsedBranch, setParsedBranch] = useState<string | null>(null)
  const lastCommandRef = useRef('')

  // Agent detection state
  const [detectedAgent, setDetectedAgent] = useState<AgentInfo | null>(null)
  const agentDetectedRef = useRef(false)
  const agentScanBytesRef = useRef(0)
  const AGENT_SCAN_LIMIT = 2048

  // Cost tracking state
  const [costInfo, setCostInfo] = useState<CostInfo | null>(null)
  const costScanCounterRef = useRef(0)
  const COST_SCAN_INTERVAL = 5 // scan every 5th output chunk

  // Conversation parsing state
  const conversationParsedCountRef = useRef(0)
  const CONVERSATION_PARSE_INTERVAL = 10 // parse every 10th output chunk when agent active

  // Session recording state
  const [isRecording, setIsRecording] = useState(false)
  const isRecordingRef = useRef(false)
  const recordingRef = useRef<SessionRecording | null>(null)

  // Pinned output state
  const [pinnedItems, setPinnedItems] = useState<PinnedItem[]>([])

  // Diff viewer state
  const [diffDetected, setDiffDetected] = useState(false)
  const [showDiffViewer, setShowDiffViewer] = useState(false)
  const diffDetectedRef = useRef(false)

  // Refs for use inside onData callback (avoids stale closures)
  const suggestionsRef = useRef<CompletionResult[]>([])
  const selectedIndexRef = useRef(0)
  const dropdownVisibleRef = useRef(false)
  const autocompleteEnabledRef = useRef(true)

  // Keep refs in sync with state
  suggestionsRef.current = suggestions
  selectedIndexRef.current = selectedIndex
  dropdownVisibleRef.current = dropdownVisible
  fixSuggestionRef.current = fixSuggestion
  isRecordingRef.current = isRecording

  // Sync autocomplete setting from store
  const autocompleteEnabled = useTerminalStore(s => s.autocompleteEnabled)
  autocompleteEnabledRef.current = autocompleteEnabled

  const dismissDropdown = useCallback(() => {
    setSuggestions([])
    setSelectedIndex(0)
    setDropdownVisible(false)
  }, [])

  const triggerCompletions = useCallback(async (input: string) => {
    if (input.length < 2) {
      dismissDropdown()
      return
    }
    try {
      const results = await getCompletions(input)
      if (results.length > 0) {
        setSuggestions(results)
        setSelectedIndex(0)
        setDropdownVisible(true)
        // Position near bottom-left of terminal container
        if (containerRef.current) {
          const rect = containerRef.current.getBoundingClientRect()
          setDropdownPosition({
            x: rect.left + 20,
            y: rect.top + 40,
          })
        }
      } else {
        dismissDropdown()
      }
    } catch {
      dismissDropdown()
    }
  }, [dismissDropdown])

  const acceptSuggestion = useCallback((suggestion: CompletionResult) => {
    const input = inputBufferRef.current
    // Calculate what to insert: the suggestion text minus what's already typed
    // For full-command history suggestions, replace the entire input
    let textToInsert: string
    if (suggestion.source === 'history') {
      // Erase current input and type the full command
      const eraseCount = input.length
      const eraseChars = '\u007f'.repeat(eraseCount)
      textToInsert = eraseChars + suggestion.text
    } else {
      // Find common prefix and insert the rest
      const parts = input.split(/\s+/)
      const lastPart = parts[parts.length - 1] || ''
      if (suggestion.text.startsWith(lastPart)) {
        textToInsert = suggestion.text.slice(lastPart.length)
      } else {
        textToInsert = suggestion.text
      }
    }

    if (textToInsert) {
      window.termpolis.writeToTerminal(terminalId, textToInsert)
      // Update input buffer to reflect the accepted text
      if (suggestion.source === 'history') {
        inputBufferRef.current = suggestion.text
      } else {
        inputBufferRef.current += textToInsert
      }
    }
    dismissDropdown()
  }, [terminalId, dismissDropdown])

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

  const shellLabel: Record<string, string> = {
    bash: 'Bash', zsh: 'Zsh', cmd: 'CMD', powershell: 'PowerShell', gitbash: 'Git Bash',
  }

  const handleStartRecording = useCallback(() => {
    const recording = createSessionRecorder(terminalName, shellLabel[shellType] ?? shellType)
    recordingRef.current = recording
    setIsRecording(true)
    setContextMenu({ visible: false, x: 0, y: 0 })
  }, [terminalName, shellType])

  const handleStopRecording = useCallback(() => {
    const recording = recordingRef.current
    if (!recording) return
    const content = formatRecording(recording)
    const defaultFilename = generateRecordingFilename(terminalName)
    window.termpolis.exportTerminal({ content, defaultFilename })
    recordingRef.current = null
    setIsRecording(false)
    setContextMenu({ visible: false, x: 0, y: 0 })
  }, [terminalName])

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
    const term = new Terminal({
      theme: getTheme(theme),
      fontFamily,
      fontSize,
      cursorBlink: true,
      scrollback: 10000,
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

    // 7. Fit
    fitAddon.fit()

    termRef.current = term
    fitRef.current = fitAddon

    onTerminalReady?.(term)

    // Copy/paste support (Ctrl+Shift+C to copy, Ctrl+Shift+V to paste)
    const keyHandler = term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'C') {
        const selection = term.getSelection()
        if (selection) navigator.clipboard.writeText(selection)
        return false // prevent terminal from processing
      }
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'V') {
        navigator.clipboard.readText().then(text => {
          if (text) window.termpolis.writeToTerminal(terminalId, text)
        })
        return false
      }
      return true // let terminal handle all other keys
    })

    term.onData((data) => {
      // Ctrl+Space: manually trigger completions
      if (data === '\x00') {
        const input = inputBufferRef.current
        if (input.length > 0) {
          getCompletions(input).then(results => {
            if (disposed) return
            if (results.length > 0) {
              setSuggestions(results)
              setSelectedIndex(0)
              setDropdownVisible(true)
              if (containerRef.current) {
                const rect = containerRef.current.getBoundingClientRect()
                setDropdownPosition({
                  x: rect.left + 20,
                  y: rect.top + 40,
                })
              }
            }
          }).catch(() => {})
        }
        return
      }

      // When dropdown is visible, intercept certain keys
      if (dropdownVisibleRef.current && suggestionsRef.current.length > 0) {
        // Tab: accept selected suggestion
        if (data === '\t') {
          const selected = suggestionsRef.current[selectedIndexRef.current]
          if (selected) {
            // Use a microtask so React state updates apply
            Promise.resolve().then(() => {
              const input = inputBufferRef.current
              let textToInsert: string
              if (selected.source === 'history') {
                const eraseCount = input.length
                const eraseChars = '\u007f'.repeat(eraseCount)
                textToInsert = eraseChars + selected.text
              } else {
                const parts = input.split(/\s+/)
                const lastPart = parts[parts.length - 1] || ''
                if (selected.text.startsWith(lastPart)) {
                  textToInsert = selected.text.slice(lastPart.length)
                } else {
                  textToInsert = selected.text
                }
              }
              if (textToInsert) {
                window.termpolis.writeToTerminal(terminalId, textToInsert)
                if (selected.source === 'history') {
                  inputBufferRef.current = selected.text
                } else {
                  inputBufferRef.current += textToInsert
                }
              }
              setSuggestions([])
              setSelectedIndex(0)
              setDropdownVisible(false)
            })
          }
          return // Don't pass Tab to PTY
        }

        // Escape: dismiss dropdown
        if (data === '\x1b') {
          setSuggestions([])
          setSelectedIndex(0)
          setDropdownVisible(false)
          return // Don't pass Escape to PTY
        }

        // Arrow Up: navigate up
        if (data === '\x1b[A') {
          setSelectedIndex(prev => (prev > 0 ? prev - 1 : suggestionsRef.current.length - 1))
          return // Don't pass to PTY
        }

        // Arrow Down: navigate down
        if (data === '\x1b[B') {
          setSelectedIndex(prev => (prev < suggestionsRef.current.length - 1 ? prev + 1 : 0))
          return // Don't pass to PTY
        }
      }

      // Pass data to PTY
      window.termpolis.writeToTerminal(terminalId, data)

      // Record input if recording
      if (isRecordingRef.current && recordingRef.current) {
        appendEntry(recordingRef.current, 'input', data)
      }

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
        setSuggestions([])
        setSelectedIndex(0)
        setDropdownVisible(false)
      } else if (data === '\u007f') {
        inputBufferRef.current = inputBufferRef.current.slice(0, -1)
        // Re-filter completions after backspace
        if (autocompleteEnabledRef.current && inputBufferRef.current.length >= 2) {
          getCompletions(inputBufferRef.current).then(results => {
            if (disposed) return
            if (results.length > 0) {
              setSuggestions(results)
              setSelectedIndex(0)
              setDropdownVisible(true)
            } else {
              setSuggestions([])
              setSelectedIndex(0)
              setDropdownVisible(false)
            }
          }).catch(() => {})
        } else {
          setSuggestions([])
          setSelectedIndex(0)
          setDropdownVisible(false)
        }
      } else if (!data.startsWith('\x1b')) {
        inputBufferRef.current += data
        // Dismiss fix banner when user starts typing a new command
        if (fixSuggestionRef.current) setFixSuggestion(null)
        // Trigger completions if autocomplete is enabled and input has 2+ chars
        if (autocompleteEnabledRef.current && inputBufferRef.current.length >= 2) {
          getCompletions(inputBufferRef.current).then(results => {
            if (disposed) return
            if (results.length > 0) {
              setSuggestions(results)
              setSelectedIndex(0)
              setDropdownVisible(true)
              if (containerRef.current) {
                const rect = containerRef.current.getBoundingClientRect()
                setDropdownPosition({
                  x: rect.left + 20,
                  y: rect.top + 40,
                })
              }
            } else {
              setSuggestions([])
              setSelectedIndex(0)
              setDropdownVisible(false)
            }
          }).catch(() => {})
        }
      }
    })

    const throttledWrite = createOutputThrottle((data) => term.write(data))

    const unsub = window.termpolis.onTerminalData((id, data) => {
      if (id !== terminalId) return
      throttledWrite(data)

      // Record output if recording
      if (isRecordingRef.current && recordingRef.current) {
        appendEntry(recordingRef.current, 'output', data)
      }

      // Buffer recent output (keep last 4KB to avoid memory bloat)
      outputBufferRef.current += data
      if (outputBufferRef.current.length > 4096) {
        outputBufferRef.current = outputBufferRef.current.slice(-4096)
      }

      // Detect diff output
      const DIFF_PATTERN = /^diff --git /m
      const hasDiff = DIFF_PATTERN.test(outputBufferRef.current)
      if (hasDiff !== diffDetectedRef.current) {
        diffDetectedRef.current = hasDiff
        if (!disposed) setDiffDetected(hasDiff)
      }

      // Parse prompt for cwd and git branch (works on all platforms by reading terminal output)
      const stripped = outputBufferRef.current.replace(/\x1b\[[\?]?[0-9;]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
      const promptInfo = parsePromptFromOutput(stripped, shellType)
      if (promptInfo.cwd && !disposed) setParsedCwd(promptInfo.cwd)
      if (promptInfo.gitBranch !== undefined && !disposed) setParsedBranch(promptInfo.gitBranch)

      // Agent detection: scan first ~2KB of output then stop
      if (!agentDetectedRef.current && agentScanBytesRef.current < AGENT_SCAN_LIMIT) {
        agentScanBytesRef.current += data.length
        const agent = detectAgent(stripped)
        if (agent) {
          agentDetectedRef.current = true
          if (!disposed) setDetectedAgent(agent)
        }
      }

      // Cost tracking: scan periodically when an agent is active
      if (agentDetectedRef.current) {
        costScanCounterRef.current++
        if (costScanCounterRef.current % COST_SCAN_INTERVAL === 0) {
          const parsed = parseCostFromOutput(stripped)
          if (parsed && !disposed) {
            setCostInfo(prev => ({
              tokensIn: parsed.tokensIn ?? prev?.tokensIn ?? 0,
              tokensOut: parsed.tokensOut ?? prev?.tokensOut ?? 0,
              estimatedCost: parsed.estimatedCost ?? prev?.estimatedCost ?? 0,
              lastUpdated: parsed.lastUpdated ?? Date.now(),
            }))
          }
        }
      }

      // Conversation parsing: periodically parse output when an agent is active
      if (agentDetectedRef.current) {
        conversationParsedCountRef.current++
        if (conversationParsedCountRef.current % CONVERSATION_PARSE_INTERVAL === 0) {
          const agentName = detectedAgent?.name ?? 'AI Agent'
          const turns = parseConversation(stripped, terminalId, terminalName, agentName)
          const store = useTerminalStore.getState()
          const existingConv = store.conversations.find(c => c.terminalId === terminalId)
          const existingCount = existingConv?.turns.length ?? 0
          // Only add genuinely new turns
          if (turns.length > existingCount) {
            const newTurns = turns.slice(existingCount)
            for (const turn of newTurns) {
              store.addConversationTurn(terminalId, terminalName, agentName, turn)
            }
          }
        }
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
      // (works without shell integration markers)
      if (lastCommandRef.current && !fixSuggestionRef.current) {
        const errorPatterns = /command not found|not recognized|is not a .* command|Permission denied|EACCES|No such file or directory/i
        if (errorPatterns.test(data)) {
          const cmd = lastCommandRef.current
          const output = outputBufferRef.current
          getSuggestion(cmd, output).then(suggestion => {
            if (disposed) return
            if (suggestion) setFixSuggestion(suggestion)
          }).catch(() => {})
        }
      }
    })

    const ro = new ResizeObserver(() => {
      fitAddon.fit()
      window.termpolis.resizeTerminal(terminalId, term.cols, term.rows)
    })
    ro.observe(containerRef.current)

    return () => {
      disposed = true
      unsub()
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
        fitRef.current!.fit()
        window.termpolis.resizeTerminal(terminalId, termRef.current!.cols, termRef.current!.rows)
      }, 0)
    }
  }, [isVisible, terminalId])

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
            const paths = files.map(f => `"${f.path}"`).join(' ')
            window.termpolis.writeToTerminal(terminalId, paths)
          }
        }}
      >
        <PinnedOutput pins={pinnedItems} onUnpin={handleUnpin} />
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
              Copy<span className="float-right text-[#666]">Ctrl+Shift+C</span>
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
              Paste<span className="float-right text-[#666]">Ctrl+Shift+V</span>
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
            {!isRecording ? (
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
              className={`w-full text-left px-3 py-1.5 text-xs hover:bg-[#094771] cursor-pointer ${termRef.current?.getSelection() ? 'text-[#d4d4d4]' : 'text-[#666] pointer-events-none'}`}
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
                    Split Right<span className="float-right text-[#666]">Ctrl+Shift+R</span>
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
                    Split Down<span className="float-right text-[#666]">Ctrl+Shift+D</span>
                  </button>
                )}
              </>
            )}
          </div>
        )}
        {dropdownVisible && (
          <CompletionDropdown
            suggestions={suggestions}
            selectedIndex={selectedIndex}
            position={dropdownPosition}
            onAccept={acceptSuggestion}
            onDismiss={dismissDropdown}
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
      <TerminalStatusBar terminalId={terminalId} shellType={shellType} cwd={parsedCwd || cwd} parsedBranch={parsedBranch} agent={detectedAgent} costInfo={costInfo} isRecording={isRecording} />
      {showDiffViewer && (
        <DiffViewer
          rawDiff={outputBufferRef.current}
          onClose={() => setShowDiffViewer(false)}
        />
      )}
    </div>
  )
}
