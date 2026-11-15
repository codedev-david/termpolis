import { useEffect, useRef, useState } from 'react'
import type { MemoryEntry, MemorySearchResult } from '../../types'

// The memory tour: memory working in under a minute. Shown once after the first-run tour ends with
// "Get started", and from the command palette ("Memory tour") any time. Three steps:
//   1. Tell Termpolis something: saves a real memory (agent `termpolis-tour`, tag `termpolis-tour`).
//   2. Ask in different words: a real memory search for it. The default question shares words with the
//      default fact, so it comes back with the keyword fallback too, not only with the local model.
//   3. Which agents share this memory, and where to watch it learn (Memory ▸ This week).
// Leaving the tour, from any step, removes the demo memory unless "Keep it" is ticked. It only removes a
// memory this run created: saving text that is already in memory returns the existing entry, and that
// one stays.

const SEEN_KEY = 'termpolis.memoryTour.seen.v1'
export const TOUR_AGENT = 'termpolis-tour'
export const TOUR_FACT = 'I like short commit messages that start with a verb.'
export const TOUR_QUESTION = 'How should I phrase my commit messages?'
const STEPS = 3

export function hasSeenMemoryTour(): boolean {
  try { return localStorage.getItem(SEEN_KEY) === '1' } catch { return false }
}

export function markMemoryTourSeen(): void {
  try { localStorage.setItem(SEEN_KEY, '1') } catch {}
}

type SearchState = { found: MemorySearchResult | null; count: number } | null

