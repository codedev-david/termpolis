/**
 * The outline hint (v1.55.0 Task 12): when Claude reads a large source file whole, its PreToolUse hook
 * asks for this and hands the model the file's symbols with their line ranges, so the next read of the
 * same file can take only the part it needs. The read itself is never blocked or changed.
 *
 * About one session in ten (the primer holdout, armOf) gets nothing, so the Read bytes of the two arms
 * can be compared.
 */
import type { SymbolHit } from './codeGraph'
import { armOf } from './primerSessionGuard'

/** A file shorter than this is read whole without a hint: Claude's Read takes up to 2,000 lines. */
export const OUTLINE_MIN_FILE_LINES = 1500
/** Most symbols listed. */
export const OUTLINE_MAX_LINES = 60
/** Larger files are not counted, so a hint never makes main read a huge file. */
export const OUTLINE_MAX_FILE_BYTES = 8 * 1024 * 1024

export interface OutlineDeps {
  /** The indexed symbols of the file, any order; empty when it is not indexed. */
  symbols: (file: string) => SymbolHit[]
  /** Its line count, or null when it cannot be read (or is too large to count). */
  countLines: (file: string) => Promise<number | null>
}

export interface OutlineArgs { path?: unknown; sessionId?: unknown }

/** The hint text, or null for a small, unindexed or unreadable file, a holdout session, or a bad ask. */
export async function outlineHint(args: OutlineArgs, deps: OutlineDeps): Promise<string | null> {
  const file = typeof args.path === 'string' ? args.path.trim() : ''
  const sessionId = typeof args.sessionId === 'string' ? args.sessionId : ''
  if (!file || !sessionId || armOf(sessionId) === 'holdout') return null
  const symbols = deps.symbols(file)
  if (symbols.length === 0) return null
  const total = await deps.countLines(file)
  if (total === null || total <= OUTLINE_MIN_FILE_LINES) return null
  const sorted = [...symbols].sort((a, b) => a.startLine - b.startLine)
  const lines = sorted.slice(0, OUTLINE_MAX_LINES).map((s) => `${s.name} ${s.kind} (${s.startLine}-${s.endLine})`)
  const more = sorted.length > OUTLINE_MAX_LINES ? `\n… ${sorted.length - OUTLINE_MAX_LINES} more symbols (code_explore lists them)` : ''
  return `[Termpolis] This file has ${total} lines. Its outline from the code index, for reading a part with offset and limit next time:\n${lines.join('\n')}${more}`
}

/** Newlines in a buffer, plus one for a last line with no newline. */
export function countLinesIn(buf: Buffer): number {
  if (buf.length === 0) return 0
  let n = 0
  for (let i = buf.indexOf(10); i !== -1; i = buf.indexOf(10, i + 1)) n++
  return buf[buf.length - 1] === 10 ? n : n + 1
}
