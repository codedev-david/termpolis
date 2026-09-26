import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { StuckProcessView, StuckScanView, TermpolisAPI } from '../../types'
import { InfoTip } from './InfoTip'
import {
  AGENT_LABEL,
  describeKillResult,
  formatAge,
  formatBytes,
  formatCpu,
  killResultTone,
  ownerLabel,
  processKey,
  reasonHint,
} from '../../lib/processFormat'

/**
 * Processes — find what is quietly slowing the machine down, and end it.
 *
 * Three groups, classified in main (src/main/stuckProcesses.ts): headless AI agents, git that
 * is frozen, orphaned or long-running, and the shells and tools such runs leave behind.
 * Scanning happens when the tab opens and on Refresh, never on a timer.
 *
 * Every kill goes through an inline confirmation, and main re-checks each target against a
 * fresh scan by pid and start time. A list that sat on screen while a pid was reused cannot
 * end the wrong process.
 */

type GroupId = StuckProcessView['category']
/** Which button opened the confirmation: it decides the rows, and whether main re-checks "stuck". */
type ConfirmMode = 'selected' | 'stuck'
type Tone = ReturnType<typeof killResultTone>

const GROUPS: { id: GroupId; title: string; hint: string }[] = [
  {
    id: 'agent',
    title: 'Headless AI agents',
    hint: 'Claude Code, Codex and Gemini CLI runs with no window — scheduled jobs, hooks, swarm workers and anything they started.',
  },
  {
    id: 'git',
    title: 'Git',
    hint: 'Git that is frozen (Windows), lost the program that started it, or has run for more than 30 minutes.',
  },
  {
    id: 'leftover',
    title: 'Leftover shells & tools',
    hint: 'Shells, wrappers, MCP servers and tools whose parent is gone, or that are frozen (Windows).',
  },
]

const BUTTON = 'text-xs px-2 py-1 rounded bg-[#2d2d2d] text-[#d4d4d4] hover:bg-[#3a3a3a] disabled:opacity-50'
const DANGER = 'text-xs px-2 py-1 rounded bg-[#a1260d] text-white hover:bg-[#c42b1c] disabled:opacity-50'
const TONE_CLASS: Record<Tone, string> = {
  ok: 'text-[#98c379]',
  warn: 'text-[#e5c07b]',
  bad: 'text-[#e06c75]',
}

/** How far one process's start time may drift between scans — the same allowance main's kill check makes. */
function createdTolerance(platform: string): number {
  return platform === 'win32' ? 2000 : 5000
}

function message(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)) || 'Unknown error'
}

function ProcessRow({
  p,
  platform,
  checked,
  disabled,
  onToggle,
}: {
  p: StuckProcessView
  platform: string
  checked: boolean
  disabled: boolean
  onToggle: () => void
}): JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const label = p.agent ? AGENT_LABEL[p.agent] : p.name
  const wrap = expanded ? 'whitespace-pre-wrap break-all' : 'truncate'
  return (
    <li className="flex items-start gap-2 py-2 border-t border-[#2d2d2d]" data-testid={`processes-row-${p.pid}`}>
      <input
        type="checkbox"
        className="mt-0.5"
        data-testid={`processes-check-${p.pid}`}
        aria-label={`Select ${label} (pid ${p.pid})`}
        checked={checked}
        disabled={disabled}
        onChange={onToggle}
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <span className="font-semibold text-[#e0e0e0]">{label}</span>
          <span className="text-[#9ca3af]">pid {p.pid}</span>
          {p.stuck && (
            <span
              className="px-1.5 rounded bg-[#5a1d1d] text-[#f48771] font-semibold"
              title="Safe to kill: serves no TCP port, nobody is using it, and it is frozen or orphaned."
            >
              STUCK
            </span>
          )}
          {p.reasons.map((r) => (
            <span key={r} className="px-1.5 rounded bg-[#2d2d2d] text-[#d4d4d4]" title={reasonHint(r, platform)}>
              {r}
            </span>
          ))}
          {p.mcp && <span className="px-1.5 rounded bg-[#1e3a5f] text-[#9cdcfe]">MCP</span>}
        </div>
        <div className="text-xs text-[#9ca3af] mt-0.5">
          {ownerLabel(p)} · up {formatAge(p.ageMs)} · CPU {formatCpu(p.cpuSec)} · {formatBytes(p.memBytes)}
          {p.treeSize > 1 && ` · +${p.treeSize - 1} child process${p.treeSize === 2 ? '' : 'es'}`}
          {p.serving.length > 0 && ` · serving port ${p.serving.join(', ')}`}
        </div>
        {/* Click to see the whole line. Never a title attribute: masking a command line is best
            effort, and Sentry copies a clicked element's title into its breadcrumbs. */}
        <button
          type="button"
          className={`block w-full text-left text-[11px] font-mono text-[#d4d4d4] mt-0.5 ${wrap}`}
          data-testid={`processes-command-${p.pid}`}
          data-sentry-element="process-command"
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
        >
          {p.command}
        </button>
        {p.detail && (
          <button
            type="button"
            className={`block w-full text-left text-[11px] font-mono text-[#9ca3af] ${wrap}`}
            data-testid={`processes-detail-${p.pid}`}
            data-sentry-element="process-detail"
            aria-expanded={expanded}
            onClick={() => setExpanded((v) => !v)}
          >
            ↳ {p.detail}
          </button>
        )}
      </div>
    </li>
  )
}

