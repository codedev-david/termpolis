// Parsing for the Changes rail and the per-terminal git dot.
//
// Deliberately NOT folded into `git:status-parsed`. That handler splits porcelain output
// on newlines and does `line.slice(3).trim()`, which silently loses a rename's old path
// and mangles any filename with a trailing space — and four suites pin its exact shape,
// so it cannot be fixed in place. Everything here reads the `-z` (NUL-terminated) forms
// instead, where those two cases are representable.
//
// Kept out of index.ts so it is testable as plain functions: no Electron, no ipcMain, no
// spawning git. The handlers in index.ts do nothing but run git and hand the bytes here.

import { resolve as pathResolve, sep } from 'path'

export type ChangeMode = 'staged' | 'unstaged' | 'untracked'

export interface ChangeEntry {
  file: string
  /** Pre-rename path, present only on an R/C entry. */
  oldFile?: string
  /** Porcelain shorthand: M, A, D, R, C, T, U (unmerged) or ?? (untracked). */
  status: string
  added: number
  removed: number
  binary: boolean
}

export interface ChangesResult {
  branch: string
  /** Commits on HEAD that the upstream does not have — i.e. "needs pushing". */
  ahead: number
  behind: number
  staged: ChangeEntry[]
  unstaged: ChangeEntry[]
  untracked: ChangeEntry[]
}

export interface ChangeCounts {
  branch: string
  ahead: number
  behind: number
  staged: number
  unstaged: number
  untracked: number
  conflicted: number
}

interface NumStat {
  added: number
  removed: number
  binary: boolean
}

export interface StatusRecord {
  x: string
  y: string
  file: string
  oldFile?: string
}

/** Split a NUL-terminated git record stream, dropping the trailing empty field. */
export function zsplit(out: string): string[] {
  const parts = out.split('\0')
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop()
  return parts
}

const AHEAD_RE = /\bahead (\d+)/
const BEHIND_RE = /\bbehind (\d+)/
const NO_COMMITS = 'No commits yet on '

/**
 * Parse the `-b` header record: `## main...origin/main [ahead 1, behind 2]`.
 *
 * Also handles `## main` (no upstream configured — ahead/behind are then 0, which is
 * right: with nowhere to push to, "needs pushing" is not a state the repo can be in)
 * and `## No commits yet on main` (a fresh `git init`).
 */
export function parseBranchHeader(rec: string): { branch: string; ahead: number; behind: number } {
  const body = rec.slice(3)
  const bracket = body.indexOf(' [')
  const head = bracket >= 0 ? body.slice(0, bracket) : body
  const tail = bracket >= 0 ? body.slice(bracket) : ''
  const dots = head.indexOf('...')
  let branch = dots >= 0 ? head.slice(0, dots) : head
  if (branch.startsWith(NO_COMMITS)) branch = branch.slice(NO_COMMITS.length)
  const a = AHEAD_RE.exec(tail)
  const b = BEHIND_RE.exec(tail)
  return { branch, ahead: a ? parseInt(a[1], 10) : 0, behind: b ? parseInt(b[1], 10) : 0 }
}

/**
 * Parse `git diff --numstat -z` into file → line counts.
 *
 * Normal record is `12\t3\tpath`. A binary file is `-\t-\tpath`. A RENAME is the trap:
 * numstat emits `12\t3\t` with an EMPTY path field, then the old and new paths as their
 * own two records — so the cursor advances by three, not one, and the NEW path (the
 * second of the pair) is the one `git status` will also report.
 */
export function parseNumstatZ(out: string): Map<string, NumStat> {
  const map = new Map<string, NumStat>()
  const recs = zsplit(out)
  for (let i = 0; i < recs.length; i++) {
    const rec = recs[i]
    const t1 = rec.indexOf('\t')
    const t2 = t1 < 0 ? -1 : rec.indexOf('\t', t1 + 1)
    if (t2 < 0) continue
    const addRaw = rec.slice(0, t1)
    const delRaw = rec.slice(t1 + 1, t2)
    let file = rec.slice(t2 + 1)
    if (file === '') {
      file = recs[i + 2] ?? ''
      i += 2
    }
    const binary = addRaw === '-' || delRaw === '-'
    map.set(file, {
      added: binary ? 0 : parseInt(addRaw, 10) || 0,
      removed: binary ? 0 : parseInt(delRaw, 10) || 0,
      binary,
    })
  }
  return map
}

/**
 * Parse `git status --porcelain -b -z`.
 *
 * Never trims the path: under `-z` git emits the filename raw and unquoted, so a name
 * that genuinely ends in a space survives — trimming it would produce a path that fails
 * to open when the row is clicked.
 */
export function parseStatusZ(out: string): {
  branch: string
  ahead: number
  behind: number
  records: StatusRecord[]
} {
  const recs = zsplit(out)
  let branch = ''
  let ahead = 0
  let behind = 0
  let i = 0
  if (recs.length > 0 && recs[0].startsWith('## ')) {
    const h = parseBranchHeader(recs[0])
    branch = h.branch
    ahead = h.ahead
    behind = h.behind
    i = 1
  }
  const records: StatusRecord[] = []
  for (; i < recs.length; i++) {
    const rec = recs[i]
    if (rec.length < 4) continue
    const x = rec[0]
    const y = rec[1]
    const file = rec.slice(3)
    if (x === 'R' || x === 'C') {
      records.push({ x, y, file, oldFile: recs[i + 1] ?? '' })
      i++
    } else {
      records.push({ x, y, file })
    }
  }
  return { branch, ahead, behind, records }
}

