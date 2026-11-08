import { useCallback, useEffect, useRef, useState } from 'react'
import type { ClaudeNotesSettings } from '../../types'

/**
 * Claude Code's saved notes in memory (1.55.0): the two switches, what has been imported, and the undo.
 *
 * Claude Code keeps what it learns about a project as small markdown files in its own folder, private to
 * Claude in that one project. With this on, Termpolis reads them (and only reads: nothing is written into that
 * folder), keeps a copy in its memory under the project they belong to, so Codex and the Antigravity CLI find
 * them too and a search matches them by their own words. Edit or delete a note and the copy follows.
 *
 * Everything it reads and writes is spelled out below, in the same words as PRIVACY.md. The import runs only
 * while your agents are connected (Settings > Agent Integration): that is the consent every other thing
 * Termpolis does with your agents' data is gated on, so the first switch says so rather than pretending to act.
 *
 * Read on open and on Refresh, never on a timer (see VectorRamPanel).
 */

const BUTTON = 'text-xs px-2 py-1 rounded bg-[#2d2d2d] text-[#d4d4d4] hover:bg-[#3a3a3a] border border-[#3c3c3c] disabled:opacity-50 shrink-0'

function Switch({ on, label, testId, disabled, onClick }: { on: boolean; label: string; testId: string; disabled: boolean; onClick: () => void }) {
  return (
    <button
      id={testId}
      // Not `disabled`: a button that goes disabled drops the keyboard focus it holds, so a screen-reader user who flips it with
      // Space never hears the new state. It stays in the tab order and says it is busy; a click is ignored meanwhile.
      onClick={() => { if (!disabled) onClick() }}
      aria-disabled={disabled || undefined}
      aria-label={label}
      aria-pressed={on}
      data-testid={testId}
      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors mt-0.5 flex-shrink-0 ${disabled ? 'opacity-50' : ''} ${on ? 'bg-[#0078d4]' : 'bg-[#555]'}`}
    >
      <span className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${on ? 'translate-x-5' : 'translate-x-0.5'}`} />
    </button>
  )
}

const plural = (n: number, one: string, many: string): string => `${n.toLocaleString()} ${n === 1 ? one : many}`

function when(ts: number | null): string {
  if (ts === null) return 'not yet'
  try { return new Date(ts).toLocaleString() } catch { return 'not yet' }
}

