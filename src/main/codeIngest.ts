// Code/repo ingestion — indexes the working repo's git-tracked source into the
// shared memory brain so agents can semantically recall "where/how is X done"
// without re-grepping every session.
//
// Security: we reuse the SAME sensitive-file denylist as the read watcher
// (matchSensitiveFile) so .env / keys / cloud creds are NEVER embedded — the
// indexer's skip-list is your security posture, not a separate guess. Binaries,
// minified bundles, and oversized files are skipped too. Using `git ls-files`
// means node_modules/dist/out are excluded for free (they're gitignored), and
// a committed dependency folder or virtual environment is dropped by the
// listing too (repoFileList.ts inTrackedSkipPath).

import * as crypto from 'crypto'
import { promises as fsp, type Stats } from 'fs'
import { normalizeNewlines } from './lineEndings'
import { join } from 'path'
import { isIndexableCodeFile } from './codeFileFilter'
import { safeGitAsync } from './gitCommand'
import { inSkippedPath, listRepo } from './repoFileList'
import { CASE_FOLDING_PLATFORMS } from './watchGuard'
import { confinedReader, confinedTextReader, isInside } from './world/folderSafety'
import { walkFolder } from './world/folderWalk'
import { readRootIgnore } from './world/rootIgnore'
import { knownHashes } from './conversationIngest' // one membership-resolution rule for both ingesters

export interface CodeChunk {
  text: string
  filePath: string
  startLine: number
  endLine: number
  hash: string
}

export interface CodeIngestStats {
  filesScanned: number
  filesSkipped: number
  chunksWritten: number
  chunksSkipped: number
  truncated: boolean    // maxChunks halted this pass early — backlog remains for the next run
}

// A macrotask yield — see conversationIngest.ts. Embedding runs in-process on
// the main thread, so we hand control back to the event loop between embeds to
// keep IPC/UI responsive during a bulk repo index instead of freezing the app.
const yieldToEventLoop = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve))

const MAX_FILE_BYTES = 256 * 1024

export { isIndexableCodeFile } from './codeFileFilter'

export interface CodeChunkOptions {
  maxLines?: number
  maxFileBytes?: number
}

// Split a file into ~maxLines line-windows, each prefixed with its path + line
// range so retrieval surfaces "where" alongside "what".
export function chunkCode(filePath: string, content: string, opts: CodeChunkOptions = {}): CodeChunk[] {
  const maxLines = opts.maxLines ?? 60
  const maxBytes = opts.maxFileBytes ?? MAX_FILE_BYTES
  if (!content || content.length > maxBytes) return []
  // Normalize CRLF → LF BEFORE splitting, so the chunk body (and therefore its hash) is identical
  // whether this file was read on Windows or Linux. Without this the same repo indexed on two OSes
  // stores every chunk twice. See lineEndings.ts.
  const lines = normalizeNewlines(content).split('\n')
  const chunks: CodeChunk[] = []
  for (let i = 0; i < lines.length; i += maxLines) {
    const body = lines.slice(i, i + maxLines).join('\n').trim()
    if (!body) continue
    const startLine = i + 1
    const endLine = Math.min(i + maxLines, lines.length)
    const text = `${filePath}:${startLine}-${endLine}\n${body}`
    const hash = crypto
      .createHash('sha256')
      .update(`code${filePath}${startLine}${body}`)
      .digest('hex')
    chunks.push({ text, filePath, startLine, endLine, hash })
  }
  return chunks
}

export interface CodeIngestDeps {
  listFiles: () => Promise<string[]>
  readFile: (filePath: string) => Promise<string>
  /** SYNC on purpose — consumed as `if (deps.hasHash(h))`, and a Promise is truthy. With the store
   *  out of process, wire `hasHashes` instead (see conversationIngest.IngestDeps.hasHash). */
  hasHash?: (hash: string) => boolean
  /** v1.26: batched membership, asked once per FILE. Takes precedence over hasHash. */
  hasHashes?: (hashes: string[]) => Promise<string[]> | string[]
  write: (chunk: CodeChunk) => Promise<void>
  /** Wave2 (codeIngest-stale-chunks): remove a file's previously-indexed chunks before
   *  re-writing, so an edited file replaces its chunks instead of accumulating stale ones. */
  prunePath?: (filePath: string) => Promise<void> | void
  chunkOptions?: CodeChunkOptions
  /** Awaited between embeds so a bulk pass can't freeze the UI. Default: a setImmediate macrotask. */
  yield?: () => Promise<void>
  /** Yield after this many writes (default 1 — breathe after every embed). */
  yieldEvery?: number
  /** Stop after writing this many new chunks this pass; sets `truncated` (default: unbounded). */
  maxChunks?: number
}

