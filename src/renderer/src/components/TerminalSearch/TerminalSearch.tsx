import React, { useEffect, useRef, useState } from 'react'

// In-terminal find bar. Searches the live terminal buffer INCLUDING scrollback
// and scrolls the viewport to each match (the heavy lifting is done by xterm's
// SearchAddon, wired up in TerminalPane). This component owns only the UI + the
// query/option state and calls injected callbacks, so it unit-tests cleanly
// without a real xterm instance.

export interface TerminalSearchOptions {
  caseSensitive: boolean
  wholeWord: boolean
  regex: boolean
}

export interface TerminalSearchProps {
  /** Incremental search as the user types / toggles options (stays on the first
   *  match rather than advancing on every keystroke). */
  onSearch: (term: string, options: TerminalSearchOptions) => void
  /** Advance to the next match (Enter / ▼). */
  onNext: (term: string, options: TerminalSearchOptions) => void
  /** Go to the previous match (Shift+Enter / ▲). */
  onPrevious: (term: string, options: TerminalSearchOptions) => void
  /** Close the find bar. */
  onClose: () => void
  /** 0-based index of the active match (-1 when none) and total count — fed from
   *  the parent's subscription to SearchAddon.onDidChangeResults. */
  resultIndex: number
  resultCount: number
}

const baseBtn =
  'flex items-center justify-center h-6 min-w-6 px-1 rounded text-[11px] leading-none transition-colors'
const iconBtn = `${baseBtn} text-[#9ca3af] hover:text-[#d4d4d4] hover:bg-[#37373d]`
const toggleBtn = (active: boolean): string =>
  `${baseBtn} font-mono ${active ? 'bg-[#0e639c] text-white' : 'text-[#9ca3af] hover:text-[#d4d4d4] hover:bg-[#37373d]'}`

export function TerminalSearch({
  onSearch,
  onNext,
  onPrevious,
  onClose,
  resultIndex,
  resultCount,
}: TerminalSearchProps): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [options, setOptions] = useState<TerminalSearchOptions>({ caseSensitive: false, wholeWord: false, regex: false })
  const inputRef = useRef<HTMLInputElement>(null)

  // Focus the input the moment the bar opens so the user can just start typing.
  useEffect(() => { inputRef.current?.focus() }, [])

  // Re-run an incremental search whenever the query or any option changes.
  useEffect(() => {
    if (query) onSearch(query, options)
    // onSearch is a stable parent callback; re-running on its identity is noise.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, options])

  const next = (): void => { if (query) onNext(query, options) }
  const previous = (): void => { if (query) onPrevious(query, options) }
  const toggle = (k: keyof TerminalSearchOptions): void => setOptions((o) => ({ ...o, [k]: !o[k] }))

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter') {
      e.preventDefault()
      if (e.shiftKey) previous(); else next()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }

  const noMatches = query.length > 0 && resultCount === 0
  const countLabel = query.length === 0 ? '' : resultCount > 0 ? `${resultIndex + 1}/${resultCount}` : 'No results'

  return (
    <div
      data-testid="terminal-search"
      role="search"
      // Keep clicks inside the bar from reaching the terminal's mousedown/context handlers.
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
      className="flex items-center gap-1 bg-[#252526] border border-[#3c3c3c] rounded shadow-lg px-1.5 py-1"
    >
      <i className="fa-solid fa-magnifying-glass text-[10px] text-[#9ca3af] ml-0.5"></i>
      <input
        ref={inputRef}
        data-testid="terminal-search-input"
        aria-label="Find in terminal"
        value={query}
        spellCheck={false}
        placeholder="Find in terminal"
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={handleKeyDown}
        className="bg-transparent text-sm text-[#d4d4d4] outline-none placeholder-[#9ca3af] w-44"
      />
      <span
        data-testid="terminal-search-count"
        className={`text-[11px] tabular-nums min-w-[3.25rem] text-right pr-0.5 ${noMatches ? 'text-[#e06c75]' : 'text-[#9ca3af]'}`}
      >
        {countLabel}
      </span>
      <button data-testid="terminal-search-case" type="button" title="Match case" aria-pressed={options.caseSensitive} onClick={() => toggle('caseSensitive')} className={toggleBtn(options.caseSensitive)}>Aa</button>
      <button data-testid="terminal-search-word" type="button" title="Match whole word" aria-pressed={options.wholeWord} onClick={() => toggle('wholeWord')} className={toggleBtn(options.wholeWord)}>ab</button>
      <button data-testid="terminal-search-regex" type="button" title="Use regular expression" aria-pressed={options.regex} onClick={() => toggle('regex')} className={toggleBtn(options.regex)}>.*</button>
      <button data-testid="terminal-search-prev" type="button" title="Previous match (Shift+Enter)" onClick={previous} className={iconBtn}><i className="fa-solid fa-chevron-up text-[10px]"></i></button>
      <button data-testid="terminal-search-next" type="button" title="Next match (Enter)" onClick={next} className={iconBtn}><i className="fa-solid fa-chevron-down text-[10px]"></i></button>
      <button data-testid="terminal-search-close" type="button" title="Close (Esc)" onClick={onClose} className={iconBtn}><i className="fa-solid fa-xmark text-[11px]"></i></button>
    </div>
  )
}
