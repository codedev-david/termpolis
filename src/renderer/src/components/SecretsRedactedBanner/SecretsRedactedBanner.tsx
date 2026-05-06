import { useEffect, useState } from 'react'

interface RedactionEvent {
  id: string
  hits: { rule: string; label: string; sample: string }[]
  agent: string | null
}

interface AiSecuritySubscriber {
  onSecretsRedacted?: (cb: (data: RedactionEvent) => void) => () => void
}

// Slim banner that surfaces when the auto-scanner intercepts a secret on its
// way to an AI prompt. Auto-dismisses after 8s; user can also click ×.
export function SecretsRedactedBanner() {
  const [event, setEvent] = useState<RedactionEvent | null>(null)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    const api = (window as any).aiSecurity as AiSecuritySubscriber | undefined
    if (!api?.onSecretsRedacted) return
    const unsub = api.onSecretsRedacted((data) => {
      setEvent(data)
      setTick((t) => t + 1)
    })
    return () => {
      try { unsub?.() } catch {}
    }
  }, [])

  useEffect(() => {
    if (!event) return
    const t = setTimeout(() => setEvent(null), 8000)
    return () => clearTimeout(t)
  }, [event, tick])

  if (!event) return null

  const labels = Array.from(new Set(event.hits.map((h) => h.label))).slice(0, 3).join(', ')
  const more = event.hits.length > 3 ? ` (+${event.hits.length - 3} more)` : ''
  const agent = event.agent ? ` to ${event.agent}` : ''

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="secrets-redacted-banner"
      className="px-4 py-2 flex items-center justify-between text-sm bg-[#3a2a0d] border-t border-[#FFB74D]/40 text-[#FFB74D]"
    >
      <div className="flex items-center gap-2">
        <i className="fa-solid fa-shield-halved"></i>
        <span>
          Termpolis redacted {event.hits.length} secret{event.hits.length === 1 ? '' : 's'} from your prompt{agent}: {labels}{more}.
        </span>
      </div>
      <button
        onClick={() => setEvent(null)}
        className="text-xs px-1.5 py-1 rounded hover:bg-white/10"
        aria-label="Dismiss redaction banner"
      >
        <i className="fa-solid fa-xmark"></i>
      </button>
    </div>
  )
}
