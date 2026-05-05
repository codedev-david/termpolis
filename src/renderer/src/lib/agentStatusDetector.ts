/**
 * Agent Status Detector — real-time status detection for swarm agent terminals.
 *
 * Analyzes terminal output to determine what an AI agent is currently doing.
 * Used by the swarm monitoring loop to update dashboard status indicators.
 */

// 'blocked' = agent process has exited or is stalled and needs manual restart
// (e.g. Codex printed "Please restart Codex" after a self-update, the CLI
// segfaulted silently, or the shell is back at a plain prompt with no agent
// running). Distinct from 'errored' (fatal error message) and
// 'waiting_for_input' (agent is alive and asking the user something) — a
// blocked agent will silently ignore swarm tasks until someone relaunches it.
export type AgentStatus = 'starting' | 'thinking' | 'waiting_for_input' | 'working' | 'idle' | 'errored' | 'completed' | 'blocked'

export interface AgentStatusResult {
  status: AgentStatus
  /** One-line summary of what the agent is doing (shown in dashboard) */
  summary: string
}

// Strip ANSI escape codes for clean pattern matching
function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\[\??[0-9;]*[a-zA-Z]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b[()][A-Z0-9]/g, '')
}

/**
 * Detect the current status of a swarm agent from its terminal output.
 *
 * @param recentOutput - The last ~2-4KB of the terminal's output buffer
 * @param agentName - The agent type (e.g. "Claude", "Codex", "Gemini", "Qwen Code")
 * @param previousStatus - The agent's previous status (for hysteresis)
 */
export function detectAgentStatus(
  recentOutput: string,
  agentName: string,
  previousStatus: AgentStatus = 'starting',
): AgentStatusResult {
  const clean = stripAnsi(recentOutput)
  // Focus on the tail for recency — most signals are at the end
  const tail = clean.slice(-1500)

  // --- Priority 1: Blocked — agent is dead/stalled, needs restart ---
  // Must outrank waiting_for_input: a "please re-authenticate" or
  // "gemini auth"-hint message contains auth keywords but the agent
  // process isn't actually alive to receive terminal input — the user
  // has to relaunch the CLI. Also precedes isIdle for the same reason.
  if (isBlocked(tail, agentName)) {
    const summary = extractBlockedSummary(tail, agentName)
    return { status: 'blocked', summary }
  }

  // --- Priority 2: Waiting for user input (needs attention) ---
  if (isWaitingForInput(tail, agentName)) {
    const summary = extractInputPrompt(tail, agentName)
    return { status: 'waiting_for_input', summary }
  }

  // --- Priority 3: Error state ---
  if (isErrored(tail)) {
    const summary = extractErrorSummary(tail)
    return { status: 'errored', summary }
  }

  // --- Priority 3: Completed ---
  if (isCompleted(tail, agentName)) {
    const summary = extractCompletionSummary(tail)
    return { status: 'completed', summary }
  }

  // --- Priority 4: Actively working (writing files, running commands) ---
  if (isWorking(tail)) {
    const summary = extractWorkSummary(tail)
    return { status: 'working', summary }
  }

  // --- Priority 5: Still starting (check before thinking — startup output looks like thinking) ---
  if (isStarting(tail, previousStatus)) {
    return { status: 'starting', summary: 'Agent initializing...' }
  }

  // --- Priority 6: Thinking (agent is generating output) ---
  if (isThinking(tail, agentName)) {
    return { status: 'thinking', summary: 'Analyzing and generating response...' }
  }

  // --- Priority 7: Idle (prompt visible, nothing happening) ---
  if (isIdle(tail, agentName)) {
    return { status: 'idle', summary: 'Waiting at prompt' }
  }

  // Default: keep previous status if we can't determine
  return { status: previousStatus, summary: '' }
}

// ---- Detection helpers ----

function isWaitingForInput(tail: string, agentName: string): boolean {
  // Trust folder prompts
  if (/do you trust.*files|trust this folder|allow access/i.test(tail)) return true
  // Auth prompts
  if (/sign in|log in|authenticate|visit.*to sign in|enter.*api.?key/i.test(tail)) return true
  // Interactive questions from agents
  if (/\(y\/n\)|yes\/no|\[Y\/n\]|\[y\/N\]/i.test(tail)) return true
  // Agent-specific prompts
  if (/claude/i.test(agentName) && /Do you want to proceed|Allow|Deny/i.test(tail)) return true
  if (/codex/i.test(agentName) && /press.*to confirm|select.*option/i.test(tail)) return true
  if (/gemini/i.test(agentName) && /\?\s*$/m.test(tail.slice(-200))) return true
  if (/qwen/i.test(agentName) && /\?\s*$/m.test(tail.slice(-200))) return true
  return false
}

