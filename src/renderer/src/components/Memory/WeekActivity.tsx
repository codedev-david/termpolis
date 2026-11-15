import { useCallback, useEffect, useState } from 'react'
import type { ActivityMemory, ActivityReplaceReason, MemoryActivity } from '../../types'

// Memory ▸ This week: what memory learned and what it replaced in the last 7 days, so the learning is
// something you can see. Learned = lessons Termpolis distilled plus the decisions, facts and notes agents
// saved. Replaced = a newer memory took over from an older one; recall stops returning the older one.
// Undo brings back everything that newer memory replaced, for good.

const REASON_COPY: Record<ActivityReplaceReason, string> = {
  restated: 'Said again in newer words',
  contradicts: 'The newer one says the opposite',
  explicit: 'The newer one says it replaces this',
  linked: 'An agent linked them',
}

function label(m: ActivityMemory): string {
  if (m.lesson) return 'Lesson'
  if (m.kind === 'decision') return 'Decision'
  if (m.kind === 'fact') return 'Fact'
  return 'Note'
}

/** "just now", "5 min ago", "3 h ago", "2 d ago". */
export function ago(ts: number, now: number): string {
  const min = Math.floor(Math.max(0, now - ts) / 60000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min} min ago`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h} h ago`
  return `${Math.floor(h / 24)} d ago`
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

function Meta({ m, now }: { m: ActivityMemory; now: number }): JSX.Element {
  return (
    <div className="text-[#777] text-[10px]">
      {m.agent}{m.project ? ` · ${m.project}` : ''} · {ago(m.ts, now)}
    </div>
  )
}

export function WeekActivity(): JSX.Element {
  const [data, setData] = useState<MemoryActivity | null>(null)
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')
  const [undoing, setUndoing] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())

  const load = useCallback(async () => {
    try {
      const res = await window.termpolis.memoryActivity()
      if (res.success && res.data) {
        setData(res.data)
        setError('')
      } else {
        setError(res.error || "Couldn't load this week's activity.")
      }
    } catch {
      setError("Couldn't load this week's activity.")
    }
    setNow(Date.now())
  }, [])

  useEffect(() => { void load() }, [load])

  const undo = useCallback(async (newerId: string) => {
    setUndoing(newerId)
    try {
      const res = await window.termpolis.memoryReleaseSupersedes(newerId)
      if (res.success) {
        const n = res.data ?? 0
        setStatus(n > 0 ? `Brought back ${plural(n, 'memory', 'memories')}. Search returns ${n === 1 ? 'it' : 'them'} again.` : 'Nothing to undo; it was already back.')
        await load()
      } else {
        setStatus(res.error || "Couldn't undo that.")
      }
    } catch {
      setStatus("Couldn't undo that.")
    } finally {
      setUndoing(null)
    }
  }, [load])

  if (error) return <div className="text-[#FFB74D] text-[11px]" role="alert">{error}</div>
  if (!data) return <div className="text-[#bbb]">Loading…</div>

  const c = data.counts
  const nothing = c.lessons + c.decisions + c.facts + c.notes + c.replaced === 0

  return (
    <div className="flex flex-col gap-3" data-testid="memory-week">
      <div className="flex items-center justify-between">
        <div className="text-[#666] text-[10px] uppercase tracking-wider">Last 7 days</div>
        <button
          className="text-[#888] hover:text-[#d4d4d4] text-[11px] cursor-pointer"
          onClick={() => void load()}
          aria-label="Refresh this week"
          title="Refresh"
        >
          <i className="fa-solid fa-arrows-rotate"></i>
        </button>
      </div>

      {nothing ? (
        <div className="text-[#bbb] text-[11px] leading-relaxed" data-testid="memory-week-empty">
          Nothing new this week. When an agent saves a decision, a fact or a note, or Termpolis distills a lesson from your sessions, it shows up here.
        </div>
      ) : (
        <>
          <div className="text-[#bbb] text-[11px] leading-relaxed" data-testid="memory-week-counts">
            Learned <strong className="text-[#22D3EE]">{plural(c.lessons, 'lesson', 'lessons')}</strong>,{' '}
            {plural(c.decisions, 'decision', 'decisions')}, {plural(c.facts, 'fact', 'facts')} and {plural(c.notes, 'note', 'notes')}.{' '}
            Replaced <strong className="text-[#22D3EE]">{plural(c.replaced, 'memory', 'memories')}</strong>.
          </div>

          {data.learned.length > 0 && (
            <div className="flex flex-col gap-1">
              <div className="text-[#666] text-[10px] uppercase tracking-wider">Learned</div>
              <ul className="flex flex-col gap-1">
                {data.learned.map((m) => (
                  <li key={m.id} className="bg-[#1e1e1e] border border-[#333] rounded px-2 py-1">
                    <div className="text-[#777] text-[10px] uppercase">{label(m)}</div>
                    <div className="text-[#cfcfcf] break-words">{m.content}</div>
                    <Meta m={m} now={now} />
                  </li>
                ))}
              </ul>
            </div>
          )}

          {data.replaced.length > 0 && (
            <div className="flex flex-col gap-1">
              <div className="text-[#666] text-[10px] uppercase tracking-wider">Replaced</div>
              <ul className="flex flex-col gap-1">
                {data.replaced.map((r) => (
                  <li key={`${r.newer.id}:${r.older.id}`} className="bg-[#1e1e1e] border border-[#333] rounded px-2 py-1 flex flex-col gap-1">
                    <div className="text-[#777] text-[10px]">{REASON_COPY[r.reason]} · {ago(r.ts, now)}</div>
                    <div>
                      <div className="text-[#777] text-[10px] uppercase">Now</div>
                      <div className="text-[#cfcfcf] break-words">{r.newer.content}</div>
                    </div>
                    <div>
                      <div className="text-[#777] text-[10px] uppercase">Replaced</div>
                      <div className="text-[#888] line-through break-words">{r.older.content}</div>
                    </div>
                    <div className="flex items-center justify-between">
                      <Meta m={r.newer} now={now} />
                      <button
                        className="bg-[#2d2d30] hover:bg-[#37373a] border border-[#3c3c3c] rounded px-2 py-0.5 text-[#d4d4d4] text-[11px] cursor-pointer disabled:opacity-50"
                        onClick={() => void undo(r.newer.id)}
                        disabled={undoing !== null}
                        title="Bring back what this replaced"
                      >Undo</button>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {data.more && <div className="text-[#777] text-[10px]">Showing the newest. There is more.</div>}
        </>
      )}

      {status && <div className="text-[#22D3EE] text-[11px]">{status}</div>}
    </div>
  )
}
