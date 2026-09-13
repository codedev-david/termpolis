// The diff window the Changes rail opens when you click a file.
//
// Built on the SAME parseUnifiedDiff the Swarm Review panel uses, rather than the
// naive line-coloured <pre> GitPanel renders — so this gets real hunk structure and
// real line numbers, and a rename or a binary file reads as what it is instead of as
// a wall of green. Nothing here mutates the repo: it is a viewer, so there are no
// stage/discard controls to mis-click.

import { useEffect, useMemo, useRef } from 'react'
import { parseUnifiedDiff, type DiffFile } from '../../lib/diffParser'

/** A diff large enough to lock the renderer is not a diff anyone reads line by line. */
export const MAX_DIFF_CHARS = 200_000
export const MAX_DIFF_LINES = 1_500

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/

export type LineKind = 'add' | 'del' | 'ctx' | 'hunk' | 'meta'

export interface RenderLine {
  kind: LineKind
  text: string
  /** Line number in the OLD file, or null for added / structural lines. */
  oldNo: number | null
  /** Line number in the NEW file, or null for removed / structural lines. */
  newNo: number | null
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
      out.push({ kind: 'meta', text: 'Binary file — no textual diff', oldNo: null, newNo: null })
      continue
    }
    if (f.hunks.length === 0) {
      // A pure rename or mode change: real, but with nothing to show line by line.
      out.push({ kind: 'meta', text: 'No textual changes', oldNo: null, newNo: null })
      continue
    }
    for (const h of f.hunks) {
      out.push({ kind: 'hunk', text: h.header, oldNo: null, newNo: null })
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
          out.push({ kind: 'meta', text: line, oldNo: null, newNo: null })
        } else if (line.startsWith('+')) {
          out.push({ kind: 'add', text: line.slice(1), oldNo: null, newNo: newNo++ })
        } else if (line.startsWith('-')) {
          out.push({ kind: 'del', text: line.slice(1), oldNo: oldNo++, newNo: null })
        } else {
          out.push({ kind: 'ctx', text: line.startsWith(' ') ? line.slice(1) : line, oldNo: oldNo++, newNo: newNo++ })
        }
      }
    }
  }
  return out
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
}

export function FileDiffModal({ file, diff, loading = false, error = null, onClose }: FileDiffModalProps) {
  const closeRef = useRef(onClose)
  closeRef.current = onClose

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

  const { lines, truncated, added, removed } = useMemo(() => {
    // Cap on BYTES before parsing: the parser walks every line, so a 40 MB generated
    // file would be paid for in full before any line cap could help.
    const oversizeByChars = diff.length > MAX_DIFF_CHARS
    const raw = oversizeByChars ? diff.slice(0, MAX_DIFF_CHARS) : diff
    const parsed = parseUnifiedDiff(raw)
    const all = buildLines(parsed)
    let a = 0
    let r = 0
    for (const l of all) {
      if (l.kind === 'add') a++
      else if (l.kind === 'del') r++
    }
    const oversizeByLines = all.length > MAX_DIFF_LINES
    return {
      lines: oversizeByLines ? all.slice(0, MAX_DIFF_LINES) : all,
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
          {!loading && !error && lines.map((l, i) => (
            <div key={i} className={`flex ${LINE_BG[l.kind]}`}>
              <span className="w-10 flex-shrink-0 text-right pr-2 text-[#5c6370] select-none">
                {l.oldNo ?? ''}
              </span>
              <span className="w-10 flex-shrink-0 text-right pr-2 text-[#5c6370] select-none">
                {l.newNo ?? ''}
              </span>
              <span className={`w-3 flex-shrink-0 select-none ${LINE_FG[l.kind]}`}>{SIGIL[l.kind]}</span>
              <span className={`whitespace-pre-wrap break-all pr-3 ${LINE_FG[l.kind]}`}>{l.text}</span>
            </div>
          ))}
          {truncated && (
            <div className="px-4 py-3 text-[#e5c07b] text-center" data-testid="file-diff-truncated">
              Diff truncated — open the file to see the rest.
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
