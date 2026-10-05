import { useRef, useState } from 'react'
import type { LinkedActivityView, LinkedGrants, LinkedMachineView } from '../../types'
import { formatDuration, latestActivity, relativeTime, toggleGrant } from '../../lib/linkedMachines'
import { LinkedGrantToggles } from './LinkedGrantToggles'

export interface LinkedMachineRowProps {
  machine: LinkedMachineView
  now: number
  /** Settles once main has answered; the row then follows the saved name again. */
  onRename(ref: string, name: string): Promise<void>
  onSetGrants(ref: string, grants: LinkedGrants): void
  onUnlink(ref: string): void
}

/** One linked computer: its name (edited in place), whether it is online, what
 *  it may do here, when it last did anything, and a two-click Unlink. */
export function LinkedMachineRow({
  machine,
  now,
  onRename,
  onSetGrants,
  onUnlink,
}: LinkedMachineRowProps): JSX.Element {
  // null means "follow the saved name"; a string means the user is mid-edit.
  const [draft, setDraft] = useState<string | null>(null)
  const [confirmUnlink, setConfirmUnlink] = useState(false)
  // Enter saves, and the blur that usually follows it would save a second time.
  const saving = useRef(false)

  const commit = async (): Promise<void> => {
    if (draft === null || saving.current) return
    const name = draft.trim()
    if (!name || name === machine.name) {
      setDraft(null)
      return
    }
    saving.current = true
    try {
      await onRename(machine.ref, name)
    } finally {
      // Back to the saved name either way: the new one if main took it, the old
      // one (beside the error banner) if it did not.
      saving.current = false
      setDraft(null)
    }
  }

  return (
    <div
      data-testid={`linked-machine-${machine.ref}`}
      className="border border-[#3c3c3c] rounded px-3 py-2 flex flex-col gap-2"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <span
            aria-hidden="true"
            className={`inline-block w-2 h-2 rounded-full flex-shrink-0 ${machine.online ? 'bg-[#7ee2a3]' : 'bg-[#4a4a4a]'}`}
          />
          <input
            type="text"
            data-testid={`linked-machine-name-${machine.ref}`}
            aria-label="Computer name"
            title="Click to rename. Enter saves, Escape cancels."
            value={draft ?? machine.name}
            maxLength={64}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => void commit()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void commit()
              else if (e.key === 'Escape') setDraft(null)
            }}
            className="min-w-0 flex-1 bg-transparent hover:bg-[#2d2d2d] focus:bg-[#2d2d2d] text-sm text-[#e0e0e0] border border-transparent focus:border-[#3c3c3c] rounded px-1 py-0.5 focus:outline-none"
          />
          <span data-testid={`linked-online-${machine.ref}`} className="text-xs text-[#6b7280]">
            {machine.online ? 'online' : 'offline'}
          </span>
          {!machine.confirmed && (
            <span
              data-testid={`linked-waiting-${machine.ref}`}
              className="text-[10px] px-1.5 py-0.5 rounded border border-[#5a4a2d] bg-[#2a2419] text-[#e5c07b] whitespace-nowrap"
            >
              waiting for confirmation
            </span>
          )}
        </div>
        {confirmUnlink ? (
          <button
            data-testid={`linked-unlink-confirm-${machine.ref}`}
            onClick={() => {
              setConfirmUnlink(false)
              onUnlink(machine.ref)
            }}
            className="px-2 py-1 text-xs rounded bg-[#a33] hover:bg-[#c44] text-white"
          >
            Really unlink?
          </button>
        ) : (
          <button
            data-testid={`linked-unlink-${machine.ref}`}
            onClick={() => setConfirmUnlink(true)}
            className="px-2 py-1 text-xs rounded bg-[#3c3c3c] hover:bg-[#4a4a4a] text-[#e0e0e0]"
          >
            Unlink
          </button>
        )}
      </div>

      <div className="text-xs text-[#6b7280]">What it may do here:</div>
      <LinkedGrantToggles
        grants={machine.grants}
        // The whole object every time, with write ⇒ run already applied: main
        // validates both flags and refuses a partial payload.
        onToggle={(key) => onSetGrants(machine.ref, toggleGrant(machine.grants, key))}
        testIdPrefix={`linked-grant-${machine.ref}`}
      />

      <div data-testid={`linked-last-${machine.ref}`} className="text-xs text-[#6b7280]">
        {machine.lastActivityAt ? `last activity ${relativeTime(machine.lastActivityAt, now)}` : 'no activity yet'}
      </div>
    </div>
  )
}

/** In: that computer asked this one. Out: this one asked that computer. */
const DIRECTION = {
  in: { icon: 'fa-arrow-down text-[#4aa8d8]', word: 'from', label: 'Asked of this computer' },
  out: { icon: 'fa-arrow-up text-[#c678dd]', word: 'to', label: 'Asked by this computer' },
} as const

const STATUS_CLASS: Record<LinkedActivityView['status'], string> = {
  running: 'text-[#4aa8d8]',
  done: 'text-[#7ee2a3]',
  failed: 'text-[#f28b82]',
  cancelled: 'text-[#9ca3af]',
}

/** The latest jobs in both directions. Kept in memory by main only, so it
 *  starts empty after a restart. */
export function LinkedActivityList({
  activity,
  now,
}: {
  activity: LinkedActivityView[]
  now: number
}): JSX.Element {
  const rows = latestActivity(activity)
  return (
    <div data-testid="linked-activity" className="mb-2">
      <div className="text-xs text-[#9ca3af] mb-2">Activity</div>
      {rows.length === 0 ? (
        <p data-testid="linked-no-activity" className="text-xs text-[#6b7280]">
          No jobs yet. Work either computer hands the other shows up here.
        </p>
      ) : (
        <ul className="flex flex-col">
          {rows.map((row) => {
            const dir = DIRECTION[row.direction]
            return (
              <li
                key={row.id}
                data-testid={`linked-activity-${row.id}`}
                className="flex items-center gap-2 text-xs text-[#d4d4d4] border-b border-[#2d2d2d] py-1"
              >
                <i aria-hidden="true" title={dir.label} className={`fa-solid ${dir.icon} w-3 flex-shrink-0`}></i>
                <span className="text-[#9ca3af] w-28 truncate flex-shrink-0">
                  {dir.word} {row.machine}
                </span>
                <span className="text-[#9ca3af] w-14 flex-shrink-0">{row.agent}</span>
                <span className="flex-1 min-w-0 truncate" title={row.summary}>
                  {row.summary}
                </span>
                <span className={STATUS_CLASS[row.status]}>{row.status}</span>
                {row.durationMs !== undefined && (
                  <span className="text-[#6b7280] whitespace-nowrap">{formatDuration(row.durationMs)}</span>
                )}
                <span className="text-[#6b7280] whitespace-nowrap">{relativeTime(row.startedAt, now)}</span>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
