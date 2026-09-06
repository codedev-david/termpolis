// AppLogModal.tsx
//
// "Let me see what the app is doing behind the scenes."
//
// In a packaged build there is no console, so the only answer to "it did something
// odd" used to be "install a dev build". This shows the same lines main and the
// renderer print, newest last, with a level filter and a substring filter, and a Copy
// that produces something pasteable into a bug report.
//
// It reads on open and on demand rather than subscribing to a stream: the ring buffer
// already holds the history, a push channel would add IPC traffic to every console
// call in the app, and a log you are reading is a log that has stopped moving anyway.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { formatLogLine, type AppLogEntry, type AppLogLevel } from '../../../../shared/appLog'

interface AppLogModalProps {
  onClose: () => void
}

/** Level → colour. Warn and error are the reason anyone opens this, so they are the
 *  only two that get a colour strong enough to find by scrolling. */
const LEVEL_STYLE: Record<AppLogLevel, string> = {
  debug: 'text-[#6a737d]',
  info: 'text-[#8ab4f8]',
  log: 'text-[#c8c8c8]',
  warn: 'text-[#e5c07b]',
  error: 'text-[#ff8a8a]',
}

const LEVEL_ORDER: readonly AppLogLevel[] = ['debug', 'info', 'log', 'warn', 'error']

/** Entries at or above `min`, then narrowed by a case-insensitive substring. Exported
 *  because it is the only logic here worth testing directly -- the rest is markup. */
export function filterEntries(
  entries: readonly AppLogEntry[],
  min: AppLogLevel,
  query: string,
): AppLogEntry[] {
  const floor = LEVEL_ORDER.indexOf(min)
  const q = query.trim().toLowerCase()
  return entries.filter((e) => {
    if (LEVEL_ORDER.indexOf(e.level) < floor) return false
    if (!q) return true
    return e.msg.toLowerCase().includes(q) || e.source.includes(q)
  })
}

