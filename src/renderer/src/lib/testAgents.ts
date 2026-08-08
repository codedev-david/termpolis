const TEST_AGENT_MAP: Record<string, string> = {
  'claude': 'node e2e/mocks/mock-claude.cjs',
  'codex': 'node e2e/mocks/mock-codex.cjs',
  'gemini': 'node e2e/mocks/mock-gemini.cjs',
}

/**
 * The renderer runs with contextIsolation on and nodeIntegration off, so it has no
 * `process` at all — reading `process.env` there throws ReferenceError and both switches
 * below silently stayed off. That meant every UI-driven agent launch under E2E ran the
 * REAL claude/codex binary at the full 4s/10s delays instead of the mocks. Preload ferries
 * the two flags across on `window.termpolisTestFlags`; the `process.env` branch is the
 * fallback for unit tests, which import this module under plain Node.
 */
function testFlag(name: 'agents' | 'timing'): boolean {
  const bridged = (globalThis as any).termpolisTestFlags
  if (bridged) return !!bridged[name]
  try {
    const key = name === 'agents' ? 'TERMPOLIS_TEST_AGENTS' : 'TERMPOLIS_TEST_TIMING'
    return process?.env?.[key] === '1'
  } catch {}
  return false
}

export function resolveAgentCommand(command: string): string {
  if (testFlag('agents')) {
    return TEST_AGENT_MAP[command] ?? command
  }
  return command
}

/** True when a command string launches Claude Code — used to gate the always-on Headroom proxy. */
export function isClaudeCommand(command?: string | null): boolean {
  return !!command && command.trim().toLowerCase().startsWith('claude')
}

export function testDelay(ms: number): number {
  if (testFlag('timing')) {
    return Math.max(Math.round(ms / 10), 50)
  }
  return ms
}