function isBlocked(tail: string, agentName: string): boolean {
  // Codex self-update completed — the CLI exits and leaves this banner.
  // Without a restart the terminal is back to a plain shell prompt and
  // will silently ignore every MCP/swarm instruction sent to it.
  if (/update ran successfully.*please restart codex/i.test(tail)) return true
  if (/please restart codex/i.test(tail)) return true
  // Claude Code equivalent — it prints this when an in-place upgrade
  // finishes or when the account session has been invalidated.
  if (/claude/i.test(agentName) && /please restart claude|please re-?launch/i.test(tail)) return true
  // Gemini CLI rejects every command until auth is provided. The explicit
  // "gemini auth" hint is what the CLI prints when it detects no creds.
  if (/gemini/i.test(agentName) && /gemini\s+auth|run.*gemini auth|not authenticated/i.test(tail)) return true
  // Any agent: "session expired / please re-authenticate" messages.
  if (/session (?:has )?expired|please (?:re-?)?authenticate/i.test(tail)) return true
  // npm/pnpm installed new agent binary behind agent's back — another
  // "you need to restart" signal seen in the wild with auto-update paths.
  if (/restart (?:the )?(?:agent|cli|process) to (?:apply|continue|use)/i.test(tail)) return true
  return false
}

function isErrored(tail: string): boolean {
  // Fatal/crash errors — not just any "error" word in output
  if (/(?:fatal|panic|unhandled|uncaught).*(?:error|exception)/i.test(tail)) return true
  if (/process.*(?:exit|crash|killed)|segmentation fault|SIGKILL|SIGTERM/i.test(tail)) return true
  if (/token.*(?:limit|exceeded|budget)|context.*(?:limit|exceeded|full)/i.test(tail)) return true
  if (/rate.?limit.*exceeded|429.*too many/i.test(tail)) return true
  if (/ECONNREFUSED|ETIMEDOUT|network.*error/i.test(tail)) return true
  // Windows shell launch failures — the stub-claude.exe case produces this exact
  // wording; the "recognized as an internal or external command" is cmd.exe's
  // version of the same; "cannot find the path" is PowerShell's missing-binary
  // error. Catching these as errored surfaces a clear signal to the dashboard
  // instead of leaving the status stuck at "thinking" or "starting".
  if (/not a valid application for this OS platform/i.test(tail)) return true
  if (/is not recognized as an internal or external command/i.test(tail)) return true
  if (/cannot find the path specified|The system cannot find the (?:file|path)/i.test(tail)) return true
  if (/ApplicationFailedException|NativeCommandFailed/i.test(tail)) return true
  // Claude's own stub shim prints this exact message when the native binary
  // wasn't installed (postinstall skipped or --ignore-scripts).
  if (/claude native binary not installed/i.test(tail)) return true
  if (/command not found.*(?:claude|codex|gemini|qwen)/i.test(tail)) return true
  return false
}

function isCompleted(tail: string, _agentName: string): boolean {
  // Agent explicitly signals done
  if (/SWARM COMPLETE|TASK COMPLETE|all tasks.*complet/i.test(tail)) return true
  // Agent returned to prompt after doing work (not just starting)
  if (/(?:completed|finished|done)[.!]?\s*$/im.test(tail.slice(-300))) return true
  return false
}

