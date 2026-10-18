import { useEffect, useRef, useState } from 'react'
import { subscribe, unsubscribe } from '../../lib/pollingService'
import { conductorScreenText } from '../../lib/conductorLaunch'

interface Props {
  conductorTerminalId: string | null
}

const POLL_ID = 'conductor-output'
const POLL_MS = 2000

/**
 * The Swarm Dashboard's Debug view: what the conductor's hidden terminal shows, as plain text,
 * read-only and refreshed every two seconds.
 *
 * Read from the terminal's output buffer rather than shown as a terminal pane (GitHub #36: the
 * old Debug unhid the terminal behind the dashboard, and split view never drew it). A pane for
 * the conductor would start the memory primer, which pastes into the conductor's console with an
 * Enter, and the shell in that terminal runs whatever is waiting there once claude exits. A pane
 * would also let a keystroke or a closed tab end the conductor. Read-only has neither problem, and
 * it shows the same thing in tabs and split view, without touching either layout.
 */
export function ConductorOutput({ conductorTerminalId }: Props) {
  // null until the first read comes back.
  const [screen, setScreen] = useState<{ text: string; readable: boolean } | null>(null)
  const scrollRef = useRef<HTMLPreElement>(null)
  // Follow new output until the user scrolls up to read something.
  const following = useRef(true)

  useEffect(() => {
    setScreen(null)
    following.current = true
    if (!conductorTerminalId) return
    let disposed = false
    const read = async (): Promise<void> => {
      try {
        const res = await window.termpolis.readTerminalBuffer(conductorTerminalId)
        if (disposed) return
        // `skip` is the tail of an escape sequence the buffer's eviction cut in half.
        setScreen(res.success && res.data
          ? { text: conductorScreenText(res.data.output.slice(res.data.skip ?? 0)), readable: true }
          : { text: '', readable: false })
      } catch {
        if (!disposed) setScreen({ text: '', readable: false })
      }
    }
    void read()
    subscribe(POLL_ID, () => { void read() }, POLL_MS)
    return () => {
      disposed = true
      unsubscribe(POLL_ID)
    }
  }, [conductorTerminalId])

  useEffect(() => {
    const el = scrollRef.current
    if (el && following.current) el.scrollTop = el.scrollHeight
  }, [screen])

  if (!conductorTerminalId) {
    return (
      <div className="text-[#6a6a6a] text-xs p-4" data-testid="conductor-output">
        No swarm conductor running.
      </div>
    )
  }

  return (
    <div
      className="flex flex-col text-xs bg-[#1e1e1e] border border-[#3c3c3c] rounded"
      data-testid="conductor-output"
    >
      <div className="px-3 py-1.5 border-b border-[#3c3c3c] text-[10px] uppercase tracking-wide text-[#858585] flex justify-between">
        <span>Conductor output</span>
        <span>read-only</span>
      </div>
      {screen === null && <div className="text-[#6a6a6a] text-xs p-4">Reading the conductor's output…</div>}
      {screen && !screen.readable && (
        <div className="text-[#6a6a6a] text-xs p-4">The conductor's output can't be read. Its terminal may have closed.</div>
      )}
      {screen && screen.readable && screen.text === '' && (
        <div className="text-[#6a6a6a] text-xs p-4">The conductor hasn't printed anything yet.</div>
      )}
      {screen && screen.readable && screen.text !== '' && (
        <pre
          ref={scrollRef}
          data-testid="conductor-output-text"
          onScroll={(e) => {
            const el = e.currentTarget
            following.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
          }}
          className="m-0 p-3 max-h-[440px] overflow-y-auto font-mono text-[11px] leading-snug text-[#cccccc] whitespace-pre-wrap break-words"
        >
          {screen.text}
        </pre>
      )}
    </div>
  )
}

export default ConductorOutput
