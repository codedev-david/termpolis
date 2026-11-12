import { useEffect, useState } from 'react'

/** What main sends on `terminal:sensitive-file-read` (see the subscribeSensitiveReads wiring in main). */
interface SensitiveFileReadEvent {
  id: string
  agent: string
  tool: string
  rule: string
  label: string
  filePath: string
  source: 'path' | 'command'
  ts: number
}

interface SensitiveReadSubscriber {
  onSensitiveFileRead?: (cb: (data: SensitiveFileReadEvent) => void) => () => void
}

/** How long the notice stays up before it clears itself. */
export const SENSITIVE_READ_NOTICE_MS = 10_000

/**
 * Shows a notice when an agent reads a high-risk file (`.env`, a PEM key, `~/.ssh/*` …).
 *
 * Main has always recorded the hit and sent `terminal:sensitive-file-read`, and Settings → AI Security
 * promised a notice, but nothing in the renderer listened, so the promise was false. This is that
 * listener. It never blocks the agent and never shows file contents: only which agent read which file.
 */
export function SensitiveFileReadBanner() {
  const [event, setEvent] = useState<SensitiveFileReadEvent | null>(null)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    const api = (window as any).aiSecurity as SensitiveReadSubscriber | undefined
    if (typeof api?.onSensitiveFileRead !== 'function') return
    const unsub = api.onSensitiveFileRead((data) => {
      setEvent(data)
      setTick((t) => t + 1)
    })
    return () => {
      try { unsub?.() } catch {}
    }
  }, [])

  useEffect(() => {
    if (!event) return
    const t = setTimeout(() => setEvent(null), SENSITIVE_READ_NOTICE_MS)
    return () => clearTimeout(t)
  }, [event, tick])

  if (!event) return null

  const who = event.agent || 'An agent'
  const what = event.filePath ? `${event.label} (${event.filePath})` : event.label

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="sensitive-file-read-banner"
      className="px-4 py-2 flex items-center justify-between text-sm bg-[#3a2a0d] border-t border-[#FFB74D]/50 text-[#FFB74D]"
    >
      <div className="flex items-center gap-2 min-w-0">
        <i className="fa-solid fa-file-shield"></i>
        <span className="truncate">
          {who} read a sensitive file: {what}. Add it to the agent&apos;s ignore file before the next session.
        </span>
      </div>
      <button
        onClick={() => setEvent(null)}
        className="text-xs px-1.5 py-1 rounded hover:bg-white/10"
        aria-label="Dismiss sensitive-file notice"
      >
        <i className="fa-solid fa-xmark"></i>
      </button>
    </div>
  )
}
