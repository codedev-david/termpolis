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
// "The active session" is the newest one that is this computer's own. A job another
// computer ran here over Linked machines saves a session too (when its agent's CLI
// can't be told not to), and while it is the newest it would stand in for the user's:
// the search would show it, and the learning reflex would learn from it. So the newest
// few are read in turn and a delegated one is passed over (shared/headlessPrompt),
// and the primer a headless run opened with is left out, as the indexer leaves it out.
//
// Best-effort throughout: any missing dir / unreadable file / unknown agent yields
// an empty list rather than throwing. Pure glue around already-tested helpers, with
// injectable deps so it unit-tests without touching the real filesystem.

import { promises as fsp } from 'fs'
import { listSessionFiles } from './transcriptWatchers/claudeCodeWatcher'
import { parseClaudeTranscript, parseBySource, newestTranscriptFiles, type ConversationSource } from './conversationIngest'
import { ownDialogue } from '../shared/headlessPrompt'

/** How many of the newest sessions are read looking for this computer's own. A computer runs at
 *  most four linked jobs at once (linkedJobs MAX_JOBS_TOTAL), so this looks past all of them.
 *  Each look reads a whole file, which is why it is not every session on disk. */
export const MAX_SESSION_CANDIDATES = 5

export interface LiveTurn {
  role: 'user' | 'assistant'
  text: string
  ts: number
}

export interface TranscriptDeps {
  /** cwd → its session JSONL paths, newest first. */
  findFiles: (cwd: string) => string[]
  /** Read a transcript file's UTF-8 content. */
  readFile: (file: string) => Promise<string>
  /** Parse JSONL content into clean turns (ts optional — missing on older lines). */
  parse: (content: string) => Array<{ role: 'user' | 'assistant'; text: string; ts?: number }>
}

const defaultDeps: TranscriptDeps = {
  findFiles: listSessionFiles,
  readFile: (file) => fsp.readFile(file, 'utf8'),
  parse: parseClaudeTranscript,
}

/** The turns of the newest of `files` that is this computer's own, read and parsed with `read`
 *  and `parse`. [] when the newest own one can't be read or parsed, or none of the first few is. */
async function newestOwn<T extends { role: 'user' | 'assistant'; text: string }>(
  files: string[],
  read: (file: string) => Promise<string>,
  parse: (content: string) => T[],
): Promise<T[]> {
  for (const file of files.slice(0, MAX_SESSION_CANDIDATES)) {
    let content: string
    try {
      content = await read(file)
    } catch {
      return [] // session file vanished / unreadable — no-op
    }
    let own: T[] | null
    try {
      own = ownDialogue(parse(content))
    } catch {
      return [] // malformed transcript — never crash the search or the reflex
    }
    if (own) return own
  }
  return []
}

/**
 * Read + parse the CURRENT session transcript for a working directory into clean
 * dialogue turns. Claude Code only for now — its per-cwd JSONL layout is resolvable
 * via listSessionFiles; other agents return [] (the renderer falls back to its
 * on-screen parse) until their session lookup lands. Never throws.
 */
export async function readActiveTranscript(
  cwd: string,
  agentType: string,
  deps: TranscriptDeps = defaultDeps,
): Promise<LiveTurn[]> {
  if (!cwd || agentType !== 'claude') return []
  const turns = await newestOwn(deps.findFiles(cwd), deps.readFile, deps.parse)
  return turns.map((t) => ({ role: t.role, text: t.text, ts: t.ts ?? 0 }))
}

/** A single dialogue turn, agent-agnostic (role + text) — the shape mnemeSession consumes. */
export interface SessionTurn {
  role: 'user' | 'assistant'
  text: string
}

/** Injectable deps for readSessionTranscript — real filesystem + parser by default. */
export interface SessionTranscriptDeps {
  /** (cwd, agent) → the agent's session file paths, newest first (may be async). */
  findFiles: (cwd: string, agent: string) => string[] | Promise<string[]>
  readFile: (file: string) => Promise<string>
  parse: (agent: string, content: string) => Array<{ role: 'user' | 'assistant'; text: string }>
}

const defaultSessionDeps: SessionTranscriptDeps = {
  // Claude resolves per-cwd (precise). Codex/Gemini resolve to the newest sessions via the
  // indexer's PROVEN discovery — correct roots + patterns + recursion — which handles Codex's
  // nested `sessions/YYYY/MM/DD/rollout-*.jsonl` and Gemini's `tmp/<proj>/chats/session-*.json`
  // layouts (the old watcher finders silently missed both).
  findFiles: (cwd, agent) =>
    agent === 'claude'
      ? listSessionFiles(cwd)
      : agent === 'codex'
        ? newestTranscriptFiles('codex', MAX_SESSION_CANDIDATES)
        : agent === 'gemini'
          ? newestTranscriptFiles('gemini', MAX_SESSION_CANDIDATES)
          : [],
  readFile: (file) => fsp.readFile(file, 'utf8'),
  parse: (agent, content) => parseBySource(agent as ConversationSource, content),
}

/**
 * Read + parse the active session transcript for ANY supported agent (Claude / Codex /
 * Gemini) into clean role/text turns — the cross-agent companion to readActiveTranscript,
 * used by the solo-session learning reflex. Claude resolves per-cwd; Codex/Gemini resolve
 * to the newest sessions under their respective roots (matching the live watchers). Never
 * throws: an empty/unknown agent, missing file, unreadable file, or parse error → [].
 */
export async function readSessionTranscript(
  cwd: string,
  agent: string,
  deps: SessionTranscriptDeps = defaultSessionDeps,
): Promise<SessionTurn[]> {
  if (!cwd || !agent) return []
  const files = await deps.findFiles(cwd, agent)
  const turns = await newestOwn(files, deps.readFile, (content) => deps.parse(agent, content))
  return turns.map((t) => ({ role: t.role, text: t.text }))
}
