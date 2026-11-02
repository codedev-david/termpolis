import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * The activity record (1.55.0): how much of "what memory did" this computer holds, and a way to clear it.
 *
 * Termpolis keeps a short, local record of what its memory did (memoryAudit.ts): each memory stored, each recall, each digest
 * handed to an agent and each learning pass. It is on by default and has no switch; what the user can do about it is see how much
 * there is and forget it. Everything it holds is spelled out below in the same words as PRIVACY.md.
 *
 * The panel only asks main for a size and for the clear (memoryAuditIpc.ts); it never sees a line of the record. Read on open and
 * on Refresh, never on a timer (see ClaudeNotesPanel).
 */

const BUTTON = 'text-xs px-2 py-1 rounded bg-[#2d2d2d] text-[#d4d4d4] hover:bg-[#3a3a3a] border border-[#3c3c3c] shrink-0'

type RecordSize = { files: number; bytes: number }

const plural = (n: number, one: string, many: string): string => `${n.toLocaleString()} ${n === 1 ? one : many}`

/** A size in the unit that reads best; the unit goes up as soon as the number would otherwise round to 1,024. */
function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} ${bytes === 1 ? 'byte' : 'bytes'}`
  const kb = bytes / 1024
  if (Math.round(kb * 10) / 10 < 1024) return `${kb.toFixed(1)} KB`
  return `${(kb / 1024).toFixed(1)} MB`
}

export function ActivityRecordPanel({ refreshToken = 0 }: { refreshToken?: number }) {
  const [record, setRecord] = useState<RecordSize | null>(null)
  const [err, setErr] = useState('')              // a failed READ
  const [actionErr, setActionErr] = useState('')  // a failed CLEAR, kept apart so a re-read does not wipe it
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const mounted = useRef(true)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const clearRef = useRef<HTMLButtonElement>(null)
  // Focus follows the confirm step, as in ClaudeNotesPanel: onto the SAFE choice when it opens (a held Enter must not confirm), and
  // back onto the button that opened it once it closes and nothing is in flight.
  const refocus = useRef(false)
  useEffect(() => { if (confirming) cancelRef.current?.focus() }, [confirming])
  useEffect(() => {
    if (!confirming && !busy && refocus.current) { refocus.current = false; clearRef.current?.focus() }
  }, [confirming, busy])
  const dismissConfirm = () => { refocus.current = true; setConfirming(false) }

  const load = useCallback(async () => {
    try {
      const res = await window.termpolis?.memoryAuditSize?.()
      if (!mounted.current) return
      if (res?.success && res.data) { setRecord(res.data); setErr('') }
      else setErr(res?.error || 'Could not read the activity record')
    } catch (e) {
      if (mounted.current) setErr((e as Error).message || 'Could not read the activity record')
    }
  }, [])

  // On open, and on Refresh. NEVER on a timer.
  useEffect(() => {
    mounted.current = true
    void load()
    return () => { mounted.current = false }
  }, [load, refreshToken])

  // Runs with the button disabled (`busy`), so a second click cannot arrive while it is in flight.
  const clear = async () => {
    refocus.current = true
    setConfirming(false)
    setBusy(true)
    setActionErr('')
    setNotice('')
    try {
      const res = await window.termpolis?.memoryClearAudit?.()
      if (!mounted.current) return
      if (res?.success && res.data) {
        const { removed, failed } = res.data
        setNotice(
          failed > 0
            ? `Cleared ${plural(removed, 'file', 'files')}. ${plural(failed, 'file', 'files')} could not be removed (another program may be holding ${failed === 1 ? 'it' : 'them'} open); try again.`
            : 'Cleared. Memory itself is untouched; the record starts again from now.',
        )
        await load()
      } else setActionErr(res?.error || 'Could not clear the activity record')
    } catch (e) {
      if (mounted.current) setActionErr((e as Error).message || 'Could not clear the activity record')
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  if (err && !record) return <div data-testid="activity-record-error" role="alert" className="text-xs text-[#EF5350]">{err}</div>
  if (!record) return <div data-testid="activity-record-loading" className="text-xs text-[#9ca3af]">Reading the activity record&hellip;</div>

  // Not `disabled`: a button that goes disabled drops the keyboard focus it holds. It stays in the tab order, says it is not
  // available, and a click is ignored meanwhile.
  const unavailable = busy || record.files === 0

  return (
    <section data-testid="activity-record-panel" className="flex flex-col gap-3">
      <div>
        <h3 className="font-semibold text-[#22D3EE] mb-1 flex items-center gap-2">
          <i className="fa-solid fa-clock-rotate-left text-xs"></i> Activity record
        </h3>
        <p className="text-xs text-[#9ca3af] leading-relaxed">
          Termpolis keeps a short record of what memory did: each memory stored (its kind, the agent that stored it and a clipped
          preview with anything that might be a secret taken out), each recall (how many memories it found and the ids of the top
          few), each digest handed to an agent (its size) and each learning pass. It holds counts, ids, kinds and the name of the
          agent, never what was asked. It stays on this computer and is capped at about 2 MB, with one earlier copy of each file.
        </p>
      </div>

      <div data-testid="activity-record-status" className="text-xs text-[#9ca3af] leading-relaxed">
        {record.files === 0
          ? 'Nothing recorded.'
          : `${plural(record.files, 'file', 'files')} on this computer, ${sizeText(record.bytes)} together.`}
      </div>

      <div
        className="flex items-center gap-2 flex-wrap"
        onKeyDown={(e) => { if (confirming && e.key === 'Escape') { e.stopPropagation(); dismissConfirm() } }}
      >
        {confirming ? (
          <>
            <span data-testid="activity-record-confirm" className="text-xs text-[#e5e5e5]">
              Forget what memory has recorded about its own work? No memory is removed.
            </span>
            <button className={BUTTON} data-testid="activity-record-confirm-yes" onClick={() => { void clear() }}>Clear</button>
            <button ref={cancelRef} className={BUTTON} data-testid="activity-record-cancel" onClick={dismissConfirm}>Cancel</button>
          </>
        ) : (
          <button
            ref={clearRef}
            className={`${BUTTON} ${unavailable ? 'opacity-50' : ''}`}
            data-testid="activity-record-clear"
            aria-disabled={unavailable || undefined}
            onClick={() => { if (!unavailable) setConfirming(true) }}
          >
            Clear activity record
          </button>
        )}
        <span className="text-[10px] text-[#6b7280]">Your memories are not touched.</span>
      </div>

      {notice ? <div data-testid="activity-record-notice" role="status" className="text-xs text-[#7ee2a3]">{notice}</div> : null}
      {actionErr ? <div data-testid="activity-record-action-error" role="alert" className="text-xs text-[#EF5350]">{actionErr}</div> : null}
      {err ? <div data-testid="activity-record-error" role="alert" className="text-xs text-[#EF5350]">{err}</div> : null}
    </section>
  )
}
