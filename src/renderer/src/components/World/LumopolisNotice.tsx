// One short line about a `lumopolis` request that did not simply open the pane (lib/lumopolisOsc.ts sends it):
// main's refusal ("no such folder", a Git Bash-only folder, too many requests), or a request from a terminal that
// is not the active one, which gets an Open button instead of taking the screen. Bottom right, above the status
// bar; it hides itself, and a newer notice replaces it. Small and engine-free: it is in App's main chunk.
import { useEffect, useState } from 'react'
import { LUMOPOLIS_NOTICE_EVENT, openLumopolis, type LumopolisNotice as Notice } from './worldOpen'

/** How long a notice stays up. */
export const NOTICE_MS = 8000

export function LumopolisNotice(): JSX.Element | null {
  const [notice, setNotice] = useState<(Notice & { seq: number }) | null>(null)

  useEffect(() => {
    let seq = 0
    const on = (e: Event): void => {
      const d = (e as CustomEvent<Notice | null>).detail
      if (d && typeof d.message === 'string' && d.message !== '') setNotice({ ...d, seq: ++seq })
    }
    window.addEventListener(LUMOPOLIS_NOTICE_EVENT, on)
    return () => window.removeEventListener(LUMOPOLIS_NOTICE_EVENT, on)
  }, [])

  useEffect(() => {
    if (!notice) return
    const t = setTimeout(() => setNotice(null), NOTICE_MS)
    return () => clearTimeout(t)
  }, [notice])

  if (!notice) return null
  const folder = notice.folder
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="lumopolis-notice"
      className="fixed bottom-9 right-4 z-50 flex max-w-[min(28rem,calc(100vw-2rem))] items-center gap-2 rounded border border-[#0078d4]/60 bg-[#1f2d3a] px-3 py-2 text-xs text-[#d4d4d4] shadow-lg"
    >
      <i className="fa-solid fa-earth-americas text-[#4fc1ff]" aria-hidden="true"></i>
      <span className="min-w-0 break-words">{notice.message}</span>
      {folder !== undefined && (
        <button
          type="button"
          data-testid="lumopolis-notice-open"
          onClick={() => { setNotice(null); openLumopolis(folder) }}
          className="shrink-0 rounded bg-[#0078d4] px-2 py-0.5 text-white hover:bg-[#1a8ae6]"
        >Open</button>
      )}
      <button
        type="button"
        data-testid="lumopolis-notice-dismiss"
        aria-label="Dismiss"
        title="Dismiss"
        onClick={() => setNotice(null)}
        className="shrink-0 rounded px-1 text-[#9ca3af] hover:bg-[#37373d] hover:text-white"
      ><i className="fa-solid fa-xmark text-[11px]"></i></button>
    </div>
  )
}
