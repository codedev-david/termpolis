import { useState, useRef, useCallback } from 'react'
import { getCompletions, type CompletionResult } from '../completions/completionEngine'
import { useTerminalStore } from '../store/terminalStore'

interface CompletionDropdownState {
  suggestions: CompletionResult[]
  selectedIndex: number
  dropdownPosition: { x: number; y: number }
  dropdownVisible: boolean
  dismissDropdown: () => void
  triggerCompletions: (input: string) => Promise<void>
  acceptSuggestion: (suggestion: CompletionResult) => void
  /**
   * Called from onData handler to intercept keys when dropdown is visible.
   * Returns true if the key was consumed (should not be passed to PTY).
   */
  handleDropdownKeyIntercept: (data: string) => boolean
  /** Ref-based check for whether the dropdown is visible (avoids stale closures) */
  isDropdownVisibleRef: React.RefObject<boolean>
  /** Ref-based access to current suggestions (avoids stale closures) */
  suggestionsRef: React.RefObject<CompletionResult[]>
  /** Ref for autocomplete enabled setting */
  autocompleteEnabledRef: React.RefObject<boolean>
}

export function useCompletionDropdown(
  terminalId: string,
  containerRef: React.RefObject<HTMLDivElement | null>,
  inputBufferRef: React.RefObject<string>,
): CompletionDropdownState {
  const [suggestions, setSuggestions] = useState<CompletionResult[]>([])
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [dropdownPosition, setDropdownPosition] = useState({ x: 0, y: 0 })
  const [dropdownVisible, setDropdownVisible] = useState(false)

  // Refs for use inside callbacks (avoids stale closures)
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

  const updateDropdownPosition = useCallback(() => {
    if (containerRef.current) {
      const rect = containerRef.current.getBoundingClientRect()
      setDropdownPosition({
        x: rect.left + 20,
        y: rect.top + 40,
      })
    }
  }, [containerRef])

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
        updateDropdownPosition()
      } else {
        dismissDropdown()
      }
    } catch {
      dismissDropdown()
    }
  }, [dismissDropdown, updateDropdownPosition])

  const acceptSuggestion = useCallback((suggestion: CompletionResult) => {
    const input = inputBufferRef.current
    let textToInsert: string
    if (suggestion.source === 'history') {
      const eraseCount = input.length
      const eraseChars = '\u007f'.repeat(eraseCount)
      textToInsert = eraseChars + suggestion.text
    } else {
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
      if (suggestion.source === 'history') {
        inputBufferRef.current = suggestion.text
      } else {
        inputBufferRef.current += textToInsert
      }
    }
    dismissDropdown()
  }, [terminalId, dismissDropdown, inputBufferRef])

  const handleDropdownKeyIntercept = useCallback((data: string): boolean => {
    if (!dropdownVisibleRef.current || suggestionsRef.current.length === 0) {
      return false
    }

    // Tab: accept selected suggestion
    if (data === '\t') {
      const selected = suggestionsRef.current[selectedIndexRef.current]
      if (selected) {
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
      return true
    }

    // Escape: dismiss dropdown
    if (data === '\x1b') {
      setSuggestions([])
      setSelectedIndex(0)
      setDropdownVisible(false)
      return true
    }

    // Arrow Up: navigate up
    if (data === '\x1b[A') {
      setSelectedIndex(prev => (prev > 0 ? prev - 1 : suggestionsRef.current.length - 1))
      return true
    }

    // Arrow Down: navigate down
    if (data === '\x1b[B') {
      setSelectedIndex(prev => (prev < suggestionsRef.current.length - 1 ? prev + 1 : 0))
      return true
    }

    return false
  }, [terminalId, inputBufferRef])

  return {
    suggestions,
    selectedIndex,
    dropdownPosition,
    dropdownVisible,
    dismissDropdown,
    triggerCompletions,
    acceptSuggestion,
    handleDropdownKeyIntercept,
    isDropdownVisibleRef: dropdownVisibleRef,
    suggestionsRef,
    autocompleteEnabledRef,
  }
}
