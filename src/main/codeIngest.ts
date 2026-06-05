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
import { join } from 'path'
import { matchSensitiveFile } from './sensitiveFileWatcher'

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
  const lines = content.split('\n')
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
  hasHash: (hash: string) => boolean
  write: (chunk: CodeChunk) => Promise<void>
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
    for (const chunk of chunkCode(filePath, content, deps.chunkOptions)) {
      if (deps.hasHash(chunk.hash)) {
        stats.chunksSkipped++
        continue
      }
      try {
        await deps.write(chunk)
        stats.chunksWritten++
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
  try {
    const stdout = await execGit(['-C', repoRoot, 'ls-files'], { maxBuffer: 64 * 1024 * 1024 })
    return stdout
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((rel) => join(repoRoot, rel))
  } catch {
    return []
  }
}

export interface CodeIngestMemory {
  hasHash: (hash: string) => boolean
  write: (input: { agentId: string; kind: 'note'; content: string; source: string; hash: string }) => Promise<unknown>
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
    write: async (chunk) => {
      await memory.write({ agentId: 'code-index', kind: 'note', content: chunk.text, source: 'code', hash: chunk.hash })
    },
  })
}
