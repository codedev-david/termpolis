import { useEffect } from 'react'
import type { AgentInfo } from '../lib/agentDetector'

/**
 * Attaches a native transcript watcher when an agent is detected in a terminal,
 * and detaches it when the terminal unmounts or the agent changes.
 *
 * Uses the main-process watcher manager (via agentActivity IPC) — this fills
 * the agentEventBus with structured events from real provider transcripts
 * (JSONL) rather than fragile buffer heuristics.
 */

const AGENT_TYPE_MAP: Record<string, 'claude' | 'codex' | 'gemini' | 'aider'> = {
  'Claude Code': 'claude',
  Codex: 'codex',
  'Gemini CLI': 'gemini',
  Aider: 'aider',
}

export function useTranscriptWatcher(
  terminalId: string,
  cwd: string,
  detectedAgent: AgentInfo | null,
): void {
  useEffect(() => {
    if (!detectedAgent || !terminalId || !cwd) return
    const agentType = AGENT_TYPE_MAP[detectedAgent.name]
    if (!agentType) return

    window.agentActivity
      ?.attachWatcher(terminalId, cwd, agentType)
      .catch(() => {})

    return () => {
      // Fire-and-forget detach; main process is idempotent
      window.agentActivity?.detachWatcher(terminalId).catch(() => {})
    }
  }, [terminalId, cwd, detectedAgent?.name])
}
