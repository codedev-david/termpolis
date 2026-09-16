// The diff window the Changes rail opens when you click a file.
//
// Built on the SAME parseUnifiedDiff the Swarm Review panel uses, rather than the
// naive line-coloured <pre> GitPanel renders — so this gets real hunk structure and
// real line numbers, and a rename or a binary file reads as what it is instead of as
// a wall of green.
//
// It is no longer purely a viewer: each hunk carries a menu with Revert, Explain and
// Discuss. Revert is the only one that touches the repo, and it is deliberately
// restricted to UNSTAGED hunks — see the comment on `revertBlocker` for why the other
// two modes are refused rather than best-guessed.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { parseUnifiedDiff, type DiffFile, type DiffHunk } from '../../lib/diffParser'
import { HunkMenu, type HunkMenuItem } from './HunkMenu'

/** A diff large enough to lock the renderer is not a diff anyone reads line by line. */
export const MAX_DIFF_CHARS = 200_000
export const MAX_DIFF_LINES = 1_500

/** How long the "Reverted — Undo" affordance stays up before it fades. */
export const UNDO_WINDOW_MS = 10_000

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/

export type LineKind = 'add' | 'del' | 'ctx' | 'hunk' | 'meta'

export type DiffMode = 'staged' | 'unstaged' | 'untracked' | 'commit'

export interface RenderLine {
  kind: LineKind
  text: string
  /** Line number in the OLD file, or null for added / structural lines. */
  oldNo: number | null
  /** Line number in the NEW file, or null for removed / structural lines. */
  newNo: number | null
  /**
   * Id of the hunk this line belongs to (`DiffHunk.id`), or null for the file-level
   * meta lines that belong to no hunk. Stamping the id onto every line is what lets
   * the flat render loop stay flat: the menu finds its hunk by id rather than the
   * lines needing to be re-nested into groups.
   */
  hunkId: string | null
}

/**
 * Flatten parsed diff files into numbered, renderable lines.
 *
 * parseUnifiedDiff keeps each hunk's body verbatim (it has to — the same string is fed
 * back to `git apply` elsewhere), so the old/new counters are re-derived here from the
 * `@@` header rather than tracked during parsing.
 */
export function buildLines(files: DiffFile[]): RenderLine[] {
  const out: RenderLine[] = []
  for (const f of files) {
    if (f.binary) {
      out.push({ kind: 'meta', text: 'Binary file — no textual diff', oldNo: null, newNo: null, hunkId: null })
      continue
    }
    if (f.hunks.length === 0) {
      // A pure rename or mode change: real, but with nothing to show line by line.
      out.push({ kind: 'meta', text: 'No textual changes', oldNo: null, newNo: null, hunkId: null })
      continue
    }
    for (const h of f.hunks) {
      const hunkId = h.id
      out.push({ kind: 'hunk', text: h.header, oldNo: null, newNo: null, hunkId })
      const m = HUNK_RE.exec(h.header)
      let oldNo = m ? parseInt(m[1], 10) : 0
      let newNo = m ? parseInt(m[2], 10) : 0
      // body[0] is the @@ header itself; the parser prepends it.
      const body = h.body.split('\n').slice(1)
      // The raw diff ends in a newline, so the final hunk's body carries a trailing ''.
      // A genuinely blank CONTEXT line is ' ' (a space), never '', so this is safe.
      while (body.length > 0 && body[body.length - 1] === '') body.pop()
      for (const line of body) {
        if (line.startsWith('\\')) {
          out.push({ kind: 'meta', text: line, oldNo: null, newNo: null, hunkId })
        } else if (line.startsWith('+')) {
          out.push({ kind: 'add', text: line.slice(1), oldNo: null, newNo: newNo++, hunkId })
        } else if (line.startsWith('-')) {
          out.push({ kind: 'del', text: line.slice(1), oldNo: oldNo++, newNo: null, hunkId })
        } else {
          out.push({ kind: 'ctx', text: line.startsWith(' ') ? line.slice(1) : line, oldNo: oldNo++, newNo: newNo++, hunkId })
        }
      }
    }
  }
  return out
}