/** The porcelain shapes that mean "merge conflict", all of which show as U in the rail. */
export function isUnmerged(x: string, y: string): boolean {
  return x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')
}

function entry(file: string, status: string, n: NumStat | undefined, oldFile?: string): ChangeEntry {
  return {
    file,
    ...(oldFile ? { oldFile } : {}),
    status,
    added: n?.added ?? 0,
    removed: n?.removed ?? 0,
    binary: n?.binary ?? false,
  }
}

/**
 * Fold one status stream and the two numstat streams into the rail's three sections.
 *
 * A file can appear in BOTH staged and unstaged (porcelain `MM` — staged one change,
 * then edited again), and that is not a bug to dedupe away: they are two different diffs
 * of the same path, and the rail has to be able to open each.
 */
export function buildChanges(
  statusOut: string,
  unstagedNumstat: string,
  stagedNumstat: string,
): ChangesResult {
  const { branch, ahead, behind, records } = parseStatusZ(statusOut)
  const un = parseNumstatZ(unstagedNumstat)
  const st = parseNumstatZ(stagedNumstat)
  const staged: ChangeEntry[] = []
  const unstaged: ChangeEntry[] = []
  const untracked: ChangeEntry[] = []
  for (const r of records) {
    if (r.x === '?' && r.y === '?') {
      // No line counts: getting them means reading the file off disk, and this runs on a
      // 3-second poll. An untracked file is "all new" anyway.
      untracked.push({ file: r.file, status: '??', added: 0, removed: 0, binary: false })
      continue
    }
    if (isUnmerged(r.x, r.y)) {
      unstaged.push(entry(r.file, 'U', un.get(r.file), r.oldFile))
      continue
    }
    if (r.x !== ' ') staged.push(entry(r.file, r.x, st.get(r.file), r.oldFile))
    if (r.y !== ' ') unstaged.push(entry(r.file, r.y, un.get(r.file), r.oldFile))
  }
  return { branch, ahead, behind, staged, unstaged, untracked }
}

/**
 * The dot's payload: counts only, from the single status spawn.
 *
 * Separate from buildChanges because this runs once per terminal per poll, and the two
 * numstat spawns the rail needs would triple that for information a dot cannot show.
 */
export function countChanges(statusOut: string): ChangeCounts {
  const { branch, ahead, behind, records } = parseStatusZ(statusOut)
  let staged = 0
  let unstaged = 0
  let untracked = 0
  let conflicted = 0
  for (const r of records) {
    if (r.x === '?' && r.y === '?') {
      untracked++
      continue
    }
    if (isUnmerged(r.x, r.y)) {
      conflicted++
      continue
    }
    if (r.x !== ' ') staged++
    if (r.y !== ' ') unstaged++
  }
  return { branch, ahead, behind, staged, unstaged, untracked, conflicted }
}

/**
 * Resolve a repo-relative path, refusing anything that escapes the repo.
 *
 * The path arrives from the renderer, so it is untrusted even though every legitimate
 * value came from git itself one poll earlier.
 */
export function resolveInsideRepo(root: string, file: string): string | null {
  const base = pathResolve(root)
  const target = pathResolve(base, file)
  const prefix = base.endsWith(sep) ? base : base + sep
  if (target !== base && !target.startsWith(prefix)) return null
  return target
}

/** Above this, an untracked file is shown as binary rather than rendered line by line. */
export const UNTRACKED_MAX_BYTES = 2 * 1024 * 1024

/**
 * Build a unified diff for an untracked file, which git itself will not diff.
 *
 * `git diff --no-index /dev/null <file>` is the obvious move and the wrong one: it exits
 * 1 whenever the files differ — i.e. always, here — so execFile rejects on every success,
 * and `/dev/null` is not a path on Windows. Synthesising the diff is both portable and
 * one file read instead of a process spawn.
 */
export function synthesizeUntrackedDiff(file: string, bytes: Buffer): string {
  const header = `diff --git a/${file} b/${file}\nnew file mode 100644\n`
  if (bytes.length > UNTRACKED_MAX_BYTES || bytes.includes(0)) {
    return `${header}Binary files /dev/null and b/${file} differ\n`
  }
  const preamble = `${header}--- /dev/null\n+++ b/${file}\n`
  const text = bytes.toString('utf8')
  if (text === '') return preamble
  const lines = text.split('\n')
  // A trailing newline leaves a final '' that is not a line; its absence is a real thing
  // git annotates, so say so rather than inventing a newline the file does not have.
  const endsWithNewline = lines[lines.length - 1] === ''
  if (endsWithNewline) lines.pop()
  const body = lines.map(l => `+${l}`).join('\n')
  const marker = endsWithNewline ? '' : '\\ No newline at end of file\n'
  return `${preamble}@@ -0,0 +1,${lines.length} @@\n${body}\n${marker}`
}
