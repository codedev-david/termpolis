// Pure helpers for Settings ▸ Linked machines. Nothing here touches React or
// `window`, so every rule the pane follows -- write implies run, which pending
// links still need confirming, how a time is worded -- is tested on its own.
import type { LinkedActivityView, LinkedGrants, LinkedJobRecord, LinkedMachineView } from '../types'

/** Mirrors `MAX_LINKED_MACHINES` in main/remoteBridge/protocol.ts. The bridge
 *  enforces the cap; the pane only explains it before a 17th pairing is refused. */
export const LINKED_MACHINE_LIMIT = 16

/** The activity view shows the latest 20 jobs (spec §3.1). */
export const ACTIVITY_ROWS = 20

export type GrantKey = keyof LinkedGrants

/** Flip one grant and keep `write ⇒ run` true in both directions: granting
 *  write grants run with it, and taking run away takes write with it. Main
 *  forces the same rule, so sending anything else would only be corrected. */
export function toggleGrant(grants: LinkedGrants, key: GrantKey): LinkedGrants {
  if (key === 'write') {
    const write = !grants.write
    return { run: write || grants.run, write }
  }
  const run = !grants.run
  return { run, write: run && grants.write }
}

export function secondsLeft(expiresAt: number, now: number): number {
  return Math.max(0, Math.ceil((expiresAt - now) / 1000))
}

