// Live transcript reader — the clean, complete source for "find in my AI session".
//
// A fullscreen agent (Claude Code) repaints the same visible rows and keeps its
// scroll history internally, so the terminal emulator only ever holds the visible
// screen. The COMPLETE conversation does exist, though: Claude writes it
// continuously to a per-session JSONL on disk. This module locates the active
// session for a working directory and parses it into clean dialogue turns (tool
// calls / command noise already stripped by parseClaudeTranscript) so the renderer
// can search the ENTIRE current conversation — not the repaint-mangled buffer.
//
// Best-effort throughout: any missing dir / unreadable file / unknown agent yields
// an empty list rather than throwing. Pure glue around already-tested helpers, with
// injectable deps so it unit-tests without touching the real filesystem.

import { promises as fsp } from 'fs'
import { findLatestSessionFile } from './transcriptWatchers/claudeCodeWatcher'
import { parseClaudeTranscript } from './conversationIngest'

export interface LiveTurn {
  role: 'user' | 'assistant'
  text: string
  ts: number
}

export interface TranscriptDeps {
  /** cwd → newest session JSONL path (or null). */
  findFile: (cwd: string) => string | null
  /** Read a transcript file's UTF-8 content. */
  readFile: (file: string) => Promise<string>
  /** Parse JSONL content into clean turns (ts optional — missing on older lines). */
  parse: (content: string) => Array<{ role: 'user' | 'assistant'; text: string; ts?: number }>
}

const defaultDeps: TranscriptDeps = {
  findFile: findLatestSessionFile,
  readFile: (file) => fsp.readFile(file, 'utf8'),
  parse: parseClaudeTranscript,
}

/**
 * Read + parse the CURRENT session transcript for a working directory into clean
 * dialogue turns. Claude Code only for now — its per-cwd JSONL layout is resolvable
 * via findLatestSessionFile; other agents return [] (the renderer falls back to its
 * on-screen parse) until their session lookup lands. Never throws.
 */
export async function readActiveTranscript(
  cwd: string,
  agentType: string,
  deps: TranscriptDeps = defaultDeps,
): Promise<LiveTurn[]> {
  if (!cwd || agentType !== 'claude') return []
  const file = deps.findFile(cwd)
  if (!file) return []
  let content: string
  try {
    content = await deps.readFile(file)
  } catch {
    return [] // session file vanished / unreadable — no-op
  }
  try {
    return deps.parse(content).map((t) => ({ role: t.role, text: t.text, ts: t.ts ?? 0 }))
  } catch {
    return [] // malformed transcript — never crash the search
  }
}
