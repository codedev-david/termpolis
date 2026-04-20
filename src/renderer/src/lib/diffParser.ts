// Unified-diff parser for Swarm Review. Splits a multi-file diff into file
// blocks and individual hunks so each hunk can be rendered with its own
// accept/reject/fix controls. The raw hunk patch text is preserved verbatim
// so it can be fed back to `git apply` (with or without --reverse) to
// un-apply a single change without touching siblings.

export interface DiffHunk {
  /** Unique key within the diff (file + hunk index). */
  id: string
  /** File this hunk belongs to. */
  file: string
  /** `@@ -a,b +c,d @@ ctx` header verbatim. */
  header: string
  /** Raw hunk lines including the header + each ' ' / '+' / '-' line. */
  body: string
  /** Self-contained patch string ready to feed to `git apply`. Includes the
   *  file-level `diff --git`, `---`/`+++`, and just this one hunk. */
  patch: string
  /** Count of added lines (+). */
  added: number
  /** Count of removed lines (-). */
  removed: number
  /** Starting line number in the new file. */
  startLine: number
}

export interface DiffFile {
  /** Path of the file (post-rename if renamed). */
  file: string
  /** Original path in case of rename, else same as file. */
  oldFile: string
  /** Git status: 'A' (added), 'M' (modified), 'D' (deleted), 'R' (renamed). */
  status: 'A' | 'M' | 'D' | 'R' | '?'
  /** Preamble lines before the first hunk (diff --git, index, ---, +++, etc). */
  preamble: string
  /** Parsed hunks. */
  hunks: DiffHunk[]
  /** Total added across all hunks. */
  added: number
  /** Total removed across all hunks. */
  removed: number
  /** True when the file is a binary patch (no hunks to review). */
  binary: boolean
}

const DIFF_HEADER_RE = /^diff --git a\/(.+?) b\/(.+)$/
const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/

/**
 * Parse a multi-file unified diff.
 *
 * Tolerant of common variants:
 *   - `diff --git` headers (standard git output)
 *   - Missing final newline markers ("\ No newline at end of file")
 *   - Binary patch markers
 *   - Renames / pure mode changes with no hunks
 */
export function parseUnifiedDiff(raw: string): DiffFile[] {
  if (!raw) return []
  const lines = raw.split('\n')
  const files: DiffFile[] = []
  let current: DiffFile | null = null
  let hunk: { header: string; body: string[]; added: number; removed: number; startLine: number } | null = null

  const flushHunk = () => {
    if (!current || !hunk) return
    const body = hunk.header + '\n' + hunk.body.join('\n')
    const patch = current.preamble + (current.preamble.endsWith('\n') ? '' : '\n') + body + (body.endsWith('\n') ? '' : '\n')
    current.hunks.push({
      id: `${current.file}::${current.hunks.length}`,
      file: current.file,
      header: hunk.header,
      body,
      patch,
      added: hunk.added,
      removed: hunk.removed,
      startLine: hunk.startLine,
    })
    current.added += hunk.added
    current.removed += hunk.removed
    hunk = null
  }

  for (const line of lines) {
    const m = DIFF_HEADER_RE.exec(line)
    if (m) {
      flushHunk()
      current = {
        file: m[2],
        oldFile: m[1],
        status: m[1] === m[2] ? 'M' : 'R',
        preamble: line,
        hunks: [],
        added: 0,
        removed: 0,
        binary: false,
      }
      files.push(current)
      continue
    }
    if (!current) continue // ignore lines before first diff header

    if (line.startsWith('@@')) {
      flushHunk()
      const hm = HUNK_RE.exec(line)
      hunk = {
        header: line,
        body: [],
        added: 0,
        removed: 0,
        startLine: hm ? parseInt(hm[2], 10) : 0,
      }
      continue
    }

    if (hunk) {
      // Hunk body: +, -, space, or "\ No newline" marker
      hunk.body.push(line)
      if (line.startsWith('+') && !line.startsWith('+++')) hunk.added++
      else if (line.startsWith('-') && !line.startsWith('---')) hunk.removed++
      continue
    }

    // Preamble lines (before first hunk): accumulate, detect status
    current.preamble += '\n' + line
    if (line.startsWith('new file')) current.status = 'A'
    else if (line.startsWith('deleted file')) current.status = 'D'
    else if (line.startsWith('Binary files')) current.binary = true
    else if (line.startsWith('rename from') || line.startsWith('rename to')) current.status = 'R'
  }
  flushHunk()

  return files
}

/**
 * Produce a stat summary across a diff.
 */
export function diffStat(files: DiffFile[]): { files: number; added: number; removed: number; hunks: number } {
  let added = 0
  let removed = 0
  let hunks = 0
  for (const f of files) {
    added += f.added
    removed += f.removed
    hunks += f.hunks.length
  }
  return { files: files.length, added, removed, hunks }
}

/**
 * Given a single hunk, produce a tiny patch that `git apply -R` can consume to
 * undo just that hunk. Returns the pre-built patch from the parser.
 */
export function hunkPatch(hunk: DiffHunk): string {
  return hunk.patch
}