export function ClaudeNotesPanel({ refreshToken = 0 }: { refreshToken?: number }) {
  const [s, setS] = useState<ClaudeNotesSettings | null>(null)
  const [err, setErr] = useState('')          // a failed READ
  const [actionErr, setActionErr] = useState('') // a failed ACTION, kept apart so a re-read does not wipe it
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const mounted = useRef(true)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const removeRef = useRef<HTMLButtonElement>(null)
  // Focus follows the confirm step: onto the SAFE choice when it opens (a held Enter must not confirm a removal) and only then, not
  // each time something else in the panel finishes; and back onto the button that opened it once it closes and nothing is in
  // flight (a button that is disabled cannot take focus).
  const refocus = useRef(false)
  useEffect(() => { if (confirming) cancelRef.current?.focus() }, [confirming])
  useEffect(() => {
    if (!confirming && !busy && refocus.current) { refocus.current = false; removeRef.current?.focus() }
  }, [confirming, busy])
  const dismissConfirm = () => { refocus.current = true; setConfirming(false) }

  const load = useCallback(async () => {
    try {
      const res = await window.termpolis?.memoryGetNotesSettings?.()
      if (!mounted.current) return
      if (res?.success && res.data) { setS(res.data); setErr('') }
      else setErr(res?.error || "Could not read the saved-notes settings")
    } catch (e) {
      if (mounted.current) setErr((e as Error).message || "Could not read the saved-notes settings")
    }
  }, [])

  // On open, and on Refresh. NEVER on a timer.
  useEffect(() => {
    mounted.current = true
    void load()
    return () => { mounted.current = false }
  }, [load, refreshToken])

  // Both actions run with every control disabled (`busy`), so a second click cannot arrive while one is in flight.
  const change = async (patch: { indexClaudeNotes?: boolean; shareNotesAcrossProjects?: boolean }) => {
    setBusy(true)
    setActionErr('')
    setNotice('')
    try {
      const res = await window.termpolis?.memorySetNotesSettings?.(patch)
      if (!mounted.current) return
      // What main now holds is what the switches show, never what was asked for.
      if (res?.success && res.data) setS(res.data)
      else setActionErr(res?.error || 'Could not change the setting')
    } catch (e) {
      if (mounted.current) setActionErr((e as Error).message || 'Could not change the setting')
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  const remove = async () => {
    refocus.current = true
    setConfirming(false)
    setBusy(true)
    setActionErr('')
    setNotice('')
    try {
      const res = await window.termpolis?.memoryRemoveImportedNotes?.()
      if (!mounted.current) return
      if (res?.success && res.data) {
        setS(res.data.settings)
        const { removed, failed, unchecked } = res.data
        const done = failed > 0
          ? `Removed ${plural(removed, 'note chunk', 'note chunks')}. ${plural(failed, 'chunk', 'chunks')} could not be removed yet (memory may be locked) and will be retried.`
          : `Removed ${plural(removed, 'note chunk', 'note chunks')} from memory.`
        // Memory that could not be searched all the way through may still hold copies the record lost track of: say so, and what to do,
        // instead of closing with "turn it on to bring them back", which says they all went.
        setNotice(
          unchecked
            ? `${done} Memory could not be searched all the way through, so some copies may remain. Choose Remove imported notes again to finish.`
            : failed > 0 ? done : `${done} The import is off; turn it on to bring them back.`,
        )
      } else setActionErr(res?.error || 'Could not remove the imported notes')
    } catch (e) {
      if (mounted.current) setActionErr((e as Error).message || 'Could not remove the imported notes')
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  if (err && !s) return <div data-testid="claude-notes-error" role="alert" className="text-xs text-[#EF5350]">{err}</div>
  if (!s) return <div data-testid="claude-notes-loading" className="text-xs text-[#9ca3af]">Reading the saved-notes settings&hellip;</div>

  const waiting = s.indexClaudeNotes && !s.connected
  const { status } = s
  const nothingYet = status.notes === 0 && status.lastAt === null

  return (
    <section data-testid="claude-notes-panel" className="flex flex-col gap-3">
      <div>
        <h3 className="font-semibold text-[#22D3EE] mb-1 flex items-center gap-2">
          <i className="fa-solid fa-note-sticky text-xs"></i> Claude Code&rsquo;s saved notes
        </h3>
        <p className="text-xs text-[#9ca3af] leading-relaxed">
          Claude Code keeps what it learns about a project as small notes in its own folder
          (<code className="bg-[#3c3c3c] px-1 rounded">~/.claude/projects/&hellip;/memory/*.md</code>), visible only to Claude and
          only in that project. With this on, Termpolis <strong>reads</strong> those notes and keeps a copy in its memory, under the
          project they belong to, so Codex and the Antigravity CLI can find them too. Nothing is ever written back into
          Claude&rsquo;s folder. Termpolis sends nothing off this computer, but an agent that finds a note passes its text on to
          its own provider, as it does any memory it reads. An edited note updates its copy; a deleted one removes it.
          Secrets in a note are redacted before the copy is stored by the Memory scrub, the one switch that covers all of memory
          (Settings &rsaquo; AI Security); a note is stored as it is if you have turned that off there.
        </p>
      </div>

      <div className="flex items-start gap-3 p-3 border border-[#3c3c3c] rounded bg-[#252526]">
        <Switch
          on={s.indexClaudeNotes}
          label="Include Claude Code's saved notes in memory"
          testId="claude-notes-index-toggle"
          disabled={busy}
          onClick={() => { void change({ indexClaudeNotes: !s.indexClaudeNotes }) }}
        />
        <div className="flex flex-col gap-0.5">
          <label htmlFor="claude-notes-index-toggle" className="text-sm font-medium cursor-pointer">Include Claude Code&rsquo;s saved notes in memory</label>
          <span className="text-xs text-[#9ca3af] leading-relaxed">
            On by default. Runs with the background indexer (about every 30 minutes), only once you have connected your agents.
            Turning it off stops the reading; the copies already made stay until you remove them below.
          </span>
        </div>
      </div>

      {waiting ? (
        <div data-testid="claude-notes-waiting" role="status" className="text-xs text-[#e2c08d] p-3 border border-[#e2c08d]/40 rounded bg-[#e2c08d]/10 leading-relaxed">
          Your agents are not connected (or an earlier version connected them and you have not been asked yet), so no note is
          read. The switch above is on; once you connect them in Settings &rsaquo; Agent Integration, or answer the review Termpolis
          shows when it starts (Settings lists such an install as not yet reviewed), the notes are picked up at the next check
          (about every 30 minutes).
        </div>
      ) : null}

      {s.locked ? (
        <div data-testid="claude-notes-locked" role="status" className="text-xs text-[#e2c08d] p-3 border border-[#e2c08d]/40 rounded bg-[#e2c08d]/10 leading-relaxed">
          Memory is locked, so nothing is read or removed until it opens (the Memory panel says why and what to do). The switches
          still keep what you choose.
        </div>
      ) : null}

      <div className="flex items-start gap-3 p-3 border border-[#3c3c3c] rounded bg-[#252526]">
        <Switch
          on={s.shareNotesAcrossProjects}
          label="Let general notes help in other projects"
          testId="claude-notes-share-toggle"
          disabled={busy}
          onClick={() => { void change({ shareNotesAcrossProjects: !s.shareNotesAcrossProjects }) }}
        />
        <div className="flex flex-col gap-0.5">
          <label htmlFor="claude-notes-share-toggle" className="text-sm font-medium cursor-pointer">Let general notes help in other projects</label>
          <span className="text-xs text-[#9ca3af] leading-relaxed">
            Off by default. When on, a memory search in one project may also return up to two notes of the kinds
            <em> reference</em>, <em>feedback</em> and <em>user</em> from another project, after that project&rsquo;s own results and marked with
            the project they came from. Notes about one project&rsquo;s own state never leave it. Notes from sessions run in your home
            folder belong to no project, so a search that names a project is not lent them. A search that names no project returns no
            saved note (with this on, only those kinds). Leave it off if your projects are not meant to see each other (employer and
            personal, say).
          </span>
        </div>
      </div>

      <div data-testid="claude-notes-status" className="text-xs text-[#9ca3af] leading-relaxed">
        {nothingYet
          ? 'Nothing imported yet.'
          : `${plural(status.notes, 'note', 'notes')} from ${plural(status.projects, 'project', 'projects')} ${status.notes === 1 ? 'is' : 'are'} in memory (${plural(status.chunks, 'chunk', 'chunks')}). Last checked: ${when(status.lastAt)}.`}
        {status.noProject > 0 ? (
          <span data-testid="claude-notes-noproject">
            {' '}{plural(status.noProject, 'note was', 'notes were')} left out because Claude Code has no session recorded for its project folder yet.
          </span>
        ) : null}
        {status.secretsRedacted > 0 ? (
          <span data-testid="claude-notes-redacted">
            {' '}{plural(status.secretsRedacted, 'secret was', 'secrets were')} redacted from notes as they were copied.
          </span>
        ) : null}
        {status.pending > 0 ? (
          <span data-testid="claude-notes-pending">
            {' '}{plural(status.pending, 'removal is', 'removals are')} waiting to be retried.
          </span>
        ) : null}
      </div>

      <div
        className="flex items-center gap-2 flex-wrap"
        onKeyDown={(e) => { if (confirming && e.key === 'Escape') { e.stopPropagation(); dismissConfirm() } }}
      >
        {confirming ? (
          <>
            <span className="text-xs text-[#e5e5e5]">Remove every imported note from memory and turn the import off?</span>
            <button className={BUTTON} data-testid="claude-notes-remove-confirm" disabled={busy} onClick={() => { void remove() }}>Remove</button>
            <button ref={cancelRef} className={BUTTON} data-testid="claude-notes-remove-cancel" disabled={busy} onClick={dismissConfirm}>Cancel</button>
          </>
        ) : (
          <button ref={removeRef} className={BUTTON} data-testid="claude-notes-remove" disabled={busy} onClick={() => setConfirming(true)}>Remove imported notes</button>
        )}
        <span className="text-[10px] text-[#6b7280]">Claude&rsquo;s own notes are not touched.</span>
      </div>

      {notice ? <div data-testid="claude-notes-notice" role="status" className="text-xs text-[#7ee2a3]">{notice}</div> : null}
      {actionErr ? <div data-testid="claude-notes-action-error" role="alert" className="text-xs text-[#EF5350]">{actionErr}</div> : null}
      {err ? <div data-testid="claude-notes-error" role="alert" className="text-xs text-[#EF5350]">{err}</div> : null}
    </section>
  )
}