export async function ingestCode(deps: CodeIngestDeps): Promise<CodeIngestStats> {
  const doYield = deps.yield ?? yieldToEventLoop
  const yieldEvery = Math.max(1, deps.yieldEvery ?? 1)
  const maxChunks = deps.maxChunks ?? Infinity
  const stats: CodeIngestStats = { filesScanned: 0, filesSkipped: 0, chunksWritten: 0, chunksSkipped: 0, truncated: false }
  let sinceYield = 0
  let files: string[]
  try {
    files = await deps.listFiles()
  } catch {
    return stats
  }
  for (const filePath of files) {
    if (!isIndexableCodeFile(filePath)) {
      stats.filesSkipped++
      continue
    }
    let content: string
    try {
      content = await deps.readFile(filePath)
    } catch {
      continue
    }
    stats.filesScanned++
    const fileChunks = chunkCode(filePath, content, deps.chunkOptions)
    const hashes = fileChunks.map((c) => c.hash)
    // Wave2 (codeIngest-stale-chunks): if ANY chunk is new, the file changed (edits shift line
    // numbers → hashes) → prune its stale chunks before re-writing; else it's unchanged, skip.
    let known = await knownHashes(deps, hashes)
    const changed = fileChunks.some((c) => !known.has(c.hash))
    if (!changed) { stats.chunksSkipped += fileChunks.length; continue }
    if (deps.prunePath) {
      try { await deps.prunePath(filePath) } catch { /* best effort */ }
      // RE-ASK after the prune. prunePath just deleted every chunk of this file, INCLUDING the ones
      // whose content did not change and whose hashes are therefore still in `known`. Reusing the
      // pre-prune answer would skip exactly those — leaving the untouched parts of an edited file
      // deleted from the index and never rewritten. One extra round trip, and only for files that
      // actually changed.
      known = await knownHashes(deps, hashes)
    }
    for (const chunk of fileChunks) {
      if (known.has(chunk.hash)) {
        stats.chunksSkipped++
        continue
      }
      try {
        await deps.write(chunk)
        stats.chunksWritten++
        known.add(chunk.hash)
      } catch {
        continue // skip a chunk that fails to persist (no embed happened to yield for)
      }
      // Hand control back to the event loop between embeds so a bulk repo
      // index stays responsive instead of pegging the main thread.
      if (++sinceYield >= yieldEvery) {
        sinceYield = 0
        await doYield()
      }
      if (stats.chunksWritten >= maxChunks) {
        stats.truncated = true
        return stats
      }
    }
  }
  return stats
}

// The files a person sees in repoRoot: tracked ones (minus committed dependency, environment, cache and worktree
// folders; committed build output stays) plus untracked ones the ignore files allow (so node_modules and
// dist stay out), minus untracked dependency folders and virtual environments the ignore files miss (a root-only
// /node_modules rule, a venv with no .gitignore inside: never read, never indexed), the tracked files of its
// submodules, and the files of nested repositories that are not submodules (repoFileList.ts listRepo; one git
// refuses is walked as a plain folder, and a nested worktree of the repository itself is left out). Absolute paths.
// Returns [] if not a git repo / git missing.
// `confineTo` (the clone folder of a Lumopolis clone, someone else's content: folderSafety.ts cloneConfinement): a root
// whose real path is not inside it lists nothing, and every path discovery opens itself (a `.gitmodules`, a nested
// repository's `.git`, a worktree's `.git` pointer, a walked nested repository's .gitignore) is opened through its real
// path, and only if that is inside it, so a committed link out of it never makes a folder outside a repository to list,
// nor feeds a listing rules from a file elsewhere. The paths it lists may still be links: the reader a sweep is handed
// (confinedTextReader) refuses those.
export async function discoverRepoFiles(repoRoot: string, opts: { confineTo?: string | null } = {}): Promise<string[]> {
  if (!repoRoot) return []
  // Started now: notes of a listing started earlier and coming back later (one a sweep gave up waiting for) never land
  // over these (Codex r4 M2).
  const generation = ++listingsStarted
  const key = notesKey(repoRoot)
  // Whether this is the newest listing of the root to come back; if so it is from now on. A listing that fails, or
  // that the clone's confinement refuses, is newer too: an older one coming back after it lands nothing (Codex r5 2).
  const newest = (): boolean => {
    if ((notesGeneration.get(key) ?? 0) >= generation) return false
    notesGeneration.set(key, generation)
    return true
  }
  const within = opts.confineTo ?? null
  if (within !== null && !(await insideReal(within, repoRoot))) {
    newest()
    return []
  }
  // The proc host runs git (safeGitAsync): the spawn happens off the main thread. This used to start git here with
  // child_process.execFile, whose spawn blocks the calling thread (0.1-0.3 s on a busy Windows laptop), on every
  // code re-index (a watcher event), and only fell back to the host when that failed. safeGitAsync also resolves the
  // binary from the common install locations when a packaged app inherits a PATH without git, which is what stops a
  // transient git-off-PATH from silently wiping the code graph. A REAL "not a repo" error still lists nothing.
  const git = (args: string[]): Promise<string | null> =>
    safeGitAsync(args, { cwd: repoRoot, timeout: LIST_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 }).then(
      (out) => out,
      () => null
    )
  const stat = within !== null ? confinedReader(within, (p) => fsp.stat(p)) : (p: string) => fsp.stat(p)
  // listRepo reads a `.git` file only once the stat above has found it a file, so a confined read refuses only a path
  // swapped for a link between the two: it is kept for that.
  const read = within !== null ? confinedTextReader(within) : (p: string) => fsp.readFile(p, 'utf8')
  const statOf = (p: string): Promise<Stats | null> => stat(p).then((st) => st, () => null)
  const exists = (p: string): Promise<boolean> => statOf(p).then((st) => st !== null)
  const isFile = (p: string): Promise<boolean> => statOf(p).then((st) => st !== null && st.isFile())
  const readText = (p: string): Promise<string | null> => read(p).then((t) => t, () => null)
  const walk = (dir: string, cap: number): ReturnType<typeof walkNested> => walkNested(dir, cap, read)
  const listed = await listRepo(repoRoot, { git, exists, isFile, readText, walk })
  if (listed === null) {
    newest()
    return []
  }
  if (newest()) listingNotes.set(key, { nestedCapped: listed.nestedCapped, unreadable: listed.unreadable, nested: listed.nested })
  return listed.files.map((rel) => join(repoRoot, rel))
}

