import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { buildInjectedInstruction, type InjectedInstructionOpts } from './headroom/injectedInstruction'

/**
 * Cross-agent memory parity for OpenAI Codex.
 *
 * Claude Code is launched with `--append-system-prompt-file`, so its memory instruction is
 * invisible, per-session, and never touches the repo. Codex has no equivalent flag (verified
 * against codex-cli 0.142.5 — the only instruction surface it reads without being asked is
 * `AGENTS.md`, discovered from the cwd upward). So parity here is a file, not a flag.
 *
 * Three properties make writing into the user's repo acceptable:
 *
 *  1. **Managed span.** Everything outside the two markers is preserved byte-for-byte. A user's
 *     own AGENTS.md content is never read, rewritten, or reordered.
 *  2. **Byte-stable.** The block is the same constant text Claude receives, with no digest, no
 *     timestamp, and no counts inlined — so it is written once per project and then never again.
 *     `writeAgentsMd` returns `changed: false` on every later launch and does not touch the file.
 *     A block that churned would show up as a dirty working tree after every launch.
 *  3. **Same words.** The block is built from `buildInjectedInstruction`, the exact function that
 *     produces Claude's bytes. "Parity" that re-typed the instruction would drift the first time
 *     one side was edited, and no test would notice.
 */

export const AGENTS_BEGIN = '<!-- BEGIN TERMPOLIS MEMORY (managed — edits inside are overwritten) -->'
export const AGENTS_END = '<!-- END TERMPOLIS MEMORY -->'

/** The managed span, markers included. Deterministic for a given `opts`. */
export function buildAgentsBlock(opts: InjectedInstructionOpts): string {
  return [
    AGENTS_BEGIN,
    '## Project memory (Termpolis)',
    '',
    buildInjectedInstruction(opts),
    AGENTS_END,
  ].join('\n')
}

/**
 * Splice `block` into `existing`, replacing a previous managed span if one is present.
 * Pure — no IO — so the "did anything change?" decision can be made without a write.
 */
export function mergeAgentsMd(existing: string, block: string): string {
  const start = existing.indexOf(AGENTS_BEGIN)
  const end = existing.indexOf(AGENTS_END)
  if (start >= 0 && end > start) {
    return existing.slice(0, start) + block + existing.slice(end + AGENTS_END.length)
  }
  // A stray BEGIN with no END (hand-edited, or a half-written file) is left alone and the block
  // appended: deleting to end-of-file on a marker mismatch could take the user's content with it.
  if (existing.trim() === '') return block + '\n'
  return existing.replace(/\s*$/, '') + '\n\n' + block + '\n'
}

export interface AgentsMdResult {
  changed: boolean
  path: string
  skipped?: 'read-failed' | 'write-failed'
  error?: string
}

/** Write (or refresh) the managed block in `<cwd>/AGENTS.md`. No-op when already current. */
export function writeAgentsMd(cwd: string, opts: InjectedInstructionOpts): AgentsMdResult {
  const path = join(cwd, 'AGENTS.md')
  let existing = ''
  if (existsSync(path)) {
    try {
      existing = readFileSync(path, 'utf-8')
    } catch (e) {
      return { changed: false, path, skipped: 'read-failed', error: (e as Error)?.message || String(e) }
    }
  }
  const next = mergeAgentsMd(existing, buildAgentsBlock(opts))
  if (next === existing) return { changed: false, path }
  try {
    writeFileSync(path, next, 'utf-8')
  } catch (e) {
    return { changed: false, path, skipped: 'write-failed', error: (e as Error)?.message || String(e) }
  }
  return { changed: true, path }
}

/**
 * Memory tools only. Codex prompts for approval per MCP tool, and a prompt on `memory_primer` is
 * the difference between "Codex has the same context as Claude" and "Codex has the same context
 * as Claude if the user notices a dialog and clicks it". These read and write Termpolis's own
 * brain and touch nothing else, which is why auto-approving them is not an overreach —
 * `run_command` and `write_to_terminal` are deliberately absent and keep prompting.
 */
export const CODEX_AUTO_APPROVED_TOOLS: readonly string[] = [
  'memory_anticipate', 'memory_audit', 'memory_conflicts', 'memory_feedback', 'memory_graph',
  'memory_link', 'memory_list', 'memory_pool', 'memory_primer', 'memory_related',
  'memory_search', 'memory_selfcheck', 'memory_write',
]

/** The value codex-cli accepts for "run without asking". Probed against 0.142.5: `approve` (ask)
 *  and `auto` load; `never`, `always`, `allow`, `deny`, `on_request` are all rejected by
 *  `--strict-config`. Guessing here would have written a config that refuses to load. */
export const CODEX_AUTO = 'auto'

export interface CodexApprovalResult {
  changed: boolean
  tools: string[]
  skipped?: 'missing' | 'corrupt' | 'write-failed'
  error?: string
}

/**
 * Ensure every memory tool is auto-approved in `config.toml`.
 *
 * Text-blob editing, matching `registerInCodex`'s reasoning: a real TOML parser would refuse the
 * whole file over one unrelated syntax error the user made, and then memory would silently not
 * work. Existing `approval_mode = "approve"` lines inside a termpolis tool stanza are flipped
 * rather than duplicated — Codex writes those itself when a user answers a prompt once, so the
 * common case is a file that already has the wrong value, not a file that is missing the key.
 */
export function ensureCodexMemoryAutoApproved(tomlPath: string): CodexApprovalResult {
  if (!existsSync(tomlPath)) return { changed: false, tools: [], skipped: 'missing' }
  let content: string
  try {
    content = readFileSync(tomlPath, 'utf-8')
  } catch (e) {
    return { changed: false, tools: [], skipped: 'corrupt', error: (e as Error)?.message || String(e) }
  }
  const original = content
  const touched: string[] = []
  for (const tool of CODEX_AUTO_APPROVED_TOOLS) {
    const header = `[mcp_servers.termpolis.tools.${tool}]`
    const at = content.indexOf(header)
    if (at < 0) {
      content = content.replace(/\s*$/, '') + `\n\n${header}\napproval_mode = "${CODEX_AUTO}"\n`
      touched.push(tool)
      continue
    }
    // Rewrite approval_mode only within THIS stanza — up to the next `[` at line start, or EOF.
    const bodyStart = at + header.length
    const rest = content.slice(bodyStart)
    const nextHeader = rest.search(/\n\[/)
    const body = nextHeader < 0 ? rest : rest.slice(0, nextHeader)
    let nextBody: string
    if (/^\s*approval_mode\s*=/m.test(body)) {
      nextBody = body.replace(/^(\s*)approval_mode\s*=.*$/m, `$1approval_mode = "${CODEX_AUTO}"`)
    } else {
      nextBody = `\napproval_mode = "${CODEX_AUTO}"` + body
    }
    if (nextBody !== body) {
      content = content.slice(0, bodyStart) + nextBody + (nextHeader < 0 ? '' : rest.slice(nextHeader))
      touched.push(tool)
    }
  }
  if (content === original) return { changed: false, tools: [] }
  try {
    writeFileSync(tomlPath, content, 'utf-8')
  } catch (e) {
    return { changed: false, tools: [], skipped: 'write-failed', error: (e as Error)?.message || String(e) }
  }
  return { changed: true, tools: touched }
}