export function formatCountdown(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

export function relativeTime(ts: number, now: number): string {
  const secs = Math.max(0, Math.round((now - ts) / 1000))
  if (secs < 60) return 'just now'
  const mins = Math.round(secs / 60)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

export function formatDuration(ms: number): string {
  // "0s" would read as "did nothing"; a job that answered at once still ran.
  if (ms < 1000) return '<1s'
  const secs = Math.round(ms / 1000)
  if (secs < 60) return `${secs}s`
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m ${secs % 60}s`
  return `${Math.floor(mins / 60)}h ${mins % 60}m`
}

/** The job history shows this many rows. */
export const HISTORY_ROWS = 50

/** How many lines of the history file the pane asks for: two a job, so enough for its rows. */
export const HISTORY_READ = 200

/** A job in the history, its start and end lines joined. `running` only while it is still
 *  running here; `unrecorded` for one whose end was never written -- Termpolis quit or crashed
 *  before the line landed. */
export interface HistoryJobRow {
  kind: 'job'
  key: string
  ts: number
  machine: string
  agent?: string
  write?: boolean
  cwd?: string
  summary?: string
  status: 'running' | 'done' | 'failed' | 'cancelled' | 'unrecorded'
  durationMs?: number
  /** Credential rules screening matched, in the prompt or the answer. */
  secretRules: string[]
}

export interface HistoryRefusalRow {
  kind: 'refused'
  key: string
  ts: number
  machine: string
  agent?: string
  write?: boolean
  reason: string
  /** More refusals of the same computer in that minute. */
  count?: number
}

export type HistoryRow = HistoryJobRow | HistoryRefusalRow

/** The history's lines as rows, newest first: one per job, however many of its lines survived
 *  rotation, and one per refusal line. `running` is the ids of the jobs running here now, which
 *  the file alone can't tell from ones whose end was never written. */
export function historyRows(records: LinkedJobRecord[], running: ReadonlySet<string>, limit = HISTORY_ROWS): HistoryRow[] {
  const jobs = new Map<string, HistoryJobRow>()
  const rows: HistoryRow[] = []
  const started = new Set(records.filter((r) => r.event === 'started').map((r) => r.jobId))
  records.forEach((r, i) => {
    if (r.event === 'refused') {
      rows.push({
        kind: 'refused',
        key: `refused-${r.ts}-${i}`,
        ts: r.ts,
        machine: r.machine,
        ...(r.agent ? { agent: r.agent } : {}),
        ...(r.write !== undefined ? { write: r.write } : {}),
        reason: r.reason ?? '',
        ...(r.count ? { count: r.count } : {}),
      })
      return
    }
    if (!r.jobId) return
    let row = jobs.get(r.jobId)
    if (!row) {
      row = {
        kind: 'job',
        key: r.jobId,
        ts: r.ts,
        machine: r.machine,
        status: running.has(r.jobId) ? 'running' : 'unrecorded',
        secretRules: [],
      }
      jobs.set(r.jobId, row)
      rows.push(row)
    }
    row.agent = row.agent ?? r.agent
    row.secretRules = [...new Set([...row.secretRules, ...(r.secretRules ?? [])])].sort()
    if (r.event === 'started') {
      row.ts = r.ts
      row.machine = r.machine
      if (r.write !== undefined) row.write = r.write
      if (r.cwd !== undefined) row.cwd = r.cwd
      if (r.summary !== undefined) row.summary = r.summary
    } else {
      if (r.status) row.status = r.status
      if (r.durationMs !== undefined) row.durationMs = r.durationMs
      // Its start line was rotated away: when it started, as near as the end line says.
      if (!started.has(r.jobId)) row.ts = r.ts - (r.durationMs ?? 0)
    }
  })
  return rows.sort((x, y) => y.ts - x.ts).slice(0, limit)
}

/** Newest first, capped. Sorted here rather than trusted, so the pane shows
 *  the latest jobs whatever order main keeps its log in. */
export function latestActivity(rows: LinkedActivityView[], limit = ACTIVITY_ROWS): LinkedActivityView[] {
  return [...rows].sort((a, b) => b.startedAt - a.startedAt).slice(0, limit)
}

/** A link announced by a `pending` event, keyed by its ref. */
export interface PendingAnnouncement {
  phrase: string
  suggestedName: string
  /** A status has listed this ref. Until then its absence from a status only
   *  means the status is older than the event; after it, absence means the link
   *  was removed -- typically the other computer cancelled. */
  seen: boolean
}

export type Announcements = Record<string, PendingAnnouncement>

/** One link waiting for the user to compare safety words. */
export interface PendingConfirmation {
  ref: string
  /** Null only if neither the status nor an event carried the words, in which
   *  case there is nothing to compare and the pane must not offer "They match". */
  phrase: string | null
  suggestedName: string
}

/** Drop announcements a status has made obsolete: confirmed links, and links
 *  that were listed once and are now gone. Returns `prev` itself when nothing
 *  changed, so a state setter built on it does not re-render for nothing. */
export function reconcileAnnouncements(prev: Announcements, machines: LinkedMachineView[]): Announcements {
  const byRef = new Map(machines.map((m) => [m.ref, m]))
  const next: Announcements = {}
  let changed = false
  for (const [ref, a] of Object.entries(prev)) {
    const m = byRef.get(ref)
    if (m ? m.confirmed : a.seen) {
      changed = true
    } else if (m && !a.seen) {
      next[ref] = { ...a, seen: true }
      changed = true
    } else {
      next[ref] = a
    }
  }
  return changed ? next : prev
}

export function withoutAnnouncement(prev: Announcements, ref: string): Announcements {
  const next = { ...prev }
  delete next[ref]
  return next
}

/** Every link still waiting for its safety words to be confirmed here: each
 *  unconfirmed machine, plus any announced link no status has listed yet. */
export function pendingConfirmations(
  machines: LinkedMachineView[],
  announced: Announcements,
): PendingConfirmation[] {
  const out: PendingConfirmation[] = []
  for (const m of machines) {
    if (m.confirmed) continue
    const a = announced[m.ref]
    out.push({ ref: m.ref, phrase: m.phrase ?? a?.phrase ?? null, suggestedName: a?.suggestedName ?? m.name })
  }
  const listed = new Set(machines.map((m) => m.ref))
  for (const [ref, a] of Object.entries(announced)) {
    if (!listed.has(ref)) out.push({ ref, phrase: a.phrase, suggestedName: a.suggestedName })
  }
  return out
}