/** Whether `p`'s real path is inside `folder`'s; false when either cannot be resolved. */
async function insideReal(folder: string, p: string): Promise<boolean> {
  const [f, r] = await Promise.all([fsp.realpath(folder).catch(() => null), fsp.realpath(p).catch(() => null)])
  return f !== null && r !== null && isInside(f, r)
}

/** A nested repository git refuses, walked as a plain folder: what git would list (no `.git` file), minus its own
 *  .gitignore, read with `read` (confined for a clone). */
async function walkNested(dir: string, cap: number, read: (p: string) => Promise<string>): Promise<{ files: string[]; unreadable: string[]; capped: boolean }> {
  const ignored = await readRootIgnore(dir, undefined, read)
  return walkFolder(dir, { keep: (rel) => !inSkippedPath(rel) && !/(^|\/)\.git$/.test(rel), cap, ...(ignored ? { ignored } : {}) })
}

/** What the last listing of a repository could not show, and the nested repositories it holds. */
export interface RepoListingNotes {
  /** Nested repositories held more files than the cap: some were left out. */
  nestedCapped: boolean
  /** Repository-relative names that are not UTF-8 (at most repoFileList's MAP_FILE_CAP). */
  unreadable: string[]
  /** The nested repositories listed or walked and the submodules recursed, repository-relative: the file watcher
   *  keeps their edits. */
  nested: string[]
}

const listingNotes = new Map<string, RepoListingNotes>()
/** The listing each root's notes came from, by the order the listings started in (discoverRepoFiles). */
const notesGeneration = new Map<string, number>()
let listingsStarted = 0
/** The root as a key: `/` separated, no trailing separator, folded to lower case only where the file system folds case. */
const notesKey = (root: string): string => {
  const key = root.replace(/\\/g, '/').replace(/\/+$/, '')
  return CASE_FOLDING_PLATFORMS.has(process.platform) ? key.toLowerCase() : key
}

/** The notes of the last discoverRepoFiles of `root` (Lumopolis says them in its pane); null before any listing. */
export function repoListingNotes(root: string): RepoListingNotes | null {
  return listingNotes.get(notesKey(root)) ?? null
}

/** A listing of a large repository with many untracked folders walks them all: more time than git's usual 10 s. */
const LIST_TIMEOUT_MS = 60_000

export interface CodeIngestMemory {
  /** SYNC, in-process only — see CodeIngestDeps.hasHash. */
  hasHash?: (hash: string) => boolean
  /** Batched membership; what the app wires, because the store is out of process. */
  hasHashes?: (hashes: string[]) => Promise<string[]> | string[]
  write: (input: { agentId: string; kind: 'note'; content: string; source: string; hash: string; project?: string }) => Promise<unknown>
  /** Wave2: prune a file's stale code chunks before re-indexing it. */
  prunePath?: (filePath: string) => Promise<void> | void
}

export async function runCodeIngest(
  memory: CodeIngestMemory,
  opts: {
    repoRoot: string
    chunkOptions?: CodeChunkOptions
    maxChunks?: number
    /** The listing and the reader (index.ts graphSourceFor: confined for a Lumopolis clone, as the code graph's sweeps of
     *  it are); without one, git's listing of repoRoot and a plain read. */
    source?: { listFiles: () => Promise<string[]>; readFile: (file: string) => Promise<string> }
  },
): Promise<CodeIngestStats> {
  const source = opts.source ?? { listFiles: () => discoverRepoFiles(opts.repoRoot), readFile: (fp: string) => fsp.readFile(fp, 'utf8') }
  return ingestCode({
    chunkOptions: opts.chunkOptions,
    maxChunks: opts.maxChunks,
    listFiles: source.listFiles,
    readFile: source.readFile,
    hasHash: memory.hasHash,
    hasHashes: memory.hasHashes,
    prunePath: memory.prunePath,
    write: async (chunk) => {
      await memory.write({ agentId: 'code-index', kind: 'note', content: chunk.text, source: 'code', hash: chunk.hash, project: opts.repoRoot })
    },
  })
}
