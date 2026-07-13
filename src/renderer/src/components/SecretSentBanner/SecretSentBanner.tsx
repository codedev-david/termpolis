import { useEffect, useState } from 'react'

/** What main tells us about a secret that went out. There is deliberately no `sample` field:
 *  main strips it at the IPC boundary, because for the named rules the matched text spans the
 *  whole assignment and carries the secret inside it. We say WHAT leaked; we never show it. */
interface SecretSentEvent {
  id: string
  hits: { rule: string; label: string; name?: string }[]
  agent: string | null
}

interface AiSecuritySubscriber {
  onSecretSent?: (cb: (data: SecretSentEvent) => void) => () => void
}

/**
 * Fires when a secret has been sent to a model.
 *
 * This used to be `SecretsRedactedBanner`, and it used to say "Termpolis redacted N secrets from
 * your prompt". That stopped being true when the redaction path was removed — and it could not
 * have been true even before: a TUI agent already holds your line in its own buffer by the time
 * you press Enter, so there is nothing left for us to rewrite. The honest banner is the inverse
 * of the old one. It is not a reassurance that we caught something. It is a warning that
 * something already left, aimed at the only question you can still act on: what do I rotate?
 *
 * So it is styled as a warning rather than a shield, and it lingers longer than a "you're fine"
 * toast would.
 */
export function SecretSentBanner() {
  const [event, setEvent] = useState<SecretSentEvent | null>(null)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    const api = (window as any).aiSecurity as AiSecuritySubscriber | undefined
    if (!api?.onSecretSent) return
    const unsub = api.onSecretSent((data) => {
      setEvent(data)
      setTick((t) => t + 1)
    })
    return () => {
      try { unsub?.() } catch {}
    }
  }, [])

  useEffect(() => {
    if (!event) return
    const t = setTimeout(() => setEvent(null), 12000)
    return () => clearTimeout(t)
  }, [event, tick])

  if (!event) return null

  // Prefer the NAME (`DB_PASSWORD`) — that is the thing you go and rotate. Fall back to the rule
  // label ("AWS Access Key ID") for the bare/shapeless matches that have no name to report.
  const names = Array.from(new Set(event.hits.map((h) => h.name).filter(Boolean) as string[]))
  const labels = Array.from(new Set(event.hits.filter((h) => !h.name).map((h) => h.label)))
  const shown = [...names, ...labels]
  const head = shown.slice(0, 3).join(', ')
  const more = shown.length > 3 ? ` (+${shown.length - 3} more)` : ''
  const agent = event.agent ? ` to ${event.agent}` : ''
  const n = event.hits.length

  return (
    <div
      role="alert"
      aria-live="assertive"
      data-testid="secret-sent-banner"
      className="px-4 py-2 flex items-center justify-between text-sm bg-[#3d1a1a] border-t border-[#EF5350]/50 text-[#FF8A80]"
    >
      <div className="flex items-center gap-2">
        <i className="fa-solid fa-triangle-exclamation"></i>
        <span>
          {n} secret{n === 1 ? '' : 's'} sent{agent}: {head}{more}. Already delivered &mdash; rotate {n === 1 ? 'it' : 'them'}.
        </span>
      </div>
      <button
        onClick={() => setEvent(null)}
        className="text-xs px-1.5 py-1 rounded hover:bg-white/10"
        aria-label="Dismiss secret-sent warning"
      >
        <i className="fa-solid fa-xmark"></i>
      </button>
    </div>
  )
}