export interface HunkCoverage {
  covered: number
  total: number
  pct: number
}

/**
 * Coverage over the lines a hunk ADDS.
 *
 * Only lines lcov actually recorded count. A line absent from the map is not
 * uncovered — it is not executable at all (a blank line, a comment, a closing brace),
 * and counting those would report a docstring-only change as 0% tested. When a hunk
 * adds no executable lines the answer is null, meaning "show nothing", never "0%".
 */
export function hunkCoverage(
  lines: Record<number, number> | null | undefined,
  addedLineNos: number[],
): HunkCoverage | null {
  if (!lines) return null
  let covered = 0
  let total = 0
  for (const n of addedLineNos) {
    const hits = lines[n]
    if (hits === undefined) continue
    total++
    if (hits > 0) covered++
  }
  if (total === 0) return null
  return { covered, total, pct: Math.round((covered / total) * 100) }
}

/** Green at or above this, amber above `COVERAGE_LOW`, red below it. */
export const COVERAGE_GOOD = 80
export const COVERAGE_LOW = 50

export function coverageColor(pct: number): string {
  if (pct >= COVERAGE_GOOD) return '#98c379'
  if (pct >= COVERAGE_LOW) return '#e5c07b'
  return '#e06c75'
}

// Bracketed-paste markers, so a multi-line hunk lands in the agent as ONE paste.
// Without them every newline in the block reads as Enter and the agent answers the
// first line of the diff. Same idiom as PastAISessions.tsx and Memory.tsx.
const BP_START = '\x1b[200~'
const BP_END = '\x1b[201~'

export function wrapAsBracketedPaste(text: string): string {
  return BP_START + text.replace(/\r?\n/g, '\r') + BP_END
}

/**
 * The prompt sent into the terminal for Explain / Discuss.
 *
 * The hunk goes in verbatim, diff markers and all, inside a ```diff fence: an agent
 * reading `-old` / `+new` learns what CHANGED, which stripped code cannot convey.
 */
export function buildHunkPrompt(kind: 'explain' | 'discuss', file: string, hunk: DiffHunk): string {
  const intro =
    kind === 'explain'
      ? `Explain this change to ${file} — what it does, and why it would have been made:`
      : `Let's talk about this change to ${file}:`
  return `${intro}\n\n\`\`\`diff\n${hunk.body}\n\`\`\`\n`
}

const LINE_BG: Record<LineKind, string> = {
  add: 'bg-[#1e3a24]',
  del: 'bg-[#3a1e21]',
  ctx: '',
  hunk: 'bg-[#1d2b3a]',
  meta: '',
}

const LINE_FG: Record<LineKind, string> = {
  add: 'text-[#98c379]',
  del: 'text-[#e06c75]',
  ctx: 'text-[#abb2bf]',
  hunk: 'text-[#61afef]',
  meta: 'text-[#888] italic',
}

const SIGIL: Record<LineKind, string> = { add: '+', del: '-', ctx: ' ', hunk: '', meta: '' }

export interface FileDiffModalProps {
  /** Path shown in the header (post-rename path for a rename). */
  file: string
  /** Raw unified diff. Empty string is a valid, meaningful state. */
  diff: string
  loading?: boolean
  error?: string | null
  onClose: () => void
  /** Which of the three diffs this is. Revert is offered only for 'unstaged'. */
  mode?: DiffMode
  /** Terminal that Explain / Discuss write into. Absent disables both. */
  terminalId?: string | null
  /** Executable line → hit count for this file, plus whether it predates the file. */
  coverage?: { lines: Record<number, number>; stale: boolean } | null
  /**
   * Apply one hunk's patch, reversed to revert or forward to undo that revert.
   * Absent disables Revert.
   */
  onApplyHunk?: (hunk: DiffHunk, reverse: boolean) => Promise<{ ok: boolean; error?: string }>
}