function isWorking(tail: string): boolean {
  // File operations
  if (/(?:creating|writing|updating|modifying|deleting|reading)\s+(?:file|directory)/i.test(tail)) return true
  if (/(?:wrote|created|updated|modified|deleted)\s+\S+\.\w{1,10}/i.test(tail)) return true
  // Running commands
  if (/(?:running|executing|installing|building|compiling|testing)\b/i.test(tail)) return true
  // Git operations
  if (/git\s+(?:add|commit|push|pull|checkout|merge|rebase)/i.test(tail)) return true
  // npm/package operations
  if (/npm\s+(?:install|run|test|build)|yarn\s+(?:add|install|build)/i.test(tail)) return true
  // Tool use indicators from Claude/Codex
  if (/(?:Read|Write|Edit|Bash|Grep|Glob)\s*\(/i.test(tail.slice(-500))) return true
  return false
}

function isThinking(tail: string, agentName: string): boolean {
  // Claude thinking indicators
  if (/claude/i.test(agentName) && /thinking|analyzing|planning/i.test(tail.slice(-500))) return true
  // Streaming indicators (partial lines, ellipsis)
  if (/\.{3}\s*$|…\s*$/m.test(tail.slice(-200))) return true
  // Active output without a prompt (agent is in the middle of generating)
  const lines = tail.split('\n').filter(l => l.trim().length > 0)
  const lastLine = lines[lines.length - 1] || ''
  // If the last line doesn't look like a prompt and there's recent content, agent is thinking
  if (lastLine.length > 20 && !/[$>#%]\s*$/.test(lastLine) && !/^\s*$/.test(lastLine)) return true
  return false
}

function isIdle(tail: string, agentName: string): boolean {
  const trimmed = tail.trimEnd()
  const lastChars = trimmed.slice(-50)
  // Shell prompt patterns
  if (/[$>#%]\s*$/.test(lastChars)) return true
  // Claude Code prompt (> at start of line)
  if (/claude/i.test(agentName) && /^>\s*$/m.test(trimmed.slice(-100))) return true
  // Codex prompt
  if (/codex/i.test(agentName) && /^>\s*$/m.test(trimmed.slice(-100))) return true
  return false
}

function isStarting(tail: string, previousStatus: AgentStatus): boolean {
  // Only stay in starting if we were starting and haven't seen much output
  if (previousStatus !== 'starting') return false
  if (tail.trim().length < 100) return true
  // Still loading
  if (/loading|initializing|connecting|starting|resolving/i.test(tail.slice(-500))) return true
  // Agent version output (still in startup phase)
  if (/version\s+\d+\.\d+/i.test(tail) && tail.trim().length < 500) return true
  return false
}

// ---- Summary extractors ----

function extractInputPrompt(tail: string, _agentName: string): string {
  // Find the last question or prompt in the output
  const lines = tail.split('\n').filter(l => l.trim())
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 5); i--) {
    const line = lines[i].trim()
    if (/\?|trust|sign in|log in|allow|confirm|y\/n/i.test(line)) {
      return line.slice(0, 120)
    }
  }
  return 'Agent needs input'
}

function extractBlockedSummary(tail: string, agentName: string): string {
  if (/update ran successfully.*please restart codex/i.test(tail)) {
    return 'Codex self-updated — needs restart to resume'
  }
  if (/please restart codex/i.test(tail)) return 'Codex needs restart'
  if (/claude/i.test(agentName) && /please restart claude|please re-?launch/i.test(tail)) {
    return 'Claude Code needs restart'
  }
  if (/gemini/i.test(agentName) && /gemini\s+auth|run.*gemini auth|not authenticated/i.test(tail)) {
    return 'Gemini CLI not authenticated — run: gemini auth'
  }
  if (/session (?:has )?expired|please (?:re-?)?authenticate/i.test(tail)) {
    return 'Session expired — re-authenticate required'
  }
  if (/restart (?:the )?(?:agent|cli|process) to (?:apply|continue|use)/i.test(tail)) {
    return 'Agent needs restart to apply update'
  }
  return 'Agent blocked — manual intervention required'
}

function extractErrorSummary(tail: string): string {
  const lines = tail.split('\n').filter(l => l.trim())
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 10); i--) {
    const line = lines[i].trim()
    if (/error|fatal|panic|fail|crash|limit|exceeded|refused/i.test(line)) {
      return line.slice(0, 120)
    }
  }
  return 'Agent encountered an error'
}

function extractCompletionSummary(tail: string): string {
  const lines = tail.split('\n').filter(l => l.trim())
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 5); i--) {
    const line = lines[i].trim()
    if (/complete|finished|done|success/i.test(line)) {
      return line.slice(0, 120)
    }
  }
  return 'Task completed'
}

function extractWorkSummary(tail: string): string {
  const lines = tail.split('\n').filter(l => l.trim())
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 5); i--) {
    const line = lines[i].trim()
    if (/(?:creat|writ|updat|modif|delet|read|running|executing|install|build|compil|test|git |npm |yarn )/i.test(line)) {
      return line.slice(0, 120)
    }
  }
  return 'Working...'
}
