// Code/repo ingestion — indexes the working repo's git-tracked source into the
// shared memory brain so agents can semantically recall "where/how is X done"
// without re-grepping every session.
//
// Security: we reuse the SAME sensitive-file denylist as the read watcher
// (matchSensitiveFile) so .env / keys / cloud creds are NEVER embedded — the
// indexer's skip-list is your security posture, not a separate guess. Binaries,
// minified bundles, and oversized files are skipped too. Using `git ls-files`
// means node_modules/dist/out are excluded for free (they're gitignored).

import * as crypto from 'crypto'
import { promises as fsp } from 'fs'
import { execFile } from 'child_process'
import { normalizeNewlines } from './lineEndings'
import { join } from 'path'
import { matchSensitiveFile } from './sensitiveFileWatcher'
import { safeGit } from './gitCommand'
import { knownHashes } from './conversationIngest' // one membership-resolution rule for both ingesters

// Promise wrapper that references execFile only when CALLED (not at module
// load), so test files that mock child_process can still import this module.
function execGit(args: string[], opts: { cwd?: string; maxBuffer?: number }): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, opts, (err, stdout) => (err ? reject(err) : resolve(String(stdout))))
  })
}

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

// Non-text / generated artifacts that pollute a code index.
const SKIP_EXT =
  /\.(png|jpe?g|gif|webp|ico|bmp|svg|pdf|zip|gz|tgz|tar|7z|rar|exe|dll|so|dylib|node|wasm|onnx|bin|woff2?|ttf|eot|otf|mp[34]|mov|avi|webm|class|jar|pyc|map)$/i
const SKIP_NAME = /(\.min\.(js|css)|package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/i
const MAX_FILE_BYTES = 256 * 1024

export function isIndexableCodeFile(filePath: string): boolean {
  if (!filePath || typeof filePath !== 'string') return false
  if (matchSensitiveFile(filePath) !== null) return false // secrets — never index
  if (SKIP_EXT.test(filePath)) return false
  if (SKIP_NAME.test(filePath)) return false
  return true
}

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

// git-tracked files under repoRoot (respects .gitignore, so node_modules/dist
// are excluded). Absolute paths. Returns [] if not a git repo / git missing.
export async function discoverRepoFiles(repoRoot: string): Promise<string[]> {
  if (!repoRoot) return []
  let stdout: string
  try {
    stdout = await execGit(['-C', repoRoot, 'ls-files'], { maxBuffer: 64 * 1024 * 1024 })
  } catch {
    // A packaged app can inherit a PATH without git — retry via safeGit, which resolves the
    // binary from common install locations. A REAL "not a repo" error still throws → []. This is
    // what stops a transient git-off-PATH from silently wiping the code graph.
    try {
      stdout = safeGit(['-C', repoRoot, 'ls-files'], { cwd: repoRoot, maxBuffer: 64 * 1024 * 1024 })
    } catch {
      return []
    }
  }
  return stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((rel) => join(repoRoot, rel))
}

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
  opts: { repoRoot: string; chunkOptions?: CodeChunkOptions; maxChunks?: number },
): Promise<CodeIngestStats> {
  return ingestCode({
    chunkOptions: opts.chunkOptions,
    maxChunks: opts.maxChunks,
    listFiles: () => discoverRepoFiles(opts.repoRoot),
    readFile: (fp) => fsp.readFile(fp, 'utf8'),
    hasHash: memory.hasHash,
    hasHashes: memory.hasHashes,
    prunePath: memory.prunePath,
    write: async (chunk) => {
      await memory.write({ agentId: 'code-index', kind: 'note', content: chunk.text, source: 'code', hash: chunk.hash, project: opts.repoRoot })
    },
  })
}