export function FileDiffModal({
  file,
  diff,
  loading = false,
  error = null,
  onClose,
  mode = 'unstaged',
  terminalId = null,
  coverage = null,
  onApplyHunk,
}: FileDiffModalProps) {
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  const [menu, setMenu] = useState<{ x: number; y: number; hunkId: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [undo, setUndo] = useState<DiffHunk | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        closeRef.current()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // A pending undo timer outlives the modal otherwise, and fires setState on a
  // component nobody is looking at any more.
  useEffect(() => () => {
    if (undoTimer.current) clearTimeout(undoTimer.current)
  }, [])

  const { lines, hunksById, addedByHunk, truncated, added, removed } = useMemo(() => {
    // Cap on BYTES before parsing: the parser walks every line, so a 40 MB generated
    // file would be paid for in full before any line cap could help.
    const oversizeByChars = diff.length > MAX_DIFF_CHARS
    const raw = oversizeByChars ? diff.slice(0, MAX_DIFF_CHARS) : diff
    const parsed = parseUnifiedDiff(raw)
    const all = buildLines(parsed)
    const byId = new Map<string, DiffHunk>()
    for (const f of parsed) for (const h of f.hunks) byId.set(h.id, h)
    const addedNos = new Map<string, number[]>()
    let a = 0
    let r = 0
    for (const l of all) {
      if (l.kind === 'add') {
        a++
        if (l.hunkId && l.newNo !== null) {
          const arr = addedNos.get(l.hunkId)
          if (arr) arr.push(l.newNo)
          else addedNos.set(l.hunkId, [l.newNo])
        }
      } else if (l.kind === 'del') r++
    }
    const oversizeByLines = all.length > MAX_DIFF_LINES
    return {
      lines: oversizeByLines ? all.slice(0, MAX_DIFF_LINES) : all,
      hunksById: byId,
      addedByHunk: addedNos,
      truncated: oversizeByChars || oversizeByLines,
      added: a,
      removed: r,
    }
  }, [diff])

  const copy = () => {
    try {
      navigator.clipboard?.writeText(diff)
    } catch {
      /* clipboard denied — copying a diff is a convenience, never a failure path */
    }
  }

  const sendToTerminal = useCallback((kind: 'explain' | 'discuss', hunk: DiffHunk) => {
    if (!terminalId) return
    const write = window.termpolis?.writeToTerminal
    if (typeof write !== 'function') return
    write(terminalId, wrapAsBracketedPaste(buildHunkPrompt(kind, file, hunk)))
    // Explain is a complete question, so it is sent. Discuss deliberately is NOT:
    // it stages the block so you can type what you actually want to say about it.
    if (kind === 'explain') write(terminalId, '\r')
    closeRef.current()
  }, [file, terminalId])

  const applyHunk = useCallback(async (hunk: DiffHunk, reverse: boolean) => {
    if (!onApplyHunk) return
    setBusy(true)
    setActionError(null)
    try {
      const res = await onApplyHunk(hunk, reverse)
      if (!res.ok) {
        setActionError(res.error ?? (reverse ? 'Could not revert that hunk' : 'Could not undo that revert'))
        return
      }
      if (undoTimer.current) clearTimeout(undoTimer.current)
      if (reverse) {
        setUndo(hunk)
        undoTimer.current = setTimeout(() => setUndo(null), UNDO_WINDOW_MS)
      } else {
        setUndo(null)
      }
    } catch (e: any) {
      setActionError(e?.message ?? 'Could not apply that change')
    } finally {
      setBusy(false)
    }
  }, [onApplyHunk])

  /**
   * Why Revert refuses the other two modes rather than guessing.
   *
   * The patch `git apply -R` would receive describes the diff it came from. For an
   * unstaged hunk that is worktree-vs-index, which is exactly what reverting should
   * undo. A STAGED hunk's patch is index-vs-HEAD: reverse-applying it to the worktree
   * would clobber edits made since staging. An UNTRACKED file's diff is synthesised
   * against /dev/null, so reversing it deletes a file git has no copy of — the one
   * action here that cannot be undone by anything.
   */
  const revertBlocker =
    !onApplyHunk
      ? 'Reverting is unavailable here'
      : mode === 'staged'
        ? 'Unstage this file first — reverting a staged hunk would discard newer edits'
        : mode === 'untracked'
          ? 'This file is untracked, so git has no copy to restore it from'
          : mode === 'commit'
            ? 'This hunk is already committed — undo it with git revert, not by editing the worktree'
            : null

  const items: HunkMenuItem[] = useMemo(() => {
    const hunk = menu ? hunksById.get(menu.hunkId) : undefined
    if (!hunk) return []
    const noTerminal = terminalId ? undefined : 'No terminal is attached to this panel'
    return [
      {
        key: 'explain',
        label: 'Explain this hunk',
        icon: 'fa-lightbulb',
        disabled: !terminalId,
        title: noTerminal,
        onSelect: () => sendToTerminal('explain', hunk),
      },
      {
        key: 'discuss',
        label: 'Discuss this hunk',
        icon: 'fa-comments',
        disabled: !terminalId,
        title: noTerminal ?? 'Pastes the hunk into the terminal without sending it',
        onSelect: () => sendToTerminal('discuss', hunk),
      },
      {
        key: 'revert',
        label: 'Revert this hunk',
        icon: 'fa-rotate-left',
        danger: true,
        disabled: !!revertBlocker || busy,
        title: revertBlocker ?? 'Reverse-applies just this hunk',
        onSelect: () => { void applyHunk(hunk, true) },
      },
    ]
  }, [menu, hunksById, terminalId, revertBlocker, busy, sendToTerminal, applyHunk])

  const openMenuAt = (e: React.MouseEvent, hunkId: string | null) => {
    if (!hunkId) return
    e.preventDefault()
    e.stopPropagation()
    setMenu({ x: e.clientX, y: e.clientY, hunkId })
  }

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60"
      onClick={onClose}
      data-testid="file-diff-backdrop"
    >
      <div
        role="dialog"
        aria-label={`Diff for ${file}`}
        data-testid="file-diff-modal"
        className="w-[900px] max-w-[92vw] max-h-[85vh] flex flex-col rounded border border-[#3c3c3c] bg-[#1e1e1e] shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-4 py-2.5 border-b border-[#3c3c3c]">
          <i className="fa-solid fa-code-compare text-[#61afef] text-xs"></i>
          <span className="text-[13px] text-[#d4d4d4] truncate flex-1" title={file}>{file}</span>
          {!loading && !error && (
            <span className="text-[11px] font-mono flex-shrink-0">
              <span className="text-[#98c379]">+{added}</span>
              {' '}
              <span className="text-[#e06c75]">−{removed}</span>
            </span>
          )}
          <button
            onClick={copy}
            title="Copy diff"
            className="text-[#888] hover:text-[#d4d4d4] text-xs px-1.5 py-1 rounded hover:bg-[#37373d]"
          ><i className="fa-solid fa-copy"></i></button>
          <button
            onClick={onClose}
            title="Close (Esc)"
            aria-label="Close diff"
            className="text-[#888] hover:text-[#d4d4d4] text-xs px-1.5 py-1 rounded hover:bg-[#37373d]"
          ><i className="fa-solid fa-xmark"></i></button>
        </div>

        {(undo || actionError) && (
          <div
            className="flex items-center gap-2 px-4 py-1.5 border-b border-[#3c3c3c] text-[11px]"
            data-testid="file-diff-action-bar"
          >
            {actionError ? (
              <span className="text-[#e06c75]" data-testid="file-diff-action-error">{actionError}</span>
            ) : (
              <>
                <span className="text-[#98c379]">Hunk reverted.</span>
                <button
                  onClick={() => { if (undo) void applyHunk(undo, false) }}
                  disabled={busy}
                  data-testid="file-diff-undo"
                  className="text-[#61afef] hover:underline disabled:text-[#5a5f6a]"
                >Undo</button>
              </>
            )}
          </div>
        )}

        <div className="flex-1 overflow-auto font-mono text-[12px] leading-[1.5]">
          {loading && <div className="px-4 py-6 text-[#888] text-center">Loading diff…</div>}
          {!loading && error && (
            <div className="px-4 py-6 text-[#e06c75] text-center" data-testid="file-diff-error">{error}</div>
          )}
          {!loading && !error && lines.length === 0 && (
            <div className="px-4 py-6 text-[#888] text-center italic" data-testid="file-diff-empty">
              No changes to show for this file.
            </div>
          )}
          {!loading && !error && lines.map((l, i) => {
            if (l.kind === 'hunk') {
              const cov = hunkCoverage(coverage?.lines, l.hunkId ? addedByHunk.get(l.hunkId) ?? [] : [])
              return (
                <div
                  key={i}
                  className={`flex items-center ${LINE_BG.hunk}`}
                  onContextMenu={e => openMenuAt(e, l.hunkId)}
                  data-testid={`diff-hunk-header-${l.hunkId}`}
                >
                  <span className={`flex-1 truncate pl-[5.25rem] pr-2 ${LINE_FG.hunk}`}>{l.text}</span>
                  {cov && (
                    <span
                      data-testid={`hunk-coverage-${l.hunkId}`}
                      title={
                        coverage?.stale
                          ? 'Coverage data is older than this file — re-run the tests'
                          : `${cov.covered} of ${cov.total} added executable lines are covered by tests`
                      }
                      className="flex-shrink-0 text-[10px] px-1.5 mr-1 rounded"
                      style={{ color: coverage?.stale ? '#5a5f6a' : coverageColor(cov.pct) }}
                    >
                      {coverage?.stale ? '— tested' : `${cov.pct}% tested`}
                    </span>
                  )}
                  <button
                    onClick={e => openMenuAt(e, l.hunkId)}
                    aria-label={`Actions for hunk ${l.text}`}
                    title="Hunk actions"
                    data-testid={`hunk-menu-button-${l.hunkId}`}
                    className="flex-shrink-0 px-2 text-[#61afef] hover:text-[#d4d4d4]"
                  ><i className="fa-solid fa-ellipsis"></i></button>
                </div>
              )
            }
            return (
              <div
                key={i}
                className={`flex ${LINE_BG[l.kind]}`}
                onContextMenu={e => openMenuAt(e, l.hunkId)}
              >
                <span className="w-10 flex-shrink-0 text-right pr-2 text-[#5c6370] select-none">
                  {l.oldNo ?? ''}
                </span>
                <span className="w-10 flex-shrink-0 text-right pr-2 text-[#5c6370] select-none">
                  {l.newNo ?? ''}
                </span>
                <span className={`w-3 flex-shrink-0 select-none ${LINE_FG[l.kind]}`}>{SIGIL[l.kind]}</span>
                <span className={`whitespace-pre-wrap break-all pr-3 ${LINE_FG[l.kind]}`}>{l.text}</span>
              </div>
            )
          })}
          {truncated && (
            <div className="px-4 py-3 text-[#e5c07b] text-center" data-testid="file-diff-truncated">
              Diff truncated — open the file to see the rest.
            </div>
          )}
        </div>
      </div>

      {menu && items.length > 0 && (
        <HunkMenu x={menu.x} y={menu.y} items={items} onClose={() => setMenu(null)} />
      )}
    </div>
  )
}
