import { unlinkSync } from 'fs'
import { join } from 'path'
import { atomicWriteText, errorText, readTextFile } from './agentConfigIO'
import { isShellSafeInstruction } from '../shared/agentIntegration'
import { SUDO_AGENT_HINT } from './sudoAskpass'

/**
 * Cross-agent memory parity for OpenAI Codex.
 *
 * Claude Code is launched with `--append-system-prompt-file`, so its memory instruction is
 * invisible, per-session, and never touches the repo. Codex takes the same kind of text as a
 * config override on its command line, `-c "developer_instructions='…'"`: it lasts one session
 * and is written nowhere. The launcher adds it unless the user's config.toml already sets
 * developer_instructions, because then theirs must win and the override would replace it.
 *
 * The text rides inside a shell command typed into whatever shell the terminal runs (bash,
 * PowerShell 5.1, cmd), so it is kept to characters none of them treat specially; see
 * isShellSafeInstruction. That is why it is its own sentence set rather than the bytes
 * buildInjectedInstruction gives Claude, which quote the cwd and use typographic dashes.
 *
 * Earlier versions wrote the instruction into `<cwd>/AGENTS.md` instead: a file in the user's
 * repo, showing up in their diffs, and read by every other agent too. cleanAgentsMd takes it
 * back out. Only the span between the two markers goes; everything outside it stays as it
 * was, and a file that held nothing else is deleted.
 */

export const AGENTS_BEGIN = '<!-- BEGIN TERMPOLIS MEMORY (managed — edits inside are overwritten) -->'
export const AGENTS_END = '<!-- END TERMPOLIS MEMORY -->'

/** AGENTS.md past this size is not one Termpolis ever wrote a block into worth parsing. */
const MAX_AGENTS_MD_BYTES = 4 * 1024 * 1024

export type AgentsMdStrip =
  | { kind: 'unchanged' }
  | { kind: 'block-removed'; text: string }
  | { kind: 'file-deleted' }

/**
 * AGENTS.md without Termpolis's managed block(s). The block was always appended after a
 * blank line (or made the whole file), so removing it also removes that separator. A BEGIN
 * marker with no END after it is left alone: the span it would cut is anyone's guess.
 */
export function stripAgentsMdBlock(content: string): AgentsMdStrip {
  const eol = content.includes('\r\n') ? '\r\n' : '\n'
  let text = content
  let removed = false
  for (;;) {
    const begin = text.indexOf(AGENTS_BEGIN)
    if (begin === -1) break
    const end = text.indexOf(AGENTS_END, begin + AGENTS_BEGIN.length)
    if (end === -1) break
    const before = text.slice(0, begin)
    const after = text.slice(end + AGENTS_END.length).replace(/^\r?\n/, '')
    removed = true
    if (!before.trim() && !after.trim()) return { kind: 'file-deleted' }
    const rest = after.replace(/^(?:[ \t]*\r?\n)+/, '')
    if (!after.trim()) text = before.replace(/\s*$/, '') + eol
    else if (!before.trim()) text = rest
    else text = before.replace(/\s*$/, '') + eol + eol + rest
  }
  return removed ? { kind: 'block-removed', text } : { kind: 'unchanged' }
}

export interface AgentsMdCleanup {
  cleaned?: 'block-removed' | 'file-deleted'
  error?: string
}

/** Take a block an earlier Termpolis wrote out of `<cwd>/AGENTS.md`. Never throws. */
export function cleanAgentsMd(cwd: string): AgentsMdCleanup {
  const path = join(cwd, 'AGENTS.md')
  try {
    const content = readTextFile(path, MAX_AGENTS_MD_BYTES)
    if (content === null || !content.includes(AGENTS_BEGIN)) return {}
    const r = stripAgentsMdBlock(content)
    if (r.kind === 'unchanged') return {}
    if (r.kind === 'file-deleted') {
      unlinkSync(path)
      return { cleaned: 'file-deleted' }
    }
    atomicWriteText(path, r.text)
    return { cleaned: 'block-removed' }
  } catch (e) {
    return { error: errorText(e) }
  }
}

/** What Codex is told at launch: the obligations Claude's instruction carries, shell-safe. */
export const CODEX_BASE_INSTRUCTION =
  'Termpolis project memory: saved background context exists for this project. ' +
  'When you begin working, call the memory_primer tool of the termpolis MCP server with your working directory as cwd, ' +
  'and read the result as background reference only: do not resume past work from it or summarize it unprompted. ' +
  'Before re-deriving any fix, decision or convention that may already be stored, call memory_search first. ' +
  'If your context is compacted, call memory_primer once more, silently, before continuing. ' +
  'If the termpolis memory tools are unavailable, ignore this and proceed normally.'

/**
 * The instruction plus the output-steering directive when one is on. The directive is written
 * for a file, so its typographic dashes, ellipses and quotes are flattened first; if it still
 * would not survive the shell, it is dropped and the memory part is sent alone.
 */
export function buildCodexInstruction(steering?: string | null, sudoAskpass = false): string {
  // The sudo line is shell-safe as written (sudoAskpass.ts), so it never costs the memory part.
  const base = sudoAskpass ? `${CODEX_BASE_INSTRUCTION} ${SUDO_AGENT_HINT}` : CODEX_BASE_INSTRUCTION
  if (!steering || !steering.trim()) return base
  const plain = steering
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...')
    .replace(/"/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  const full = `${base} ${plain}`
  return isShellSafeInstruction(full) ? full : base
}