export function ProcessesSettings(): JSX.Element {
  const [scan, setScan] = useState<StuckScanView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  // Only which button asked. The rows are read from the live list on every render, so a rescan
  // behind an open confirmation can never leave it naming processes the list no longer shows.
  const [confirm, setConfirm] = useState<ConfirmMode | null>(null)
  const [result, setResult] = useState<{ text: string; tone: Tone } | null>(null)
  const openerRef = useRef<HTMLButtonElement | null>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const refreshRef = useRef<HTMLButtonElement>(null)
  // Set when the user closes the confirmation, so focus goes back where they were; not when a
  // rescan empties it out from under them.
  const restoreFocus = useRef(false)
  const questionId = useId()
  const warningId = useId()

  const api = window.termpolis as TermpolisAPI | undefined
  const unavailable = !api?.processesScanStuck

  const load = useCallback(async (): Promise<void> => {
    if (!api?.processesScanStuck) return
    setBusy(true)
    try {
      const res = await api.processesScanStuck()
      if (res.success) {
        setScan(res.data)
        setError(null)
        // A selection carries over only to the same process: its pid, and a start time within the
        // drift main allows (POSIX start times are only approximate). Anything that dropped off
        // the list is forgotten, even if it is listed again later.
        const tolerance = createdTolerance(res.data.platform)
        const byPid = new Map(res.data.processes.map((p) => [p.pid, p] as const))
        setSelected((prev) => {
          const next = new Set<string>()
          for (const k of prev) {
            const [pid, created] = k.split(':').map(Number)
            const row = byPid.get(pid)
            if (row && Math.abs(row.created - created) <= tolerance) next.add(processKey(row))
          }
          return next
        })
      } else {
        setError(res.error || 'Scan failed.')
      }
    } catch (e) {
      setError(message(e))
    } finally {
      setBusy(false)
    }
  }, [api])

  useEffect(() => {
    void load()
  }, [load])

  const rows = scan?.processes ?? []
  const selectedRows = rows.filter((p) => selected.has(processKey(p)))
  const stuckRows = rows.filter((p) => p.stuck)
  const confirmRows = confirm === 'stuck' ? stuckRows : confirm === 'selected' ? selectedRows : []
  const open = confirmRows.length > 0
  const confirmChildren = confirmRows.reduce((n, p) => n + p.treeSize - 1, 0)

  // A rescan left nothing to confirm, so the question goes too.
  useEffect(() => {
    if (confirm !== null && confirmRows.length === 0) setConfirm(null)
  }, [confirm, confirmRows.length])

  useEffect(() => {
    if (open) (cancelRef.current as HTMLButtonElement).focus()
  }, [open, confirm])

  // Deferred until the kill and its rescan are done: the opener is disabled while they run.
  useEffect(() => {
    if (confirm === null && !busy && restoreFocus.current) {
      restoreFocus.current = false
      const opener = openerRef.current as HTMLButtonElement
      ;(opener.disabled ? (refreshRef.current as HTMLButtonElement) : opener).focus()
    }
  }, [confirm, busy])

  const ask = (mode: ConfirmMode, opener: HTMLButtonElement): void => {
    openerRef.current = opener
    setConfirm(mode)
  }

  const closeConfirm = (): void => {
    restoreFocus.current = true
    setConfirm(null)
  }

  const kill = async (mode: ConfirmMode, targets: StuckProcessView[]): Promise<void> => {
    closeConfirm()
    setResult(null)
    setBusy(true)
    let outcome: { result?: { text: string; tone: Tone }; error?: string }
    try {
      const res = await (api as TermpolisAPI).processesKillStuck(
        targets.map((p) => ({ pid: p.pid, created: p.created })),
        // "Kill all stuck" means stuck now, not stuck when the list was drawn.
        { stuckOnly: mode === 'stuck' },
      )
      outcome = res.success
        ? { result: { text: describeKillResult(res.data), tone: killResultTone(res.data) } }
        : { error: res.error || 'Kill failed.' }
    } catch (e) {
      outcome = { error: message(e) }
    }
    await load()
    // Applied after the re-scan, which clears the error line when it succeeds.
    setResult(outcome.result ?? null)
    if (outcome.error) setError(outcome.error)
  }

  const toggle = (keys: string[], on: boolean): void => {
    setSelected((prev) => {
      const next = new Set(prev)
      for (const k of keys) {
        if (on) next.add(k)
        else next.delete(k)
      }
      return next
    })
  }

  if (unavailable) {
    return (
      <div className="settings-section" data-testid="processes-settings">
        <h2 className="text-sm font-semibold text-[#e0e0e0] mb-2">Processes</h2>
        <p className="text-xs text-[#9ca3af]">Process cleanup is not available in this build.</p>
      </div>
    )
  }

  if (!scan && !error) {
    return (
      <div className="settings-section" data-testid="processes-settings">
        <h2 className="text-sm font-semibold text-[#e0e0e0] mb-2">Processes</h2>
        <p className="text-xs text-[#9ca3af]" data-testid="processes-loading">
          Scanning…
        </p>
      </div>
    )
  }

  return (
    <div className="settings-section" data-testid="processes-settings">
      <div className="flex items-center justify-between mb-1">
        <h2 className="text-sm font-semibold text-[#e0e0e0] inline-flex items-center">
          Processes
          <InfoTip testId="processes-info" label="What counts as stuck">
            <p className="mb-2">
              <span className="text-[#d4d4d4]">Stuck</span> means it serves no TCP port and is either frozen (Windows
              only: every thread suspended for at least a minute) or orphaned: the program that started it has
              exited (a headless agent only after an hour). On Windows, Git Bash can leave a git or jq frozen for
              good when the script that started it quits at the wrong moment; a status line that runs git on every
              refresh leaks a few a day.
            </p>
            <p className="mb-2">
              Also listed, but not marked stuck: headless agents still attached to whatever started them or
              orphaned for under an hour, git that has run for over 30 minutes, and anything listening on a TCP
              port — that may be a server you started on purpose. On macOS and Linux a stopped (Ctrl+Z) job is
              never counted as frozen. Anything someone is using — an agent CLI open in a terminal, or git
              waiting on a pager or an editor — is left alone: it is never marked stuck, and an orphaned or
              long-running tree that holds one is not listed.
            </p>
            <p>
              Termpolis itself, the programs that launched it, and its own windows and terminal shells are never
              listed. Processes in other Windows sessions (other users&apos; processes on macOS and Linux) are not
              listed; elevated ones can only be killed from an elevated Termpolis.
            </p>
          </InfoTip>
        </h2>
        <button
          type="button"
          ref={refreshRef}
          data-testid="processes-refresh"
          onClick={() => {
            setResult(null)
            void load()
          }}
          disabled={busy}
          className={BUTTON}
        >
          {busy ? 'Scanning…' : 'Refresh'}
        </button>
      </div>
      <p className="text-xs text-[#9ca3af] mb-4">
        Headless AI agents, frozen or runaway git, and the shells and tools they leave behind. They pile up when
        a scheduled job, hook or crashed session never cleans up after itself, and each one holds memory and file
        handles. Nothing is scanned in the background — only when this tab opens or you press Refresh.
      </p>

      {error && (
        <p role="alert" className="text-xs text-[#e06c75] mb-3" data-testid="processes-error">
          {error}
        </p>
      )}
      {/* Always mounted, so a screen reader hears the verdict when it lands. */}
      <div role="status" aria-live="polite" data-testid="processes-status">
        {scan?.warnings.map((w) => (
          <p key={w} className="text-xs text-[#e5c07b] mb-3" data-testid="processes-warning">
            {w}
          </p>
        ))}
        {result && (
          <p className={`text-xs ${TONE_CLASS[result.tone]} mb-3`} data-testid="processes-result">
            {result.text}
          </p>
        )}
      </div>

      {scan && (
        <>
          <div className="flex flex-wrap items-center gap-2 mb-4">
            <button
              type="button"
              data-testid="processes-kill-selected"
              disabled={busy || selectedRows.length === 0}
              onClick={(e) => ask('selected', e.currentTarget)}
              className={DANGER}
            >
              Kill selected ({selectedRows.length})
            </button>
            <button
              type="button"
              data-testid="processes-kill-stuck"
              disabled={busy || stuckRows.length === 0}
              onClick={(e) => ask('stuck', e.currentTarget)}
              className={BUTTON}
            >
              Kill all stuck ({stuckRows.length})
            </button>
            <span className="text-xs text-[#9ca3af]" data-testid="processes-summary">
              {scan.totalProcesses} processes scanned at {new Date(scan.scannedAt).toLocaleTimeString()}
            </span>
          </div>

          {open && (
            <div
              className="mb-4 p-3 rounded border border-[#5a1d1d] bg-[#2a1616]"
              role="alertdialog"
              aria-label="Confirm kill"
              aria-describedby={`${questionId} ${warningId}`}
              data-testid="processes-confirm"
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.stopPropagation()
                  closeConfirm()
                }
              }}
            >
              <p id={questionId} className="text-xs text-[#e0e0e0] mb-1">
                Kill {confirmRows.length} {confirmRows.length === 1 ? 'process' : 'processes'}
                {confirmChildren > 0 &&
                  `, plus ${confirmChildren} child process${confirmChildren === 1 ? '' : 'es'} under ${confirmRows.length === 1 ? 'it' : 'them'}`}
                ?
              </p>
              <p id={warningId} className="text-xs text-[#9ca3af] mb-2">
                Whatever they were doing is lost. A git killed mid-write can leave a stale{' '}
                <code>.git/index.lock</code> — delete it if the next git command complains. Each one is checked again
                first: anything that has exited{confirm === 'stuck' && ', is no longer stuck'}, or whose pid now
                belongs to a different process, is skipped. Anything still running is ended with its current child
                processes.
              </p>
              <div className="flex gap-2">
                <button
                  type="button"
                  data-testid="processes-confirm-kill"
                  disabled={busy}
                  onClick={() => void kill(confirm as ConfirmMode, confirmRows)}
                  className={DANGER}
                >
                  Kill {confirmRows.length}
                </button>
                <button
                  type="button"
                  ref={cancelRef}
                  data-testid="processes-confirm-cancel"
                  onClick={closeConfirm}
                  className={BUTTON}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {rows.length === 0 ? (
            <p className="text-xs text-[#98c379]" data-testid="processes-empty">
              Nothing stuck. No headless agents, frozen git or orphaned leftovers were found.
            </p>
          ) : (
            GROUPS.map((g) => {
              const members = rows.filter((p) => p.category === g.id)
              if (members.length === 0) return null
              const keys = members.map(processKey)
              const all = keys.every((k) => selected.has(k))
              const some = !all && keys.some((k) => selected.has(k))
              return (
                <div key={g.id} className="mb-5" data-testid={`processes-group-${g.id}`}>
                  <label className="flex items-center gap-2 text-xs font-semibold text-[#e0e0e0]">
                    <input
                      type="checkbox"
                      ref={(el) => {
                        if (el) el.indeterminate = some
                      }}
                      data-testid={`processes-select-all-${g.id}`}
                      aria-label={`Select all ${g.title}`}
                      checked={all}
                      disabled={busy}
                      onChange={() => toggle(keys, !all)}
                    />
                    {g.title} ({members.length})
                  </label>
                  <p className="text-xs text-[#9ca3af] mb-1 ml-5">{g.hint}</p>
                  <ul className="ml-5">
                    {members.map((p) => {
                      const k = processKey(p)
                      return (
                        // Keyed by pid: a POSIX start time shifts a little between scans, and a new
                        // key would remount the row and fold up a command line the user opened.
                        <ProcessRow
                          key={p.pid}
                          p={p}
                          platform={scan.platform}
                          checked={selected.has(k)}
                          disabled={busy}
                          onToggle={() => toggle([k], !selected.has(k))}
                        />
                      )
                    })}
                  </ul>
                </div>
              )
            })
          )}
        </>
      )}
    </div>
  )
}