export function AppLogModal({ onClose }: AppLogModalProps): React.JSX.Element {
  const [entries, setEntries] = useState<AppLogEntry[]>([])
  const [path, setPath] = useState<string | null>(null)
  const [minLevel, setMinLevel] = useState<AppLogLevel>('debug')
  const [query, setQuery] = useState('')
  const [copied, setCopied] = useState(false)
  const [loading, setLoading] = useState(true)
  const bottomRef = useRef<HTMLDivElement | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const res = await window.termpolis.readAppLog(1000)
      if (res.success && res.data) {
        setEntries(res.data.entries ?? [])
        setPath(res.data.path ?? null)
      }
    } catch {
      /* the log viewer failing to read the log must not throw into the app */
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  // Esc closes. Registered on the window rather than the dialog so it works before
  // anything inside has taken focus.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const shown = useMemo(() => filterEntries(entries, minLevel, query), [entries, minLevel, query])

  // Newest line in view on open and after a refresh -- the last thing that happened is
  // what you came to read.
  useEffect(() => { bottomRef.current?.scrollIntoView({ block: 'end' }) }, [shown.length])

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(shown.map(formatLogLine).join('\n'))
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch { /* clipboard denied -- the text is still on screen */ }
  }, [shown])

  const handleClear = useCallback(async () => {
    try {
      await window.termpolis.clearAppLog()
      setEntries([])
    } catch { /* ignore */ }
  }, [])

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 animate-fadeIn"
      onClick={onClose}
      data-testid="app-log-overlay"
    >
      <div
        className="bg-[#1e1e1e] border border-[#3c3c3c] rounded-lg shadow-2xl flex flex-col"
        style={{ width: '86vw', maxWidth: 1100, height: '82vh' }}
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-label="Application log"
        data-testid="app-log-modal"
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-[#3c3c3c]">
          <div className="flex items-center gap-2 min-w-0">
            <i className="fa-solid fa-file-lines text-[#61afef]"></i>
            <span className="text-sm font-semibold text-[#d4d4d4]">App Log</span>
            <span className="text-xs text-[#888] truncate" data-testid="app-log-count">
              ({shown.length} of {entries.length} line{entries.length === 1 ? '' : 's'})
            </span>
          </div>
          <div className="flex items-center gap-2">
            <select
              className="px-2 py-1 text-xs bg-[#2d2d2d] text-[#d4d4d4] rounded border border-[#454545] cursor-pointer"
              value={minLevel}
              onChange={e => setMinLevel(e.target.value as AppLogLevel)}
              aria-label="Minimum level"
              data-testid="app-log-level"
            >
              {LEVEL_ORDER.map(l => (
                <option key={l} value={l}>{l === 'debug' ? 'All levels' : `${l} and above`}</option>
              ))}
            </select>
            <input
              className="px-2 py-1 text-xs bg-[#2d2d2d] text-[#d4d4d4] rounded border border-[#454545] w-48"
              placeholder="Filter…"
              value={query}
              onChange={e => setQuery(e.target.value)}
              aria-label="Filter log"
              data-testid="app-log-filter"
            />
            <button
              className="px-3 py-1 text-xs bg-[#2d2d2d] hover:bg-[#3c3c3c] text-[#d4d4d4] rounded border border-[#454545] cursor-pointer"
              onClick={() => { void refresh() }}
              data-testid="app-log-refresh"
            >
              <i className="fa-solid fa-rotate mr-1"></i>Refresh
            </button>
            <button
              className="px-3 py-1 text-xs bg-[#2d2d2d] hover:bg-[#3c3c3c] text-[#d4d4d4] rounded border border-[#454545] cursor-pointer"
              onClick={() => { void handleCopy() }}
              data-testid="app-log-copy"
            >
              <i className={`fa-solid ${copied ? 'fa-check' : 'fa-copy'} mr-1`}></i>{copied ? 'Copied' : 'Copy'}
            </button>
            <button
              className="px-3 py-1 text-xs bg-[#2d2d2d] hover:bg-[#3c3c3c] text-[#d4d4d4] rounded border border-[#454545] cursor-pointer"
              onClick={() => { void handleClear() }}
              data-testid="app-log-clear"
            >
              <i className="fa-solid fa-broom mr-1"></i>Clear
            </button>
            <button
              className="text-[#888] hover:text-[#d4d4d4] cursor-pointer px-1"
              onClick={onClose}
              aria-label="Close"
              data-testid="app-log-close"
            >
              <i className="fa-solid fa-xmark text-lg"></i>
            </button>
          </div>
        </div>

        <div className="flex-1 min-h-0 overflow-auto px-4 py-2 font-mono text-[11px] leading-[1.5]" data-testid="app-log-body">
          {loading && entries.length === 0 && (
            <div className="text-[#888] py-4">Reading log…</div>
          )}
          {!loading && shown.length === 0 && (
            <div className="text-[#888] py-4" data-testid="app-log-empty">
              {entries.length === 0
                ? 'Nothing logged yet this session.'
                : 'No lines match that filter.'}
            </div>
          )}
          {shown.map((e, i) => (
            <div key={`${e.t}-${i}`} className={`whitespace-pre-wrap break-words ${LEVEL_STYLE[e.level]}`}>
              {formatLogLine(e)}
            </div>
          ))}
          <div ref={bottomRef} />
        </div>

        <div className="px-4 py-2 border-t border-[#3c3c3c] flex items-center justify-between text-[11px] text-[#888]">
          <span className="truncate" title={path ?? undefined} data-testid="app-log-path">
            {path ? `Saved to ${path}` : 'In memory only (no log file this session)'}
          </span>
          {path && (
            <button
              className="px-2 py-1 rounded border border-[#454545] hover:bg-[#2d2d2d] cursor-pointer shrink-0 ml-3"
              onClick={() => { void window.termpolis.openPath(path) }}
              data-testid="app-log-open-file"
            >
              <i className="fa-solid fa-folder-open mr-1"></i>Open file
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

export default AppLogModal
