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
import { findLatestCodexSessionFile } from './transcriptWatchers/codexWatcher'
import { findLatestGeminiSessionFile } from './transcriptWatchers/geminiWatcher'
import { parseClaudeTranscript, parseBySource, type ConversationSource } from './conversationIngest'

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

/** A single dialogue turn, agent-agnostic (role + text) — the shape mnemeSession consumes. */
export interface SessionTurn {
  role: 'user' | 'assistant'
  text: string
}

/** Injectable deps for readSessionTranscript — real filesystem + parser by default. */
export interface SessionTranscriptDeps {
  /** (cwd, agent) → the agent's active session file path, or null. */
  findFile: (cwd: string, agent: string) => string | null
  readFile: (file: string) => Promise<string>
  parse: (agent: string, content: string) => Array<{ role: 'user' | 'assistant'; text: string }>
}

const defaultSessionDeps: SessionTranscriptDeps = {
  findFile: (cwd, agent) =>
    agent === 'claude'
      ? findLatestSessionFile(cwd)
      : agent === 'codex'
        ? findLatestCodexSessionFile()
        : agent === 'gemini'
          ? findLatestGeminiSessionFile()
          : null,
  readFile: (file) => fsp.readFile(file, 'utf8'),
  parse: (agent, content) => parseBySource(agent as ConversationSource, content),
}

/**
 * Read + parse the active session transcript for ANY supported agent (Claude / Codex /
 * Gemini) into clean role/text turns — the cross-agent companion to readActiveTranscript,
 * used by the solo-session learning reflex. Claude resolves per-cwd; Codex/Gemini resolve
 * to the newest session under their respective roots (matching the live watchers). Never
 * throws: an empty/unknown agent, missing file, unreadable file, or parse error → [].
 */
export async function readSessionTranscript(
  cwd: string,
  agent: string,
  deps: SessionTranscriptDeps = defaultSessionDeps,
): Promise<SessionTurn[]> {
  if (!cwd || !agent) return []
  const file = deps.findFile(cwd, agent)
  if (!file) return []
  let content: string
  try {
    content = await deps.readFile(file)
  } catch {
    return [] // session file vanished / unreadable — no-op
  }
  try {
    return deps.parse(agent, content).map((t) => ({ role: t.role, text: t.text }))
  } catch {
    return [] // malformed transcript — never crash the reflex
  }
}
