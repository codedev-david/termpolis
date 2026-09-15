// Right-docked rail listing every changed file in the active terminal's repo.
//
// GitPanel already lists changed files, but it is a CENTRED MODAL: it covers the
// terminal, so it is a thing you open, act on, and dismiss. This is the other half —
// an always-visible rail you glance at while an agent works, where clicking a file
// opens its diff and nothing on the row can mutate the repo by accident. Staging,
// committing, pull/push all stay in GitPanel; this rail is strictly read-and-review.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { subscribe, unsubscribe } from '../../lib/pollingService'
import type { DiffHunk } from '../../lib/diffParser'
import { FileDiffModal } from './FileDiffModal'

export type ChangeMode = 'staged' | 'unstaged' | 'untracked'

export interface ChangeEntry {
  file: string
  oldFile?: string
  status: string
  added: number
  removed: number
  binary: boolean
}

interface ChangesResult {
  branch: string
  /** Commits HEAD has that the upstream does not — i.e. "needs pushing". */
  ahead: number
  behind: number
  staged: ChangeEntry[]
  unstaged: ChangeEntry[]
  untracked: ChangeEntry[]
}

/** Mirrors the payload of src/main/coverageReader.ts. */
interface FileCoverage {
  source: string
  /** Which artifact format the numbers came from — lcov, cobertura, jacoco, clover, gocover. */
  format: string
  lines: Record<number, number>
  stale: boolean
}

interface Props {
  cwd: string
  onClose: () => void
  /** Terminal this rail reports on. Explain / Discuss write the hunk into it. */
  terminalId?: string | null
}

// Git's own porcelain shorthand, not a re-spelling of it: ?? is untracked and U is
// unmerged, which are genuinely different states, and anyone who reads `git status`
// already knows which is which.
const STATUS_LABELS: Record<string, string> = {
  M: 'Modified',
  A: 'Added',
  D: 'Deleted',
  R: 'Renamed',
  C: 'Copied',
  T: 'Type changed',
  U: 'Conflicted',
  '??': 'Untracked',
}

// Same palette ContextPanel uses for git status, so a status letter means the same
// colour everywhere in the app. U gets its own orange rather than sharing D's red:
// a conflict is the one row here you cannot resolve by reading the diff.
const STATUS_COLORS: Record<string, string> = {
  M: '#e5c07b',
  A: '#98c379',
  D: '#e06c75',
  R: '#c678dd',
  C: '#c678dd',
  T: '#e5c07b',
  U: '#d19a66',
  '??': '#61afef',
}

export function statusColor(status: string): string {
  return STATUS_COLORS[status] ?? '#abb2bf'
}

export function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status
}

/** Split "src/components/Foo.tsx" into the dimmed directory and the bright basename. */
export function splitPath(file: string): { dir: string; base: string } {
  const idx = Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\'))
  return idx < 0 ? { dir: '', base: file } : { dir: file.slice(0, idx + 1), base: file.slice(idx + 1) }
}

