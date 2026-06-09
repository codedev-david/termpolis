import { useCallback, useEffect, useRef } from 'react'
import type { AgentInfo } from '../lib/agentDetector'
import { createReprimeController, type ReprimeController } from '../lib/compactionReprime'

// Auto context-primer: when an AI agent is first detected in a terminal, paste a
// one-time digest of the most relevant memories for this project into its input
// — so "every invocation" starts already knowing prior decisions and context,
// across agents and past sessions. Opt-out in Settings.

const SETTING_KEY = 'termpolis.memory.autoPrimerOnLaunch'
const INJECT_DELAY_MS = 1500 // let the agent CLI finish booting before we paste

// Bracketed-paste markers so the multi-line primer lands as ONE paste in the
// agent's input — not auto-submitted, not a flurry of Enter-ed lines.
const BP_START = '\x1b[200~'
const BP_END = '\x1b[201~'

/** Auto-primer is ON by default; users opt out in Settings. */
export function isAutoPrimerEnabled(): boolean {
  try {
    return localStorage.getItem(SETTING_KEY) !== '0'
  } catch {
    return true
  }
}

export function setAutoPrimerEnabled(on: boolean): void {
  try {
    localStorage.setItem(SETTING_KEY, on ? '1' : '0')
  } catch {
    /* ignore */
  }
}

// Build a primer from the project's most relevant memories and paste it into the
// freshly-launched agent terminal. Best-effort and silent: a no-op if the API is
// unavailable or there is no relevant memory yet. Returns whether it injected.
export async function injectAutoPrimer(terminalId: string, cwd: string): Promise<boolean> {
  try {
    const api = window.termpolis
    if (!api?.memoryBuildPrimer || !api?.writeToTerminal) return false
    const project = cwd ? cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '' : ''
    const query = project
      ? `recent work, decisions, conventions, and context for ${project}`
      : 'recent work, key decisions, and conventions'
    const res = await api.memoryBuildPrimer(query)
    if (!res?.success || !res.data) return false
    const wrapped = BP_START + res.data.replace(/\r\n|\r|\n/g, '\r') + BP_END
    api.writeToTerminal(terminalId, wrapped)
    return true
  } catch {
    return false
  }
}

// Fire injectAutoPrimer once, shortly after an AI agent is first detected in
// this terminal. One TerminalPane mounts this per terminal, so the ref scopes
// the "prime once" guard to that terminal's lifetime.
export function useAutoPrimer(terminalId: string, detectedAgent: AgentInfo | null, cwd: string): void {
  const primedRef = useRef(false)
  const agentName = detectedAgent?.name ?? null
  useEffect(() => {
    if (!agentName || !terminalId) return
    if (primedRef.current) return
    if (!isAutoPrimerEnabled()) return
    primedRef.current = true
    const handle = setTimeout(() => {
      void injectAutoPrimer(terminalId, cwd)
    }, INJECT_DELAY_MS)
    return () => clearTimeout(handle)
  }, [terminalId, agentName, cwd])
}

// Watch a terminal's live output for a Claude Code compaction and, once it settles,
// re-inject the most relevant memories so the agent recovers the context it just
// summarized away. Returns a STABLE `onOutput(stripped)` to call from the terminal's
// data handler; current cwd/agent are read through refs so the callback never goes
// stale. One TerminalPane mounts this per terminal. Opt-out in Settings.
export function useCompactionReprimer(
  terminalId: string,
  detectedAgent: AgentInfo | null,
  cwd: string,
): (stripped: string) => void {
  const cwdRef = useRef(cwd)
  cwdRef.current = cwd
  const agentRef = useRef<string | null>(detectedAgent?.name ?? null)
  agentRef.current = detectedAgent?.name ?? null

  const controllerRef = useRef<ReprimeController | null>(null)
  if (!controllerRef.current) {
    controllerRef.current = createReprimeController({
      hasAgent: () => agentRef.current != null,
      reprime: () => {
        void injectAutoPrimer(terminalId, cwdRef.current)
      },
    })
  }

  useEffect(() => () => controllerRef.current?.dispose(), [])

  return useCallback((stripped: string) => {
    controllerRef.current?.onOutput(stripped)
  }, [])
}
