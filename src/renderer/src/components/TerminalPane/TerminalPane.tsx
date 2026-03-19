import React, { useEffect, useRef, useState, useCallback } from 'react'
import { Terminal } from 'xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { getTheme } from '../../themes/terminalThemes'
import { createOutputThrottle } from '../../lib/outputThrottle'
import { stripAnsi, generateFilename } from '../../lib/exportTerminal'
import { getCompletions, type CompletionResult } from '../../completions/completionEngine'
import { CompletionDropdown } from '../CompletionDropdown/CompletionDropdown'
import { useTerminalStore } from '../../store/terminalStore'
import 'xterm/css/xterm.css'

interface Props {
  terminalId: string
  terminalName: string
  isVisible: boolean
  fontSize: number
  theme: string
  fontFamily: string
  onTerminalReady?: (term: any) => void
}

interface ContextMenuState {
  visible: boolean
  x: number
  y: number
}

export function TerminalPane({ terminalId, terminalName, isVisible, fontSize, theme, fontFamily, onTerminalReady }: Props) {
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

  // Refs for use inside onData callback (avoids stale closures)
  const suggestionsRef = useRef<CompletionResult[]>([])
  const selectedIndexRef = useRef(0)
  const dropdownVisibleRef = useRef(false)
  const autocompleteEnabledRef = useRef(true)

  // Keep refs in sync with state
  suggestionsRef.current = suggestions
  selectedIndexRef.current = selectedIndex
  dropdownVisibleRef.current = dropdownVisible

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
            y: rect.bottom - 200,
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
    try {
      const webglAddon = new WebglAddon()
      webglAddon.onContextLoss(() => {
        webglAddon.dispose()
      })
      term.loadAddon(webglAddon)
    } catch {
      // WebGL not available — falls back to canvas renderer automatically
    }

    // 5. Load Unicode11 addon
    const unicode11 = new Unicode11Addon()
    term.loadAddon(unicode11)
    term.unicode.activeVersion = '11'

    // 6. Fit
    fitAddon.fit()

    termRef.current = term
    fitRef.current = fitAddon

    onTerminalReady?.(term)

    term.onData((data) => {
      // Ctrl+Space: manually trigger completions
      if (data === '\x00') {
        const input = inputBufferRef.current
        if (input.length > 0) {
          getCompletions(input).then(results => {
            if (results.length > 0) {
              setSuggestions(results)
              setSelectedIndex(0)
              setDropdownVisible(true)
              if (containerRef.current) {
                const rect = containerRef.current.getBoundingClientRect()
                setDropdownPosition({
                  x: rect.left + 20,
                  y: rect.bottom - 200,
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

      // Update input buffer
      if (data === '\r') {
        const cmd = inputBufferRef.current.trim()
        if (cmd) window.termpolis.appendHistory(terminalId, terminalName, cmd)
        inputBufferRef.current = ''
        // Dismiss dropdown on Enter
        setSuggestions([])
        setSelectedIndex(0)
        setDropdownVisible(false)
      } else if (data === '\u007f') {
        inputBufferRef.current = inputBufferRef.current.slice(0, -1)
        // Re-filter completions after backspace
        if (autocompleteEnabledRef.current && inputBufferRef.current.length >= 2) {
          getCompletions(inputBufferRef.current).then(results => {
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
        // Trigger completions if autocomplete is enabled and input has 2+ chars
        if (autocompleteEnabledRef.current && inputBufferRef.current.length >= 2) {
          getCompletions(inputBufferRef.current).then(results => {
            if (results.length > 0) {
              setSuggestions(results)
              setSelectedIndex(0)
              setDropdownVisible(true)
              if (containerRef.current) {
                const rect = containerRef.current.getBoundingClientRect()
                setDropdownPosition({
                  x: rect.left + 20,
                  y: rect.bottom - 200,
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
      if (id === terminalId) throttledWrite(data)
    })

    const ro = new ResizeObserver(() => {
      fitAddon.fit()
      window.termpolis.resizeTerminal(terminalId, term.cols, term.rows)
    })
    ro.observe(containerRef.current)

    return () => {
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
      ref={containerRef}
      className="absolute inset-0"
      style={{ visibility: isVisible ? 'visible' : 'hidden', padding: 4 }}
      onContextMenu={handleContextMenu}
    >
      {contextMenu.visible && (
        <div
          className="fixed z-50 bg-[#2d2d2d] border border-[#454545] rounded shadow-lg py-1 min-w-[200px]"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
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
    </div>
  )
}