export function MemoryTour({ onClose }: { onClose: (opts?: { openWeek?: boolean }) => void }): JSX.Element {
  const [step, setStep] = useState(1)
  const [fact, setFact] = useState(TOUR_FACT)
  const [question, setQuestion] = useState(TOUR_QUESTION)
  const [saved, setSaved] = useState<MemoryEntry | null>(null)
  const [created, setCreated] = useState(false)
  const [keep, setKeep] = useState(false)
  const [search, setSearch] = useState<SearchState>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const closing = useRef(false)
  // Refs, not state, so every exit (close while a save is still in flight, or an unmount) sees the latest.
  const pendingSave = useRef<Promise<unknown> | null>(null)
  const ours = useRef<string | null>(null) // id of the demo memory this run created
  const keepRef = useRef(false)
  keepRef.current = keep

  const removeDemo = async (): Promise<void> => {
    if (pendingSave.current) { try { await pendingSave.current } catch { /* a failed save left nothing */ } }
    const id = ours.current
    if (!id || keepRef.current) return
    ours.current = null
    try { await window.termpolis.memoryDelete(id) } catch { /* the demo fact stays; harmless */ }
  }

  // Unmounted some other way (the window reloads its view, a parent drops the tour): still clean up.
  useEffect(() => () => { if (!closing.current) { closing.current = true; void removeDemo() } }, [])

  const save = async (): Promise<void> => {
    const content = fact.trim() // the button is disabled while this is empty
    setBusy(true)
    setError('')
    const startedAt = Date.now()
    try {
      const write = window.termpolis.memoryWrite({ agentId: TOUR_AGENT, kind: 'fact', content, tags: [TOUR_AGENT] })
      pendingSave.current = write
      const res = await write
      if (res.success && res.data) {
        // The same text already in memory comes back as the existing entry: that one isn't ours to remove.
        const mine = res.data.agentId === TOUR_AGENT && res.data.ts >= startedAt - 1000
        if (mine) ours.current = res.data.id
        if (closing.current) return // closed while saving: close() removes it
        setSaved(res.data)
        setCreated(mine)
        setSearch(null)
        setStep(2)
      } else {
        setError(res.error || "Couldn't save that to memory.")
      }
    } catch {
      setError("Couldn't save that to memory.")
    } finally {
      setBusy(false)
    }
  }

  const ask = async (): Promise<void> => {
    const query = question.trim()
    if (!query || !saved) return
    setBusy(true)
    setError('')
    try {
      const res = await window.termpolis.memorySearch({ query, limit: 10 })
      const hits = res.success && res.data ? res.data : []
      if (!res.success) setError(res.error || 'Search failed.')
      setSearch({ found: hits.find((h) => h.id === saved.id) ?? null, count: hits.length })
    } catch {
      setError('Search failed.')
    } finally {
      setBusy(false)
    }
  }

  const close = async (opts?: { openWeek?: boolean }): Promise<void> => {
    if (closing.current) return
    closing.current = true
    markMemoryTourSeen()
    await removeDemo()
    onClose(opts)
  }

  // Re-bound every render so Escape (like Skip tour) sees the current demo memory and Keep box.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') void close() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const btn = 'px-4 py-1.5 text-sm rounded-lg bg-[#22D3EE]/20 text-[#22D3EE] hover:bg-[#22D3EE]/30 font-medium disabled:opacity-50'
  const field = 'bg-[#1e1e1e] border border-[#3c3c3c] rounded px-2 py-1.5 text-[#d4d4d4] text-[13px] outline-hidden focus:border-[#22D3EE]'

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/80">
      <div
        className="bg-[#252526] border border-[#3c3c3c] rounded-xl shadow-2xl w-[520px] max-h-[95vh] overflow-y-auto p-6 flex flex-col gap-4"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-labelledby="memory-tour-title"
      >
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-[#22D3EE]/15 flex items-center justify-center">
            <i className="fa-solid fa-brain text-[#22D3EE] text-lg"></i>
          </div>
          <div className="flex-1">
            <h2 id="memory-tour-title" className="text-base font-semibold text-[#d4d4d4]">Memory in a minute</h2>
            <p className="text-xs text-[#9ca3af]">Your agents remember what you tell them.</p>
          </div>
          <div className="text-[11px] text-[#9ca3af]">Step {step} of {STEPS}</div>
        </div>

        <div className="flex items-center gap-1.5" aria-hidden="true">
          {Array.from({ length: STEPS }, (_, i) => i + 1).map((n) => (
            <div key={n} className={`h-1.5 flex-1 rounded-full ${n <= step ? 'bg-[#22D3EE]' : 'bg-[#3c3c3c]'}`} />
          ))}
        </div>

        {step === 1 && (
          <div className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold text-[#d4d4d4]">Tell Termpolis something</h3>
            <p className="text-xs text-[#9ca3af] leading-relaxed">
              Write a fact you want your agents to know. Change it if you like, then save it.
            </p>
            <textarea
              className={`${field} resize-none`}
              rows={3}
              value={fact}
              onChange={(e) => setFact(e.target.value)}
              aria-label="Fact to remember"
            />
          </div>
        )}

        {step === 2 && (
          <div className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold text-[#d4d4d4]">Ask in different words</h3>
            <p className="text-xs text-[#9ca3af] leading-relaxed">
              Saved. Now ask for it the way you would later, without repeating it word for word.
            </p>
            <div className="flex gap-2">
              <input
                className={`${field} flex-1`}
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void ask() }}
                aria-label="Question for memory"
              />
              <button className={btn} onClick={() => void ask()} disabled={busy || !question.trim()}>Ask</button>
            </div>
            {search && search.found && (
              <div className="border border-[#22D3EE]/40 rounded px-2 py-2 text-xs flex flex-col gap-1" data-testid="memory-tour-found">
                <div className="text-[#22D3EE]"><i className="fa-solid fa-check mr-1"></i>It came back:</div>
                <div className="text-[#d4d4d4]">{search.found.content}</div>
              </div>
            )}
            {search && !search.found && (
              <div className="border border-[#FFB74D]/50 rounded px-2 py-2 text-xs text-[#d4d4d4] leading-relaxed" data-testid="memory-tour-missed">
                {search.count === 0 ? 'Nothing came back for those words.' : `${search.count} other memories came back, but not this one.`}{' '}
                Search matches on meaning once the local model has loaded, and on shared words before that. Try a question that uses a word from the fact.
              </div>
            )}
          </div>
        )}

        {step === 3 && (
          <div className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold text-[#d4d4d4]">Every agent shares it</h3>
            <p className="text-xs text-[#d4d4d4] leading-relaxed">
              Claude Code, Codex and Antigravity read and write this same memory through Termpolis.
            </p>
            <p className="text-xs text-[#d4d4d4] leading-relaxed">
              To see what they learned and what got replaced, open Memory ▸ This week.
            </p>
            {saved && created && (
              <label className="flex items-center gap-2 text-xs text-[#9ca3af] mt-1 cursor-pointer">
                <input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} />
                Keep it (otherwise the tour removes the fact it saved)
              </label>
            )}
            {saved && !created && (
              <p className="text-xs text-[#9ca3af]">That fact was already in memory, so the tour leaves it there.</p>
            )}
          </div>
        )}

        {error && <div className="text-xs text-[#FFB74D]" role="alert">{error}</div>}

        <div className="flex items-center justify-between border-t border-[#3c3c3c] pt-3">
          <button onClick={() => void close()} className="text-xs text-[#9ca3af] hover:text-[#d4d4d4] underline">
            Skip tour
          </button>
          <div className="flex items-center gap-2">
            {step === 1 && (
              <button className={btn} onClick={() => void save()} disabled={busy || !fact.trim()}>Save to memory</button>
            )}
            {step === 2 && (
              <button className={btn} onClick={() => setStep(3)}>Next</button>
            )}
            {step === 3 && (
              <>
                <button
                  className="px-4 py-1.5 text-sm rounded-lg border border-[#3c3c3c] text-[#d4d4d4] hover:bg-[#37373d]"
                  onClick={() => void close({ openWeek: true })}
                >Open This week</button>
                <button className={btn} onClick={() => void close()}>Finish</button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
