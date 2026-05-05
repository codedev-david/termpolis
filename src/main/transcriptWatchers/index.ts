import { attachClaudeCodeWatcher, type ClaudeCodeWatcherHandle } from './claudeCodeWatcher'
import { attachCodexWatcher, type CodexWatcherHandle } from './codexWatcher'
import { attachGeminiWatcher, type GeminiWatcherHandle } from './geminiWatcher'

/**
 * Central watcher manager — attaches the right transcript watcher(s) for a
 * given terminal based on detected agent type. One terminal may have
 * multiple watchers if multiple agents are active (rare but possible).
 *
 * Lifecycle:
 *   attach(terminalId, cwd, agentType)  — called when agent is detected
 *   detach(terminalId)                    — called when terminal closes or agent changes
 *   detachAll()                           — called on app shutdown
 *
 * Security:
 * - Only attaches for a known agentType; unknown types do nothing
 * - Each watcher enforces its own path containment
 * - Detach is idempotent
 */

export type AttachedWatcher =
  | ClaudeCodeWatcherHandle
  | CodexWatcherHandle
  | GeminiWatcherHandle

const active = new Map<string, AttachedWatcher[]>()

export type DetectedAgent = 'claude' | 'codex' | 'gemini'

export function attachWatcher(terminalId: string, cwd: string, agentType: DetectedAgent): AttachedWatcher | null {
  if (!terminalId || typeof terminalId !== 'string') return null
  if (!cwd || typeof cwd !== 'string') return null

  let handle: AttachedWatcher | null = null
  switch (agentType) {
    case 'claude':
      handle = attachClaudeCodeWatcher(terminalId, cwd)
      break
    case 'codex':
      handle = attachCodexWatcher(terminalId)
      break
    case 'gemini':
      handle = attachGeminiWatcher(terminalId)
      break
    default:
      return null
  }

  if (handle) {
    const list = active.get(terminalId) ?? []
    list.push(handle)
    active.set(terminalId, list)
  }
  return handle
}

export function detachWatchers(terminalId: string): void {
  const list = active.get(terminalId)
  if (!list) return
  for (const h of list) {
    try { h.stop() } catch {}
  }
  active.delete(terminalId)
}

export function detachAll(): void {
  for (const [, list] of active) {
    for (const h of list) {
      try { h.stop() } catch {}
    }
  }
  active.clear()
}

export function getActiveWatcherCount(): number {
  let n = 0
  for (const [, list] of active) n += list.length
  return n
}

/** Test-only state reset */
export function _resetForTests(): void {
  detachAll()
}