export function ChangesPanel({ cwd, onClose, terminalId = null }: Props) {
  const [root, setRoot] = useState<string | null>(null)
  const [detecting, setDetecting] = useState(true)
  const [changes, setChanges] = useState<ChangesResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})

  const [openFile, setOpenFile] = useState<{ file: string; mode: ChangeMode } | null>(null)
  const [diff, setDiff] = useState('')
  const [diffLoading, setDiffLoading] = useState(false)
  const [diffError, setDiffError] = useState<string | null>(null)
  const [coverage, setCoverage] = useState<FileCoverage | null>(null)

  // Resolve the repo root from the active terminal's cwd. A cwd deep inside a repo is
  // the normal case, so this is not optional.
  useEffect(() => {
    let cancelled = false
    if (!cwd) {
      setRoot(null)
      setDetecting(false)
      return
    }
    setDetecting(true)
    window.termpolis.gitFindRoot(cwd)
      .then(res => {
        if (cancelled) return
        setRoot(res.success && res.data ? res.data : null)
      })
      .catch(() => { if (!cancelled) setRoot(null) })
      .finally(() => { if (!cancelled) setDetecting(false) })
    return () => { cancelled = true }
  }, [cwd])

  const refresh = useCallback(async () => {
    if (!root) return
    try {
      const res = await window.termpolis.gitChanges(root)
      if (res.success && res.data) {
        setChanges(res.data)
        setError(null)
      } else {
        setError(res.error ?? 'Could not read git status')
      }
    } catch (e: any) {
      setError(e?.message ?? 'Could not read git status')
    }
  }, [root])

  useEffect(() => {
    if (!root) return
    refresh()
    const id = `changes-panel-${root}`
    subscribe(id, refresh, 3000)
    return () => unsubscribe(id)
  }, [refresh, root])

  const openDiff = useCallback(async (file: string, mode: ChangeMode) => {
    setOpenFile({ file, mode })
    setDiff('')
    setDiffError(null)
    setDiffLoading(true)
    setCoverage(null)
    // Fired alongside the diff rather than awaited before it: coverage is decoration,
    // and a monorepo's lcov must never delay the thing that was actually clicked.
    const readCoverage = window.termpolis?.coverageForFile
    if (root && typeof readCoverage === 'function') {
      readCoverage(root, file)
        .then(res => setCoverage(res?.success ? res.data ?? null : null))
        .catch(() => setCoverage(null))
    }
    try {
      const res = await window.termpolis.gitChangeDiff(root!, file, mode)
      if (res.success) setDiff(res.data ?? '')
      else setDiffError(res.error ?? 'Could not load diff')
    } catch (e: any) {
      setDiffError(e?.message ?? 'Could not load diff')
    } finally {
      setDiffLoading(false)
    }
  }, [root])

  // Reverse-apply one hunk to revert it, or forward-apply the same patch to undo that
  // revert. Both the open diff and the file list now describe a worktree that has just
  // changed underneath them, so both are reloaded immediately rather than left to the
  // 3-second poll: a diff still showing a hunk you just reverted is exactly the kind of
  // lie that stops people trusting the panel.
  const applyHunk = useCallback(async (hunk: DiffHunk, reverse: boolean) => {
    if (!root) return { ok: false, error: 'No repository' }
    try {
      const res = await window.termpolis.gitApplyPatch(root, hunk.patch, reverse)
      if (!res.success) return { ok: false, error: res.error ?? 'git apply refused the patch' }
      if (openFile) await openDiff(openFile.file, openFile.mode)
      await refresh()
      return { ok: true }
    } catch (e: any) {
      return { ok: false, error: e?.message ?? 'git apply refused the patch' }
    }
  }, [root, openFile, openDiff, refresh])

  const toggle = (key: string) => setCollapsed(p => ({ ...p, [key]: !p[key] }))

  const total = useMemo(
    () => (changes ? changes.staged.length + changes.unstaged.length + changes.untracked.length : 0),
    [changes],
  )

  const section = (key: string, title: string, entries: ChangeEntry[], mode: ChangeMode) => {
    if (entries.length === 0) return null
    const isCollapsed = collapsed[key]
    return (
      <div>
        <button
          className="flex items-center gap-1.5 w-full px-3 py-1.5 hover:bg-[#2a2d2e] cursor-pointer text-left"
          onClick={() => toggle(key)}
          data-testid={`changes-section-${key}`}
        >
          <i className={`fa-solid fa-chevron-${isCollapsed ? 'right' : 'down'} text-[8px] text-[#888]`}></i>
          <span className="text-[11px] font-semibold uppercase tracking-wider text-[#bbb]">{title}</span>
          <span className="text-[10px] text-[#999] ml-auto">{entries.length}</span>
        </button>
        {!isCollapsed && (
          <div className="pb-1">
            {entries.map(entry => {
              const { dir, base } = splitPath(entry.file)
              return (
                <button
                  key={`${mode}:${entry.file}`}
                  onClick={() => openDiff(entry.file, mode)}
                  data-testid={`change-row-${entry.file}`}
                  title={`${statusLabel(entry.status)} — ${entry.oldFile ? `${entry.oldFile} → ` : ''}${entry.file}`}
                  className="flex items-center gap-1.5 w-full px-3 py-0.5 hover:bg-[#2a2d2e] text-left cursor-pointer"
                >
                  <span
                    className="w-4 flex-shrink-0 font-mono text-[11px] font-bold text-center"
                    style={{ color: statusColor(entry.status) }}
                  >
                    {entry.status}
                  </span>
                  <span className="truncate flex-1 text-[12px] min-w-0">
                    {dir && <span className="text-[#777]">{dir}</span>}
                    <span className="text-[#ccc]">{base}</span>
                  </span>
                  {entry.binary ? (
                    <span className="text-[10px] text-[#777] flex-shrink-0">bin</span>
                  ) : (entry.added > 0 || entry.removed > 0) ? (
                    <span className="text-[10px] font-mono flex-shrink-0">
                      {entry.added > 0 && <span className="text-[#98c379]">+{entry.added}</span>}
                      {entry.added > 0 && entry.removed > 0 && ' '}
                      {entry.removed > 0 && <span className="text-[#e06c75]">−{entry.removed}</span>}
                    </span>
                  ) : null}
                </button>
              )
            })}
          </div>
        )}
      </div>
    )
  }

  return (
    <div
      className="flex flex-col h-full border-l border-[#3c3c3c] bg-[#252526] select-none"
      style={{ width: 280, minWidth: 280, maxWidth: 280 }}
      data-testid="changes-panel"
    >
      <div className="flex items-center justify-between px-3 py-2 border-b border-[#3c3c3c]">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-[#888]">
          Changes{total > 0 ? ` (${total})` : ''}
        </span>
        <button
          className="text-[#888] hover:text-[#d4d4d4] text-xs cursor-pointer"
          onClick={onClose}
          aria-label="Close changes panel"
          title="Close panel (Ctrl+Shift+J)"
        >
          <i className="fa-solid fa-xmark"></i>
        </button>
      </div>

      {root && (
        <div className="flex items-center gap-1.5 px-3 py-1 border-b border-[#3c3c3c] text-[11px] text-[#888]">
          <i className="fa-solid fa-code-branch text-[#61afef] text-[9px]"></i>
          <span className="truncate flex-1 min-w-0" title={root}>{changes?.branch || '—'}</span>
          {/* Unpushed commits are outstanding work that shows up nowhere else in the
              UI — the same reason the sidebar dot counts `ahead` as dirty. */}
          {!!changes?.ahead && (
            <span className="flex-shrink-0 text-[#e5c07b]" title={`${changes.ahead} commit(s) to push`}>
              ↑{changes.ahead}
            </span>
          )}
          {!!changes?.behind && (
            <span className="flex-shrink-0 text-[#61afef]" title={`${changes.behind} commit(s) to pull`}>
              ↓{changes.behind}
            </span>
          )}
        </div>
      )}

      <div className="flex-1 overflow-y-auto text-[12px]">
        {detecting && <div className="px-3 py-3 text-[#888] italic text-[11px]">Looking for a repository…</div>}
        {!detecting && !root && (
          <div className="px-3 py-3 text-[#888] italic text-[11px]" data-testid="changes-no-repo">
            The active terminal is not inside a git repository.
          </div>
        )}
        {!detecting && root && error && (
          <div className="px-3 py-3 text-[#e06c75] text-[11px]" data-testid="changes-error">{error}</div>
        )}
        {!detecting && root && !error && total === 0 && (
          <div className="px-3 py-3 text-[#888] italic text-[11px]" data-testid="changes-clean">
            Nothing changed — the working tree is clean.
          </div>
        )}
        {!detecting && root && !error && changes && (
          <>
            {section('staged', 'Staged', changes.staged, 'staged')}
            {section('unstaged', 'Changes', changes.unstaged, 'unstaged')}
            {section('untracked', 'Untracked', changes.untracked, 'untracked')}
          </>
        )}
      </div>

      {openFile && (
        <FileDiffModal
          file={openFile.file}
          diff={diff}
          loading={diffLoading}
          error={diffError}
          mode={openFile.mode}
          terminalId={terminalId}
          coverage={coverage}
          onApplyHunk={applyHunk}
          onClose={() => setOpenFile(null)}
        />
      )}
    </div>
  )
}
