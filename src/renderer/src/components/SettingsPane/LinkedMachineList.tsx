import { useEffect, useRef, useState } from 'react'
import type { LinkedActivityView, LinkedGrants, LinkedJobRecord, LinkedMachineView } from '../../types'
import {
  codexEditAccess,
  formatDuration,
  historyRows,
  latestActivity,
  relativeTime,
  toggleGrant,
  type GrantKey,
  type HistoryRow,
} from '../../lib/linkedMachines'
import { LinkedGrantToggles } from './LinkedGrantToggles'
import { hostPlatform } from '../../lib/platform'

export interface LinkedMachineRowProps {
  machine: LinkedMachineView
  now: number
  /** Settles once main has answered; the row then follows the saved name again. */
  onRename(ref: string, name: string): Promise<void>
  /** `confirmWrite` only from the edit panel's Allow: main turns edit on for nothing else. */
  onSetGrants(ref: string, grants: LinkedGrants, confirmWrite?: boolean): void
  onUnlink(ref: string): void
}

/** What edit hands a computer, per agent, where it is turned on (spec §4.6). Termpolis switches
 *  a Codex job's network off; Claude and Gemini have no such switch. What that switch is worth
 *  depends on this computer's OS (codexEditAccess). */
function EditConfirm({
  machine,
  onAllow,
  onCancel,
}: {
  machine: LinkedMachineView
  onAllow(): void
  onCancel(): void
}): JSX.Element {
  const codex = codexEditAccess(hostPlatform())
  return (
    <div
      data-testid={`linked-write-confirm-${machine.ref}`}
      className="border border-[#5a4a2d] bg-[#2a2419] rounded px-3 py-2 flex flex-col gap-2"
    >
      <div className="text-xs text-[#e5c07b]">Let {machine.name} edit files and run commands here?</div>
      <ul className="text-xs text-[#d4d4d4] list-disc pl-4 flex flex-col gap-1">
        <li>
          <span className="text-[#e5c07b]">Claude and Gemini: full access.</span> The agent runs any command as
          you, without asking. It can read and change any file you can, use your Termpolis terminals, and reach
          your other linked computers.
        </li>
        <li>
          <span className="text-[#e5c07b]">Codex: in its sandbox.</span> It can change files only in the
          job&apos;s folder and temporary folders, and read any file you can. {codex.sentence}
        </li>
      </ul>
      <p className="text-xs text-[#9ca3af]">
        Switching this off stops its running edit jobs, but not what they already changed.
      </p>
      <div className="flex gap-2">
        <button
          data-testid={`linked-write-allow-${machine.ref}`}
          onClick={onAllow}
          className="px-2 py-1 text-xs rounded bg-[#a33] hover:bg-[#c44] text-white"
        >
          Allow edit
        </button>
        <button
          data-testid={`linked-write-cancel-${machine.ref}`}
          onClick={onCancel}
          className="px-2 py-1 text-xs rounded bg-[#3c3c3c] hover:bg-[#4a4a4a] text-[#e0e0e0]"
        >
          Cancel
        </button>
      </div>
    </div>
  )
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
  // Ticking edit asks first, here in the row. Edit turned on some other way answers the question.
  const [askEdit, setAskEdit] = useState(false)
  useEffect(() => {
    if (machine.grants.write) setAskEdit(false)
  }, [machine.grants.write])
  // Enter saves, and the blur that usually follows it would save a second time.
  const saving = useRef(false)

  const toggle = (key: GrantKey): void => {
    if (key === 'write' && !machine.grants.write) {
      setAskEdit(true)
      return
    }
    // The whole object every time, with write ⇒ run already applied: main
    // validates both flags and refuses a partial payload.
    onSetGrants(machine.ref, toggleGrant(machine.grants, key))
  }

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
          {machine.grants.write && (
            <span
              data-testid={`linked-full-access-${machine.ref}`}
              title={
                codexEditAccess(hostPlatform()).full
                  ? 'Its agents run here with full access as you: Claude and Gemini, and on Windows Codex too.'
                  : 'Its Claude and Gemini agents run here with full access as you; Codex in its sandbox, network off.'
              }
              className="text-[10px] px-1.5 py-0.5 rounded border border-[#5a2d2d] bg-[#2a1919] text-[#f28b82] whitespace-nowrap"
            >
              full access
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
        onToggle={toggle}
        testIdPrefix={`linked-grant-${machine.ref}`}
        // Edit goes only to a computer whose words were checked here; off stays reachable.
        disabledKeys={!machine.confirmed && !machine.grants.write ? ['write'] : []}
      />
      {askEdit && (
        <EditConfirm
          machine={machine}
          onAllow={() => {
            setAskEdit(false)
            onSetGrants(machine.ref, { run: true, write: true }, true)
          }}
          onCancel={() => setAskEdit(false)}
        />
      )}

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
 *  starts empty after a restart. A job another computer is running here can be
 *  stopped from its row. */
export function LinkedActivityList({
  activity,
  now,
  onStop,
}: {
  activity: LinkedActivityView[]
  now: number
  onStop(id: string): void
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
                {row.direction === 'in' && row.status === 'running' && (
                  <button
                    data-testid={`linked-stop-${row.id}`}
                    onClick={() => onStop(row.id)}
                    title={`Stop this job. ${row.machine} is told it was stopped here.`}
                    className="px-2 py-0.5 text-xs rounded bg-[#3c3c3c] hover:bg-[#a33] text-[#e0e0e0]"
                  >
                    Stop
                  </button>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

const HISTORY_STATUS: Record<Exclude<HistoryRow, { kind: 'refused' }>['status'], { word: string; className: string }> = {
  running: { word: 'running', className: STATUS_CLASS.running },
  done: { word: 'done', className: STATUS_CLASS.done },
  failed: { word: 'failed', className: STATUS_CLASS.failed },
  cancelled: { word: 'cancelled', className: STATUS_CLASS.cancelled },
  unrecorded: { word: 'no end recorded', className: 'text-[#6b7280]' },
}

/** The last part of a folder path, for a row that has no room for all of it. */
function folderName(cwd: string): string {
  const parts = cwd.split(/[\\/]+/).filter(Boolean)
  return parts.at(-1) ?? cwd
}

/** Every job other computers started here, and every one they were refused, from the history
 *  file main keeps (linked-jobs.jsonl): unlike Activity, it is still there after a restart.
 *  `records` is null until it has been read. */
export function LinkedJobHistory({
  records,
  running,
  now,
}: {
  records: LinkedJobRecord[] | null
  running: ReadonlySet<string>
  now: number
}): JSX.Element {
  const rows = records ? historyRows(records, running) : []
  return (
    <div data-testid="linked-history" className="mt-4">
      <div className="text-xs text-[#9ca3af] mb-1">Job history on this computer</div>
      <p className="text-xs text-[#6b7280] mb-2">
        Every job another computer started here, and every one this computer refused, kept across
        restarts.
      </p>
      {rows.length === 0 ? (
        <p data-testid="linked-history-empty" className="text-xs text-[#6b7280]">
          {records ? 'No other computer has asked this one for a job yet.' : 'Reading the job history…'}
        </p>
      ) : (
        <ul className="flex flex-col">
          {rows.map((row) =>
            row.kind === 'refused' ? (
              <li
                key={row.key}
                data-testid={`linked-history-${row.key}`}
                className="flex items-start gap-2 text-xs text-[#d4d4d4] border-b border-[#2d2d2d] py-1"
              >
                <span className="text-[#f28b82] whitespace-nowrap">refused</span>
                <span className="text-[#9ca3af] w-28 truncate flex-shrink-0">from {row.machine}</span>
                <span className="flex-1 min-w-0 break-words text-[#9ca3af]">
                  {row.reason}
                  {row.count ? ` (and ${row.count} more that minute)` : ''}
                </span>
                <span className="text-[#6b7280] whitespace-nowrap">{relativeTime(row.ts, now)}</span>
              </li>
            ) : (
              <li
                key={row.key}
                data-testid={`linked-history-${row.key}`}
                className="flex flex-col gap-0.5 text-xs text-[#d4d4d4] border-b border-[#2d2d2d] py-1"
              >
                <div className="flex items-center gap-2">
                  <span className="text-[#9ca3af] w-28 truncate flex-shrink-0">from {row.machine}</span>
                  <span className="text-[#9ca3af] w-14 flex-shrink-0">{row.agent ?? ''}</span>
                  {row.write && (
                    <span
                      data-testid={`linked-history-edit-${row.key}`}
                      className="text-[10px] px-1.5 py-0.5 rounded border border-[#5a2d2d] bg-[#2a1919] text-[#f28b82] whitespace-nowrap"
                    >
                      edit
                    </span>
                  )}
                  <span className="flex-1 min-w-0 truncate" title={row.summary}>
                    {row.summary ?? ''}
                  </span>
                  <span className={HISTORY_STATUS[row.status].className}>{HISTORY_STATUS[row.status].word}</span>
                  {row.durationMs !== undefined && (
                    <span className="text-[#6b7280] whitespace-nowrap">{formatDuration(row.durationMs)}</span>
                  )}
                  <span className="text-[#6b7280] whitespace-nowrap">{relativeTime(row.ts, now)}</span>
                </div>
                {(row.cwd || row.secretRules.length > 0) && (
                  <div className="flex items-center gap-2 pl-[7.5rem] text-[#6b7280]">
                    {row.cwd && (
                      <span className="font-mono truncate" title={row.cwd}>
                        in {folderName(row.cwd)}
                      </span>
                    )}
                    {row.secretRules.length > 0 && (
                      <span data-testid={`linked-history-secrets-${row.key}`} className="text-[#e5c07b]">
                        credentials screened: {row.secretRules.join(', ')}
                      </span>
                    )}
                  </div>
                )}
              </li>
            ),
          )}
        </ul>
      )}
    </div>
  )
}
